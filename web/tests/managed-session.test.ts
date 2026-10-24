import test from 'node:test';
import assert from 'node:assert/strict';
import {api,registerSessionResolver,clearToken,setToken,MANAGED_SESSION_KEY} from '../src/lib/api.ts';
// Local origins only: validateApiUrl approves localhost page -> localhost API
// without any pin, so this suite runs free of operator-specific domains.
const origin='http://127.0.0.1:8377';
const originalFetch=globalThis.fetch;
let storage:Map<string,string>;let calls:{url:string;authorization:string}[];
function scope(tenantId='synthetic-tenant',expiresAt=Date.now()-1000){storage.set(MANAGED_SESSION_KEY,JSON.stringify({tenantId,expiresAt}));}
test.beforeEach(()=>{
 storage=new Map([['wzp_api_url',origin]]);calls=[];
 Object.assign(globalThis,{localStorage:{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)},window:{location:{hostname:'127.0.0.1',pathname:'/onboarding',href:''}}});
 registerSessionResolver(null);globalThis.fetch=async(url,options)=>{calls.push({url:String(url),authorization:(options?.headers as Record<string,string>).Authorization});return new Response(JSON.stringify({connected:false,readOnly:true}),{status:200,headers:{'content-type':'application/json'}});};
});
test.afterEach(()=>{clearToken();registerSessionResolver(null);globalThis.fetch=originalFetch;});
test('reload waits for native auth and sends only the renewed tenant bearer',async()=>{
 scope();setToken('synthetic-expired');const pending=api.status();await Promise.resolve();assert.equal(calls.length,0);
 registerSessionResolver(async()=>{setToken('synthetic-renewed');scope('synthetic-tenant',Date.now()+300000);return 'synthetic-renewed';});
 await pending;assert.deepEqual(calls,[{url:origin+'/api/status',authorization:'Bearer synthetic-renewed'}]);
});
test('a stale StrictMode resolver is not retained between cleanup and registration',async()=>{
 scope();setToken('synthetic-expired');const pending=api.status();
 registerSessionResolver(async()=>{throw Error('STALE_RESOLVER');});registerSessionResolver(null);
 registerSessionResolver(async()=>{setToken('synthetic-active');scope('synthetic-tenant',Date.now()+300000);return 'synthetic-active';});
 await pending;assert.equal(calls[0].authorization,'Bearer synthetic-active');
});
test('logout cancels pending native restoration without any API request',async()=>{
 scope();setToken('synthetic-expired');const pending=api.status();const rejected=assert.rejects(pending,/Entre novamente/);clearToken();await rejected;assert.equal(calls.length,0);
});
test('account or API-origin change during restoration never leaks the next bearer to the old scope',async()=>{
 for(const change of ['account','origin']){
  storage.set('wzp_api_url',origin);scope();setToken('synthetic-expired');registerSessionResolver(null);const pending=api.status();const rejected=assert.rejects(pending,/espaço mudou/);
  if(change==='account')scope('another-synthetic-tenant');else storage.set('wzp_api_url','http://127.0.0.1:8378');
  registerSessionResolver(async()=>{throw Error('MUST_NOT_RENEW_WRONG_SCOPE');});await rejected;
 }
 assert.equal(calls.length,0);
});
test('logout while renewal is in flight prevents a late token from being sent',async()=>{
 scope();setToken('synthetic-expired');let finish!:(value:string)=>void;let entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve);
 registerSessionResolver(async()=>{entered();return new Promise<string>(resolve=>finish=resolve);});
 const pending=api.status();const rejected=assert.rejects(pending,/sessão mudou/);await started;clearToken();finish('synthetic-late');await rejected;assert.equal(calls.length,0);
});
test('missing native restoration times out without sending an expired bearer',async(t)=>{
 t.mock.timers.enable({apis:['setTimeout']});scope();setToken('synthetic-expired');const pending=api.status();const rejected=assert.rejects(pending,/Entre novamente/);t.mock.timers.tick(10000);await rejected;assert.equal(calls.length,0);
});
test('legacy sessions remain usable and corrupt managed metadata fails closed',async()=>{
 setToken('synthetic-legacy');await api.status();assert.equal(calls[0].authorization,'Bearer synthetic-legacy');calls=[];
 storage.set(MANAGED_SESSION_KEY,'broken-json');await assert.rejects(api.status());assert.equal(calls.length,0);
});
