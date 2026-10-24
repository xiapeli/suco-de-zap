import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import{mkdtemp,writeFile,rm}from'node:fs/promises';
import{tmpdir}from'node:os';
import{join}from'node:path';

const url=process.env.SUCO_LIMIT_TEST_DATABASE_URL;
const parsed=url?new URL(url):null;
if(parsed&&(!parsed.pathname.startsWith('/suco_limits_')||parsed.hostname!=='127.0.0.1'||parsed.port!=='5436'||!parsed.username.startsWith('suco_limits_')))throw Error('SYNTHETIC_LIMIT_DATABASE_REQUIRED');

test('real PostgreSQL atomic monitored admission, usage, rollback and quota errors',{skip:!url},async(t)=>{
 const dir=await mkdtemp(join(tmpdir(),'suco-limits-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const keyFile=join(dir,'fake-key');await writeFile(keyFile,'synthetic-no-provider-key',{mode:0o600});
 process.env.API_TOKEN='synthetic-limit-token';process.env.DATABASE_URL=url;process.env.SUCO_GLM_REGULAR_KEY_FILE=keyFile;process.env.SUCO_MONITORED_LIMIT='2';process.env.SUCO_LLM_MONTHLY_LIMIT='2';process.env.SUCO_LLM_DAILY_LIMIT='2';
 for(const k of['SUCO_TENANT_ID','SUCO_ACCOUNT_ID','SUCO_WORKER_KEY','SUCO_CONTROL_PLANE_URL'])delete process.env[k];
 const{app}=await import('../src/api.js');const{pool}=await import('../src/db.js');t.after(()=>pool.end());
 const{SCHEMA}=await import('../src/cloud-glm/ledger.js');const{callCloudLLM}=await import('../src/cloud-runtime.js');
 await pool.query(`CREATE TABLE wa_chats(jid text PRIMARY KEY,tracked boolean NOT NULL DEFAULT false,archived boolean NOT NULL DEFAULT false,updated_at timestamptz NOT NULL DEFAULT now());`);
 await pool.query(SCHEMA);
 // Widen each UPDATE so a missing admission lock reliably oversubscribes under concurrency.
 await pool.query(`CREATE FUNCTION delay_chat_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.05); RETURN NEW; END $$; CREATE TRIGGER delay_chat BEFORE UPDATE ON wa_chats FOR EACH ROW EXECUTE FUNCTION delay_chat_update();`);
 await pool.query(`INSERT INTO wa_chats(jid,tracked,archived) VALUES ('initial',true,true),('a',false,false),('b',false,false),('c',false,false),('d',false,false),('e',false,false),('f',false,false)`);
 const headers={Authorization:'Bearer synthetic-limit-token','Content-Type':'application/json'};
 const patch=(jid:string,body:unknown)=>app.request('/api/chats/'+encodeURIComponent(jid),{method:'PATCH',headers,body:JSON.stringify(body)});
 await t.test('concurrent requests admit one remaining slot and count archived tracked chats',async()=>{
  const replies=await Promise.all(['a','b','c','d','e','f'].map(jid=>patch(jid,{tracked:true})));
  assert.equal(replies.filter(r=>r.status===200).length,1);assert.equal(replies.filter(r=>r.status===429).length,5);
  const denied=await replies.find(r=>r.status===429)!.json();assert.equal(denied.code,'MONITORED_LIMIT_REACHED');assert.equal(denied.limit,2);assert.match(denied.error,/Desmarque/);
  assert.equal((await pool.query('SELECT count(*)::int n FROM wa_chats WHERE tracked')).rows[0].n,2);
 });
 await t.test('retracking at full capacity is idempotent; missing target returns404 first',async()=>{
  assert.equal((await patch('initial',{tracked:true,archived:false})).status,200);assert.equal((await patch('initial',{tracked:true})).status,200);
  assert.equal((await patch('not-present',{tracked:true})).status,404);
  assert.equal((await pool.query('SELECT count(*)::int n FROM wa_chats WHERE tracked')).rows[0].n,2);
 });
 await t.test('untracking frees a slot; archive-only updates bypass admission and invalid optional fields are ignored',async()=>{
  assert.equal((await patch('initial',{tracked:false})).status,200);
  assert.equal((await patch('initial',{tracked:true,archived:'ignored'})).status,200);
  assert.equal((await patch('initial',{archived:true})).status,200);
  assert.equal((await pool.query("SELECT tracked,archived FROM wa_chats WHERE jid='initial'")).rows[0].archived,true);
 });
 await t.test('usage includes consumed/uncertain reservations, excludes released and exposes actual limits',async()=>{
  await pool.query(`INSERT INTO suco_llm_usage(id,account_id,request_id,month_key,day_key,state) VALUES ('u1','personal','r1',to_char(now() AT TIME ZONE 'UTC','YYYY-MM'),to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD'),'committed'),('u2','personal','r2',to_char(now() AT TIME ZONE 'UTC','YYYY-MM'),to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD'),'unknown'),('u3','personal','r3',to_char(now() AT TIME ZONE 'UTC','YYYY-MM'),to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD'),'released')`);
  const response=await app.request('/api/usage',{headers});assert.equal(response.status,200);const u=await response.json();assert.equal(u.available,true);assert.equal(u.monthlyUsed,2);assert.equal(u.dailyUsed,2);assert.equal(u.monitoredUsed,2);assert.equal(u.monitoredLimit,2);assert.equal(u.monthlyLimit,2);assert.equal(u.dailyLimit,2);assert.equal(u.timezone,'UTC');
 });
 await t.test('actual PgLedger usage refusal is429 with safe explanation and zero provider calls',async()=>{
  let providerCalls=0;const original=globalThis.fetch;globalThis.fetch=async()=>{providerCalls++;throw Error('NO_MODEL_CALL_ALLOWED');};
  try{await assert.rejects(callCloudLLM('Synthetic limit test'),(e:unknown)=>{const error=e as Error&{status:number};assert.equal(error.status,429);assert.match(error.message,/limite de análises/);assert.doesNotMatch(error.message,/USAGE_LIMIT_REACHED|synthetic-no-provider/);return true;});assert.equal(providerCalls,0);}finally{globalThis.fetch=original;}
 });
});
