import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createSupabaseIngestionSpool } from '../src/lib/supabase-ingestion-spool.js';
import type { StagedMessage } from '../src/lib/ingestion-spool.js';

const ownerId = '11111111-1111-4111-8111-111111111111';
const message: StagedMessage = {
  chat_jid: 'private-chat@example.invalid', id: 'private-message-id',
  sender_jid: 'private-sender@example.invalid', sender_name: 'Private Synthetic Name',
  from_me: false, body: 'PRIVATE_SYNTHETIC_BODY_DO_NOT_EXPOSE',
  msg_type: 'text', ts: new Date('2026-10-23T08:00:00.000Z'),
};
const userJwt = (sub = ownerId, role = 'authenticated') => {
  const payload = { sub, role, exp: Math.floor(Date.now() / 1000) + 3600 };
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
};
type SealedRow = { object_id: string; key_epoch: number; nonce_hex: string; ciphertext_hex: string; revision: number };

function syntheticSupabase() {
  const rows = new Map<string, SealedRow>();
  const requests: string[] = [];
  let dropFirstStageResponse = false;
  let writesEnabled = true;
  const fetcher: typeof fetch = async (url, init) => {
    const name = String(url).split('/').at(-1);
    const raw = String(init?.body);
    requests.push(raw);
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers.apikey, 'sb_publishable_synthetic');
    assert.equal(headers.Authorization, `Bearer ${userJwt()}`);
    const body = JSON.parse(raw) as Record<string, unknown>;
    if ((name === 'suco_ingestion_stage' || name === 'suco_ingestion_ack') && !writesEnabled) {
      return new Response(JSON.stringify({ code: '55000' }), { status: 409 });
    }
    if (name === 'suco_ingestion_stage') {
      const id = body.p_object_id as string;
      if (!rows.has(id)) rows.set(id, {
        object_id: id, key_epoch: body.p_key_epoch as number,
        nonce_hex: body.p_nonce_hex as string,
        ciphertext_hex: body.p_ciphertext_hex as string, revision: 1,
      });
      if (dropFirstStageResponse) { dropFirstStageResponse = false; throw Error('response lost after commit'); }
      return Response.json(1);
    }
    if (name === 'suco_ingestion_list') {
      const after = body.p_after as string | null;
      const found = [...rows.values()].filter((r) => !after || r.object_id > after)
        .sort((a, b) => a.object_id.localeCompare(b.object_id)).slice(0, body.p_limit as number);
      return Response.json(found);
    }
    if (name === 'suco_ingestion_ack') {
      rows.delete(body.p_object_id as string);
      return Response.json(true);
    }
    throw Error('unexpected RPC');
  };
  return { rows, requests, fetcher,
    loseFirstStageResponse: () => { dropFirstStageResponse = true; },
    setWritesEnabled: (value: boolean) => { writesEnabled = value; } };
}

test('ciphertext remote outbox survives VM recreation and uncertain stage/commit responses', async () => {
  const remote = syntheticSupabase();
  const key = randomBytes(32);
  const options = {
    url: 'https://synthetic.supabase.invalid', publishableKey: 'sb_publishable_synthetic',
    ownerId, tenantId: 'tenant-one', keyEpoch: 1, key,
    userJwt: async () => userJwt(), fetcher: remote.fetcher,
  };
  const firstVm = createSupabaseIngestionSpool(options);
  remote.loseFirstStageResponse();
  await firstVm.stage(message);
  assert.equal(remote.rows.size, 1);
  const [stored] = [...remote.rows.values()];
  assert.match(stored.object_id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.doesNotMatch(JSON.stringify(stored), /PRIVATE_SYNTHETIC|private-chat|private-sender/);
  assert.doesNotMatch(remote.requests.join(''), /PRIVATE_SYNTHETIC|private-chat|private-sender/);

  const db = new Set<string>();
  for await (const row of firstVm.pending()) db.add(`${row.chat_jid}/${row.id}`);
  assert.equal(db.size, 1);
  firstVm.close(); // VM disappears after database commit but before ack.

  const secondVm = createSupabaseIngestionSpool(options);
  let replayed = 0;
  for await (const row of secondVm.pending()) {
    replayed++;
    assert.deepEqual(row, message);
    db.add(`${row.chat_jid}/${row.id}`); // DB primary key dedupes replay.
    await secondVm.ack(row.chat_jid, row.id);
  }
  assert.equal(replayed, 1);
  assert.equal(db.size, 1);
  assert.equal(remote.rows.size, 0);
  await secondVm.ack(message.chat_jid, message.id);
  secondVm.close();
});

test('wrong key and tampered ciphertext fail closed; disabled gate never falls back', async () => {
  const remote = syntheticSupabase();
  const key = randomBytes(32);
  const options = {
    url: 'https://synthetic.supabase.invalid', publishableKey: 'sb_publishable_synthetic',
    ownerId, tenantId: 'tenant-one', keyEpoch: 1, key,
    userJwt: async () => userJwt(), fetcher: remote.fetcher,
  };
  const spool = createSupabaseIngestionSpool(options);
  await spool.stage(message);
  const wrong = createSupabaseIngestionSpool({ ...options, key: randomBytes(32) });
  await assert.rejects(async () => { for await (const _ of wrong.pending()) { /* consume */ } },
    { code: 'INGESTION_SPOOL_UNREADABLE' });
  wrong.close();

  const [stored] = [...remote.rows.values()];
  stored.ciphertext_hex = `${stored.ciphertext_hex.slice(0, -2)}00`;
  await assert.rejects(async () => { for await (const _ of spool.pending()) { /* consume */ } },
    { code: 'INGESTION_SPOOL_UNREADABLE' });
  remote.setWritesEnabled(false);
  await assert.rejects(spool.stage(message), { code: 'INGESTION_SPOOL_REMOTE' });
  assert.equal(remote.rows.size, 1);
  spool.close();
});

test('adapter rejects service credentials and another user JWT before network access', async () => {
  const remote = syntheticSupabase();
  const options = {
    url: 'https://synthetic.supabase.invalid', publishableKey: 'sb_publishable_synthetic',
    ownerId, tenantId: 'tenant-one', keyEpoch: 1, key: randomBytes(32),
    userJwt: async () => userJwt('22222222-2222-4222-8222-222222222222'),
    fetcher: remote.fetcher,
  };
  assert.throws(() => createSupabaseIngestionSpool({ ...options, publishableKey: 'sb_secret_wrong' }),
    { code: 'INGESTION_SPOOL_INPUT' });
  const spool = createSupabaseIngestionSpool(options);
  await assert.rejects(spool.stage(message), { code: 'INGESTION_SPOOL_AUTH' });
  assert.equal(remote.requests.length, 0);
  spool.close();
});
