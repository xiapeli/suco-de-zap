import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCorsAllowlist,
  buildReadyReport,
  isBodyTooLarge,
  RateLimiter,
  renderReadyPublic,
  validateWaitlistInput,
} from '../src/lib/http-guards.js';
import { AiConcurrencyGate } from '../src/lib/ai-gate.js';

// ===== AiConcurrencyGate (concorrência 1 de operações de IA) =====

test('AiConcurrencyGate: fail-fast 429 (retryAfter), release idempotente', () => {
  const g = new AiConcurrencyGate(1);
  const s1 = g.tryAcquire();
  assert.equal(s1.ok, true);
  assert.equal(g.current, 1);
  const s2 = g.tryAcquire();
  assert.equal(s2.ok, false, 'segunda operação de IA não enfileira');
  if (!s2.ok) assert.ok(s2.retryAfterMs > 0, 'vem com Retry-After');
  if (s1.ok) {
    s1.release();
    s1.release(); // double-release não devolve slot a mais
  }
  assert.equal(g.current, 0);
  assert.equal(g.tryAcquire().ok, true, 'slot volta após release');
});

// ===== CORS allowlist =====

test('allowlist default: localhost + Pages + previews; sem wildcard aberto', () => {
  const a = buildCorsAllowlist({});
  assert.equal(a.allowed('http://localhost:5173'), true);
  assert.equal(a.allowed('http://127.0.0.1:3000'), true);
  assert.equal(a.allowed('https://suco-de-zap.pages.dev'), true);
  assert.equal(a.allowed('https://abc123.suco-de-zap.pages.dev'), true, 'preview do Pages');
  assert.equal(a.allowed('https://evil.com'), false);
  assert.equal(a.allowed('https://sub.evil.com'), false);
  assert.equal(a.allowed(undefined), false, 'sem Origin não precisa allowlist');
});

test('allowlist configurável via CORS_ORIGINS substitui o default', () => {
  const a = buildCorsAllowlist({ corsOrigins: 'https://a.com, https://b*.example.com' });
  assert.equal(a.allowed('https://a.com'), true);
  assert.equal(a.allowed('https://bx.example.com'), true);
  assert.equal(a.allowed('https://suco-de-zap.pages.dev'), false, 'default não vale mais');
});

test('PUBLIC_DOMAIN entra no default (apex + subdomínios)', () => {
  const a = buildCorsAllowlist({ publicDomain: 'suco.app.br' });
  assert.equal(a.allowed('https://suco.app.br'), true);
  assert.equal(a.allowed('https://app.suco.app.br'), true);
  assert.equal(a.allowed('https://nao-e-suco.app.br'), false, 'suffix não casa');
});

// ===== RateLimiter =====

test('RateLimiter: janela fixa, 429 e recuperação', () => {
  let now = 0;
  const rl = new RateLimiter({ windowMs: 1_000, max: 3, now: () => now });

  assert.equal(rl.check('ip').allowed, true);
  assert.equal(rl.check('ip').allowed, true);
  assert.equal(rl.check('ip').remaining, 0);
  const blocked = rl.check('ip');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterMs, 1_000);
  // outra chave tem orçamento próprio
  assert.equal(rl.check('outro').allowed, true);

  now = 1_000; // janela virou
  assert.equal(rl.check('ip').allowed, true);

  rl.check('ip2');
  rl.check('ip2');
  rl.reset('ip2');
  assert.equal(rl.check('ip2').remaining, 2, 'reset libera a chave');
});

test('RateLimiter: teto de chaves com eviction — sem DoS de memória', () => {
  let now = 0;
  const rl = new RateLimiter({ windowMs: 10_000, max: 5, maxKeys: 3, now: () => now });
  rl.check('a');
  rl.check('b');
  rl.check('c');
  assert.equal(rl.keyCount, 3);
  rl.check('d'); // teto atingido: evicta a mais antiga ('a')
  assert.equal(rl.keyCount, 3, 'mapa nunca passa do teto');
  const again = rl.check('a'); // 'a' foi evictada → orçamento fresco
  assert.equal(again.allowed, true);
  assert.equal(again.remaining, 4, 'chave evictada recomeça do zero');

  now = 10_000; // todas as janelas expiraram: a varredura libera sem evictar ativas
  rl.check('e');
  assert.ok(rl.keyCount <= 3);
  assert.equal(rl.check('f').allowed, true);
});

// ===== body size =====

test('isBodyTooLarge: content-length declarado e tamanho real', () => {
  assert.equal(isBodyTooLarge('300', 50, 256), true, 'declarado acima do teto');
  assert.equal(isBodyTooLarge(undefined, 300, 256), true, 'real acima do teto');
  assert.equal(isBodyTooLarge('100', 100, 256), false);
  assert.equal(isBodyTooLarge('abc', 10, 256), false, 'header lixo não derruba');
});

// ===== waitlist =====

test('validateWaitlistInput aceita e corta (clip) campos', () => {
  const v = validateWaitlistInput({
    email: '  Phelipe@Example.COM ',
    name: `Nome ${'x'.repeat(200)}`,
    profession: 'dev',
    whatsapp: '  11999888777  ',
    source: 'lp',
  });
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal(v.value.email, 'phelipe@example.com');
    assert.equal(v.value.name!.length, 120, 'nome clipado em 120');
    assert.equal(v.value.whatsapp, '11999888777');
  }
});

test('validateWaitlistInput rejeita e-mail inválido / corpo ruim', () => {
  assert.equal(validateWaitlistInput({ email: 'sem-arroba' }).ok, false);
  assert.equal(validateWaitlistInput({}).ok, false);
  assert.equal(validateWaitlistInput(null).ok, false);
  assert.equal(
    validateWaitlistInput({ email: `${'a'.repeat(300)}@x.com` }).ok,
    false,
    'email maior que 254'
  );
  // vazio vira null, não string vazia
  const v = validateWaitlistInput({ email: 'ok@ok.com', name: '   ' });
  assert.equal(v.ok && v.value.name, null);
});

// ===== /ready shapes =====

test('buildReadyReport/renderReadyPublic: detalhe só p/ auth, público genérico', () => {
  const ok = buildReadyReport({ postgres: 'ok', llm: 'ok' });
  assert.equal(ok.ok, true);
  const bad = buildReadyReport({ postgres: 'ok', llm: 'unreachable' });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.deepEqual(bad.failing, ['llm']);
  // público: SÓ o booleano — sem componentes, sem detalhes
  const pub = renderReadyPublic(bad);
  assert.deepEqual(Object.keys(pub), ['ok']);
  assert.equal(pub.ok, false);
});
