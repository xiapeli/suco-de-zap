import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { LlmReadiness, httpProbe } from '../src/lib/llm-readiness.js';

/**
 * Teste REAL da llm-queue (tools/llm-queue.mjs): sobe o processo de verdade
 * em porta efêmera com um upstream falso (servidor HTTP local), NÃO toca o
 * serviço/porta de produção nem sobe modelo algum. Valida o /ready novo e o
 * probe do backend apontando para ele (LLM_READY_URL).
 */

const BACKEND_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as { port: number }).port;
      srv.close(() => resolve(p));
    });
  });
}

function listen(srv: http.Server): Promise<number> {
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve((srv.address() as { port: number }).port));
  });
}

async function waitUp(url: string, ms = 5_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (r.status > 0) return;
    } catch {}
    await sleep(50);
  }
  throw new Error(`fila não respondeu em ${url}`);
}

test('llm-queue /ready: 200 com upstream no ar, 503 com upstream morto (TTL vencido); backend probe consome', async () => {
  // upstream fake estilo LM Studio: só /v1/models (não tem /health)
  const upstream = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const upstreamPort = await listen(upstream);
  const queuePort = await freePort();

  const child = spawn(process.execPath, [path.join(BACKEND_ROOT, 'tools', 'llm-queue.mjs')], {
    cwd: BACKEND_ROOT,
    env: {
      LLMQ_PORT: String(queuePort),
      LLMQ_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
      LLMQ_READY_TTL_MS: '80',
      LLMQ_READY_TIMEOUT_MS: '1000',
    },
    stdio: 'ignore',
  });

  try {
    await waitUp(`http://127.0.0.1:${queuePort}/status`);
    const readyUrl = `http://127.0.0.1:${queuePort}/ready`;

    // 1) upstream no ar → /ready 200 (probe real: /health 404 → fallback /v1/models 200)
    let res = await fetch(readyUrl);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(res.headers.get('cache-control'), 'no-store');

    // 2) passthrough /v1/models segue direto ao upstream (não é o readiness)
    res = await fetch(`http://127.0.0.1:${queuePort}/v1/models`);
    assert.equal(res.status, 200);

    // 3) probe do BACKEND (httpProbe real) apontando p/ o /ready da fila
    const readiness = new LlmReadiness({
      baseUrl: `http://127.0.0.1:${queuePort}/v1`,
      readyUrl,
      ttlMs: 40,
      timeoutMs: 2_000,
      probe: httpProbe,
    });
    assert.equal(readiness.probeUrl(), readyUrl);
    assert.equal(await readiness.check(), 'ok');

    // 4) upstream MORRE (porta fechada de verdade): TTL vence → fila 503,
    //    e o probe do backend enxerga 'unreachable' (erro não mascarado)
    upstream.close();
    upstream.closeAllConnections?.();
    await sleep(150); // TTL de 80ms vence
    res = await fetch(readyUrl);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false });
    readiness.invalidate();
    assert.equal(await readiness.check(), 'unreachable');
  } finally {
    child.kill('SIGKILL');
    upstream.close();
    upstream.closeAllConnections?.();
  }
});
