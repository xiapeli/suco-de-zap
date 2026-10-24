import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createConfidentialMessageStore } from '../src/lib/confidential-message-store.js';
import type { StagedMessage } from '../src/lib/ingestion-spool.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const jwt = (sub: string) => `header.${Buffer.from(JSON.stringify({
  sub, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600,
})).toString('base64url')}.signature`;

type Cipher = { object_id: string; key_epoch: number; nonce_hex: string; ciphertext_hex: string; revision: number };
function remote() {
  const pending = new Map<string, Map<string, Cipher>>();
  const committed = new Map<string, Map<string, Cipher>>();
  const requests: string[] = [];
  let messageListCalls = 0;
  let failAck = false;
  const bucket = (table: Map<string, Map<string, Cipher>>, owner: string) => {
    let values = table.get(owner);
    if (!values) { values = new Map(); table.set(owner, values); }
    return values;
  };
  const fetcher: typeof fetch = async (url, init) => {
    const name = String(url).split('/').at(-1);
    const headers = init?.headers as Record<string, string>;
    const token = headers.Authorization.slice('Bearer '.length).split('.')[1];
    const owner = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')).sub as string;
    const raw = String(init?.body);
    requests.push(raw);
    const body = JSON.parse(raw) as Record<string, unknown>;
    const table = name?.startsWith('suco_ingestion_') ? bucket(pending, owner) : bucket(committed, owner);
    if (name?.endsWith('_stage') || name?.endsWith('_commit')) {
      const id = body.p_object_id as string;
      const created = !table.has(id);
      if (created) table.set(id, {
        object_id: id, key_epoch: body.p_key_epoch as number,
        nonce_hex: body.p_nonce_hex as string,
        ciphertext_hex: body.p_ciphertext_hex as string, revision: 1,
      });
      return Response.json(name.endsWith('_commit') ? { revision: 1, created } : 1);
    }
    if (name?.endsWith('_list')) {
      if (name === 'suco_message_list') messageListCalls++;
      const after = body.p_after as string | null;
      const rows = [...table.values()].filter((row) => !after || row.object_id > after)
        .sort((a, b) => a.object_id.localeCompare(b.object_id)).slice(0, body.p_limit as number);
      return Response.json(rows);
    }
    if (name === 'suco_message_read') {
      const row = table.get(body.p_object_id as string);
      return Response.json(row ? [row] : []);
    }
    if (name === 'suco_ingestion_ack') {
      if (failAck) throw Error('synthetic ack outage');
      table.delete(body.p_object_id as string);
      return Response.json(true);
    }
    throw Error('unexpected RPC');
  };
  return { pending, committed, requests, fetcher,
    messageListCalls: () => messageListCalls,
    failAck: (value: boolean) => { failAck = value; } };
}

function message(id: number, chat: string): StagedMessage {
  return {
    chat_jid: chat, id: `synthetic-message-${id}`,
    sender_jid: null, sender_name: null, from_me: false,
    body: `PRIVATE_SYNTHETIC_BODY_${id}`, msg_type: 'text',
    ts: new Date(Date.UTC(2026, 9, 23, 8, id)),
  };
}

test('two owners remain isolated; 105 ciphertext rows page and filter only after decryption', async () => {
  const server = remote();
  const keyA = randomBytes(32);
  const keyB = randomBytes(32);
  const common = { url: 'https://synthetic.supabase.invalid', publishableKey: 'sb_publishable_synthetic',
    tenantId: 'tenant-a', keyEpoch: 1, fetcher: server.fetcher };
  const a = createConfidentialMessageStore({ ...common, ownerId: A, key: keyA, userJwt: async () => jwt(A) });
  const b = createConfidentialMessageStore({ ...common, ownerId: B, tenantId: 'tenant-b', key: keyB,
    userJwt: async () => jwt(B) });
  for (let n = 0; n < 105; n++) await a.ingest(message(n, n < 100 ? 'private-chat-a' : 'private-chat-a-extra'));
  await b.ingest(message(200, 'private-chat-b'));
  assert.equal(server.committed.get(A)?.size, 105);
  assert.equal(server.committed.get(B)?.size, 1);
  assert.equal(server.pending.get(A)?.size, 0);
  assert.doesNotMatch(server.requests.join(''), /PRIVATE_SYNTHETIC|private-chat/);
  assert.doesNotMatch(JSON.stringify([...server.committed.get(A)!.values()]), /PRIVATE_SYNTHETIC|private-chat/);

  const aAgain = createConfidentialMessageStore({ ...common, ownerId: A, key: keyA, userJwt: async () => jwt(A) });
  const [found, snapshot, evidence] = await Promise.all([
    aAgain.query({ chatJid: 'private-chat-a', text: 'BODY_9', limit: 1000 }),
    aAgain.snapshot(), aAgain.evidence(),
  ]);
  assert.equal(found.length, 11);
  assert.equal(snapshot.length, 105);
  assert.equal(evidence.lastIngestedAt, null); // Restart cannot invent an ingestion clock.
  assert.equal(server.messageListCalls(), 2); // Concurrent reads share both RPC pages.
  assert.equal((await b.query({ limit: 1000 })).length, 1);
  assert.equal((await aAgain.stats('private-chat-a')).totalMessages, 100);
  assert.equal((await aAgain.query({ chatJid: 'private-chat-b' })).length, 0);
  a.close();
  aAgain.close();
  b.close();
});

test('VM recreation replays pending stage and an ambiguous commit before outbox ack', async () => {
  const server = remote();
  const options = { url: 'https://synthetic.supabase.invalid', publishableKey: 'sb_publishable_synthetic',
    ownerId: A, tenantId: 'tenant-a', keyEpoch: 1, key: randomBytes(32),
    userJwt: async () => jwt(A), fetcher: server.fetcher };
  const first = createConfidentialMessageStore(options);
  await first.stage(message(1, 'private-chat-a'));
  first.close(); // Stage persisted, VM vanished before commit.
  const second = createConfidentialMessageStore(options);
  assert.equal(await second.replay(), 1);
  assert.equal(server.committed.get(A)?.size, 1);
  assert.equal(server.pending.get(A)?.size, 0);

  server.failAck(true);
  await assert.rejects(second.ingest(message(2, 'private-chat-a')), { code: 'INGESTION_SPOOL_REMOTE' });
  assert.equal(server.committed.get(A)?.size, 2);
  assert.equal(server.pending.get(A)?.size, 1);
  second.close();
  server.failAck(false);
  const third = createConfidentialMessageStore(options);
  assert.equal(await third.replay(), 1);
  assert.equal(server.committed.get(A)?.size, 2);
  assert.equal(server.pending.get(A)?.size, 0);
  assert.equal((await third.query({ chatJid: 'private-chat-a', limit: 1000 })).length, 2);
  third.close();
});

test('replay revalidates authorization per message and keeps uncommitted work pending', async () => {
  const server = remote();
  const options = { url: 'https://synthetic.supabase.invalid', publishableKey: 'sb_publishable_synthetic',
    ownerId: A, tenantId: 'tenant-a', keyEpoch: 1, key: randomBytes(32),
    userJwt: async () => jwt(A), fetcher: server.fetcher };
  const first = createConfidentialMessageStore(options);
  await first.stage(message(1, 'private-chat-a'));
  await first.stage(message(2, 'private-chat-a'));
  first.close();

  const restarted = createConfidentialMessageStore(options);
  let checks = 0;
  await assert.rejects(restarted.replay(async () => ++checks < 3), { code: 'INGESTION_SPOOL_AUTH' });
  assert.equal(checks, 3); // Before listing, before first commit, before second commit.
  assert.equal(server.committed.get(A)?.size, 1);
  assert.equal(server.pending.get(A)?.size, 1);
  assert.equal(await restarted.replay(async () => true), 1);
  assert.equal(server.committed.get(A)?.size, 2);
  assert.equal(server.pending.get(A)?.size, 0);
  restarted.close();
});

test('ambiguous commit does not acknowledge a tampered primary ciphertext', async () => {
  const server = remote();
  const options = { url: 'https://synthetic.supabase.invalid', publishableKey: 'sb_publishable_synthetic',
    ownerId: A, tenantId: 'tenant-a', keyEpoch: 1, key: randomBytes(32),
    userJwt: async () => jwt(A), fetcher: server.fetcher };
  const first = createConfidentialMessageStore(options);
  server.failAck(true);
  await assert.rejects(first.ingest(message(1, 'private-chat-a')), { code: 'INGESTION_SPOOL_REMOTE' });
  first.close();
  server.failAck(false);
  const row = [...server.committed.get(A)!.values()][0];
  row.ciphertext_hex = '00'.repeat(row.ciphertext_hex.length / 2);
  const restarted = createConfidentialMessageStore(options);
  await assert.rejects(restarted.replay(), { code: 'INGESTION_SPOOL_UNREADABLE' });
  assert.equal(server.pending.get(A)?.size, 1);
  restarted.close();
});
