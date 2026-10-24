#!/usr/bin/env node
/**
 * Fila de prioridades na frente do LLM local (Qwen em 127.0.0.1:1234).
 *
 * Com N instâncias do suco-server chamando o mesmo Qwen, as requests brigam
 * e a busca interativa fica atrás de extração de background. Este proxy
 * serializa (concorrência 1 — llama.cpp é efetivamente single-stream) e
 * prioriza: high (busca) > medium (digest/suco) > low (extração/retag).
 *
 * Sem dependências. Endpoints:
 *   POST /v1/chat/completions  — proxy com fila (prioridade via header x-priority)
 *   GET  /v1/models            — passthrough direto (health do upstream)
 *   GET  /ready                — readiness do UPSTREAM (sem inferência): tenta
 *                                GET /health e cai para /v1/models; cache TTL;
 *                                200 se no ar, 503 se offline (erro não mascara)
 *   GET  /status               — stats da fila
 *
 * Env: LLMQ_PORT (8378) · LLMQ_UPSTREAM (http://127.0.0.1:1234) ·
 *      LLMQ_TIMEOUT_MS (330000) · LLMQ_MAX_QUEUE (200) ·
 *      LLMQ_READY_TTL_MS (10000) · LLMQ_READY_TIMEOUT_MS (5000)
 */
import http from 'node:http';

const PORT = Number(process.env.LLMQ_PORT || 8378);
const UPSTREAM = (process.env.LLMQ_UPSTREAM || 'http://127.0.0.1:1234').replace(/\/$/, '');
const TIMEOUT_MS = Number(process.env.LLMQ_TIMEOUT_MS || 330_000);
const MAX_QUEUE = Number(process.env.LLMQ_MAX_QUEUE || 200);
const READY_TTL_MS = Number(process.env.LLMQ_READY_TTL_MS || 10_000);
const READY_TIMEOUT_MS = Number(process.env.LLMQ_READY_TIMEOUT_MS || 5_000);

const PRIORITIES = ['high', 'medium', 'low'];
const queues = { high: [], medium: [], low: [] };
let running = false;
const stats = { served: 0, errors: 0, rejected: 0, totalWaitMs: 0, totalUpstreamMs: 0 };

function queueSize() {
  return queues.high.length + queues.medium.length + queues.low.length;
}

function nextJob() {
  for (const p of PRIORITIES) {
    if (queues[p].length) return queues[p].shift();
  }
  return null;
}

async function pump() {
  if (running) return;
  const job = nextJob();
  if (!job) return;
  running = true;
  const waitMs = Date.now() - job.enqueuedAt;
  let upstreamMs = 0;
  try {
    const t0 = Date.now();
    const res = await fetch(`${UPSTREAM}${job.path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: job.body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    upstreamMs = Date.now() - t0;
    const text = await res.text();
    job.res.writeHead(res.status, { 'Content-Type': res.headers.get('content-type') || 'application/json' });
    job.res.end(text);
    stats.served++;
    stats.totalWaitMs += waitMs;
    stats.totalUpstreamMs += upstreamMs;
  } catch (e) {
    stats.errors++;
    if (!job.res.headersSent) {
      job.res.writeHead(502, { 'Content-Type': 'application/json' });
      job.res.end(JSON.stringify({ error: { message: `llm-queue: upstream falhou (${e.message})` } }));
    } else {
      job.res.destroy();
    }
  } finally {
    console.log(
      `[llmq] ${job.priority} wait=${waitMs}ms upstream=${upstreamMs}ms fila=${queueSize()} servidas=${stats.served}`
    );
    running = false;
    setImmediate(pump);
  }
}

function readBody(req, maxBytes = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('body grande demais'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ===== readiness do upstream (cache + single-flight) =====
let readyCache = null; // { ok: boolean, at: number }
let readyProbing = null; // Promise<boolean>

/** Sonda REAL do servidor de modelo, sem inferência: /health (llama-server) com fallback /v1/models (LM Studio/OpenAI-compat). */
async function probeUpstream() {
  for (const path of ['/health', '/v1/models']) {
    try {
      const r = await fetch(`${UPSTREAM}${path}`, { signal: AbortSignal.timeout(READY_TIMEOUT_MS) });
      if (r.ok) return true;
      if (r.status === 404 || r.status === 405) continue; // rota não suportada → tenta a outra
      return false; // upstream respondeu com erro de verdade → offline (não mascara)
    } catch {
      // rede/timeout nesta rota → tenta a próxima
    }
  }
  return false;
}

async function handleReady(req, res) {
  const now = Date.now();
  if (!readyCache || now - readyCache.at >= READY_TTL_MS) {
    if (!readyProbing) {
      readyProbing = probeUpstream().then((ok) => {
        readyCache = { ok, at: Date.now() };
        readyProbing = null;
        return ok;
      });
    }
  }
  const ok =
    readyCache && Date.now() - readyCache.at < READY_TTL_MS ? readyCache.ok : await readyProbing;
  res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ ok }));
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';

  if (req.method === 'GET' && (url === '/ready' || url === '/ready/')) {
    await handleReady(req, res);
    return;
  }

  if (req.method === 'GET' && url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        running,
        queue: { high: queues.high.length, medium: queues.medium.length, low: queues.low.length },
        served: stats.served,
        errors: stats.errors,
        rejected: stats.rejected,
        avg_wait_ms: stats.served ? Math.round(stats.totalWaitMs / stats.served) : 0,
        avg_upstream_ms: stats.served ? Math.round(stats.totalUpstreamMs / stats.served) : 0,
      })
    );
    return;
  }

  if (req.method === 'GET' && url.startsWith('/v1/')) {
    // passthrough de leitura (ex.: /v1/models) — não passa pela fila
    try {
      const r = await fetch(`${UPSTREAM}${url}`, { signal: AbortSignal.timeout(10_000) });
      res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/json' });
      res.end(await r.text());
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `llm-queue: upstream falhou (${e.message})` } }));
    }
    return;
  }

  if (req.method === 'POST' && url.startsWith('/v1/')) {
    if (queueSize() >= MAX_QUEUE) {
      stats.rejected++;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'llm-queue: fila cheia, tente de novo' } }));
      return;
    }
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: e.message } }));
      return;
    }
    const p = String(req.headers['x-priority'] || 'medium').toLowerCase();
    const priority = PRIORITIES.includes(p) ? p : 'medium';
    const job = { path: url, body, res, priority, enqueuedAt: Date.now() };
    queues[priority].push(job);
    // se o cliente desistir (timeout do lado dele), tira da fila
    res.on('close', () => {
      if (!res.headersSent) {
        const q = queues[priority];
        const i = q.indexOf(job);
        if (i !== -1) q.splice(i, 1);
      }
    });
    pump();
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'não encontrado' } }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`🚦 llm-queue ouvindo em 127.0.0.1:${PORT} → ${UPSTREAM} (timeout ${TIMEOUT_MS}ms)`);
});
