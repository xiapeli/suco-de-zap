import test from 'node:test';
import assert from 'node:assert/strict';
import { SignedTrialControl } from '../src/summary-workflow.js';

const config = {tenantId:'synthetic-tenant',accountId:'synthetic-account',workerKey:'k'.repeat(64),controlUrl:'https://synthetic.convex.site'};
const summaryId = '123e4567-e89b-42d3-a456-426614174000';
const requestId = 'synthetic-request';
const reserved = {allowed:true,state:'reserved',access:'trial',reservationId:'synthetic-reservation',summaryId};
const unavailable = (error:unknown) => error instanceof Error && error.message === 'TRIAL_VERIFICATION_UNAVAILABLE';

test('legitimate trial, owner, paid and denied responses preserve their access rules', async()=>{
  for (const body of [reserved, {...reserved,access:'owner',reservationId:null}, {...reserved,access:'paid',reservationId:null}, {...reserved,allowed:false}, {...reserved,allowed:false,state:'committed'}, {...reserved,allowed:false,state:'released'}, {...reserved,allowed:false,state:'denied',reservationId:null,access:'trial_exhausted'}]) {
    const client = new SignedTrialControl(config, async()=>Response.json(body));
    assert.equal((await client.reserve(requestId, summaryId)).allowed,body.allowed);
  }
});

test('invalid trial response cannot grant provider work or masquerade as exhausted credit', async()=>{
  for (const body of [null, [], {...reserved,reservationId:null}, {...reserved,reservationId:''}, {...reserved,access:'administrator'}, {...reserved,access:undefined}, {...reserved,state:'denied'}, {...reserved,summaryId:'other-summary'}, {...reserved,state:'committed'}, {...reserved,state:'released'}]) {
    const client = new SignedTrialControl(config, async()=>Response.json(body));
    await assert.rejects(client.reserve(requestId,summaryId),unavailable);
  }
});

test('signed control POST forbids redirects and uses one timeout for headers and body',async()=>{
  const client = new SignedTrialControl(config,async(url,options)=>{
    assert.equal(String(url),config.controlUrl+'/worker/trial/reserve');
    assert.equal(options?.redirect,'error');
    assert(options?.signal instanceof AbortSignal);
    return Response.json(reserved);
  });
  assert.equal((await client.reserve(requestId,summaryId)).allowed,true);
});

test('commit and refund need the exact acknowledgment state', async()=>{
  for (const operation of ['commit','release'] as const) {
    const invoke = (client:SignedTrialControl) => operation === 'commit'
      ? client.commit(requestId,'synthetic-reservation',summaryId)
      : client.release(requestId,'synthetic-reservation');
    const state = operation === 'commit' ? 'committed' : 'released';
    const correct = new SignedTrialControl(config,async()=>Response.json({state}));
    assert.equal((await invoke(correct) as {state:string}).state,state);
    for (const body of [{}, {ok:true}, {state:state === 'committed'?'released':'committed'}, null, []]) {
      await assert.rejects(invoke(new SignedTrialControl(config,async()=>Response.json(body))),unavailable);
    }
  }
});

test('oversized and malformed control responses fail before granting a trial',async()=>{
  for (const create of [
    ()=>new Response(' '.repeat(65537)),
    ()=>new Response('ignored',{headers:{'Content-Length':'65537'}}),
    ()=>new Response('invalid-json'),
    ()=>new Response(new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array(32768));c.enqueue(new Uint8Array(32769));c.close();}})),
  ]) {
    await assert.rejects(new SignedTrialControl(config,async()=>create()).reserve(requestId,summaryId),unavailable);
  }
});

test('a stalled response body is cancelled at the same request deadline',async(t)=>{
  const abort=new AbortController();let cancelled=false;
  t.mock.method(AbortSignal,'timeout',()=>abort.signal);
  const client=new SignedTrialControl(config,async()=>new Response(new ReadableStream({cancel(){cancelled=true;}})));
  const timer=setTimeout(()=>abort.abort(),5);
  try{await assert.rejects(client.reserve(requestId,summaryId),unavailable);assert.equal(cancelled,true);}
  finally{clearTimeout(timer);}
});

test('HTTP conflicts retain their idempotency error, provider failures hide remote text',async()=>{
  const conflict=new SignedTrialControl(config,async()=>new Response('private remote text',{status:409}));
  await assert.rejects(conflict.reserve(requestId,summaryId),error=>error instanceof Error && error.message==='SUMMARY_REQUEST_ALREADY_USED');
  const failure=new SignedTrialControl(config,async()=>new Response('private remote text',{status:503}));
  await assert.rejects(failure.reserve(requestId,summaryId),unavailable);
});
