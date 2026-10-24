import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ConnectionTracker,
  FencedTimer,
  backoffDelayMs,
  classifyDisconnect,
  needsUserAction,
  QR_TTL_MS,
} from '../src/lib/connection-state.js';

// ===== classificação de DisconnectReason (códigos reais do Baileys) =====

test('classifyDisconnect mapeia códigos e políticas', () => {
  assert.deepEqual(classifyDisconnect(401), { reason: 'logged_out', autoRetry: false, mayDeleteCreds: true });
  assert.deepEqual(classifyDisconnect(440), { reason: 'connection_replaced', autoRetry: false, mayDeleteCreds: false });
  assert.deepEqual(classifyDisconnect(403), { reason: 'forbidden', autoRetry: false, mayDeleteCreds: false });
  assert.deepEqual(classifyDisconnect(500), { reason: 'bad_session', autoRetry: false, mayDeleteCreds: false });
  assert.deepEqual(classifyDisconnect(411), { reason: 'multidevice_mismatch', autoRetry: false, mayDeleteCreds: false });
  assert.equal(classifyDisconnect(515).reason, 'restart_required');
  assert.equal(classifyDisconnect(515).autoRetry, true);
  assert.equal(classifyDisconnect(503).autoRetry, true);
  assert.equal(classifyDisconnect(428).autoRetry, true);
  assert.equal(classifyDisconnect(408).autoRetry, true);
  assert.equal(classifyDisconnect(undefined).reason, 'unknown');
  assert.equal(classifyDisconnect(undefined).autoRetry, true);
  // credenciais NUNCA são apagadas fora de 401 confirmado
  for (const code of [440, 403, 500, 411, 515, 503, 428, 408, undefined]) {
    assert.equal(classifyDisconnect(code).mayDeleteCreds, false, `code=${code}`);
  }
});

test('needsUserAction bloqueia retry exatamente nas razões de ação', () => {
  for (const r of ['logged_out', 'connection_replaced', 'forbidden', 'bad_session', 'multidevice_mismatch']) {
    assert.equal(needsUserAction(r as never), true);
  }
  for (const r of ['restart_required', 'service_unavailable', 'connection_closed', 'timed_out', 'unknown']) {
    assert.equal(needsUserAction(r as never), false);
  }
});

// ===== máquina de estados com relógio manual =====

function makeTracker() {
  let t = 0;
  return { tracker: new ConnectionTracker(() => t), tick: (ms: number) => (t += ms), now: () => t };
}

test('ciclo completo: connecting → qr_required → connected → queda transitória', () => {
  const { tracker, tick, now } = makeTracker();
  const gen = tracker.beginAttempt();
  let s = tracker.snapshot(now());
  assert.equal(s.connectionState, 'connecting');
  assert.equal(s.connected, false);

  tracker.markQr(gen, 'QR-SEGREDO', now());
  s = tracker.snapshot(now());
  assert.equal(s.connectionState, 'qr_required');
  assert.equal(s.qr, 'QR-SEGREDO');
  assert.equal(s.readOnly, true);
  assert.ok(s.qrExpiresAt);

  tick(QR_TTL_MS - 1);
  s = tracker.snapshot(now());
  assert.equal(s.qr, 'QR-SEGREDO', 'QR ainda válido 1ms antes de expirar');

  tick(2); // expira
  s = tracker.snapshot(now());
  assert.equal(s.qr, null, 'QR expirado não é mais servido');
  assert.equal(s.reason, 'qr_expired');
  assert.equal(s.connectionState, 'qr_required', 'continua precisando de QR');
  assert.ok(s.actionHint?.includes('novo QR'), 'hint manda pedir novo QR');

  tick(60_000);
  tracker.markConnected(gen, { jid: '5511@s.whatsapp.net', name: 'Teste' }, now());
  s = tracker.snapshot(now());
  assert.equal(s.connected, true);
  assert.equal(s.connectionState, 'connected');
  assert.equal(s.qr, null);
  assert.equal(s.me?.jid, '5511@s.whatsapp.net');
  assert.equal(s.reason, null);
  assert.ok(s.lastConnectedAt);

  const d = tracker.markDisconnected(gen, 428, now());
  assert.equal(d.autoRetry, true);
  assert.equal(d.reason, 'connection_closed');
  assert.equal(tracker.snapshot(now()).connectionState, 'reconnecting');
});

test('quedas que exigem ação: sem retry automático, com hint seguro', () => {
  const cases: Array<[number, string]> = [
    [401, 'logged_out'],
    [440, 'connection_replaced'],
    [403, 'forbidden'],
    [500, 'bad_session'],
    [411, 'multidevice_mismatch'],
  ];
  for (const [code, reason] of cases) {
    const { tracker } = makeTracker();
    const gen = tracker.beginAttempt();
    const d = tracker.markDisconnected(gen, code);
    assert.equal(d.reason, reason);
    assert.equal(d.autoRetry, false, `${reason} não reconecta sozinho`);
    const s = tracker.snapshot();
    assert.equal(s.connectionState, 'action_required');
    assert.ok(s.actionHint, `${reason} tem hint`);
  }
  // forbidden (ban): o hint NÃO promete que QR resolve
  const { tracker } = makeTracker();
  const gen = tracker.beginAttempt();
  const d = tracker.markDisconnected(gen, 403);
  assert.ok(d.actionHint?.includes('NÃO resolve'), 'hint de forbidden não promete QR');
});

test('fencing: eventos de geração velha são descartados', () => {
  const { tracker } = makeTracker();
  const gen1 = tracker.beginAttempt();
  const gen2 = tracker.beginAttempt();
  assert.equal(tracker.markQr(gen1, 'VELHO'), false);
  assert.equal(tracker.markConnected(gen1, { jid: 'x', name: null }), false);
  assert.equal(tracker.snapshot().connected, false);
  // queda de geração velha devolve decisão neutra (wa.ts ignora)
  const d = tracker.markDisconnected(gen1, 428);
  assert.equal(d.autoRetry, false);
  assert.equal(d.delayMs, 0);
  assert.equal(tracker.snapshot().connectionState, 'connecting', 'gen2 segue connecting');
  // gen2 conecta normalmente
  tracker.markConnected(gen2, { jid: 'y', name: 'n' });
  assert.equal(tracker.snapshot().connected, true);
});

test('markStopped INVALIDA a geração corrente — start pendente morre no recheck', () => {
  const { tracker, now } = makeTracker();
  const gen = tracker.beginAttempt();
  tracker.markQr(gen, 'QR-SEGREDO', now());
  tracker.markStopped(now());
  // geração da tentativa que estava em await (auth/version fetch) está morta:
  // qualquer coisa que ela tente registrar depois do logout é descartada.
  assert.equal(tracker.isCurrent(gen), false);
  assert.equal(tracker.markQr(gen, 'QR2'), false);
  assert.equal(tracker.markConnected(gen, { jid: 'x', name: null }), false);
  assert.equal(tracker.markSyncing(gen, true), false);
  const d = tracker.markDisconnected(gen, 428);
  assert.equal(d.autoRetry, false, 'decisão neutra para geração morta');
  const s = tracker.snapshot(now());
  assert.equal(s.connectionState, 'disconnected');
  assert.equal(s.reason, 'stopped');
  assert.equal(s.qr, null, 'QR de tentativa morta não vaza');
});

test('markSyncing preserva o estado REAL: true no lote, false ao terminar', () => {
  const { tracker, now } = makeTracker();
  const gen = tracker.beginAttempt();
  tracker.markConnected(gen, { jid: 'x@s.whatsapp.net', name: null }, now());
  assert.equal(tracker.snapshot(now()).syncing, false);
  assert.equal(tracker.markSyncing(gen, true, now()), true);
  assert.equal(tracker.snapshot(now()).syncing, true, 'durante o processamento do lote');
  assert.equal(tracker.markSyncing(gen, false, now()), true);
  assert.equal(tracker.snapshot(now()).syncing, false, 'lote terminou');
  // queda no meio do sync reseta a flag (não fica 'syncing' eterno)
  tracker.markSyncing(gen, true, now());
  tracker.markDisconnected(gen, 428, now());
  assert.equal(tracker.snapshot(now()).syncing, false);
  // geração morta não altera syncing
  tracker.markStopped(now());
  assert.equal(tracker.markSyncing(gen, true, now()), false);
  assert.equal(tracker.snapshot(now()).syncing, false);
});

test('backoff exponencial com teto e reset ao conectar', () => {
  assert.equal(backoffDelayMs(1), 3_000);
  assert.equal(backoffDelayMs(2), 6_000);
  assert.equal(backoffDelayMs(3), 12_000);
  assert.equal(backoffDelayMs(10), 300_000, 'teto de 5 min');
  assert.equal(backoffDelayMs(50), 300_000);
  // jitter clampa dentro de [base, max]
  const j = backoffDelayMs(5, { jitter: () => 999_999_999 });
  assert.equal(j, 300_000);

  const { tracker, now } = makeTracker();
  let gen = tracker.beginAttempt(); // attempt 1
  let d = tracker.markDisconnected(gen, 428, now());
  assert.equal(d.delayMs, 3_000);
  gen = tracker.beginAttempt(); // attempt 2
  d = tracker.markDisconnected(gen, 428, now());
  assert.equal(d.delayMs, 6_000);
  tracker.markConnected(gen, null, now()); // zera backoff
  gen = tracker.beginAttempt();
  d = tracker.markDisconnected(gen, 428, now());
  assert.equal(d.delayMs, 3_000, 'após conectar, backoff recomeça da base');
});

// ===== FencedTimer com timers FALSOS (node:test mock.timers) =====

test('FencedTimer: um retry pendente, cancela anterior, descarta geração velha', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const tracker = new ConnectionTracker();
    const gen = tracker.beginAttempt();
    let fired = 0;

    const timer = new FencedTimer(tracker);
    timer.schedule(gen, () => fired++, 3_000);
    timer.schedule(gen, () => fired++, 5_000); // substitui o anterior
    t.mock.timers.tick(4_999);
    assert.equal(fired, 0, 'primeiro timer foi cancelado, nada disparou antes dos 5s');
    t.mock.timers.tick(1);
    assert.equal(fired, 1, 'disparou exatamente uma vez');

    // geração nova invalida timer agendado pela velha
    timer.schedule(gen, () => fired++, 1_000);
    tracker.beginAttempt(); // bump de geração
    t.mock.timers.tick(5_000);
    assert.equal(fired, 1, 'timer stale NÃO dispara após nova geração');

    // clear() derruba o pendente
    timer.schedule(tracker.currentGeneration, () => fired++, 1_000);
    timer.clear();
    t.mock.timers.tick(5_000);
    assert.equal(fired, 1);
  } finally {
    t.mock.timers.reset();
  }
});

test('FencedTimer descarta callback já enfileirado após cancelamento na mesma geração', () => {
  const tracker = new ConnectionTracker();
  const gen = tracker.beginAttempt();
  const queued: Array<() => void> = [];
  const timer = new FencedTimer(tracker, {
    set: (fn) => { queued.push(fn); return queued.length; },
    clear: () => {},
  });
  let fired = 0;
  timer.schedule(gen, () => fired++, 1_000);
  timer.schedule(gen, () => fired++, 1_000);
  queued[0](); // callback entregue pelo event loop depois do clear
  assert.equal(fired, 0);
  queued[1]();
  assert.equal(fired, 1);
  timer.schedule(gen, () => fired++, 1_000);
  timer.clear();
  queued[2]();
  assert.equal(fired, 1);
});
