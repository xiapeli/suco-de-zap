import { safeErrorCode } from './lib/request-validation.js';
import cron from 'node-cron';
import { tenantAllowed, authorizeTenant, cloudGlmConfigured, advancedAiAllowed } from './tenant-context.js';
import { createHash } from 'node:crypto';
import { config } from './config.js';
import { pool } from './db.js';
import { generateSummary, DEFAULT_DAILY_PROMPT } from './summarizer.js';
import { extractFacts } from './extractor.js';
import { generateDigest, yesterdayInTz } from './digest.js';
import { LlmReadiness } from './lib/llm-readiness.js';

// probe no /ready da llm-queue (LLM_READY_URL) com cache: cron não gasta rodada
// quando o LLM local está off, e não martela o endpoint a cada tarefa.
const llmReady = new LlmReadiness({
  baseUrl: config.openaiCompatUrl,
  readyUrl: config.llmReadyUrl || undefined,
  ttlMs: 60_000,
  timeoutMs: 2_000,
});

/** Identificador anônimo estável p/ logs — sem nome/JID (PII) no stderr. */
function anon(jid: string): string {
  return createHash('sha256').update(jid).digest('hex').slice(0, 8);
}

async function llmAvailable(): Promise<boolean> {
  if(!(await authorizeTenant()) || !tenantAllowed() || !advancedAiAllowed())return false;
  if(cloudGlmConfigured())return true;
  if (!config.openaiCompatUrl && !config.anthropicApiKey) return false;
  return (await llmReady.check()) === 'ok';
}

export function startCron() {
  if (!cron.validate(config.sucoCron)) {
    console.error(`⚠️ SUCO_CRON inválido: "${config.sucoCron}" — cron de sucos desativado.`);
  } else {
    cron.schedule(config.sucoCron, () => runDailySucos(), { timezone: config.timezone });
    console.log(`⏰ Suco automático agendado: "${config.sucoCron}" (${config.timezone})`);
  }

  if (cron.validate(config.digestCron)) {
    cron.schedule(
      config.digestCron,
      async () => {
        try {
          if (!(await llmAvailable())) {
            console.log('📰 LLM indisponível — digest de hoje pulado (sem gasto de cron).');
            return;
          }
          // roda na virada do dia gerando o dia que acabou (cobre a janela 21h-24h)
          const d = await generateDigest(yesterdayInTz());
          console.log(`📰 Digest do dia ${d.day} gerado.`);
        } catch (e: any) {
          console.error('📰 Falha no digest diário:', safeErrorCode(e));
        }
      },
      { timezone: config.timezone }
    );
    console.log(`⏰ Digest diário agendado: "${config.digestCron}" (${config.timezone})`);
  } else {
    console.error(`⚠️ DIGEST_CRON inválido: "${config.digestCron}" — digest desativado.`);
  }

  if (cloudGlmConfigured() && process.env.SUCO_ENABLE_AUTO_EXTRACTION!=='1') {
    console.log('Extração automática em nuvem desativada; extração manual disponível.');
  } else if (cron.validate(config.extractCron)) {
    cron.schedule(
      config.extractCron,
      async () => {
        try {
          if (!(await llmAvailable())) {
            console.log('🗂️ LLM indisponível — extração incremental pulada (sem gasto de cron).');
            return;
          }
          const r = await extractFacts();
          if (r.scanned) console.log(`🗂️ Extração: ${r.extracted} fatos de ${r.scanned} mensagens (${r.chats} chats).`);
          if (r.errors) console.error(`🗂️ Extração com falha parcial: ${r.errors} chat(s) preservados pra retry.`);
        } catch (e: any) {
          if (e.status !== 409) console.error('🗂️ Falha na extração incremental:', safeErrorCode(e));
        }
      },
      { timezone: config.timezone }
    );
    console.log(`⏰ Extração incremental agendada: "${config.extractCron}" (${config.timezone})`);
  } else {
    console.error(`⚠️ EXTRACT_CRON inválido: "${config.extractCron}" — extração desativada.`);
  }
}

export async function runDailySucos() {
  console.log('🧃 Rodando sucos automáticos...');
  if (!(await llmAvailable())) {
    console.log('🧃 LLM indisponível — sucos automáticos pulados (sem gasto de cron).');
    return;
  }
  const tracked = await pool.query('SELECT jid, name FROM wa_chats WHERE tracked AND NOT archived');
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);

  for (const chat of tracked.rows) {
    if(!(await authorizeTenant()) || !tenantAllowed() || !advancedAiAllowed())break;
    try {
      const count = await pool.query(
        'SELECT COUNT(*)::int AS n FROM wa_messages WHERE chat_jid = $1 AND ts >= $2 AND ts <= $3',
        [chat.jid, start, end]
      );
      if (count.rows[0].n < config.sucoMinMessages) {
        console.log(`  ⏭ chat ${anon(chat.jid)}: só ${count.rows[0].n} mensagens, pulando.`);
        continue;
      }
      const s = await generateSummary({
        chatJid: chat.jid,
        start,
        end,
        analysisType: 'daily_auto',
        basePrompt: DEFAULT_DAILY_PROMPT,
        auto: true,
      });
      console.log(`  ✅ Suco do chat ${anon(chat.jid)} gerado (id ${s.id}).`);
    } catch (e: any) {
      console.error(`  ❌ Falha no suco do chat ${anon(chat.jid)}:`, safeErrorCode(e));
    }
  }
  console.log('🧃 Sucos automáticos concluídos.');
}
