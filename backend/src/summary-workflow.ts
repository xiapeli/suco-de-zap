import {AsyncLocalStorage}from'node:async_hooks';
import {createHash,createHmac,randomUUID}from'node:crypto';
import type{Pool,PoolClient}from'pg';
import type{TenantConfig}from'./tenant-access.js';
import {readControlJson}from'./lib/control-response.js';
export const SUMMARY_REQUEST_SCHEMA=`CREATE TABLE IF NOT EXISTS suco_summary_requests (
 request_id text PRIMARY KEY,fingerprint text NOT NULL,summary_id uuid NOT NULL UNIQUE,reservation_id text,
 phase text NOT NULL CHECK(phase IN ('created','reserved','persisted','committed','failed','release_pending')),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);`;
const permit=new AsyncLocalStorage<boolean>();
export function summaryAiPermitted(){return permit.getStore()===true;}
export class SummaryError extends Error{constructor(public code:string,public status:number,public requestId?:string,public summaryId?:string){super(code);}}
export interface RequestRecord{request_id:string;fingerprint:string;summary_id:string;reservation_id:string|null;phase:string;}
export interface SummaryStore {
 locked<T>(requestId:string,work:()=>Promise<T>):Promise<T>;
 ensure(requestId:string,fingerprint:string):Promise<RequestRecord>;
 summary(id:string):Promise<any|null>;
 mark(id:string,phase:string,reservationId?:string|null):Promise<void>;
}
export interface TrialControl {
 reserve(requestId:string,summaryId:string):Promise<{allowed:boolean;state:string;reservationId:string|null;summaryId:string}>;
 commit(requestId:string,reservationId:string,summaryId:string):Promise<unknown>;
 release(requestId:string,reservationId:string):Promise<unknown>;
}
export class SqlSummaryStore implements SummaryStore{
 private client=new AsyncLocalStorage<PoolClient>();
 constructor(private pool:Pool){}
 private get db(){return this.client.getStore()??this.pool;}
 async locked<T>(id:string,work:()=>Promise<T>){const client=await this.pool.connect();const hash=createHash('sha256').update('suco-summary:'+id).digest();const keys=[hash.readInt32BE(0),hash.readInt32BE(4)];let held=false,destroy=false;try{const r=await client.query('SELECT pg_try_advisory_lock($1,$2) AS held',keys);held=r.rows[0].held===true;if(!held)throw new SummaryError('SUMMARY_REQUEST_BUSY',409,id);return await this.client.run(client,work);}finally{if(held)try{await client.query('SELECT pg_advisory_unlock($1,$2)',keys);}catch{destroy=true;}client.release(destroy);}}
 async ensure(id:string,fingerprint:string){await this.db.query("INSERT INTO suco_summary_requests(request_id,fingerprint,summary_id,phase) VALUES($1,$2,$3,'created') ON CONFLICT(request_id) DO NOTHING",[id,fingerprint,randomUUID()]);const r=await this.db.query<RequestRecord>('SELECT * FROM suco_summary_requests WHERE request_id=$1',[id]);if(r.rows[0]?.fingerprint!==fingerprint)throw new SummaryError('SUMMARY_REQUEST_CHANGED',409,id);return r.rows[0];}
 async summary(id:string){const r=await this.db.query('SELECT * FROM summaries WHERE id=$1',[id]);return r.rows[0]??null;}
 async mark(id:string,phase:string,reservationId?:string|null){await this.db.query('UPDATE suco_summary_requests SET phase=$2,reservation_id=COALESCE($3,reservation_id),updated_at=now() WHERE request_id=$1',[id,phase,reservationId??null]);}
}
export class SignedTrialControl implements TrialControl{
 constructor(private config:TenantConfig,private fetcher:typeof fetch=fetch,private now:()=>number=Date.now){}
 private async post(action:string,values:object){
  const path='/worker/trial/'+action,stamp=String(this.now()),body=JSON.stringify({tenantId:this.config.tenantId,...values});
  const signature=createHmac('sha256',this.config.workerKey).update(`${stamp}.${path}.${body}`).digest('hex');
  const signal=AbortSignal.timeout(5000);let r:Response;
  try{r=await this.fetcher(this.config.controlUrl.replace(/\/$/,'')+path,{method:'POST',headers:{'content-type':'application/json','x-suco-timestamp':stamp,'x-suco-signature':signature},body,signal,redirect:'error'});}
  catch{throw new SummaryError('TRIAL_VERIFICATION_UNAVAILABLE',503);}
  if(!r.ok){void r.body?.cancel().catch(()=>{});throw new SummaryError(r.status===409?'SUMMARY_REQUEST_ALREADY_USED':'TRIAL_VERIFICATION_UNAVAILABLE',r.status===409?409:503);}
  try{return await readControlJson(r,signal) as Record<string,unknown>;}
  catch{throw new SummaryError('TRIAL_VERIFICATION_UNAVAILABLE',503);}
 }
 async reserve(requestId:string,summaryId:string){
  const r=await this.post('reserve',{requestId,summaryId})as{allowed:boolean;state:string;access:string;reservationId:string|null;summaryId:string};
  const validReservation=r.reservationId===null||(typeof r.reservationId==='string'&&r.reservationId.length>0&&r.reservationId.length<=160);
  const unmetered=r.access==='owner'||r.access==='paid';
  if(r.summaryId!==summaryId||!['reserved','committed','released','denied'].includes(r.state)||!['owner','paid','trial','trial_exhausted'].includes(r.access)||typeof r.allowed!=='boolean'||!validReservation||(r.allowed&&(r.state!=='reserved'||(!r.reservationId&&!unmetered)))||(r.state==='denied'&&r.reservationId!==null))throw new SummaryError('TRIAL_VERIFICATION_UNAVAILABLE',503);
  return r;
 }
 async commit(requestId:string,reservationId:string,summaryId:string){const r=await this.post('commit',{requestId,reservationId,summaryId});if(r.state!=='committed')throw new SummaryError('TRIAL_VERIFICATION_UNAVAILABLE',503);return r;}
 async release(requestId:string,reservationId:string){const r=await this.post('release',{requestId,reservationId});if(r.state!=='released')throw new SummaryError('TRIAL_VERIFICATION_UNAVAILABLE',503);return r;}
}
async function confirm(operation:()=>Promise<unknown>){try{return await operation();}catch{return operation();}}
/** Provider is single-shot. Only idempotent control-plane commit/release may retry. */
export async function runSummaryWorkflow<T>(o:{requestId:string;fingerprint:string;store:SummaryStore;control:TrialControl;process:()=>Promise<T>;persist:(value:T,id:string)=>Promise<any>}){
 if(!/^[A-Za-z0-9:_-]{8,128}$/.test(o.requestId))throw new SummaryError('INVALID_SUMMARY_REQUEST',400);
 return o.store.locked(o.requestId,async()=>{
  const row=await o.store.ensure(o.requestId,o.fingerprint);
  const finish=async(saved:any)=>{if(row.reservation_id)try{await confirm(()=>o.control.commit(o.requestId,row.reservation_id!,row.summary_id));}catch{throw new SummaryError('TRIAL_COMMIT_PENDING',503,o.requestId,row.summary_id);}await o.store.mark(o.requestId,'committed');return saved;};
  const saved=await o.store.summary(row.summary_id);if(saved)return row.phase==='committed'?saved:finish(saved);
  if(row.phase==='release_pending'){try{if(row.reservation_id)await confirm(()=>o.control.release(o.requestId,row.reservation_id!));await o.store.mark(o.requestId,'failed');}catch{throw new SummaryError('TRIAL_RELEASE_PENDING',503,o.requestId);}throw new SummaryError('SUMMARY_REQUEST_FAILED',409,o.requestId);}
  if(row.phase==='failed'||row.phase==='committed')throw new SummaryError('SUMMARY_REQUEST_ALREADY_USED',409,o.requestId);
  if(row.phase!=='created')throw new SummaryError('SUMMARY_REQUEST_PENDING',409,o.requestId,row.summary_id);
  const reservation=await o.control.reserve(o.requestId,row.summary_id);
  if(!reservation.allowed||reservation.state!=='reserved')throw new SummaryError('TRIAL_EXHAUSTED',402,o.requestId);
  row.reservation_id=reservation.reservationId;await o.store.mark(o.requestId,'reserved',row.reservation_id);
  let value:T;
  try{value=await permit.run(true,o.process);}catch(error){
   await o.store.mark(o.requestId,'release_pending');try{if(row.reservation_id)await confirm(()=>o.control.release(o.requestId,row.reservation_id!));await o.store.mark(o.requestId,'failed');}catch{throw new SummaryError('TRIAL_RELEASE_PENDING',503,o.requestId);}throw error;
  }
  let result:any;try{result=await o.persist(value,row.summary_id);}catch{throw new SummaryError('TRIAL_PERSIST_PENDING',503,o.requestId,row.summary_id);}
  if(!result||result.id!==row.summary_id)throw new SummaryError('TRIAL_PERSIST_PENDING',503,o.requestId,row.summary_id);
  await o.store.mark(o.requestId,'persisted');return finish(result);
 });
}
/** Durable recovery retries ONLY commit/refund; never reruns provider or refunds uncertain persistence. */
export async function reconcileTrialSummaries(pool:Pool,control:TrialControl){
 const rows=await pool.query<RequestRecord>("SELECT * FROM suco_summary_requests WHERE phase IN ('reserved','persisted','release_pending') AND reservation_id IS NOT NULL ORDER BY created_at LIMIT 3");
 const store=new SqlSummaryStore(pool);
 await Promise.all(rows.rows.map(row=>store.locked(row.request_id,async()=>{
  const saved=await store.summary(row.summary_id);
  if(saved){await confirm(()=>control.commit(row.request_id,row.reservation_id!,row.summary_id));await store.mark(row.request_id,'committed');}
  else if(row.phase==='release_pending'){await confirm(()=>control.release(row.request_id,row.reservation_id!));await store.mark(row.request_id,'failed');}
 }).catch(()=>{})));
}
