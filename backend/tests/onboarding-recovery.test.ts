import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { onboardingRoutes } from '../src/onboarding.js';

function database(pending:unknown,fail=false) {
  const statements:string[]=[];
  const db={query:async(sql:string)=>{
    statements.push(sql);
    if(sql.includes('suco_summary_requests')) {
      if(fail)throw Error('synthetic-db-unavailable');
      return {rows:[{pending}]};
    }
    return {rows:[]};
  }} as unknown as Pick<Pool,'query'>;
  return {db,statements};
}

test('onboarding permits explicit local reset only after no unsettled durable request is confirmed',async()=>{
  const {db,statements}=database(false);
  const response=await onboardingRoutes(db).request('/');
  assert.equal(response.status,200);
  assert.deepEqual((await response.json()).recovery,{canRestart:true});
  const sql=statements.find(s=>s.includes('suco_summary_requests'))!;
  assert.match(sql,/NOT IN\s*\('failed',\s*'committed'\)/);
  assert(!/reservation_id\s+IS NOT NULL/i.test(sql),'owner and paid requests without a reservation must also block');
  assert(statements.every(s=>/^SELECT/.test(s)),'recovery inspection never changes requests or quota');
});

test('active owner, paid or trial requests and malformed state never permit local reset',async()=>{
  for(const pending of [true,undefined,null,'false',0]) {
    const {db}=database(pending);
    const response=await onboardingRoutes(db).request('/');
    assert.equal(response.status,200);
    assert.deepEqual((await response.json()).recovery,{canRestart:false});
  }
});

test('unavailable durable request state fails without claiming reset is safe',async()=>{
  const {db}=database(false,true);
  const routes=onboardingRoutes(db);
  routes.onError((_error,c)=>c.json({error:'unavailable'},503));
  const response=await routes.request('/');
  assert.equal(response.status,503);
  assert.equal((await response.json()).recovery,undefined);
});
