import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { LlmReadiness, httpProbe } from '../src/lib/llm-readiness.js';

test('readyUrl (fila /ready) tem precedência sobre /models direto', async () => {
  const urls: string[] = [];
  const withReady = new LlmReadiness({
    baseUrl: 'http://llm.local/v1',
    readyUrl: 'http://127.0.0.1:8378/ready',
    probe: async (url) => {
      urls.push(url);
      return 'ok';
    },
  });
  await withReady.check();
  assert.deepEqual(urls, ['http://127.0.0.1:8378/ready']);

  const withoutReady = new LlmReadiness({
    baseUrl: 'http://llm.local/v1',
    probe: async (url) => {
      urls.push(url);
      return 'ok';
    },
  });
  await withoutReady.check();
  assert.equal(urls[1], 'http://llm.local/v1/models', 'sem readyUrl cai no /models (compat)');
});

test('httpProbe REAL contra servidor HTTP local: 200 ok, 404/503/erro de rede unreachable (sem mascarar)', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/ready') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    } else if (req.url === '/forbidden') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end('{"ok":false}');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    assert.equal(await httpProbe(`http://127.0.0.1:${port}/ready`, 2_000), 'ok');
    assert.equal(await httpProbe(`http://127.0.0.1:${port}/forbidden`, 2_000), 'unreachable', '503 não vira ok');
    assert.equal(await httpProbe(`http://127.0.0.1:${port}/nao-existe`, 2_000), 'unreachable', '404 não vira ok');
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
  // porta morta (servidor fechado): conexão recusada → unreachable
  assert.equal(await httpProbe(`http://127.0.0.1:${port}/ready`, 2_000), 'unreachable');
});

test('probe ok com cache por TTL (sem inferência)', async () => {
  let now = 0;
  let calls = 0;
  const r = new LlmReadiness({
    baseUrl: 'http://llm.local/v1',
    ttlMs: 60_000,
    now: () => now,
    probe: async () => {
      calls++;
      return 'ok';
    },
  });
  assert.equal(await r.check(), 'ok');
  assert.equal(await r.check(), 'ok');
  assert.equal(calls, 1, 'cache evita re-probe dentro do TTL');
  assert.equal(r.lastResult, 'ok');

  now = 60_001; // TTL venceu
  assert.equal(await r.check(), 'ok');
  assert.equal(calls, 2);
});

test('probe unreachable sinaliza offline (cron pula)', async () => {
  const r = new LlmReadiness({
    baseUrl: 'http://llm.local/v1',
    probe: async () => 'unreachable',
  });
  assert.equal(await r.check(), 'unreachable');
});

test('sem baseUrl (LLM remoto) não probe — assume disponível', async () => {
  let calls = 0;
  const r = new LlmReadiness({
    baseUrl: '',
    probe: async () => {
      calls++;
      return 'unreachable';
    },
  });
  assert.equal(await r.check(), 'ok');
  assert.equal(calls, 0);
});

test('invalidate força novo probe e single-flight deduplica concorrentes', async () => {
  let now = 0;
  let inflight = 0;
  let maxInflight = 0;
  let calls = 0;
  const r = new LlmReadiness({
    baseUrl: 'http://llm.local/v1',
    ttlMs: 1_000,
    now: () => now,
    probe: async () => {
      calls++;
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((res) => setTimeout(res, 10));
      inflight--;
      return 'ok';
    },
  });
  const [a, b] = await Promise.all([r.check(), r.check()]);
  assert.equal(a, 'ok');
  assert.equal(b, 'ok');
  assert.equal(calls, 1, 'checagens concorrentes compartilham o mesmo probe');
  assert.equal(maxInflight, 1);

  r.invalidate();
  assert.equal(await r.check(), 'ok');
  assert.equal(calls, 2);
});
