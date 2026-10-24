import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Integração REAL do app Hono (app.request — sem servidor TCP, sem rede).
 * Env de teste ANTES do import (config.ts valida API_TOKEN/DATABASE_URL no
 * import). DATABASE_URL aponta para porta fechada: pg.Pool é lazy e NENHUM
 * teste abaixo toca rota com banco; waitlist é exercitada só nos caminhos
 * 400/413/429 que antecedem o INSERT.
 */
process.env.API_TOKEN = 'token-de-teste';
process.env.DATABASE_URL = 'postgres://nobody:nopass@127.0.0.1:1/nao-conecta';
process.env.PORT = '0';
process.env.OPENAI_COMPAT_URL = '';
process.env.ANTHROPIC_API_KEY = '';

const { app } = await import('../src/api.js');
const { pool } = await import('../src/db.js');

const TOKEN = { Authorization: 'Bearer token-de-teste' };

test('GET /health é liveness puro', async () => {
  const res = await app.request('/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('GET /api/status: 401 sem/sem token, 200 com token e campos aditivos', async () => {
  assert.equal((await app.request('/api/status')).status, 401);
  assert.equal((await app.request('/api/status', { headers: { Authorization: 'Bearer errado' } })).status, 401);

  const res = await app.request('/api/status', { headers: TOKEN });
  assert.equal(res.status, 200);
  const body = await res.json();
  // campos legados preservados (compat com UI atual)
  assert.equal(typeof body.connected, 'boolean');
  assert.equal('qr' in body, true);
  assert.equal('me' in body, true);
  assert.equal('syncing' in body, true);
  // campos aditivos
  assert.equal(body.connectionState, 'disconnected', 'sem Baileys iniciado neste teste');
  assert.equal(body.readOnly, true);
  assert.equal(typeof body.updatedAt, 'string');
  assert.ok(!body.qr, 'sem QR sem conexão');
  assert.equal(body.lastConnectedAt, null);
});

test('GET /api/status expõe cursor gravado e saúde de escrita sem conteúdo', async () => {
  const original = pool.query.bind(pool);
  (pool as any).query = async (statement: string) => ({ rows: statement.includes('max_saved_seq')
    ? [{ max_saved_seq: '42', last_ingested_at: new Date('2026-10-23T10:00:00.000Z') }]
    : [{ last_saved_message_at: new Date('2026-10-23T09:59:00.000Z'), new_message_after_connect: false }] });
  try {
    const response = await app.request('/api/status', { headers: TOKEN });
    assert.equal(response.status, 200);
    const evidence = (await response.json()).syncEvidence;
    assert.equal(evidence.available, true);
    assert.equal(evidence.maxSavedSeq, '42');
    assert.equal(evidence.lastIngestedAt, '2026-10-23T10:00:00.000Z');
    assert.equal(evidence.lastSavedMessageAt, '2026-10-23T09:59:00.000Z');
    assert.equal(typeof evidence.writeHealth.consecutiveWriteFailures, 'number');
    assert.equal(evidence.pendingInMemory, 0);
    assert.equal(evidence.recoveryDurable, false);
    assert.equal('lastWriteSuccessAt' in evidence.writeHealth, true);
    assert.equal('lastWriteFailureAt' in evidence.writeHealth, true);
    assert.equal(JSON.stringify(evidence).includes('synthetic private value'), false);
  } finally {
    (pool as any).query = original;
  }
});

test('o seletor de grupos mostra grupos conhecidos mesmo antes das mensagens, sem mudar a lista geral', async () => {
  const original = pool.query.bind(pool);
  const sql: string[] = [];
  (pool as any).query = async (statement: string) => {
    sql.push(statement);
    const group = statement.includes('WHERE ch.is_group = true');
    const rows = statement.startsWith('SELECT COUNT(*)::int AS n FROM wa_chats')
      ? [{ n: group ? 1 : 0 }]
      : group ? [{ jid: 'synthetic@g.us', name: 'Grupo sintético', pn_jid: 'synthetic@g.us', is_group: true, tracked: false, last_message_at: null, message_count: 0, last_message_preview: null }] : [];
    return { rows };
  };
  try {
    const groups = await app.request('/api/chats?kind=group', { headers: TOKEN });
    assert.equal(groups.status, 200);
    assert.deepEqual((await groups.json()).chats.map((chat: { jid: string; message_count: number }) => [chat.jid, chat.message_count]), [['synthetic@g.us', 0]]);
    const all = await app.request('/api/chats?kind=all', { headers: TOKEN });
    assert.equal(all.status, 200);
    assert.equal((await all.json()).total, 0);
    assert.equal((await app.request('/api/chats?kind=invalid', { headers: TOKEN })).status, 400);
    assert.equal(sql.length, 4, 'kind inválido é rejeitado antes de consultar o banco');
  } finally {
    (pool as any).query = original;
  }
});

test('XFF/x-real-ip forjáveis NÃO dividem o limite: rotação de header não evade o bucket global', async () => {
  // trust boundary: sem TRUST_CLOUDFLARE_PROXY, todos os headers de cliente
  // são ignorados — um bucket global único absorve o abuso.
  let saw429 = false;
  for (let i = 0; i < 30 && !saw429; i++) {
    const res = await app.request('/api/status', {
      headers: {
        Authorization: 'Bearer errado',
        'X-Forwarded-For': `10.0.${i}.${i}`, // IP "novo" a cada tentativa
        'x-real-ip': `192.168.${i}.${i}`,
        'cf-connecting-ip': `1.2.3.${i}`, // sem flag de confiança → ignorado
      },
    });
    if (res.status === 429) saw429 = true;
  }
  assert.equal(saw429, true, '30 falhas com IPs forjados distintos esgotam o bucket global');
  // mesmo trocando TODOS os headers de novo, continua bloqueado (mesma chave)
  const res = await app.request('/api/status', {
    headers: { Authorization: 'Bearer errado', 'X-Forwarded-For': '9.9.9.9', 'cf-connecting-ip': '8.8.8.8' },
  });
  assert.equal(res.status, 429);
});

test('auth com falha é rate-limited por IP e 429 traz Retry-After', async () => {
  let saw429 = false;
  let last = 0;
  for (let i = 0; i < 45 && !saw429; i++) {
    const res = await app.request('/api/status', { headers: { Authorization: 'Bearer errado' } });
    last = res.status;
    if (res.status === 429) {
      saw429 = true;
      assert.ok(Number(res.headers.get('retry-after')) > 0);
    }
  }
  assert.equal(saw429, true, `esperava 429 após muitas falhas (último status=${last})`);
  // bloqueado para tentativas ruins...
  assert.equal((await app.request('/api/status', { headers: { Authorization: 'Bearer errado' } })).status, 429);
  // ...mas token VÁLIDO continua funcionando (limite é de falhas)
  assert.equal((await app.request('/api/status', { headers: TOKEN })).status, 200);
});

test('CORS: preflight permitido 204, proibido 403, resposta sem ACAO p/ origem ruim', async () => {
  const ok = await app.request('/api/status', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://suco-de-zap.pages.dev',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization',
    },
  });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://suco-de-zap.pages.dev');
  assert.match(ok.headers.get('access-control-allow-headers') || '', /authorization/i);
  assert.match(ok.headers.get('access-control-allow-headers') || '', /x-suco-vault-token/i);

  const bad = await app.request('/api/status', {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.com', 'Access-Control-Request-Method': 'GET' },
  });
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get('access-control-allow-origin'), null);

  // GET de origem ruim: processa (curl não é browser) mas NÃO ganha ACAO
  const getBad = await app.request('/api/status', { headers: { Origin: 'https://evil.com', ...TOKEN } });
  assert.equal(getBad.status, 200);
  assert.equal(getBad.headers.get('access-control-allow-origin'), null);

  const getOk = await app.request('/api/status', { headers: { Origin: 'http://localhost:5173', ...TOKEN } });
  assert.equal(getOk.headers.get('access-control-allow-origin'), 'http://localhost:5173');
});

test('bodyLimit streaming (middleware oficial): chunked SEM content-length conta BYTES, não UTF-16', async () => {
  // 6.000 emojis 🚀 = 24.000 bytes UTF-8, mas só 12.000 unidades UTF-16:
  // o limite de 16 KiB da waitlist só derruba contando BYTES de verdade.
  const emojiBody = JSON.stringify({ email: '🚀'.repeat(6_000) });
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(emojiBody));
      controller.close();
    },
  });
  const req = new Request('http://local/site/waitlist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }, // sem content-length → chunked
    body: stream,
    duplex: 'half', // stream body exige duplex (runtime); cast p/ tipos sem DOM lib
  } as RequestInit);
  const res = await app.request(req);
  assert.equal(res.status, 413, '24.000 bytes > 16 KiB mesmo sendo 12.000 units UTF-16');

  // teto GLOBAL (256 KiB) também vale para rota autenticada com stream puro
  const bigStream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ query: 'x'.repeat(300_000) })));
      controller.close();
    },
  });
  const big = await app.request(
    new Request('http://local/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...TOKEN },
      body: bigStream,
      duplex: 'half',
    } as RequestInit)
  );
  assert.equal(big.status, 413, 'stream sem content-length acima do teto global é cortado');
});

test('JSON array e null no body: 400 limpo, sem crash', async () => {
  const post = (raw: string) =>
    app.request('/site/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: raw,
    });
  assert.equal((await post('[]')).status, 400);
  assert.equal((await post('null')).status, 400);
});

test('CSRF: POST de origem desconhecida NÃO age (403); sem Origin segue; LLM off → 503 imediato', async () => {
  // rota autenticada com token VÁLIDO, mas origem ruim: barrado antes de agir
  const evil = await app.request('/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.com', ...TOKEN },
    body: JSON.stringify({ query: 'teste' }),
  });
  assert.equal(evil.status, 403);
  assert.equal(evil.headers.get('access-control-allow-origin'), null);

  // rota pública (waitlist) também não aceita escrita de origem ruim
  const evilWl = await app.request('/site/waitlist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ email: 'a@b.co' }),
  });
  assert.equal(evilWl.status, 403);

  // sem Origin (curl/server-to-server): passa do CORS; sem LLM configurado
  // o guard de IA responde 503 na hora (não aceita geração, não espera 5 min)
  const noLLM = await app.request('/api/summaries/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...TOKEN },
    body: JSON.stringify({ query: 'teste' }),
  });
  assert.equal(noLLM.status, 503);
  assert.ok(noLLM.headers.get('retry-after'), '503 traz Retry-After');
});

test('Cache-Control: no-store em TODA /api/* (inclusive 401/413)', async () => {
  const ok = await app.request('/api/status', { headers: TOKEN });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  const unauth = await app.request('/api/status');
  assert.ok([401, 429].includes(unauth.status), 'sem token é 401 (ou 429 se o bucket global já esgotou)');
  assert.equal(unauth.headers.get('cache-control'), 'no-store', 'resposta de erro também é no-store');
});

test('waitlist: e-mail inválido 400, body grande 413, flood 429 — sem tocar o banco', async () => {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    app.request('/site/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  const invalid = await post({ email: 'ruim' });
  assert.equal(invalid.status, 400);

  const big = await post({ email: `${'a'.repeat(20_000)}@x.com` });
  assert.equal(big.status, 413, 'body acima de 16 KiB rejeitado antes do banco');

  // limite público: 10/min por IP — mais requests caem em 429
  let saw429 = false;
  for (let i = 0; i < 12; i++) {
    const res = await post({ email: 'ruim' });
    if (res.status === 429) {
      saw429 = true;
      assert.ok(res.headers.get('retry-after'));
      break;
    }
  }
  assert.equal(saw429, true, 'waitlist pública tem rate limit');
});
