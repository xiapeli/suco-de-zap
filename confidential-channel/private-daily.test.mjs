import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createPrivateDaily } from './private-daily.mjs';

const ownerId = '11111111-1111-4111-8111-111111111111';
const chat = { jid: 'private-test@g.us', name: 'Synthetic group', is_group: true,
  tracked: true, archived: false, tracked_since: '2026-10-22T10:00:00.000Z' };
const messages = Array.from({ length: 5 }, (_, index) => ({ chat_jid: chat.jid,
  ts: new Date(`2026-10-22T15:0${index}:00.000Z`) }));

test('private daily runs after 08:00 São Paulo, uses a stable opaque job and skips completed work', async () => {
  const started = [];
  const states = new Map();
  const base = { ownerId, secret: randomBytes(32), metadata: { chatList: async () => [chat] },
    messages: { snapshot: async () => messages }, authorize: async () => true,
    catalogVersion: 'suco-17-v1', now: () => new Date('2026-10-23T12:00:00.000Z'),
    summaries: { status: async id => ({ state: states.get(id) ?? 'missing' }),
      generateAutomatic: async request => { started.push(request); states.set(request.request_id, 'complete'); } } };
  const daily = createPrivateDaily(base);
  assert.deepEqual(await daily.run(), { started: 1, pending: 0, completed: 0 });
  assert.deepEqual(await daily.run(), { started: 0, pending: 0, completed: 1 });
  assert.equal(started.length, 1);
  assert.equal(started[0].start, '2026-10-22T15:00:00.000Z');
  assert.equal(started[0].end, '2026-10-22T15:04:00.000Z');
  assert.doesNotMatch(started[0].request_id, /private-test|g\.us/);
  daily.close();
  const early = createPrivateDaily({ ...base, now: () => new Date('2026-10-23T10:00:00.000Z') });
  assert.deepEqual(await early.run(), { skipped: true });
  early.close();
});

test('private daily waits for synchronization and denies jobs when the account is inactive', async () => {
  let sync = true, authorized = true, calls = 0;
  const daily = createPrivateDaily({ ownerId, secret: randomBytes(32),
    metadata: { chatList: async () => [chat] }, messages: { snapshot: async () => messages },
    summaries: { status: async () => ({ state: 'missing' }),
      generateAutomatic: async () => { calls++; } }, catalogVersion: 'suco-17-v1',
    now: () => new Date('2026-10-23T12:00:00.000Z'),
    syncing: () => sync, authorize: async () => authorized });
  assert.deepEqual(await daily.run(), { skipped: true });
  sync = false; authorized = false;
  assert.deepEqual(await daily.run(), { skipped: true });
  assert.equal(calls, 0);
  daily.close();
});

test('private daily retries a failed job with a new stable ID and stops after three attempts', async () => {
  const states = new Map(), started = [];
  const daily = createPrivateDaily({ ownerId, secret: randomBytes(32),
    metadata: { chatList: async () => [chat] }, messages: { snapshot: async () => messages },
    summaries: { status: async id => ({ state: states.get(id) ?? 'missing' }),
      generateAutomatic: async request => { started.push(request.request_id); states.set(request.request_id, 'failed'); } },
    catalogVersion: 'suco-17-v1', now: () => new Date('2026-10-23T12:00:00.000Z'),
    authorize: async () => true });
  assert.equal((await daily.run()).started, 1);
  assert.equal((await daily.run()).started, 1);
  assert.equal((await daily.run()).started, 1);
  assert.deepEqual(await daily.run(), { started: 0, pending: 1, completed: 0 });
  assert.equal(new Set(started).size, 3);
  daily.close();
});

test('private daily limits new model jobs on each run', async () => {
  const chats = Array.from({ length: 4 }, (_, index) => ({ ...chat, jid: `test-${index}@g.us` }));
  const rows = chats.flatMap(item => messages.map(message => ({ ...message, chat_jid: item.jid })));
  const started = [];
  const daily = createPrivateDaily({ ownerId, secret: randomBytes(32),
    metadata: { chatList: async () => chats }, messages: { snapshot: async () => rows },
    summaries: { status: async () => ({ state: 'missing' }),
      generateAutomatic: async request => { started.push(request.request_id); } },
    catalogVersion: 'suco-17-v1', now: () => new Date('2026-10-23T12:00:00.000Z'),
    authorize: async () => true, maxStartsPerRun: 2 });
  assert.deepEqual(await daily.run(), { started: 2, pending: 0, completed: 0, backlog: true });
  assert.equal(started.length, 2);
  daily.close();
});
