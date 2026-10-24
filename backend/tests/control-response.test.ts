import test from 'node:test';
import assert from 'node:assert/strict';
import type {PoolClient} from 'pg';
import {readControlJson} from '../src/lib/control-response.js';
import {rollbackPreservingError} from '../src/lib/rollback.js';
import {TenantAuthorizer,verifyTenantToken} from '../src/tenant-access.js';
import {createHmac} from 'node:crypto';

test('control JSON accepts legitimate bounded data and rejects oversized CL, chunked and malformed data',async()=>{
 const signal=AbortSignal.timeout(1000);
 assert.deepEqual(await readControlJson(Response.json({allowed:true}),signal),{allowed:true});
 let cancelled=false;
 const large=new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'Content-Length':'65537'}});
 await assert.rejects(readControlJson(large,signal),/TOO_LARGE/);assert(cancelled);
 let chunksCancelled=false;
 const chunked=new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(32768));c.enqueue(new Uint8Array(32769));},cancel(){chunksCancelled=true;}}));
 await assert.rejects(readControlJson(chunked,signal),/TOO_LARGE/);assert(chunksCancelled);
 for(const raw of ['null','[]','true','invalid'])await assert.rejects(readControlJson(new Response(raw),signal));
});

test('control read timeout cancels a stalled stream even when mock stream ignores request abort',async()=>{
 const abort=new AbortController();let cancelled=false;
 const response=new Response(new ReadableStream({cancel(){cancelled=true;}}));
 const pending=readControlJson(response,abort.signal);abort.abort();
 await assert.rejects(pending,/TIMEOUT/);assert(cancelled);
});

test('oversized control response never grants entitlement',async()=>{
 const cfg={tenantId:'synthetic',accountId:'account',workerKey:'k'.repeat(64),controlUrl:'https://synthetic.convex.site'};
 const authorizer=new TenantAuthorizer(cfg,async()=>new Response('{"allowed":true,'+' '.repeat(65536)));
 assert.equal(await authorizer.allowed(),false);assert.equal(authorizer.currentlyAllowed(),false);assert.equal(authorizer.canIngest(),false);
});

test('secondary rollback errors preserve original identity and rollback is attempted exactly once',async()=>{
 const original=Error('synthetic operation failed');let queries:string[]=[];
 const client={query:async(sql:string)=>{queries.push(sql);throw Error('secondary rollback failed');}} as unknown as PoolClient;
 await assert.rejects(rollbackPreservingError(client,original),error=>error===original);assert.deepEqual(queries,['ROLLBACK']);
});

test('signed bearer token remains reusable throughout its existing five-minute lifetime',()=>{
 const now=1780000000000,cfg={tenantId:'synthetic',accountId:'account',workerKey:'k'.repeat(64),controlUrl:'https://synthetic.convex.site'};
 const payload={tenantId:cfg.tenantId,accountId:cfg.accountId,scope:'tenant',nonce:'n'.repeat(32),expMs:now+300000};
 const encoded=Buffer.from(JSON.stringify(payload)).toString('base64url'),token='suco.v1.'+encoded+'.'+createHmac('sha256',cfg.workerKey).update('suco-session-v1.'+encoded).digest('hex');
 assert.deepEqual(verifyTenantToken(token,cfg,now),payload);assert.deepEqual(verifyTenantToken(token,cfg,now+1),payload);assert.deepEqual(verifyTenantToken(token,cfg,now+299999),payload);assert.throws(()=>verifyTenantToken(token,cfg,now+300000));
});
