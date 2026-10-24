import { safeErrorCode } from './lib/request-validation.js';
import { serve } from '@hono/node-server';
import { config } from './config.js';
import { initDb, pool } from './db.js';
import { startWhatsApp, pauseWhatsApp, getStatus, flushWhatsAppState } from './wa.js';
import { app } from './api.js';
import { startCron } from './cron.js';
import { tenantConfig, tenantAuthorizer, authorizeIngestion } from './tenant-context.js';
import {reconcileTrialSummaries,SignedTrialControl}from'./summary-workflow.js';
import { TenantKeeper } from './tenant-lifecycle.js';
import { resolve } from 'node:path';

async function main() {
  if (config.confidentialRuntime) throw new Error('CONFIDENTIAL_BOOTSTRAP_REQUIRED');
  console.log('🚀 WhatzApp Chronicles Server');
  // API PRIMEIRO: /health, /ready, /api/status (QR) e /api/connection/reconnect
  // respondem mesmo com Postgres/WhatsApp lentos ou fora do ar.
  serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    console.log(`🌐 API ouvindo em http://${config.host}:${info.port}`);
  });

  await initDb();
  console.log('🗄️  Postgres conectado e schema aplicado.');

  // WhatsApp em paralelo: o start interno (auth state + version fetch) pode
  // demorar/entrar em backoff — NÃO bloqueia a API nem o cron. Erros de
  // startup já viram estado explícito + retry cercado dentro do wa.ts.
  if(tenantConfig && tenantAuthorizer){
    const authorizer=tenantAuthorizer;const trialControl=new SignedTrialControl(tenantConfig);
    const keeper=new TenantKeeper({config:tenantConfig,directory:resolve(process.env.SUCO_WORKER_STATE_DIR||process.env.SUCO_STATE_DIR||config.authDir+'/worker-state'),allowed:authorizeIngestion,reconcile:()=>reconcileTrialSummaries(pool,trialControl),invalidate:()=>authorizer.invalidate(),start:startWhatsApp,pause:pauseWhatsApp,status:getStatus,firstSummary:async()=>{const r=await pool.query('SELECT EXISTS (SELECT 1 FROM summaries) AS ready');return r.rows[0]?.ready===true;}});
    keeper.start();
    for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void keeper.stop().then(flushWhatsAppState).finally(()=>process.exit(0));});
  }else void startWhatsApp();
  startCron();
}

main().catch((e) => {
  console.error('Erro fatal:', safeErrorCode(e));
  process.exit(1);
});
