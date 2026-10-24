import {createHash,createHmac} from 'node:crypto';
import {Hono} from 'hono';
import type {Pool} from 'pg';
import type {TenantConfig} from './tenant-access.js';
import {RateLimiter} from './lib/http-guards.js';
export interface MeetingMessage {id:string;sender_jid:string|null;sender_name:string|null;from_me:boolean;body:string|null;ts:Date|string;}
export interface MeetingEvidence {id:string;sender:string;body:string;ts:string;}
export interface MeetingCandidate {intentKey:string;emails:string[];suggestedEmails:string[];ambiguous:boolean;evidence:MeetingEvidence[];}
const normalized=(text:string)=>text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
const request=/(?:reuniao|videochamada|videoconferencia|\bcall\b|\bmeeting\b)/;
const intention=/(?:vamos|bora|podemos|precisamos|quero|gostaria|conseguimos|marcar|agendar|agende|marca|convite|invite|schedule|combinamos|combinado)/;
const cancellation=/(?:\bnao\s+(?:quero|preciso|vamos|podemos|teremos|havera|vai ter|marque|agende)\b.{0,45}(?:reuniao|call)|\bsem\s+(?:reuniao|call)\b|nao\s+(?:(?:vamos|precisa|quero|podemos)\s+)?(?:marc|agend)|(?:reuniao|call).{0,35}(?:cancelad|adiad)|cancel[ae]\s+(?:a\s+)?(?:reuniao|call))/;
function excerpt(body:string,email?:string){if(body.length<=1200)return body;const at=email?body.indexOf(email):0,start=Math.max(0,at-200);return (start?'…':'')+body.slice(start,start+1200)+(start+1200<body.length?'…':'');}
export function extractMeetingCandidates(messages:MeetingMessage[],chatJid:string,tenantId:string):MeetingCandidate[]{
 const result:MeetingCandidate[]=[],handled=new Set<string>();
 for(let i=0;i<messages.length&&result.length<12;i++){
  const anchor=messages[i],text=normalized(anchor.body||'');
  if(handled.has(anchor.id)||!request.test(text)||!intention.test(text)||cancellation.test(text))continue;
  const window=messages.slice(i,i+7).filter(m=>Math.abs(new Date(m.ts).getTime()-new Date(anchor.ts).getTime())<=36*3600_000);
  if(window.some(m=>cancellation.test(normalized(m.body||'')))){window.forEach(m=>handled.add(m.id));continue;}
  const matches: {email:string;message:MeetingMessage}[]=[];
  for(const message of window){
   const body=message.body||'',n=normalized(body);
   if(/\bpix\b|boleto|cobranca|pagamento/.test(n)&&!request.test(n)&&!/e-?mail/.test(n))continue;
   for(const match of body.matchAll(/[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,63}/g)){
    const email=match[0];if(email.length<=254&&!matches.some(x=>x.email.toLowerCase()===email.toLowerCase()))matches.push({email,message});
   }
  }
  const senders=new Set(window.filter(m=>!m.from_me).map(m=>m.sender_jid||m.sender_name||m.id));
  const others=matches.filter(m=>!m.message.from_me),thirdParty=others.some(m=>/\b(?:e-?mail|contato)\s+(?:do|da|de)\s+/.test(normalized(m.message.body||''))),ambiguous=thirdParty||chatJid.endsWith('@g.us')&&senders.size>1||others.length!==1;
  const emails=matches.slice(0,10).map(x=>x.email),suggestedEmails=ambiguous?[]:others.map(x=>x.email);
  const refs=[anchor,...matches.slice(0,10).map(x=>x.message)].filter((m,index,array)=>array.findIndex(x=>x.id===m.id)===index);
  result.push({intentKey:createHash('sha256').update(JSON.stringify(['suco-meeting-v1',tenantId,chatJid,anchor.id])).digest('hex'),emails,suggestedEmails,ambiguous,
   evidence:refs.map(m=>({id:m.id,sender:m.from_me?'Você':m.sender_name||'Participante',body:excerpt(m.body||'',matches.find(x=>x.message.id===m.id)?.email),ts:new Date(m.ts).toISOString()}))});
  window.forEach(m=>handled.add(m.id));
 }
 return result;
}
export function signMeetingTicket(input:{summaryId:string;intentKey:string;title:string;emails:string[]},config:TenantConfig,now=Date.now()){
 const source={v:1,accountId:config.accountId,tenantId:config.tenantId,summaryId:input.summaryId,intentKey:input.intentKey,title:input.title.slice(0,200),emails:input.emails,exp:now+300_000};
 const encoded=Buffer.from(JSON.stringify(source)).toString('base64url');return 'meeting1.'+encoded+'.'+createHmac('sha256',config.workerKey).update('suco-meeting-v1.'+encoded).digest('hex');
}
export function meetingProposalRoutes(pool:Pool,tenant:TenantConfig|null){
 const app=new Hono(),rate=new RateLimiter({windowMs:60000,max:20,maxKeys:1});
 app.get('/:id/calendar-proposals',async c=>{
  if(!tenant)return c.json({error:'Conecte sua conta do Suco para preparar convites.',code:'CALENDAR_NATIVE_REQUIRED'},503);
  const id=c.req.param('id');if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))return c.json({error:'Suco não encontrado.'},404);
  const limit=rate.check('account');if(!limit.allowed)return c.json({error:'Aguarde um minuto antes de procurar outros convites.'},429);
  const summary=await pool.query('SELECT id,chat_jid,title,period_start,period_end FROM summaries WHERE id=$1',[id]);
  const row=summary.rows[0];if(!row)return c.json({error:'Suco não encontrado.'},404);
  const messages=await pool.query<MeetingMessage>('SELECT id,sender_jid,sender_name,from_me,body,ts FROM wa_messages WHERE chat_jid=$1 AND ts >= $2 AND ts <= $3 ORDER BY ts,seq LIMIT 10001',[row.chat_jid,row.period_start,row.period_end]);
  const candidates=extractMeetingCandidates(messages.rows.slice(0,10000),row.chat_jid,tenant.tenantId).map(candidate=>({...candidate,sourceTicket:signMeetingTicket({summaryId:row.id,intentKey:candidate.intentKey,title:row.title||'Reunião',emails:candidate.suggestedEmails},tenant)}));
  return c.json({candidates,summaryId:row.id,sourceScope:'summary_period',truncated:messages.rows.length>10000,automaticGeneration:false});
 });return app;
}
