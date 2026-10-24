import test from 'node:test';
import assert from 'node:assert/strict';
import {jsonObject,validQueryInputs,validSummaryInput,safeErrorCode} from '../src/lib/request-validation.js';
process.env.API_TOKEN='synthetic-security-token';
process.env.DATABASE_URL='postgres://nobody:nopass@127.0.0.1:1/synthetic';
process.env.OPENAI_COMPAT_URL='';process.env.ANTHROPIC_API_KEY='';
const {app}=await import('../src/api.js');
const {pool}=await import('../src/db.js');
const auth={Authorization:'Bearer synthetic-security-token'};

test('request validators reject primitive JSON, unbounded pagination and invalid summary values',()=>{
 for(const value of [null,[],true,1,'x'])assert(!jsonObject(value));
 assert(jsonObject({}));
 for(const query of [{limit:'-1'},{limit:'NaN'},{limit:'5001'},{limit:'0'},{offset:'Infinity'},{offset:'1.2'},{offset:'1000001'},{q:'x'.repeat(501)},{start:'not-a-date'},{start:'2026-10-15',end:'2026-10-01'}])assert(!validQueryInputs(query));
 assert(validQueryInputs({limit:'500',offset:'10',start:'2026-10-01',end:'2026-10-15'}));
 const good={chat_jid:'synthetic@g.us',start:'2026-10-01T00:00:00Z',end:'2026-10-15T00:00:00Z',analysis_type:'general',base_prompt:'Synthetic'};
 assert(validSummaryInput(good));
 for(const patch of [{chat_jid:{}},{start:'invalid'},{end:'2025-01-01'},{analysis_type:[]},{base_prompt:{malicious:true}},{base_prompt:'x'.repeat(24001)},{title:'x'.repeat(301)},{request_id:'x'.repeat(129)}])assert(!validSummaryInput({...good,...patch}));
 assert.equal(safeErrorCode({code:'23505',detail:'private'}),'INTERNAL_ERROR');
 assert.equal(safeErrorCode({code:'PRIVATE data'}),'INTERNAL_ERROR');
 assert.equal(safeErrorCode({code:'TRIAL_EXHAUSTED'}),'TRIAL_EXHAUSTED');
});

test('authenticated malformed requests are rejected before database work',async()=>{
 const original=pool.query;let touched=false;
 pool.query=(async()=>{touched=true;throw new Error('must never query')}) as typeof pool.query;
 try{
  for(const value of [null,[],1,'primitive']){
   const r=await app.request('/api/chats/synthetic',{method:'PATCH',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify(value)});assert.equal(r.status,400);
  }
  for(const path of ['/api/chats?limit=-1','/api/summaries?offset=NaN','/api/digests?offset=1000001','/api/chats/synthetic/messages?start=bad','/api/chats/synthetic/stats?start=2026-10-15&end=2026-10-01'])assert.equal((await app.request(path,{headers:auth})).status,400);
  assert(!touched);
 }finally{pool.query=original;}
});

test('API failures hide SQL/provider payloads and security headers apply on errors',async()=>{
 const original=pool.query,logger=console.error;const logged:unknown[][]=[];
 pool.query=(async()=>{throw Object.assign(new Error('SYNTHETIC_PRIVATE_SQL_VALUE'),{detail:'SYNTHETIC_PRIVATE_PARAMETER',code:'23505'})}) as typeof pool.query;
 console.error=(...args)=>{logged.push(args)};
 try{
  const r=await app.request('/api/chats',{headers:auth});assert.equal(r.status,500);
  const text=await r.text();assert(!text.includes('SYNTHETIC_PRIVATE'));assert(!JSON.stringify(logged).includes('SYNTHETIC_PRIVATE'));
  assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('x-content-type-options'),'nosniff');assert.equal(r.headers.get('referrer-policy'),'no-referrer');
  const big=await app.request('/api/chats/synthetic',{method:'PATCH',headers:{...auth,'Content-Type':'application/json'},body:'x'.repeat(262145)});assert.equal(big.status,413);assert.equal(big.headers.get('cache-control'),'no-store');
 }finally{pool.query=original;console.error=logger;}
});
