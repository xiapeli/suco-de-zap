import { GlmRuntime, createCallLLM } from './cloud-glm/client.js';
import { PgLedger, RuntimeError } from './cloud-glm/ledger.js';
import { pool } from './db.js';
import type { Pool } from 'pg';
import { authorizeTenant, tenantConfig, tenantAccess, tenantTrialUsage, advancedAiAllowed } from './tenant-context.js';

import { summaryAiPermitted, SummaryError } from './summary-workflow.js';

const numericLimit = (name:string, fallback:number, max:number) => {
  const value=Number(process.env[name] || fallback);
  if(!Number.isSafeInteger(value)||value<1||value>max) throw new Error('INVALID_LLM_LIMIT');
  return value;
};
export const cloudLimits = {
  monthly:numericLimit('SUCO_LLM_MONTHLY_LIMIT',300,1000),
  daily:numericLimit('SUCO_LLM_DAILY_LIMIT',30,100),
  monitored:numericLimit('SUCO_MONITORED_LIMIT',5,15),
};
const accountId=tenantConfig?.accountId || 'personal';
// Commercial bypass requires a bound SaaS tenant with a current central owner/partner grant.
// Legacy API-token mode keeps its configured provider budget.
const unlimitedCloudAccess=()=>!!tenantConfig&&tenantAccess()==='owner';
let call: ReturnType<typeof createCallLLM>|null=null;
export async function callCloudLLM(prompt:string, opts:{priority?:'high'|'medium'|'low'}={}) {
  if(!(await authorizeTenant())) throw new RuntimeError('Sua assinatura precisa ser verificada antes de processar novas análises.',402);
  if(!advancedAiAllowed()&&!summaryAiPermitted())throw new SummaryError('UPGRADE_REQUIRED',402);
  const keyFile=process.env.SUCO_GLM_REGULAR_KEY_FILE;
  if(!keyFile) throw new RuntimeError('Processamento em nuvem não configurado.');
  if(!call) call=createCallLLM(new GlmRuntime({keyFile,ledger:new PgLedger(pool),limits:{monthly:cloudLimits.monthly,daily:cloudLimits.daily,accountConcurrency:1,globalConcurrency:1},unmetered:unlimitedCloudAccess,timeoutMs:90_000,estimatePublishedCny:true}),accountId,'legacy');
  try { return await call(prompt,opts); }
  catch(error) {
    const code=error instanceof RuntimeError?error.code:'PROCESSING_UNAVAILABLE';
    const descriptions:Record<string,string>={USAGE_LIMIT_REACHED:'Você chegou ao limite de análises de hoje ou deste mês. Consulte seu uso; suas conversas salvas continuam disponíveis.',MONTHLY_LIMIT:'Você chegou ao limite de processamentos do mês. Suas conversas salvas continuam disponíveis.',DAILY_LIMIT:'Você chegou ao limite de processamentos de hoje. Tente novamente amanhã.',PROCESSING_BUSY:'Já existe uma análise em andamento. Aguarde ela terminar.',INVALID_INPUT:'Esse recorte é muito grande para uma análise. Escolha um período menor.',PROVIDER_OUTPUT_TRUNCATED:'O resumo não ficou completo. Escolha um período menor para uma nova análise.',PROVIDER_CONNECTION_UNCERTAIN:'Não conseguimos confirmar o resultado do processamento. Confira seus sucos antes de tentar novamente.'};
    const safe=new Error(descriptions[code] || 'O processamento não ficou pronto. Suas conversas foram preservadas. Tente novamente mais tarde.');
    (safe as Error & {status:number}).status=code==='USAGE_LIMIT_REACHED'?429:error instanceof RuntimeError?error.status:503;throw safe;
  }
}
export async function usageSnapshot() {
  const month=new Date().toISOString().slice(0,7),day=new Date().toISOString().slice(0,10);
  const r=await pool.query(`SELECT COUNT(*) FILTER (WHERE month_key=$2 AND state <> 'released')::int AS monthly,
    COUNT(*) FILTER (WHERE day_key=$3 AND state <> 'released')::int AS daily,
    (SELECT COUNT(*)::int FROM wa_chats WHERE tracked) AS monitored
    FROM suco_llm_usage WHERE account_id=$1`,[accountId,month,day]);
  return {access:tenantAccess(),unlimited:unlimitedCloudAccess(),trial:tenantTrialUsage(),period:month,timezone:'UTC',monthlyUsed:r.rows[0]?.monthly||0,dailyUsed:r.rows[0]?.daily||0,monthlyLimit:cloudLimits.monthly,dailyLimit:cloudLimits.daily,monitoredUsed:r.rows[0]?.monitored||0,monitoredLimit:cloudLimits.monitored};
}

/** Serialize admissions per tenant database. The same client owns lock/count/update/commit. */
export async function trackCloudChat(jid:string,archived:boolean|undefined,database:Pick<Pool,'connect'>=pool){
 const client=await database.connect();
 try{
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  await client.query("SET LOCAL lock_timeout = '3s'");
  await client.query("SET LOCAL statement_timeout = '5s'");
  await client.query('SELECT pg_advisory_xact_lock(1398096719, 1)');
  const existing=await client.query('SELECT tracked FROM wa_chats WHERE jid=$1 FOR UPDATE',[jid]);
  if(!existing.rowCount){await client.query('ROLLBACK');return null;}
  if(!existing.rows[0].tracked){
   const count=await client.query('SELECT COUNT(*)::int AS n FROM wa_chats WHERE tracked');
   if(!unlimitedCloudAccess()&&count.rows[0].n>=cloudLimits.monitored)throw new RuntimeError('MONITORED_LIMIT_REACHED',429);
  }
  const result=await client.query('UPDATE wa_chats SET tracked=true, archived=COALESCE($2::boolean, archived), updated_at=now() WHERE jid=$1 RETURNING *',[jid,archived??null]);
  await client.query('COMMIT');return result.rows[0]??null;
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
