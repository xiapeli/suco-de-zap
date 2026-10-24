import{pool}from'./db.js';
import type{Pool}from'pg';
import{normalizeSearch,nextSearchCursor,extractSensitive,KEY_SQL,PIX_LABEL,type SearchOptions,type SourceMessage,type SensitiveMatch}from'./search-core.js';
export type{SearchOptions}from'./search-core.js';
export{SearchValidationError}from'./search-core.js';
export interface SearchHitMessage extends SourceMessage{}
function literal(value:string){return'%'+value.replace(/!/g,'!!').replace(/%/g,'!%').replace(/_/g,'!_')+'%';}
export function buildSearchSQL(n:ReturnType<typeof normalizeSearch>){
 const values:unknown[]=[];const add=(v:unknown)=>{values.push(v);return'$'+values.length;};
 const start=n.filters.start?add(n.filters.start):null,end=n.filters.end?add(n.filters.end):null,chat=n.filters.chat_jid?add(n.filters.chat_jid):null;
 const snapshot=n.watermark?`SELECT ${add(n.watermark)}::bigint AS seq`:'SELECT COALESCE(MAX(seq),0) AS seq FROM wa_messages';
 const scope=(alias:string)=>[`${alias}.seq <= (SELECT seq FROM snapshot)`,start?`${alias}.ts >= ${start}::timestamptz`:null,end?`${alias}.ts < ${end}::timestamptz`:null,chat?`${alias}.chat_jid = ${chat}`:null].filter(Boolean).join(' AND ')||'TRUE';
 const termParams=n.terms.map(t=>add(literal(t))),whole=add(literal(n.query)),key=add(KEY_SQL);
 const termMatch=(alias:string)=>termParams.length?'('+termParams.map(p=>`(${alias}.body ILIKE ${p} ESCAPE '!' OR ${alias}.sender_name ILIKE ${p} ESCAPE '!' OR concat_ws(' ',ch.name,act.name,act2.name,act.notify,act2.notify) ILIKE ${p} ESCAPE '!')`).join(' OR ')+')':'FALSE';
 const typeRegex=n.filters.inferredKind==='pix'?PIX_LABEL:n.filters.inferredKind==='email'?'[[:alnum:]._%+-]+@[[:alnum:].-]+[.][[:alpha:]]{2,}':n.filters.inferredKind==='phone'?'([+]?[0-9][0-9 ()-]{8,19}[0-9])':n.filters.inferredKind==='address'?'(^|[[:space:]])(rua|avenida|av[.]|travessa|alameda|rodovia|estrada|praça)[[:space:]]':null;
 const fullText=typeRegex?null:add(n.terms.join(' ')||n.query);
 const anchorWhere=typeRegex?`m.body ~* ${add(typeRegex)}`:`(${termMatch('m')} OR to_tsvector('portuguese',COALESCE(m.body,'')) @@ plainto_tsquery('portuguese',${fullText}))`;
 const typedQualifier=typeRegex&&termParams.length?`AND (${termMatch('m')} OR EXISTS (SELECT 1 FROM (
 (SELECT qn.body,qn.sender_name FROM wa_messages qn WHERE qn.chat_jid=m.chat_jid AND ${scope('qn')} AND(qn.ts,qn.id)>=(m.ts,m.id) AND qn.ts<=m.ts+interval '10 minutes' ORDER BY qn.ts,qn.id LIMIT 3)
 UNION ALL
 (SELECT qn.body,qn.sender_name FROM wa_messages qn WHERE qn.chat_jid=m.chat_jid AND ${scope('qn')} AND(qn.ts,qn.id)<(m.ts,m.id) AND qn.ts>=m.ts-interval '10 minutes' ORDER BY qn.ts DESC,qn.id DESC LIMIT 2)
 ) q WHERE ${termMatch('q')}))`:'';
 const scoreTerms=termParams.map(p=>`CASE WHEN (m.body ILIKE ${p} ESCAPE '!' OR COALESCE(ch.name,'') ILIKE ${p} ESCAPE '!' OR m.sender_name ILIKE ${p} ESCAPE '!') THEN 100 ELSE 0 END`).join('+')||'0';
 const ctes=`WITH snapshot AS MATERIALIZED (${snapshot}),anchors AS MATERIALIZED (
 SELECT m.chat_jid,m.id,m.ts FROM wa_messages m LEFT JOIN wa_chats ch ON ch.jid=m.chat_jid
 LEFT JOIN wa_lid_map alm ON alm.lid=m.chat_jid LEFT JOIN wa_contacts act ON act.jid=m.chat_jid LEFT JOIN wa_contacts act2 ON act2.jid=alm.pn
 WHERE m.body IS NOT NULL AND ${scope('m')} AND (${anchorWhere}) ${typedQualifier}
 ), neighbors AS (
 SELECT a.chat_jid,n.id,a.id AS anchor_id,a.ts AS anchor_ts,n.ts AS message_ts FROM anchors a CROSS JOIN LATERAL (
  (SELECT nm.id,nm.ts FROM wa_messages nm WHERE nm.chat_jid=a.chat_jid AND ${scope('nm')}
    AND (nm.ts,nm.id)>=(a.ts,a.id) AND nm.ts<=a.ts+interval '10 minutes' ORDER BY nm.ts,nm.id LIMIT 3)
  UNION ALL
  (SELECT nm.id,nm.ts FROM wa_messages nm WHERE nm.chat_jid=a.chat_jid AND ${scope('nm')}
    AND (nm.ts,nm.id)<(a.ts,a.id) AND nm.ts>=a.ts-interval '10 minutes' ORDER BY nm.ts DESC,nm.id DESC LIMIT 2)
 ) n
 ), candidate_ids AS (
 SELECT DISTINCT ON(chat_jid,id) chat_jid,id,anchor_id FROM neighbors ORDER BY chat_jid,id,(id=anchor_id) DESC,abs(extract(epoch FROM(message_ts-anchor_ts))),anchor_ts DESC,anchor_id
 ), ranked AS (
 SELECT m.chat_jid,COALESCE(ch.name,ct.name,ct2.name,ct.notify,ct2.notify,split_part(m.chat_jid,'@',1)) AS chat_name,
 CASE WHEN m.from_me THEN 'Eu' ELSE m.sender_name END AS sender_name,
 left(COALESCE(m.body,''),16000) AS body,m.ts,m.id,c.anchor_id AS "anchorId",left(COALESCE(a.body,''),1000) AS "anchorBody",
 length(COALESCE(m.body,''))>16000 AS "bodyTruncated",
 (CASE WHEN m.body ~* ${key} THEN 2000 ELSE 0 END + CASE WHEN m.body ILIKE ${whole} ESCAPE '!' THEN 200 ELSE 0 END + ${scoreTerms})::int AS score
 FROM candidate_ids c JOIN wa_messages m ON m.chat_jid=c.chat_jid AND m.id=c.id
 JOIN wa_messages a ON a.chat_jid=c.chat_jid AND a.id=c.anchor_id
 LEFT JOIN wa_chats ch ON ch.jid=m.chat_jid LEFT JOIN wa_lid_map lm ON lm.lid=m.chat_jid
 LEFT JOIN wa_contacts ct ON ct.jid=m.chat_jid LEFT JOIN wa_contacts ct2 ON ct2.jid=lm.pn
 WHERE m.body IS NOT NULL
 )`;
 const limit=add(n.limit+1),offset=add(n.offset);
 const text=`${ctes} SELECT
 (SELECT jsonb_build_object('firstMessageAt',MIN(ts),'lastMessageAt',MAX(ts),'totalMessages',COUNT(*)) FROM wa_messages WHERE seq<=(SELECT seq FROM snapshot)) AS global,
 (SELECT seq::text FROM snapshot) AS watermark,
 (SELECT COUNT(*)::int FROM wa_messages m WHERE ${scope('m')}) AS selected,
 (SELECT COUNT(*)::int FROM anchors) AS anchors,
 (SELECT COUNT(*)::int FROM ranked) AS matching,
 COALESCE((SELECT jsonb_agg(to_jsonb(page)) FROM (SELECT * FROM ranked ORDER BY score DESC,ts DESC,chat_jid COLLATE "C",id COLLATE "C" LIMIT ${limit} OFFSET ${offset}) page),'[]'::jsonb) AS messages`;
 return{text,values,query_timeout:12000};
}
/** Literal local retrieval only: no query expansion or private evidence leaves this database. */
export async function searchMessages(database:Pick<Pool,'query'>,query:string,options:SearchOptions|number={}){
 const at=Date.now(),n=normalizeSearch(query,options);const result=await database.query(buildSearchSQL(n));const row=result.rows[0]??{};
 const candidates=(Array.isArray(row.messages)?row.messages:[])as(SourceMessage&{score?:number})[];const hasMore=candidates.length>n.limit;const selected=candidates.slice(0,n.limit);
 const sensitiveMatches:SensitiveMatch[]=[];const seen=new Set<string>();
 for(const m of selected)for(const hit of extractSensitive(m,n.filters.inferredKind)){const id=hit.chat_jid+'|'+hit.messageId+'|'+hit.kind+'|'+hit.value;if(!seen.has(id)&&sensitiveMatches.length<100){seen.add(id);sensitiveMatches.push(hit);}}
 const byChat=new Map<string,Set<string>>();for(const hit of sensitiveMatches){const set=byChat.get(hit.chat_jid)??new Set<string>();set.add(hit.value);byChat.set(hit.chat_jid,set);}let conflicts=false;
 for(const hit of sensitiveMatches)if(n.filters.inferredKind==='pix'&&(byChat.get(hit.chat_jid)?.size??0)>1){conflicts=true;if(hit.status==='candidate')hit.status='unconfirmed';}
 const warnings=['A cobertura informa somente as mensagens já sincronizadas e armazenadas. O WhatsApp pode não ter enviado todo o histórico.'];
 if(!n.filters.start&&!n.filters.end&&/\b(?:meses?|anos?|antig[ao]s?|atr[aá]s|janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|20\d{2})\b/i.test(n.query))warnings.push('Você mencionou uma época, mas não definiu um período. A busca percorreu todo o histórico armazenado; use o filtro de datas para conferir aquela época.');
 if(conflicts)warnings.push('Há valores diferentes na mesma conversa. A busca não determina qual chave está em uso; confira as mensagens originais.');
 if(n.filters.start&&row.global?.firstMessageAt&&new Date(n.filters.start).getTime()<new Date(row.global.firstMessageAt).getTime())warnings.push('O período começa antes da primeira mensagem armazenada. Parte dessa época pode não ter sido sincronizada.');
 if(n.filters.end&&row.global?.firstMessageAt&&new Date(n.filters.end).getTime()<=new Date(row.global.firstMessageAt).getTime())warnings.push('Não há mensagens armazenadas desse período anterior à cobertura disponível; isso não comprova ausência no WhatsApp.');
 if(selected.some(m=>m.bodyTruncated))warnings.push('Há mensagens longas com prévia limitada; abra a fonte original para conferir o texto completo.');
 if(sensitiveMatches.some(m=>m.status==='revoked'||m.status==='unconfirmed'))warnings.push('Alguns valores aparecem como antigos, não confirmados ou ambíguos. Confirme na conversa antes de usar.');
 if(hasMore)warnings.push('Há mais fontes: use a próxima página antes de concluir que um valor não foi encontrado.');
 const messages=selected.map(({score,anchorBody,...m})=>({...m,body:m.body.slice(0,2000),bodyTruncated:Boolean(m.bodyTruncated)||m.body.length>2000}));
 const matchingMessages=Number(row.matching)||0,matchingAnchors=Number(row.anchors)||0;
 const answer=sensitiveMatches.length?`Encontrei ${sensitiveMatches.length} valor(es) literais nas fontes desta página. Confira a mensagem, a data e os avisos; a busca não verifica se uma chave PIX está ativa ou pertence a alguém.`:messages.length?'Encontrei menções relacionadas nesta página, mas nenhum valor identificável com segurança neste recorte. Consulte as fontes e as próximas páginas.':'Nenhuma fonte correspondente foi encontrada nas mensagens armazenadas para estes filtros. Isso não comprova ausência no WhatsApp ou em períodos ainda não sincronizados.';
 return{answer,facts:[],messages,sensitiveMatches,coverage:{...(row.global??{firstMessageAt:null,lastMessageAt:null,totalMessages:0}),selectedMessages:Number(row.selected)||0,matchingMessages,matchingAnchors,hasMore,scope:'stored_messages',historyComplete:false,warnings},filters:n.filters,nextCursor:hasMore?nextSearchCursor(n.fingerprint,n.offset+n.limit,String(row.watermark??'0')):null,took_ms:Date.now()-at};
}
export async function smartSearch(query:string,options:SearchOptions|number={}){return searchMessages(pool,query,options);}
