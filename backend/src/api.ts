import { meetingProposalRoutes } from './meeting-proposals.js';
import { personalJuiceRoutes, SqlPersonalJuiceStore } from './personal-juices.js';
import { Hono, type Context, type Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { jsonObject, validQueryInputs, validSummaryInput, safeErrorCode } from './lib/request-validation.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { pool, getIngestionCursor, getIngestionWriteHealth } from './db.js';
import { getStatus, getPendingIngestionCount, hasDurableIngestionSpool, logoutWhatsApp, reconnectWhatsApp, beginFreshPairing, resolveChatName, formatPhoneFromJid, confidentialModeEnabled, getConfidentialMessageStore, getConfidentialMetadataStore } from './wa.js';
import { privateChatViews, privateChatPage, privateMessagePage, privateChatStats } from './lib/confidential-conversations.js';
import { createConfidentialSearch, type PrivateSearchInput } from './lib/confidential-search.js';
import type { ConfidentialSummaryService, PrivateSummaryRequest } from './lib/confidential-summary-service.js';
import { generateSummary } from './summarizer.js';
import { getExtractionSettings, extractFacts, retagFacts, normalizeTags } from './extractor.js';
import { generateDigest, todayInTz } from './digest.js';
import { smartSearch } from './search.js';
import { LlmReadiness } from './lib/llm-readiness.js';
import { AiConcurrencyGate } from './lib/ai-gate.js';
import {
  buildCorsAllowlist,
  buildReadyReport,
  isBodyTooLarge,
  RateLimiter,
  renderReadyPublic,
  validateWaitlistInput,
} from './lib/http-guards.js';

import { tenantConfig, tenantAuthorizer, authorizeTenant, cloudGlmConfigured, tenantAccess, tenantTrialUsage, advancedAiAllowed, authorizeIngestion } from './tenant-context.js';
import { verifyTenantToken, manageRouteAllowed } from './tenant-access.js';
import { onboardingRoutes } from './onboarding.js';
import { createVaultSecurity } from './vault-security.js';
import { discoveryRoutes } from './discovery.js';
import { juiceCatalogMetadata } from './juice-catalog.js';
import { cloudLimits, trackCloudChat, usageSnapshot } from './cloud-runtime.js';

export const app = new Hono<{Variables:{tenantScope:'tenant'|'manage'}}>();

type ConfidentialApiAuthorizer = {
  ownerId: string;
  /** Verify signature, expiry and audience; return subject UUID only for a valid user JWT. */
  verifyBearerToken: (token: string) => Promise<string | null>;
};
let confidentialApiAuthorizer: ConfidentialApiAuthorizer | null = null;
let confidentialSummaryService: ConfidentialSummaryService | null = null;
export function installConfidentialSummaryService(service: ConfidentialSummaryService): void {
  if (!config.confidentialRuntime || confidentialSummaryService || !service ||
      typeof service.generate !== 'function' || typeof service.status !== 'function' ||
      typeof service.list !== 'function') throw Error('CONFIDENTIAL_SUMMARY_UNSAFE');
  confidentialSummaryService = service;
}
export function installConfidentialApiAuthorizer(authorizer: ConfidentialApiAuthorizer): void {
  if (!config.confidentialRuntime || confidentialApiAuthorizer ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(authorizer?.ownerId ?? '') ||
      typeof authorizer?.verifyBearerToken !== 'function') throw new Error('CONFIDENTIAL_API_AUTH_UNSAFE');
  confidentialApiAuthorizer = authorizer;
}
const privateMode = () => config.confidentialRuntime || confidentialModeEnabled();
const privateUnavailable = (c: Context) => c.json({ error: 'Este recurso ainda não está disponível no processamento privado.', code: 'CONFIDENTIAL_FEATURE_UNAVAILABLE' }, 503);
function chatJid(c: Context): string | null {
  try {
    const value = decodeURIComponent(c.req.param('jid') ?? '');
    return value.length > 0 && value.length <= 256 && !/[\u0000-\u001f/]/.test(value) ? value : null;
  } catch { return null; }
}

// ===== Cache-Control: no-store em TODA /api/* (status/QR/resumos são dinâmicos) =====
// Registrado ANTES dos outros middlewares: mesmo respostas curtadas
// (401/413/429/503) recebem o header, e nada de /api/* fica em cache intermediário.
app.use('/api/*', async (c, next) => {
  await next();
  c.res.headers.set('Cache-Control', 'no-store');
});

// ===== Limite de body: middleware OFICIAL do Hono (streaming) =====
// Conta BYTES lidos do stream (não UTF-16), corta a leitura no teto (memória
// bornada mesmo com chunked sem content-length) e vale para TODAS as rotas —
// sem ramo de bypass. Rotas públicas apertam o limite de novo (waitlist 16KB).
const MAX_API_BODY_BYTES = 256 * 1024; // teto global (rotas de API)
app.use(
  '*',
  bodyLimit({
    maxSize: MAX_API_BODY_BYTES,
    onError: (c) => c.json({ error: 'Corpo da requisição excede o limite' }, 413),
  })
);

app.onError((error,c)=>{ console.error('API request failed:',safeErrorCode(error)); return c.json({error:'Não foi possível concluir a operação.',code:'INTERNAL_ERROR'},500); });
app.use('*',async(c,next)=>{ c.header('X-Content-Type-Options','nosniff');c.header('Referrer-Policy','no-referrer');c.header('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");await next(); });
app.use('/site/*', async (c, next) => {
  if (privateMode()) return privateUnavailable(c);
  await next();
});

// ===== CORS allowlist (nada de cors() aberto) + barreira CSRF =====
const corsAllow = buildCorsAllowlist({ corsOrigins: config.corsOrigins, publicDomain: config.publicDomain });
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
app.use('*', async (c, next) => {
  const origin = c.req.header('Origin');
  if (origin) {
    if (corsAllow.allowed(origin)) {
      c.res.headers.set('Access-Control-Allow-Origin', origin);
      c.res.headers.set('Vary', 'Origin');
      c.res.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, X-Suco-Vault-Token');
      c.res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      c.res.headers.set('Access-Control-Max-Age', '600');
      if (c.req.method === 'OPTIONS') return c.body(null, 204);
    } else if (c.req.method === 'OPTIONS') {
      // preflight de origem não autorizada: recusado, sem vazar headers CORS
      return c.json({ error: 'Origin not allowed' }, 403);
    } else if (STATE_CHANGING.has(c.req.method)) {
      // Escrita de origem desconhecida NÃO age (CSRF): browser sempre manda
      // Origin em cross-origin; curl/servidor a servidor sem Origin passa.
      return c.json({ error: 'Origin not allowed' }, 403);
    }
    // GET de origem não autorizada segue SEM headers CORS:
    // o browser bloqueia a leitura da resposta (same-origin policy).
  }
  await next();
});

app.get('/health', (c) => c.json({ ok: true }));

// ===== /ready: PG + LLM (sem inferência, sem segredos) =====
// Probe no /ready da llm-queue quando LLM_READY_URL está configurado (a fila
// checa o upstream de verdade com TTL); senão GET /models direto. 503 da fila
// ou erro de rede = unreachable — o erro nunca é mascarado como ok.
const llmReady = new LlmReadiness({
  baseUrl: config.openaiCompatUrl,
  readyUrl: config.llmReadyUrl || undefined,
  ttlMs: 60_000,
  timeoutMs: 2_000,
});

/**
 * ===== Modelo de chaves de rate limit (trust boundary) =====
 * X-Forwarded-For/x-real-ip são FORJÁVEIS por qualquer cliente e nunca
 * identificam ninguém. Só o CF-Connecting-IP é aceito — e apenas quando
 * TRUST_CLOUDFLARE_PROXY=true E a conexão chegou por loopback (adapter/tunnel
 * na mesma máquina; o bind default é 127.0.0.1). Sem isso:
 * - rotas públicas (abuso): chave estática GLOBAL — limite bornado, 1 entrada;
 * - operações autenticadas: chave POR CONTA (token) — independente de IP.
 */
function isLoopbackRemote(c: Context): boolean {
  const incoming = (c.env as { incoming?: { remoteAddress?: string } } | undefined)?.incoming;
  const addr = incoming?.remoteAddress;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function trustedClientIp(c: Context): string | null {
  if (!config.trustCloudflareProxy) return null;
  if (!isLoopbackRemote(c)) return null; // confia só no transporte local (tunnel)
  const cf = c.req.header('cf-connecting-ip');
  return cf && cf.trim() ? cf.trim().slice(0, 64) : null;
}

/** Chave de abuso p/ rotas públicas: IP confiável do CF ou bucket global único. */
function abuseKey(c: Context, prefix: string): string {
  const ip = trustedClientIp(c);
  return ip ? `${prefix}:${ip}` : `${prefix}:global`;
}

app.get('/ready', async (c) => {
  if (privateMode()) {
    const ok = !!confidentialApiAuthorizer && !!getConfidentialMessageStore() && !!getConfidentialMetadataStore();
    return c.json({ ok }, ok ? 200 : 503, { 'Cache-Control': 'no-store' });
  }
  let postgres: 'ok' | 'fail' = 'fail';
  try {
    await pool.query('SELECT 1');
    postgres = 'ok';
  } catch {}
  const llm = cloudGlmConfigured() ? 'ok' : config.openaiCompatUrl
    ? await llmReady.check()
    : config.anthropicApiKey
      ? 'ok'
      : 'not_configured';
  const report = buildReadyReport({ postgres, llm });
  // detalhes só para quem apresenta o token; fora de auth, genérico.
  const authed = await authOk(c) && (!tenantConfig || await authorizeTenant());
  return c.json(authed ? report : renderReadyPublic(report), report.ok ? 200 : 503, {
    'Cache-Control': 'no-store',
  });
});

// ===== auth (constant-time) + rate limit de tentativas =====
// comparação constant-time (API exposta publicamente via tunnel): hash dos dois
// lados iguala os tamanhos, requisito do timingSafeEqual
const expectedAuth = createHash('sha256').update(`Bearer ${config.apiToken}`).digest();
async function authOk(c: Context): Promise<boolean> {
  if (privateMode()) {
    const bearer = c.req.header('Authorization');
    if (!confidentialApiAuthorizer || !bearer?.startsWith('Bearer ') || bearer.length > 8192) return false;
    try {
      const subject = await confidentialApiAuthorizer.verifyBearerToken(bearer.slice(7));
      if (!subject) return false;
      const expected = createHash('sha256').update(confidentialApiAuthorizer.ownerId).digest();
      const actual = createHash('sha256').update(subject).digest();
      return timingSafeEqual(actual, expected);
    } catch { return false; }
  }
  if(tenantConfig){if(!c.req.header('Authorization')?.startsWith('Bearer '))return false;try{verifyTenantToken((c.req.header('Authorization')||'').replace(/^Bearer /,''),tenantConfig);return true;}catch{return false;}}
  const got = createHash('sha256').update(c.req.header('Authorization') || '').digest();
  return timingSafeEqual(got, expectedAuth);
}

const authFailLimiter = new RateLimiter({ windowMs: 15 * 60_000, max: 30, maxKeys: 1024 });
app.use('/api/*', async (c, next) => {
  if (privateMode()) {
    if (await authOk(c)) return next();
    const d = authFailLimiter.check(abuseKey(c, 'auth'));
    return d.allowed ? c.json({ error: 'Unauthorized' }, 401)
      : c.json({ error: 'Too many attempts' }, 429, { 'Retry-After': String(Math.ceil(d.retryAfterMs / 1000)) });
  }
  if (tenantConfig && await authOk(c)) {
    let p;try{p=verifyTenantToken((c.req.header('Authorization')||'').slice(7),tenantConfig);}catch{return c.json({error:'Unauthorized'},401);}
    c.set('tenantScope',p.scope);
    if(p.scope==='manage'){
      if(!manageRouteAllowed(c.req.method,c.req.path))return c.json({error:'Escopo de gerenciamento não permite esta operação'},403);
      return next();
    }
    if(!(await authorizeTenant()))return c.json({error:'Assinatura ou autorização indisponível',code:'ENTITLEMENT_REQUIRED'},402);
    return next();
  }
  if (!tenantConfig && await authOk(c)) return next();
  const d = authFailLimiter.check(abuseKey(c, 'auth'));
  if (!d.allowed) {
    return c.json({ error: 'Too many attempts' }, 429, {
      'Retry-After': String(Math.ceil(d.retryAfterMs / 1000)),
    });
  }
  return c.json({ error: 'Unauthorized' }, 401);
});

app.use('/api/*', async(c,next)=>{if(!validQueryInputs(c.req.query()))return c.json({error:'Parâmetros inválidos.'},400);return next();});

// Confidential worker exposes only routes backed by its encrypted repositories.
// All other legacy routes are denied before their SQL/provider handlers run.
app.use('/api/*', async (c, next) => {
  if (!privateMode()) return next();
  const path = c.req.path;
  const read = c.req.method === 'GET' && (
    ['/api/status', '/api/dashboard', '/api/chats', '/api/usage', '/api/juice-catalog', '/api/summaries',
      '/api/private/personal-juices', '/api/digests'].includes(path) ||
    /^\/api\/summaries\/[0-9a-f-]{36}$/.test(path) ||
    /^\/api\/chats\/[^/]+\/(messages|stats|name)$/.test(path)
  );
  const connection = c.req.method === 'POST' &&
    ['/api/connection/reconnect', '/api/connection/new-pairing', '/api/logout', '/api/summaries/generate',
      '/api/search', '/api/digests/generate',
      '/api/private/summaries/delete',
      '/api/private/chats/tracking',
      '/api/private/personal-juices/save', '/api/private/personal-juices/archive'].includes(path);
  return read || connection ? next() : privateUnavailable(c);
});

app.route('/api/onboarding',onboardingRoutes(pool));
app.route('/api/discover', discoveryRoutes(pool));
app.get('/api/juice-catalog', c => c.json(juiceCatalogMetadata()));
app.route('/api/summaries',meetingProposalRoutes(pool,tenantConfig));
app.route('/api/personal-juices',personalJuiceRoutes(new SqlPersonalJuiceStore(pool),tenantConfig?.accountId||'personal'));

const vaultSecurity=createVaultSecurity({pool,tenantId:tenantConfig?.tenantId||'personal',accountId:tenantConfig?.accountId||'personal'});
app.route('/api/vault',vaultSecurity.routes);
app.use('/api/*',async(c,next)=>{
 const path=c.req.path;
 if(privateMode())return next();
 if(path==='/api/search'||path==='/api/facts'||path.startsWith('/api/facts/')){
  if(tenantConfig&&!advancedAiAllowed()&&(path==='/api/search'||['/api/facts/extract','/api/facts/retag'].includes(path)))return c.json({error:'A busca no Cofre está disponível na assinatura. Seus sucos salvos continuam disponíveis.',code:'UPGRADE_REQUIRED'},402);
  return vaultSecurity.guard(c,next);
 }
 return next();
});


// ===== limites de body =====
const MAX_WAITLIST_BYTES = 16 * 1024; // waitlist: payload mínimo

/**
 * Lê JSON contando BYTES (não unidades UTF-16 — emoji = 4 bytes / 2 units).
 * O teto global já foi imposto pelo bodyLimit (streaming); aqui rotas com
 * limite menor rejeitam de novo pelo content-length declarado e pelos bytes
 * reais do arrayBuffer. Body ilegível vira objeto vazio (validação pega).
 */
async function parseJsonBody<T>(
  c: Context,
  maxBytes: number
): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  const declared = c.req.header('content-length');
  if (isBodyTooLarge(declared, 0, maxBytes)) {
    return { ok: false, response: c.json({ error: 'Corpo da requisição excede o limite' }, 413) };
  }
  const buf = await c.req.arrayBuffer().catch(() => null);
  if (buf === null) return { ok: true, value: {} as T };
  if (isBodyTooLarge(declared, buf.byteLength, maxBytes)) {
    return { ok: false, response: c.json({ error: 'Corpo da requisição excede o limite' }, 413) };
  }
  if (buf.byteLength === 0) return { ok: true, value: {} as T };
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (!text.trim()) return { ok: true, value: {} as T };
  try {
    const value:unknown=JSON.parse(text);
    if(!jsonObject(value))return {ok:false,response:c.json({error:'Envie um objeto JSON.'},400)};
    return { ok: true, value: value as T };
  } catch {
    return { ok: false, response: c.json({ error: 'JSON inválido' }, 400) };
  }
}

// ===== operações caras (LLM): POR CONTA (token), independente de IP =====
// Instância = conta (systemd suco@<user>): limite global da conta em vez de
// por IP (spoofável). Concorrência 1 de IA: extra em andamento → 429 na hora
// com Retry-After (não enfileira esperando minutos). LLM desligado → 503
// imediato: geração NEM é aceita (o cliente não fica aguardando 5 min).
const expensiveLimiter = new RateLimiter({ windowMs: 5 * 60_000, max: 30 });
const aiGate = new AiConcurrencyGate(1);
const LLM_OFF_RETRY_AFTER_S = '300';

async function guardExpensive(c: Context, next: Next) {
  if (privateMode()) {
    if (!confidentialSummaryService) return privateUnavailable(c);
    const decision = expensiveLimiter.check('llm:account');
    if (!decision.allowed) return c.json({ code: 'PROCESSING_RATE_LIMITED' }, 429, {
      'Retry-After': String(Math.ceil(decision.retryAfterMs / 1000)),
    });
    // The measured worker obtains its provider secret inside the TEE. The
    // legacy LLM config probe below cannot see that secret and would return 503.
    // PrivateGlm's ledger enforces concurrency for the entire async job.
    return next();
  }
  if(tenantConfig&&!advancedAiAllowed()&&c.req.path!=='/api/summaries/generate')return c.json({error:'Assine para usar esta análise. Seus sucos salvos continuam disponíveis.',code:'UPGRADE_REQUIRED'},402);
  if (cloudGlmConfigured()) {
    // Regular cloud adapter performs its own bounded provider validation.
  } else if (config.openaiCompatUrl) {
    const llm = await llmReady.check();
    if (llm !== 'ok') {
      return c.json({ error: 'LLM indisponível, tente mais tarde' }, 503, {
        'Retry-After': LLM_OFF_RETRY_AFTER_S,
      });
    }
  } else if (!config.anthropicApiKey) {
    return c.json({ error: 'Nenhum LLM configurado' }, 503, {
      'Retry-After': LLM_OFF_RETRY_AFTER_S,
    });
  }
  const d = expensiveLimiter.check('llm:account');
  if (!d.allowed) {
    return c.json({ error: 'Too many requests' }, 429, {
      'Retry-After': String(Math.ceil(d.retryAfterMs / 1000)),
    });
  }
  const slot = aiGate.tryAcquire();
  if (!slot.ok) {
    return c.json({ error: 'Operação de IA já em andamento' }, 429, {
      'Retry-After': String(Math.ceil(slot.retryAfterMs / 1000)),
    });
  }
  try {
    await next();
  } finally {
    slot.release();
  }
}
for (const p of [
  '/api/summaries/generate',
  '/api/digests/generate',
  '/api/facts/extract',
  '/api/facts/retag',
]) {
  app.use(p, guardExpensive);
}

/** Lista de espera da landing page — público (sem token), só aceita INSERT. */
const waitlistLimiter = new RateLimiter({ windowMs: 60_000, max: 10, maxKeys: 1024 });
app.post('/site/waitlist', async (c) => {
  const rl = waitlistLimiter.check(abuseKey(c, 'wl'));
  if (!rl.allowed) {
    return c.json({ error: 'Too many requests' }, 429, {
      'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)),
    });
  }
  const parsed = await parseJsonBody<Record<string, unknown>>(c, MAX_WAITLIST_BYTES);
  if (!parsed.ok) return parsed.response;
  const v = validateWaitlistInput(parsed.value);
  if (!v.ok) return c.json({ error: v.error }, 400);

  await pool.query(
    `INSERT INTO waitlist (email, name, profession, whatsapp, source)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (email) DO UPDATE SET
       name = COALESCE(waitlist.name, EXCLUDED.name),
       profession = COALESCE(waitlist.profession, EXCLUDED.profession),
       whatsapp = COALESCE(waitlist.whatsapp, EXCLUDED.whatsapp)`,
    [v.value.email, v.value.name, v.value.profession, v.value.whatsapp, v.value.source]
  );
  return c.json({ ok: true });
});

app.get('/api/waitlist', async (c) => {
  const r = await pool.query('SELECT * FROM waitlist ORDER BY created_at DESC');
  return c.json({ leads: r.rows, total: r.rowCount });
});

app.get('/api/status', async (c) => {
  const s = getStatus();
  if (privateMode()) {
    const store = getConfidentialMessageStore();
    if (!store) return c.json({ ...s, syncEvidence: { lastIngestedAt: null,
      lastSavedMessageAt: null, maxSavedSeq: null, pendingInMemory: getPendingIngestionCount(),
      recoveryDurable: false, newMessageAfterConnect: false, available: false } });
    try {
      const evidence = await store.evidence();
      const connectedAt = s.lastConnectedAt ? Date.parse(s.lastConnectedAt) : NaN;
      const newMessageAfterConnect = !!evidence.lastIngestedAt && !!evidence.lastCommittedMessageAt &&
        Number.isFinite(connectedAt) && evidence.lastIngestedAt.valueOf() >= connectedAt &&
        evidence.lastCommittedMessageAt.valueOf() >= connectedAt - 5 * 60_000;
      return c.json({ ...s, syncEvidence: {
        lastIngestedAt: evidence.lastIngestedAt, lastSavedMessageAt: evidence.lastSavedMessageAt,
        maxSavedSeq: null, writeHealth: evidence.writeHealth,
        pendingInMemory: getPendingIngestionCount(), recoveryDurable: hasDurableIngestionSpool(),
        newMessageAfterConnect, available: true,
      } });
    } catch (error) {
      console.error('Falha ao consultar evidência privada:', safeErrorCode(error));
      return c.json({ ...s, syncEvidence: { lastIngestedAt: null,
        lastSavedMessageAt: null, maxSavedSeq: null, pendingInMemory: getPendingIngestionCount(),
        recoveryDurable: hasDurableIngestionSpool(), newMessageAfterConnect: false, available: false } });
    }
  }
  if (c.get('tenantScope') === 'manage') return c.json({ ...s, qr: null, me: null });
  const writeHealth = getIngestionWriteHealth();
  const pendingInMemory = getPendingIngestionCount();
  try {
    const [cursor, result] = await Promise.all([getIngestionCursor(), pool.query<{ last_saved_message_at: Date | null; new_message_after_connect: boolean }>(
      `SELECT
         (SELECT MAX(last_message_at) FROM wa_chats) AS last_saved_message_at,
         EXISTS (
           SELECT 1 FROM wa_messages
           WHERE ingested_at >= $1::timestamptz
             AND ts >= $1::timestamptz - interval '5 minutes'
           LIMIT 1
         ) AS new_message_after_connect`,
      [s.lastConnectedAt]
    )]);
    const lastSavedMessageAt = result.rows[0]?.last_saved_message_at ?? null;
    return c.json({ ...s, syncEvidence: {
      lastIngestedAt: cursor.lastIngestedAt,
      lastSavedMessageAt,
      maxSavedSeq: cursor.maxSavedSeq,
      writeHealth,
      pendingInMemory,
      recoveryDurable: hasDurableIngestionSpool(),
      newMessageAfterConnect: result.rows[0]?.new_message_after_connect === true,
      available: true,
    } });
  } catch (error) {
    console.error('Falha ao consultar evidência de sincronização:', safeErrorCode(error));
    return c.json({ ...s, syncEvidence: { lastIngestedAt: null, lastSavedMessageAt: null, maxSavedSeq: null, writeHealth, pendingInMemory, recoveryDurable: hasDurableIngestionSpool(), newMessageAfterConnect: false, available: false } });
  }
});

/**
 * Reconexão explícita (usuário pediu — ex.: QR expirou ou ação necessária
 * resolvida). Encerra o socket atual e inicia tentativa nova; NÃO apaga
 * credenciais. Retorno = snapshot do estado logo após iniciar.
 */
app.post('/api/connection/reconnect', async (c) => {
  if(tenantConfig&&!(await authorizeIngestion()))return c.json({error:'Seus três sucos grátis terminaram. Assine para conectar novamente.',code:'TRIAL_EXHAUSTED'},402);
  return c.json(await reconnectWhatsApp());
});

// Rotação deliberada de credenciais quando a sessão não consegue mais receber.
// A ação preserva as credenciais anteriores em backup privado e requer que a
// pessoa leia um novo QR no WhatsApp. Queda transitória usa /reconnect acima.
const freshPairingLimiter = new RateLimiter({ windowMs: 15 * 60_000, max: 3, maxKeys: 1024 });
app.post('/api/connection/new-pairing', async (c) => {
  if (tenantConfig && !(await authorizeIngestion()))
    return c.json({ error: 'Sua assinatura ou autorização precisa ser reativada antes de conectar.', code: 'ENTITLEMENT_REQUIRED' }, 402);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || (body as Record<string, unknown>).confirm !== 'NEW_PAIRING')
    return c.json({ error: 'Confirme que quer ler um novo QR para esta conta.', code: 'PAIRING_CONFIRMATION_REQUIRED' }, 400);
  const limit = freshPairingLimiter.check(tenantConfig ? `pairing:${tenantConfig.accountId}` : 'pairing:owner');
  if (!limit.allowed)
    return c.json({ error: 'Aguarde antes de pedir outro pareamento.', code: 'PAIRING_RATE_LIMITED' }, 429, { 'Retry-After': String(Math.ceil(limit.retryAfterMs / 1000)) });
  try {
    return c.json(await beginFreshPairing());
  } catch (error) {
    const code = safeErrorCode(error);
    if (code === 'PAIRING_BACKUP_UNSAFE' || code === 'PAIRING_BACKUP_FAILED')
      return c.json({ error: 'Não foi possível preservar a sessão anterior. Seus dados foram mantidos; tente novamente mais tarde.', code }, 503);
    if (code === 'PAIRING_IDENTITY_UNAVAILABLE')
      return c.json({ error: 'Não conseguimos confirmar que o novo QR manteria o mesmo WhatsApp. Sua conta e seu histórico foram preservados.', code }, 409);
    throw error;
  }
});

app.post('/api/logout', async (c) => {
  await logoutWhatsApp();
  return c.json({ ok: true });
});

app.get('/api/usage', async (c) => {
  if (privateMode()) return c.json({ available: false });
  if(!cloudGlmConfigured()&&!tenantConfig)return c.json({available:false});
  if(!cloudGlmConfigured())return c.json({available:false,access:tenantAccess(),trial:tenantTrialUsage(),monthlyUsed:0,dailyUsed:0,monthlyLimit:cloudLimits.monthly,dailyLimit:cloudLimits.daily,monitoredUsed:0,monitoredLimit:cloudLimits.monitored});
  try{return c.json({available:true,...await usageSnapshot()});}
  catch{return c.json({error:'Não conseguimos consultar seu uso agora. Tente novamente mais tarde.',code:'USAGE_UNAVAILABLE'},503);}
});

app.get('/api/dashboard', async (c) => {
  if (privateMode()) {
    const store = getConfidentialMessageStore(), metadata = getConfidentialMetadataStore();
    if (!store || !metadata) return privateUnavailable(c);
    const [messages, chats] = await Promise.all([store.snapshot(), metadata.chatList()]);
    let latest: Date | null = null;
    for (const message of messages) if (!latest || message.ts > latest) latest = message.ts;
    const summaries = confidentialSummaryService ? (await confidentialSummaryService.list(1, 0)).total : 0;
    return c.json({ chats: new Set([...chats.map((chat) => chat.jid), ...messages.map((message) => message.chat_jid)]).size,
      messages: messages.length, summaries, tracked: chats.filter(chat => chat.tracked && !chat.archived).length,
      last_message_at: latest,
      connected: getStatus().connected, partial: true });
  }
  const [chats, messages, summaries, tracked, last] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS n FROM wa_chats'),
    pool.query('SELECT COUNT(*)::int AS n FROM wa_messages'),
    pool.query('SELECT COUNT(*)::int AS n FROM summaries'),
    pool.query('SELECT COUNT(*)::int AS n FROM wa_chats WHERE tracked'),
    pool.query('SELECT MAX(ts) AS t FROM wa_messages'),
  ]);
  return c.json({
    chats: chats.rows[0].n,
    messages: messages.rows[0].n,
    summaries: summaries.rows[0].n,
    tracked: tracked.rows[0].n,
    last_message_at: last.rows[0].t,
    connected: getStatus().connected,
  });
});

app.get('/api/chats', async (c) => {
  const q = c.req.query('q')?.trim();
  const kind = c.req.query('kind') || 'all';
  if (!['all', 'group', 'person'].includes(kind)) return c.json({ error: 'Tipo de conversa inválido.' }, 400);
  const limit = Math.min(Number(c.req.query('limit') || 100), 500);
  const offset = Number(c.req.query('offset') || 0);

  if (privateMode()) {
    const store = getConfidentialMessageStore(), metadata = getConfidentialMetadataStore();
    if (!store || !metadata) return privateUnavailable(c);
    const [messages, chats, contacts, lids] = await Promise.all([
      store.snapshot(), metadata.chatList(), metadata.contactList(), metadata.lidMapList(),
    ]);
    const views = privateChatViews(messages, chats, contacts, lids, formatPhoneFromJid);
    return c.json(privateChatPage(views, { kind: kind as 'all' | 'group' | 'person', q, limit, offset }));
  }

  // Joins: contato direto pelo jid do chat e, para chats @lid, o contato do número real mapeado.
  const joins = `LEFT JOIN wa_lid_map lm ON lm.lid = ch.jid
     LEFT JOIN wa_contacts ct ON ct.jid = ch.jid
     LEFT JOIN wa_contacts ct2 ON ct2.jid = lm.pn`;

  const params: unknown[] = [];
  // Group metadata can arrive before its message history. Show the group with
  // zero messages in the first-use picker so the reader knows sync is pending.
  let where = kind === 'group'
    ? 'WHERE ch.is_group = true'
    : 'WHERE EXISTS (SELECT 1 FROM wa_messages m WHERE m.chat_jid = ch.jid)';
  if (kind === 'person') where += ' AND ch.is_group = false';
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (ch.name ILIKE $${params.length} OR ct.name ILIKE $${params.length} OR ct2.name ILIKE $${params.length}
      OR ct.notify ILIKE $${params.length} OR ct2.notify ILIKE $${params.length}
      OR ch.jid ILIKE $${params.length} OR lm.pn ILIKE $${params.length})`;
  }

  const totalRes = await pool.query(
    `SELECT COUNT(*)::int AS n FROM wa_chats ch ${joins} ${where}`,
    params
  );

  const rows = await pool.query(
    `SELECT ch.jid,
            COALESCE(
              ch.name,
              ct.name, ct2.name,       -- nome salvo na agenda
              ct.notify, ct2.notify,   -- pushName
              (SELECT m.sender_name FROM wa_messages m
                WHERE m.chat_jid = ch.jid AND NOT m.from_me AND m.sender_name IS NOT NULL
                ORDER BY m.ts DESC LIMIT 1)
            ) AS name,
            COALESCE(lm.pn, ch.jid) AS pn_jid,
            ch.is_group, ch.tracked, ch.last_message_at,
            (SELECT COUNT(*)::int FROM wa_messages m WHERE m.chat_jid = ch.jid) AS message_count,
            (SELECT COALESCE(m.body, '[' || m.msg_type || ']') FROM wa_messages m
              WHERE m.chat_jid = ch.jid ORDER BY m.ts DESC LIMIT 1) AS last_message_preview
     FROM wa_chats ch
     ${joins}
     ${where}
     ORDER BY ch.last_message_at DESC NULLS LAST
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  const chats = rows.rows.map(({ pn_jid, ...r }) => ({
    ...r,
    name: r.name || formatPhoneFromJid(pn_jid) || r.jid.split('@')[0],
    phone: formatPhoneFromJid(pn_jid),
  }));

  return c.json({ chats, total: totalRes.rows[0].n });
});

app.patch('/api/chats/:jid', async (c) => {
  if(tenantConfig&&!advancedAiAllowed())return c.json({error:'Assine para acompanhar conversas automaticamente.',code:'UPGRADE_REQUIRED'},402);
  const jid = c.req.param('jid');
  const parsed = await parseJsonBody<{ tracked?: boolean; archived?: boolean }>(c, MAX_API_BODY_BYTES);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  const sets: string[] = [];
  const params: unknown[] = [jid];
  if (typeof body.tracked === 'boolean') {
    params.push(body.tracked);
    sets.push(`tracked = $${params.length}`);
  }
  if (typeof body.archived === 'boolean') {
    params.push(body.archived);
    sets.push(`archived = $${params.length}`);
  }
  if (!sets.length) return c.json({ error: 'Nada para atualizar' }, 400);
  if(cloudGlmConfigured()&&body.tracked===true){
    try{
      const chat=await trackCloudChat(jid,typeof body.archived==='boolean'?body.archived:undefined);
      if(!chat)return c.json({error:'Chat não encontrado'},404);
      return c.json({chat});
    }catch(error){
      if((error as {code?:string}).code==='MONITORED_LIMIT_REACHED')return c.json({error:`Você chegou ao limite de ${cloudLimits.monitored} conversas acompanhadas. Desmarque uma conversa para acompanhar outra.`,code:'MONITORED_LIMIT_REACHED',limit:cloudLimits.monitored},429);
      return c.json({error:'Não conseguimos atualizar essa conversa agora. Tente novamente mais tarde.',code:'MONITORING_UNAVAILABLE'},503);
    }
  }
  const r = await pool.query(`UPDATE wa_chats SET ${sets.join(', ')}, updated_at = now() WHERE jid = $1 RETURNING *`, params);
  if (!r.rows[0]) return c.json({ error: 'Chat não encontrado' }, 404);
  return c.json({ chat: r.rows[0] });
});

app.post('/api/private/chats/tracking', async (c) => {
  if (!privateMode()) return privateUnavailable(c);
  const metadata = getConfidentialMetadataStore(), messages = getConfidentialMessageStore();
  if (!metadata || !messages) return privateUnavailable(c);
  const parsed = await parseJsonBody<{ jid?: unknown; tracked?: unknown }>(c, MAX_API_BODY_BYTES);
  if (!parsed.ok) return parsed.response;
  const { jid, tracked } = parsed.value;
  if (typeof jid !== 'string' || !jid.includes('@') || jid.length > 256 ||
      typeof tracked !== 'boolean') return c.json({ code: 'PRIVATE_CHAT_INPUT' }, 400);
  const chats = await metadata.chatList();
  if (!chats.some(chat => chat.jid === jid)) return c.json({ code: 'PRIVATE_CHAT_NOT_FOUND' }, 404);
  await metadata.setChatTracking(jid, tracked);
  const [all, next] = await Promise.all([messages.snapshot(), metadata.chatList()]);
  const views = privateChatViews(all, next, await metadata.contactList(),
    await metadata.lidMapList(), formatPhoneFromJid);
  return c.json({ chat: views.find(chat => chat.jid === jid) });
});

app.get('/api/chats/:jid/messages', async (c) => {
  const jid = chatJid(c);
  if (!jid) return c.json({ error: 'Conversa inválida.' }, 400);
  const start = c.req.query('start') ? new Date(c.req.query('start')!) : new Date(0);
  const end = c.req.query('end') ? new Date(c.req.query('end')!) : new Date();
  const limit = Math.min(Number(c.req.query('limit') || 500), 5000);
  const offset = Number(c.req.query('offset') || 0);

  if (privateMode()) {
    const store = getConfidentialMessageStore();
    if (!store) return privateUnavailable(c);
    return c.json(privateMessagePage(await store.snapshot(), { jid, start, end, limit, offset }));
  }

  const totalRes = await pool.query(
    'SELECT COUNT(*)::int AS n FROM wa_messages WHERE chat_jid = $1 AND ts >= $2 AND ts <= $3',
    [jid, start, end]
  );
  const rows = await pool.query(
    `SELECT chat_jid, id, sender_jid, sender_name, from_me, body, msg_type, ts AS timestamp
     FROM wa_messages WHERE chat_jid = $1 AND ts >= $2 AND ts <= $3
     ORDER BY ts ASC LIMIT $4 OFFSET $5`,
    [jid, start, end, limit, offset]
  );
  return c.json({ messages: rows.rows, total: totalRes.rows[0].n });
});

app.get('/api/chats/:jid/stats', async (c) => {
  const jid = chatJid(c);
  if (!jid) return c.json({ error: 'Conversa inválida.' }, 400);
  const start = c.req.query('start') ? new Date(c.req.query('start')!) : new Date(0);
  const end = c.req.query('end') ? new Date(c.req.query('end')!) : new Date();

  if (privateMode()) {
    const store = getConfidentialMessageStore();
    if (!store) return privateUnavailable(c);
    return c.json(privateChatStats(await store.snapshot(), jid, start, end));
  }

  const agg = await pool.query(
    `SELECT COUNT(*)::int AS count, MIN(ts) AS first, MAX(ts) AS last
     FROM wa_messages WHERE chat_jid = $1 AND ts >= $2 AND ts <= $3`,
    [jid, start, end]
  );
  const bySender = await pool.query(
    `SELECT COALESCE(sender_name, CASE WHEN from_me THEN 'Eu' ELSE split_part(COALESCE(sender_jid, ''), '@', 1) END) AS sender_name,
            COUNT(*)::int AS count
     FROM wa_messages WHERE chat_jid = $1 AND ts >= $2 AND ts <= $3
     GROUP BY 1 ORDER BY count DESC LIMIT 20`,
    [jid, start, end]
  );
  return c.json({ ...agg.rows[0], by_sender: bySender.rows });
});

app.post('/api/summaries/generate', async (c) => {
  const parsed = await parseJsonBody<{
    chat_jid: string;
    start: string;
    end: string;
    analysis_type?: string;
    base_prompt?: string;
    template_version?: string;
    personal_revision?: string;
    focus?: string;
    title?: string;
    request_id?: string;
  }>(c, MAX_API_BODY_BYTES);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  if (!validSummaryInput(body as unknown as Record<string,unknown>)) {
    return c.json({ error: 'chat_jid, start e end são obrigatórios' }, 400);
  }
  if (privateMode()) {
    if (!confidentialSummaryService) return privateUnavailable(c);
    try {
      const result = await confidentialSummaryService.generate({
        request_id: body.request_id ?? '', chat_jid: body.chat_jid,
        start: body.start, end: body.end, analysis_type: body.analysis_type || 'general',
        template_version: body.template_version, personal_revision: body.personal_revision,
        base_prompt: body.base_prompt,
        focus: body.focus, title: body.title,
      } satisfies PrivateSummaryRequest);
      return c.json(result.state === 'complete' ? { summary: result.summary } :
        { state: 'pending', requestId: body.request_id }, result.state === 'complete' ? 200 : 202);
    } catch (error) {
      const code = safeErrorCode(error);
      const status = error && typeof error === 'object' && 'status' in error &&
        typeof error.status === 'number' && error.status >= 400 && error.status < 600 ? error.status :
        code === 'PRIVATE_SUMMARY_PENDING' || code === 'PRIVATE_SUMMARY_CONFLICT' ? 409 :
        code === 'PRIVATE_PERSONAL_CHANGED' ? 409 :
        code === 'PRIVATE_PERSONAL_NOT_FOUND' ? 404 :
        code === 'PRIVATE_SUMMARY_NO_MESSAGES' ? 422 : 503;
      return c.json({ code }, status as 400);
    }
  }
  try {
    const summary = await generateSummary({
      chatJid: body.chat_jid,
      start: new Date(body.start),
      end: new Date(body.end),
      analysisType: body.analysis_type || 'general',
      basePrompt: body.base_prompt ?? '',
      templateVersion: body.template_version,
      personalRevision: body.personal_revision,
      focus: body.focus,
      title: body.title,
      requestId: c.req.header('Idempotency-Key') || body.request_id,
    });
    return c.json({ summary });
  } catch (e: any) {
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 502;
    console.error('Erro ao gerar suco:', safeErrorCode(e));
    const descriptions:Record<string,string>={TRIAL_EXHAUSTED:'Seus três sucos grátis terminaram. Assine para criar novos resumos; os sucos salvos continuam disponíveis.',TRIAL_COMMIT_PENDING:'Seu suco foi salvo. Estamos confirmando seu uso. Tente novamente com o mesmo pedido.',TRIAL_PERSIST_PENDING:'Precisamos confirmar se seu suco foi salvo. Tente novamente com o mesmo pedido.',TRIAL_RELEASE_PENDING:'A análise falhou e estamos liberando seu uso gratuito. Tente novamente com o mesmo pedido.',SUMMARY_REQUEST_PENDING:'Este pedido aguarda confirmação. Tente novamente com o mesmo pedido.',SUMMARY_REQUEST_BUSY:'Este pedido já está em andamento. Aguarde a confirmação.',SUMMARY_REQUEST_ALREADY_USED:'Este pedido já foi encerrado. Para outra análise, inicie um novo pedido.',SUMMARY_REQUEST_CHANGED:'O recorte mudou. Inicie um novo pedido para analisar outro período.',TRIAL_VERIFICATION_UNAVAILABLE:'Não conseguimos verificar seu uso gratuito agora. Tente novamente mais tarde.'};
    Object.assign(descriptions,{PERSONAL_JUICE_REQUEST_CHANGED:'Esse pedido mudou. Retome o pedido original antes de criar outro.',INVALID_PERSONAL_JUICE:'Confira seu tipo personalizado antes de gerar.',PERSONAL_JUICE_NOT_FOUND:'Esse tipo de suco não está disponível.',PERSONAL_JUICE_ARCHIVED:'Esse tipo foi excluído. Seus sucos salvos continuam disponíveis.',TEMPLATE_VERSION_CHANGED:'Os modelos foram atualizados. Recarregue antes de gerar.',TEMPLATE_VERSION_REQUIRED:'Confira o modelo e tente novamente.',INVALID_JUICE_FOCUS:'Use um detalhe de até 2.000 caracteres.',UNKNOWN_JUICE_TEMPLATE:'Escolha um dos modelos disponíveis.',CUSTOM_JUICE_REQUEST_REQUIRED:'Escreva o que você quer tirar da conversa.'});
    return c.json({ error: descriptions[e.code] || (status===404?'Conversa não encontrada.':status===422?'Não há mensagens nesse período.':'Não foi possível gerar o resumo.'),...(typeof e.code==='string'?{code:e.code}:{}),...(e.requestId?{requestId:e.requestId}:{}),...(e.summaryId?{summaryId:e.summaryId}:{}) }, status);
  }
});

app.get('/api/summaries', async (c) => {
  if (privateMode()) {
    if (!confidentialSummaryService) return privateUnavailable(c);
    try { return c.json(await confidentialSummaryService.list(
      Math.min(Number(c.req.query('limit') || 50), 200), Number(c.req.query('offset') || 0))); }
    catch (error) { return c.json({ code: safeErrorCode(error) }, 503); }
  }
  const chatJid = c.req.query('chat_jid');
  const limit = Math.min(Number(c.req.query('limit') || 50), 200);
  const offset = Number(c.req.query('offset') || 0);
  const params: unknown[] = [];
  let where = '';
  if (chatJid) {
    params.push(chatJid);
    where = `WHERE chat_jid = $${params.length}`;
  }
  const totalRes = await pool.query(`SELECT COUNT(*)::int AS n FROM summaries ${where}`, params);
  const rows = await pool.query(
    `SELECT * FROM summaries ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  return c.json({ summaries: rows.rows, total: totalRes.rows[0].n });
});

app.get('/api/summaries/:id', async (c) => {
  if (privateMode()) {
    if (!confidentialSummaryService) return privateUnavailable(c);
    try {
      const result = await confidentialSummaryService.status(c.req.param('id'));
      if (result.state === 'missing') return c.json({ code: 'PRIVATE_SUMMARY_NOT_FOUND' }, 404);
      if (result.state === 'pending') return c.json({ state: 'pending' }, 202);
      if (result.state === 'failed') return c.json({ code: 'PRIVATE_SUMMARY_FAILED' }, 503);
      return c.json({ summary: result.summary });
    } catch (error) { return c.json({ code: safeErrorCode(error) }, 503); }
  }
  const r = await pool.query('SELECT * FROM summaries WHERE id = $1', [c.req.param('id')]);
  if (!r.rows[0]) return c.json({ error: 'Não encontrado' }, 404);
  return c.json({ summary: r.rows[0] });
});

app.get('/api/private/personal-juices', async (c) => {
  if (!privateMode() || !confidentialSummaryService) return privateUnavailable(c);
  try { return c.json({ types: await confidentialSummaryService.personalTypes() }); }
  catch (error) { return c.json({ code: safeErrorCode(error) }, 503); }
});

app.post('/api/private/personal-juices/save', async (c) => {
  if (!privateMode() || !confidentialSummaryService) return privateUnavailable(c);
  const parsed = await parseJsonBody<{ id?: unknown; revision?: unknown; name?: unknown;
    category?: unknown; base_type?: unknown; instructions?: unknown }>(c, MAX_API_BODY_BYTES);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  if (typeof body.id !== 'string' || typeof body.revision !== 'number' ||
      typeof body.name !== 'string' || typeof body.category !== 'string' ||
      typeof body.base_type !== 'string' || typeof body.instructions !== 'string')
    return c.json({ code: 'PRIVATE_SUMMARY_INPUT' }, 400);
  try { return c.json({ type: await confidentialSummaryService.savePersonalType({
    id: body.id, revision: body.revision, name: body.name, category: body.category,
    base_type: body.base_type, instructions: body.instructions,
  }) }); }
  catch (error) {
    const code = safeErrorCode(error);
    return c.json({ code }, code === 'PRIVATE_SUMMARY_INPUT' ? 400 :
      code === 'PRIVATE_SUMMARY_CONFLICT' ? 409 : 503);
  }
});

app.post('/api/private/personal-juices/archive', async (c) => {
  if (!privateMode() || !confidentialSummaryService) return privateUnavailable(c);
  const parsed = await parseJsonBody<{ id?: unknown; revision?: unknown }>(c, MAX_API_BODY_BYTES);
  if (!parsed.ok) return parsed.response;
  if (typeof parsed.value.id !== 'string' || typeof parsed.value.revision !== 'number')
    return c.json({ code: 'PRIVATE_SUMMARY_INPUT' }, 400);
  try { await confidentialSummaryService.archivePersonalType(parsed.value.id, parsed.value.revision);
    return c.json({ ok: true }); }
  catch (error) {
    const code = safeErrorCode(error);
    return c.json({ code }, code === 'PRIVATE_SUMMARY_INPUT' ? 400 :
      code === 'PRIVATE_SUMMARY_CONFLICT' ? 409 : 503);
  }
});

app.delete('/api/summaries/:id', async (c) => {
  await pool.query('DELETE FROM summaries WHERE id = $1', [c.req.param('id')]);
  return c.json({ ok: true });
});

app.post('/api/private/summaries/delete', async (c) => {
  if (!privateMode() || !confidentialSummaryService) return privateUnavailable(c);
  const parsed = await parseJsonBody<{ id?: unknown }>(c, MAX_API_BODY_BYTES);
  if (!parsed.ok) return parsed.response;
  if (typeof parsed.value.id !== 'string' || !/^[0-9a-f-]{36}$/.test(parsed.value.id))
    return c.json({ code: 'PRIVATE_SUMMARY_INPUT' }, 400);
  try { await confidentialSummaryService.deleteSummary(parsed.value.id); return c.json({ ok: true }); }
  catch (error) {
    const code = safeErrorCode(error);
    return c.json({ code }, code === 'PRIVATE_SUMMARY_CONFLICT' ? 409 :
      code === 'PRIVATE_SUMMARY_NOT_FOUND' ? 404 : 503);
  }
});

// ===== v2: Digest diário + Cofre (API-CONTRACT-V2.md) =====

app.get('/api/settings/extraction', async (c) => {
  return c.json({ settings: await getExtractionSettings() });
});

app.patch('/api/settings/extraction/:kind', async (c) => {
  const kind = c.req.param('kind');
  const parsed = await parseJsonBody<{ enabled?: boolean; pointer_only?: boolean }>(c, MAX_API_BODY_BYTES);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  if ('pointer_only' in body) {
    return c.json({ error: 'pointer_only é fixo por regra de código, não é configurável' }, 400);
  }
  if (typeof body.enabled !== 'boolean') {
    return c.json({ error: 'enabled (boolean) é obrigatório' }, 400);
  }
  const r = await pool.query(
    'UPDATE extraction_settings SET enabled = $2, updated_at = now() WHERE kind = $1 RETURNING *',
    [kind, body.enabled]
  );
  if (!r.rows[0]) return c.json({ error: 'Categoria não encontrada' }, 404);
  // desligar = apagar o que já foi extraído (não é filtro de exibição)
  if (!body.enabled) {
    await pool.query('DELETE FROM facts WHERE kind = $1', [kind]);
  }
  return c.json({ setting: r.rows[0] });
});

app.get('/api/facts', async (c) => {
  const kind = c.req.query('kind');
  const chatJid = c.req.query('chat_jid');
  const tag = c.req.query('tag')?.trim();
  const q = c.req.query('q')?.trim();
  const limit = Math.min(Number(c.req.query('limit') || 100), 500);
  const offset = Number(c.req.query('offset') || 0);

  const start = c.req.query('start');
  const end = c.req.query('end');
  if ([start,end].some(value => value !== undefined && !Number.isFinite(new Date(value).getTime()))) return c.json({error:'Período inválido.'},400);
  if (start && end && new Date(start) >= new Date(end)) return c.json({error:'O fim precisa ser posterior ao início.'},400);
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(offset) || offset < 0) return c.json({error:'Página inválida.'},400);

  const params: unknown[] = [];
  const where: string[] = ['TRUE'];
  if (kind) {
    params.push(kind);
    where.push(`kind = $${params.length}`);
  }
  if (chatJid) {
    params.push(chatJid);
    where.push(`chat_jid = $${params.length}`);
  }
  if (start) { params.push(start); where.push(`ts >= $${params.length}::timestamptz`); }
  if (end) { params.push(end); where.push(`ts < $${params.length}::timestamptz`); }
  if (tag) {
    // mesma normalização da escrita, pra "vídeo" e "video" acharem a mesma tag;
    // se a normalização zerar (ex.: só pontuação), usa a tag crua — não casa nada,
    // nunca vira '{}' (que casaria com tudo)
    const normTag = normalizeTags([tag]);
    params.push(normTag.length ? normTag : [tag.toLowerCase()]);
    where.push(`tags @> $${params.length}::text[]`);
  }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(label ILIKE $${params.length} OR value ILIKE $${params.length} OR context ILIKE $${params.length} OR chat_name ILIKE $${params.length})`);
  }
  const w = `WHERE ${where.join(' AND ')}`;
  const totalRes = await pool.query(`SELECT COUNT(*)::int AS n FROM facts ${w}`, params);
  const rows = await pool.query(
    `SELECT * FROM facts ${w} ORDER BY ts DESC NULLS LAST, created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  return c.json({ facts: rows.rows, total: totalRes.rows[0].n });
});

// faceta de tags do Cofre; kind= opcional restringe a uma categoria
app.get('/api/facts/tags', async (c) => {
  const kind = c.req.query('kind');
  const params: unknown[] = [];
  let where = '';
  if (kind) {
    params.push(kind);
    where = `WHERE f.kind = $${params.length}`;
  }
  const r = await pool.query(
    `SELECT t.tag, COUNT(*)::int AS count
     FROM facts f, unnest(f.tags) AS t(tag)
     ${where}
     GROUP BY t.tag
     ORDER BY count DESC, t.tag ASC`,
    params
  );
  return c.json({ tags: r.rows });
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

app.delete('/api/facts/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ error: 'Não encontrado' }, 404);
  await pool.query('DELETE FROM facts WHERE id = $1', [id]);
  return c.json({ ok: true });
});

app.post('/api/facts/extract', async (c) => {
  const parsed = await parseJsonBody<{ chat_jid?: string; since?: string; force?: boolean }>(c, MAX_API_BODY_BYTES);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  let since: Date | undefined;
  if (body.since) {
    since = new Date(body.since);
    if (isNaN(since.getTime())) return c.json({ error: 'since inválido (use ISO 8601)' }, 400);
  }
  try {
    const result = await extractFacts({
      chatJid: body.chat_jid,
      since,
      force: !!body.force,
    });
    return c.json(result);
  } catch (e: any) {
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 502;
    return c.json({ error: status===409?'Extração já em andamento.':'Não foi possível concluir a extração.' }, status);
  }
});

// backfill de tags nos fatos antigos (tags vazias), em lotes via LLM local
app.post('/api/facts/retag', async (c) => {
  try {
    return c.json(await retagFacts());
  } catch (e: any) {
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 502;
    if (status !== 409) console.error('Erro no retag:', safeErrorCode(e));
    return c.json({ error: status===409?'Revisão já em andamento.':'Não foi possível concluir a revisão.' }, status);
  }
});

const vaultSearchLimiter=new RateLimiter({windowMs:60_000,max:30,maxKeys:1});
app.post('/api/search', async (c) => {
  const parsed=await parseJsonBody<Record<string,unknown>>(c,MAX_API_BODY_BYTES);
  if(!parsed.ok)return parsed.response;
  const body=parsed.value;
  if(typeof body.query!=='string'||body.query.length>500)return c.json({error:'Escreva uma busca de até 500 caracteres.'},400);
  const limit=body.limit===undefined?30:body.limit;
  if(typeof limit!=='number'||!Number.isInteger(limit)||limit<1||limit>100)return c.json({error:'O limite deve ficar entre 1 e 100.'},400);
  for(const field of ['start','end'])if(body[field]!==undefined&&(typeof body[field]!=='string'||!Number.isFinite(new Date(body[field] as string).getTime())))return c.json({error:'Escolha datas válidas para a busca.'},400);
  if(body.start&&body.end&&new Date(body.start as string)>=new Date(body.end as string))return c.json({error:'A data inicial precisa ser anterior ao fim do período.'},400);
  if(body.chat_jid!==undefined&&(typeof body.chat_jid!=='string'||body.chat_jid.length>200||!body.chat_jid.trim()))return c.json({error:'Escolha uma conversa válida.'},400);
  if(body.kind!==undefined&&!['all','pix','email','phone','address'].includes(body.kind as string))return c.json({error:'Escolha um tipo de informação válido.'},400);
  if(body.timezone!==undefined&&(typeof body.timezone!=='string'||body.timezone.length>80))return c.json({error:'Fuso horário inválido.'},400);
  if(body.cursor!==undefined&&(typeof body.cursor!=='string'||body.cursor.length>2048))return c.json({error:'Página de busca inválida.'},400);
  const decision=vaultSearchLimiter.check('account');if(!decision.allowed)return c.json({error:'Você fez várias buscas. Aguarde um minuto para continuar.'},429,{'Retry-After':String(Math.ceil(decision.retryAfterMs/1000))});
  if (privateMode()) {
    const messages = getConfidentialMessageStore(), metadata = getConfidentialMetadataStore();
    if (!messages || !metadata) return privateUnavailable(c);
    try { return c.json(await createConfidentialSearch(messages, metadata)(body as unknown as PrivateSearchInput)); }
    catch (error) {
      const code = safeErrorCode(error);
      return c.json({ code }, code === 'PRIVATE_SEARCH_INPUT' ? 400 : 503);
    }
  }
  try{
    return c.json(await smartSearch(body.query.trim(),{limit,start:body.start as string|undefined,end:body.end as string|undefined,chat_jid:body.chat_jid as string|undefined,kind:body.kind as 'all'|'pix'|'email'|'phone'|'address'|undefined,cursor:body.cursor as string|undefined,timezone:body.timezone as string|undefined}));
  }catch(error){
    const status=(error as {status?:number}).status;
    return c.json({error:status===400?'Confira os filtros e tente novamente.':'Não conseguimos consultar o Cofre agora. Seus dados foram preservados.'},status===400?400:503);
  }
});

app.get('/api/digests', async (c) => {
  if (privateMode()) {
    if (!confidentialSummaryService) return privateUnavailable(c);
    try { return c.json(await confidentialSummaryService.listDigests(
      Math.min(Number(c.req.query('limit') || 60), 120), Number(c.req.query('offset') || 0))); }
    catch (error) { return c.json({ code: safeErrorCode(error) }, 503); }
  }
  const limit = Math.min(Number(c.req.query('limit') || 30), 120);
  const offset = Number(c.req.query('offset') || 0);
  const totalRes = await pool.query('SELECT COUNT(*)::int AS n FROM digests');
  const rows = await pool.query(
    'SELECT id, day::text AS day, content, stats, model, created_at FROM digests ORDER BY day DESC LIMIT $1 OFFSET $2',
    [limit, offset]
  );
  return c.json({ digests: rows.rows, total: totalRes.rows[0].n });
});

app.get('/api/digests/:day', async (c) => {
  const day = c.req.param('day');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return c.json({ error: 'day deve ser YYYY-MM-DD' }, 400);
  const r = await pool.query(
    'SELECT id, day::text AS day, content, stats, model, created_at FROM digests WHERE day = $1',
    [day]
  );
  if (!r.rows[0]) return c.json({ error: 'Não encontrado' }, 404);
  return c.json({ digest: r.rows[0] });
});

app.post('/api/digests/generate', async (c) => {
  const parsed = await parseJsonBody<{ day?: string; request_id?: string }>(c, MAX_API_BODY_BYTES);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  if (privateMode()) {
    if (!confidentialSummaryService) return privateUnavailable(c);
    try {
      const result = await confidentialSummaryService.generateDigest({
        request_id: body.request_id ?? '', day: body.day ?? '',
      });
      return c.json(result.state === 'complete' ? { digest: result.digest } :
        { state: 'pending', requestId: body.request_id }, result.state === 'complete' ? 200 : 202);
    } catch (error) {
      const code = safeErrorCode(error);
      return c.json({ code }, code === 'PRIVATE_SUMMARY_INPUT' ? 400 :
        code === 'PRIVATE_SUMMARY_NO_MESSAGES' ? 422 :
        code === 'PRIVATE_SUMMARY_PENDING' || code === 'PRIVATE_SUMMARY_CONFLICT' ? 409 : 503);
    }
  }
  try {
    const digest = await generateDigest(body.day || todayInTz());
    return c.json({ digest });
  } catch (e: any) {
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 502;
    console.error('Erro ao gerar digest:', safeErrorCode(e));
    return c.json({ error: status===400?'Data inválida.':status===422?'Não há mensagens nesse dia.':status===409?'Digest já em andamento.':'Não foi possível gerar o digest.' }, status);
  }
});

// util interno: nome resolvido de um chat
app.get('/api/chats/:jid/name', async (c) => {
  const jid = chatJid(c);
  if (!jid) return c.json({ error: 'Conversa inválida.' }, 400);
  if (privateMode()) {
    const store = getConfidentialMessageStore(), metadata = getConfidentialMetadataStore();
    if (!store || !metadata) return privateUnavailable(c);
    const [messages, chats, contacts, lids] = await Promise.all([
      store.snapshot(), metadata.chatList(), metadata.contactList(), metadata.lidMapList(),
    ]);
    const chat = privateChatViews(messages, chats, contacts, lids, formatPhoneFromJid)
      .find((item) => item.jid === jid);
    return c.json({ name: chat?.name ?? null });
  }
  const r = await pool.query('SELECT name FROM wa_chats WHERE jid = $1', [jid]);
  return c.json({ name: await resolveChatName(jid, r.rows[0]?.name ?? null) });
});
