import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { juiceTemplates, JUICE_CATALOG_VERSION, composePersonalJuicePrompt } from './juice-catalog.js';
import { RateLimiter } from './lib/http-guards.js';
export const PERSONAL_JUICE_SCHEMA=`
CREATE TABLE IF NOT EXISTS personal_juice_types(id uuid PRIMARY KEY,account_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),archived_at timestamptz);
CREATE TABLE IF NOT EXISTS personal_juice_versions(id uuid PRIMARY KEY,template_id uuid NOT NULL REFERENCES personal_juice_types(id),account_id text NOT NULL,revision integer NOT NULL,name text NOT NULL,category text NOT NULL,instructions text NOT NULL,base_type text NOT NULL,base_prompt_snapshot text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(template_id,revision));
CREATE INDEX IF NOT EXISTS personal_juice_account_idx ON personal_juice_types(account_id,archived_at);
CREATE INDEX IF NOT EXISTS personal_juice_version_idx ON personal_juice_versions(template_id,revision DESC);
CREATE TABLE IF NOT EXISTS personal_juice_request_refs(
 account_id text NOT NULL,request_id uuid NOT NULL,template_id uuid NOT NULL REFERENCES personal_juice_types(id),
 revision_id uuid NOT NULL REFERENCES personal_juice_versions(id),config_fingerprint text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(account_id,request_id));`;
export const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export class PersonalJuiceError extends Error {constructor(public code:string,public status=400){super(code);}}
export interface PersonalJuiceInput{id:string;revision_id:string;name:string;category:string;instructions:string;base_type:string;expected_revision?:string;}
export function personalInput(value:unknown,id?:string):PersonalJuiceInput {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new PersonalJuiceError('INVALID_PERSONAL_JUICE');
 const v=value as Record<string,unknown>;
 if(Object.keys(v).some(key=>!['id','revision_id','name','category','instructions','base_type','expected_revision'].includes(key)))throw new PersonalJuiceError('INVALID_PERSONAL_JUICE');
 const text=(key:string,max:number,optional=false)=>{const raw=v[key];if(raw===undefined&&optional)return '';if(typeof raw!=='string'||raw.length>max||(!optional&&!raw.trim())||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(raw))throw new PersonalJuiceError('INVALID_PERSONAL_JUICE');return raw.trim();};
 if(!uuid(id??v.id)||!uuid(v.revision_id)||(id&&(!uuid(v.expected_revision)||v.id!==undefined&&v.id!==id)))throw new PersonalJuiceError('INVALID_PERSONAL_JUICE');
 const base_type=v.base_type??'custom';if(typeof base_type!=='string'||base_type!=='custom'&&!juiceTemplates.some(t=>t.id===base_type))throw new PersonalJuiceError('INVALID_PERSONAL_JUICE');
 return {id:(id??v.id) as string,revision_id:v.revision_id,name:text('name',80),category:text('category',60,true)||'Meus tipos',instructions:text('instructions',10000),base_type,...(id?{expected_revision:v.expected_revision as string}:{})};
}
export interface PersonalJuiceRecord {id:string;revision_id:string;revision:number;name:string;category:string;instructions:string;base_type:string;base_prompt_snapshot:string;created_at:string;updated_at:string;archived:boolean;}
export function publicPersonal(row:PersonalJuiceRecord){const {base_prompt_snapshot,...visible}=row;return visible;}
export interface PersonalJuiceStore {
 list(account:string):Promise<unknown[]>;
 get(account:string,id:string,revision?:string):Promise<PersonalJuiceRecord|null>;
 save(account:string,input:PersonalJuiceInput,updating:boolean):Promise<PersonalJuiceRecord>;
 archive(account:string,id:string,expected:string):Promise<void>;
}
export class SqlPersonalJuiceStore implements PersonalJuiceStore {
 constructor(private db:Pool){}
 private async tx<T>(account:string,work:(c:PoolClient)=>Promise<T>){const c=await this.db.connect();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(hashtext($1),701926)',[account]);const value=await work(c);await c.query('COMMIT');return value;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 private select=`SELECT p.id,v.id AS revision_id,v.revision,v.name,v.category,v.instructions,v.base_type,v.base_prompt_snapshot,p.created_at,v.created_at AS updated_at,p.archived_at IS NOT NULL AS archived FROM personal_juice_types p JOIN personal_juice_versions v ON v.template_id=p.id AND v.account_id=p.account_id`;
 async list(account:string){const r=await this.db.query(`SELECT id,revision_id,revision,name,category,base_type,created_at,updated_at,left(instructions,160) AS instructions_preview FROM (SELECT DISTINCT ON(p.id) p.id,v.id AS revision_id,v.revision,v.name,v.category,v.base_type,p.created_at,v.created_at AS updated_at,v.instructions FROM personal_juice_types p JOIN personal_juice_versions v ON v.template_id=p.id AND v.account_id=p.account_id WHERE p.account_id=$1 AND p.archived_at IS NULL ORDER BY p.id,v.revision DESC) latest ORDER BY lower(name),id LIMIT 100`,[account]);return r.rows;}
 async get(account:string,id:string,revision?:string){const r=await this.db.query<PersonalJuiceRecord>(`${this.select} WHERE p.account_id=$1 AND p.id=$2 ${revision?'AND v.id=$3':'AND p.archived_at IS NULL'} ORDER BY v.revision DESC LIMIT 1`,revision?[account,id,revision]:[account,id]);return r.rows[0]??null;}
 async save(account:string,input:PersonalJuiceInput,updating:boolean){
  await this.tx(account,async c=>{
   const header=await c.query('SELECT account_id,archived_at FROM personal_juice_types WHERE id=$1 FOR UPDATE',[input.id]);
   if(header.rows[0]&&header.rows[0].account_id!==account)throw new PersonalJuiceError('PERSONAL_JUICE_NOT_FOUND',404);
   if(header.rows[0]?.archived_at)throw new PersonalJuiceError('PERSONAL_JUICE_ARCHIVED',409);
   const previous=await c.query('SELECT * FROM personal_juice_versions WHERE id=$1',[input.revision_id]);
   if(previous.rows[0]){const old=previous.rows[0];if(old.account_id!==account||old.template_id!==input.id||['name','category','instructions','base_type'].some(k=>old[k]!==input[k as keyof PersonalJuiceInput]))throw new PersonalJuiceError('PERSONAL_JUICE_CONFLICT',409);return;}
   let revision=1;
   if(updating){if(!header.rows[0])throw new PersonalJuiceError('PERSONAL_JUICE_NOT_FOUND',404);const latest=await c.query('SELECT id,revision FROM personal_juice_versions WHERE template_id=$1 AND account_id=$2 ORDER BY revision DESC LIMIT 1',[input.id,account]);if(latest.rows[0]?.id!==input.expected_revision)throw new PersonalJuiceError('PERSONAL_JUICE_CONFLICT',409);revision=latest.rows[0].revision+1;}
   else{if(header.rows[0])throw new PersonalJuiceError('PERSONAL_JUICE_CONFLICT',409);const count=await c.query('SELECT count(*)::int AS n FROM personal_juice_types WHERE account_id=$1 AND archived_at IS NULL',[account]);if(count.rows[0].n>=100)throw new PersonalJuiceError('PERSONAL_JUICE_LIMIT',409);await c.query('INSERT INTO personal_juice_types(id,account_id) VALUES($1,$2)',[input.id,account]);}
   const preset=juiceTemplates.find(t=>t.id===input.base_type)?.prompt??'';
   await c.query('INSERT INTO personal_juice_versions(id,template_id,account_id,revision,name,category,instructions,base_type,base_prompt_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[input.revision_id,input.id,account,revision,input.name,input.category,input.instructions,input.base_type,preset]);
  });
  const row=await this.get(account,input.id,input.revision_id);if(!row)throw new PersonalJuiceError('PERSONAL_JUICE_UNAVAILABLE',503);return row;
 }
 async archive(account:string,id:string,expected:string){await this.tx(account,async c=>{const latest=await c.query('SELECT p.account_id,v.id AS revision_id FROM personal_juice_types p JOIN personal_juice_versions v ON v.template_id=p.id AND v.account_id=p.account_id WHERE p.id=$1 AND p.account_id=$2 ORDER BY v.revision DESC LIMIT 1',[id,account]);if(!latest.rows[0])throw new PersonalJuiceError('PERSONAL_JUICE_NOT_FOUND',404);if(latest.rows[0].revision_id!==expected)throw new PersonalJuiceError('PERSONAL_JUICE_CONFLICT',409);await c.query('UPDATE personal_juice_types SET archived_at=COALESCE(archived_at,now()) WHERE id=$1 AND account_id=$2',[id,account]);});}
}
const messages:Record<string,string>={INVALID_PERSONAL_JUICE:'Confira nome, categoria e instruções. Use até 80 caracteres no nome e 10.000 nas instruções.',PERSONAL_JUICE_NOT_FOUND:'Esse tipo de suco não está disponível.',PERSONAL_JUICE_ARCHIVED:'Esse tipo foi excluído. Seus sucos prontos continuam disponíveis.',PERSONAL_JUICE_CONFLICT:'Esse tipo mudou em outra tela. Recarregue para conferir antes de salvar.',PERSONAL_JUICE_LIMIT:'Você já tem 100 tipos de suco. Exclua um que não usa antes de criar outro.'};
export function personalJuiceRoutes(store:PersonalJuiceStore,account:string){const app=new Hono(),rate=new RateLimiter({windowMs:60000,max:30,maxKeys:1});app.use('*',async(c,next)=>{if(c.req.method!=='GET'){const d=rate.check('account');if(!d.allowed)return c.json({error:'Aguarde um minuto antes de alterar outro tipo.'},429,{'Retry-After':String(Math.ceil(d.retryAfterMs/1000))});}return next();});
 app.onError((e,c)=>{const error=e instanceof PersonalJuiceError?e:new PersonalJuiceError('PERSONAL_JUICE_UNAVAILABLE',503);return c.json({error:messages[error.code]||'Não conseguimos salvar seus tipos agora. Tente novamente.',code:error.code||'PERSONAL_JUICE_UNAVAILABLE'},(error.status===400||error.status===404||error.status===409?error.status:503) as 400);});
 async function body(c:{req:{text:()=>Promise<string>}}){const raw=await c.req.text();if(new TextEncoder().encode(raw).length>48000)throw new PersonalJuiceError('INVALID_PERSONAL_JUICE');try{return JSON.parse(raw);}catch{throw new PersonalJuiceError('INVALID_PERSONAL_JUICE');}}
 app.get('/',async c=>c.json({types:await store.list(account)}));
 app.get('/:id',async c=>{const id=c.req.param('id'),revision=c.req.query('revision');if(!uuid(id)||revision!==undefined&&!uuid(revision))throw new PersonalJuiceError('INVALID_PERSONAL_JUICE');const row=await store.get(account,id,revision);if(!row)throw new PersonalJuiceError('PERSONAL_JUICE_NOT_FOUND',404);return c.json({type:publicPersonal(row)});});
 app.post('/',async c=>c.json({type:publicPersonal(await store.save(account,personalInput(await body(c)),false))},201));
 app.patch('/:id',async c=>c.json({type:publicPersonal(await store.save(account,personalInput(await body(c),c.req.param('id')),true))}));
 app.delete('/:id',async c=>{const id=c.req.param('id'),v=await body(c);if(!uuid(id)||!v||typeof v!=='object'||!uuid(v.expected_revision)||Object.keys(v).length!==1)throw new PersonalJuiceError('INVALID_PERSONAL_JUICE');await store.archive(account,id,v.expected_revision);return c.json({ok:true});});return app;}
export async function resolvePersonalJuice(db:Pool,account:string,args:{
 analysisType:string;personalRevision?:string;templateVersion?:string;requestId?:string;focus?:string;
 chatJid:string;start:Date;end:Date;title?:string;auto?:boolean;
}){
 const id=args.analysisType.slice('personal:'.length);
 if(args.templateVersion!==JUICE_CATALOG_VERSION||!uuid(id)||!uuid(args.personalRevision)||!uuid(args.requestId))
  throw new PersonalJuiceError('INVALID_PERSONAL_JUICE');
 const row=await new SqlPersonalJuiceStore(db).get(account,id,args.personalRevision);
 if(!row)throw new PersonalJuiceError('PERSONAL_JUICE_NOT_FOUND',404);
 // Validate before recording an immutable operation. No messages or credentials are stored here.
 const prompt=composePersonalJuicePrompt(row.base_prompt_snapshot,row.instructions,args.focus);
 const fingerprint=createHash('sha256').update(JSON.stringify({account,id,revision:args.personalRevision,
  chat:args.chatJid,start:args.start.toISOString(),end:args.end.toISOString(),focus:args.focus??null,
  title:args.title||null,auto:!!args.auto,version:args.templateVersion})).digest('hex');
 const find=()=>db.query('SELECT template_id,revision_id,config_fingerprint FROM personal_juice_request_refs WHERE account_id=$1 AND request_id=$2',[account,args.requestId]);
 let ref=(await find()).rows[0];
 if(!ref){
  if(row.archived)throw new PersonalJuiceError('PERSONAL_JUICE_ARCHIVED',409);
  // Atomic insert also closes the race between two requests using the same UUID.
  await db.query(`INSERT INTO personal_juice_request_refs(account_id,request_id,template_id,revision_id,config_fingerprint)
   SELECT $1,$2,p.id,$4,$5 FROM personal_juice_types p WHERE p.id=$3 AND p.account_id=$1 AND p.archived_at IS NULL
   ON CONFLICT(account_id,request_id) DO NOTHING`,[account,args.requestId,id,args.personalRevision,fingerprint]);
  ref=(await find()).rows[0];
  if(!ref)throw new PersonalJuiceError('PERSONAL_JUICE_ARCHIVED',409);
 }
 if(ref.template_id!==id||ref.revision_id!==args.personalRevision||ref.config_fingerprint!==fingerprint)
  throw new PersonalJuiceError('PERSONAL_JUICE_REQUEST_CHANGED',409);
 return prompt;
}
