import type { Pool, PoolClient } from 'pg';
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS suco_llm_mutex (id text PRIMARY KEY);
INSERT INTO suco_llm_mutex(id) VALUES ('regular-bigmodel') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS suco_llm_usage (
 id text PRIMARY KEY, account_id text NOT NULL, request_id text NOT NULL,
 month_key text NOT NULL, day_key text NOT NULL,
 state text NOT NULL CHECK (state IN ('reserved','unknown','committed','released')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 active_until timestamptz NOT NULL DEFAULT (now()+interval '10 minutes'),
 model text, prompt_tokens integer, completion_tokens integer, total_tokens integer,
 estimated_cny numeric, price_source text, outcome text,
 UNIQUE(account_id,request_id)
);
ALTER TABLE suco_llm_usage ADD COLUMN IF NOT EXISTS active_until timestamptz NOT NULL DEFAULT (now()+interval '10 minutes');
CREATE INDEX IF NOT EXISTS suco_llm_account_month ON suco_llm_usage(account_id,month_key,state);
CREATE INDEX IF NOT EXISTS suco_llm_account_day ON suco_llm_usage(account_id,day_key,state);
CREATE INDEX IF NOT EXISTS suco_llm_active ON suco_llm_usage(state,active_until);
`;
export class RuntimeError extends Error {
 constructor(public readonly code: string, public readonly status = 503) { super(code); this.name='RuntimeError'; }
}
export interface Limits { monthly: number; daily: number; accountConcurrency: number; globalConcurrency: number; unmetered?:boolean }
export interface Usage { model: string; promptTokens: number; completionTokens: number; totalTokens: number; estimatedCny?: number; priceSource?: string }
export interface Ledger {
 reserve(accountId: string, requestId: string, limits: Limits, activeLeaseMs?: number): Promise<string>;
 settle(id: string, state: 'committed'|'released'|'unknown', outcome: string, usage?: Usage): Promise<void>;
}
export class PgLedger implements Ledger {
 /** Inject clock only for deterministic tests; production uses PostgreSQL time. */
 constructor(private readonly pool: Pool,private readonly clock?:()=>Date) {}
 private async transaction<T>(work: (client: PoolClient)=>Promise<T>):Promise<T>{
  const client=await this.pool.connect();
  try { await client.query('BEGIN'); await client.query("SET LOCAL lock_timeout = '3s'"); await client.query("SET LOCAL statement_timeout = '5s'");
   const lock=await client.query("SELECT id FROM suco_llm_mutex WHERE id='regular-bigmodel' FOR UPDATE");
   if(lock.rowCount!==1)throw new RuntimeError("LEDGER_SCHEMA_REQUIRED");
   const value=await work(client);await client.query('COMMIT');return value;
  } catch(error) { await client.query('ROLLBACK').catch(()=>{}); if(error instanceof RuntimeError)throw error;throw new RuntimeError('LEDGER_UNAVAILABLE'); }
  finally {client.release();}
 }
 async reserve(accountId:string,requestId:string,limits:Limits,activeLeaseMs=210000):Promise<string>{
  if(!/^[\w:@.-]{1,160}$/.test(accountId)||!/^[\w:.-]{1,160}$/.test(requestId))throw new RuntimeError('INVALID_REQUEST_ID',400);
  if([limits.monthly,limits.daily,limits.accountConcurrency,limits.globalConcurrency].some(x=>!Number.isSafeInteger(x)||x<1)||(limits.unmetered!==undefined&&typeof limits.unmetered!=='boolean'))throw new RuntimeError('INVALID_LIMIT_CONFIG');
  if(!Number.isSafeInteger(activeLeaseMs)||activeLeaseMs<1000||activeLeaseMs>600000)throw new RuntimeError('INVALID_LEASE_CONFIG');
  return this.transaction(async c=>{
   const existing=await c.query('SELECT id FROM suco_llm_usage WHERE account_id=$1 AND request_id=$2',[accountId,requestId]);
   if(existing.rowCount)throw new RuntimeError('REQUEST_ALREADY_USED',409);
   // PostgreSQL clock defines UTC quota boundaries consistently across workers.
   const at=this.clock?.()??(await c.query('SELECT now() AS at')).rows[0].at;
   if(!(at instanceof Date)||!Number.isFinite(at.getTime()))throw new RuntimeError('INVALID_CLOCK');
   const keys=(await c.query("SELECT to_char($1::timestamptz AT TIME ZONE 'UTC','YYYY-MM') month_key,to_char($1::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD') day_key",[at])).rows[0];
   const counts=(await c.query(`SELECT count(*) FILTER (WHERE account_id=$1 AND month_key=$2 AND state<>'released')::int monthly,
    count(*) FILTER (WHERE account_id=$1 AND day_key=$3 AND state<>'released')::int daily,
    count(*) FILTER (WHERE account_id=$1 AND state IN ('reserved','unknown') AND active_until>$4)::int account_active,
    count(*) FILTER (WHERE state IN ('reserved','unknown') AND active_until>$4)::int global_active FROM suco_llm_usage`,[accountId,keys.month_key,keys.day_key,at])).rows[0];
   if(limits.unmetered!==true&&(counts.monthly>=limits.monthly||counts.daily>=limits.daily))throw new RuntimeError('USAGE_LIMIT_REACHED',429);
   if(counts.account_active>=limits.accountConcurrency||counts.global_active>=limits.globalConcurrency)throw new RuntimeError('PROCESSING_BUSY',429);
   const id=crypto.randomUUID();
   await c.query('INSERT INTO suco_llm_usage(id,account_id,request_id,month_key,day_key,state,active_until) VALUES($1,$2,$3,$4,$5,\'reserved\',$6)',[id,accountId,requestId,keys.month_key,keys.day_key,new Date(at.getTime()+activeLeaseMs)]);return id;
  });
 }
 async settle(id:string,state:'committed'|'released'|'unknown',outcome:string,usage?:Usage):Promise<void>{
  await this.transaction(async c=>{
   // Repeated settlement is a no-op; only unresolved reservations can transition.
   await c.query(`UPDATE suco_llm_usage SET state=$2,outcome=$3,model=$4,prompt_tokens=$5,completion_tokens=$6,total_tokens=$7,
    estimated_cny=$8,price_source=$9,updated_at=now() WHERE id=$1 AND (state='reserved' OR (state='unknown' AND $2='committed'))`,
    [id,state,outcome,usage?.model??null,usage?.promptTokens??null,usage?.completionTokens??null,usage?.totalTokens??null,usage?.estimatedCny??null,usage?.priceSource??null]);
  });
 }
}
