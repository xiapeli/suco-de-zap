import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createConfidentialSummaryStore } from '../src/lib/confidential-summary-store.js';
import { createConfidentialSummaryService } from '../src/lib/confidential-summary-service.js';
import type { ConfidentialMessageStore } from '../src/lib/confidential-message-store.js';
import type { ConfidentialMetadataStore } from '../src/lib/confidential-metadata-store.js';
import type { ConfidentialGlm } from '../src/lib/confidential-glm.js';
import { JUICE_CATALOG_VERSION } from '../src/juice-catalog.js';

const owner = '11111111-1111-4111-8111-111111111111';
const token = `header.${Buffer.from(JSON.stringify({ sub: owner, role: 'authenticated',
  exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.sig`;
type CipherRow = { object_id: string; key_epoch: number; nonce: string; ciphertext: string; revision: number };

function remote() {
  const rows = new Map<string, CipherRow>();
  const rawBodies: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const address = new URL(String(url));
    if (address.pathname.endsWith('/rpc/suco_cipher_put')) {
      const raw = String(init?.body);
      rawBodies.push(raw);
      const body = JSON.parse(raw) as Record<string, unknown>;
      const id = body.p_object_id as string;
      const expected = Number(body.p_expected_revision);
      const prior = rows.get(id);
      if ((prior?.revision ?? 0) !== expected) return Response.json({ code: '40001' }, { status: 409 });
      rows.set(id, { object_id: id, key_epoch: Number(body.p_key_epoch),
        nonce: body.p_nonce as string, ciphertext: body.p_ciphertext as string,
        revision: expected + 1 });
      return Response.json(expected + 1);
    }
    if (address.pathname.endsWith('/rpc/suco_cipher_delete')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const id = String(body.p_object_id);
      const row = rows.get(id);
      if (!row || row.revision !== Number(body.p_expected_revision)) return Response.json(false);
      rows.delete(id);
      return Response.json(true);
    }
    if (address.pathname.endsWith('/suco_cipher_objects')) {
      const id = address.searchParams.get('object_id')?.replace(/^eq\./, '');
      return Response.json(id ? (rows.has(id) ? [rows.get(id)] : []) : [...rows.values()]);
    }
    throw Error('unexpected request');
  };
  return { fetcher, rows, rawBodies };
}

test('private summary job and result stay encrypted, scoped to key, and survive a new store instance', async () => {
  const server = remote(), key = randomBytes(32), id = randomUUID(), fingerprint = 'a'.repeat(64);
  const options = { url: 'https://synthetic.supabase.invalid', publishableKey: 'sb_publishable_synthetic',
    ownerId: owner, keyEpoch: 1, key, userJwt: async () => token, fetcher: server.fetcher };
  const store = createConfidentialSummaryStore(options);
  assert.equal(await store.reserve(id, fingerprint), null);
  await assert.rejects(store.reserve(id, fingerprint), /PRIVATE_SUMMARY_PENDING/);
  const summary = { id, chat_jid: 'synthetic-private-group@g.us', chat_name: 'Grupo sintético',
    title: 'Suco sintético', analysis_type: 'general', period_start: '2026-10-22T00:00:00.000Z',
    period_end: '2026-10-23T00:00:00.000Z', content: 'PRIVATE_SYNTHETIC_SUMMARY',
    model: 'glm-5.3-flash', created_at: new Date().toISOString(), auto: false as const };
  await store.complete(summary, fingerprint);
  assert.doesNotMatch(server.rawBodies.join(''), /PRIVATE_SYNTHETIC|Grupo sintético|g\.us/);
  assert.doesNotMatch(JSON.stringify([...server.rows.values()]), /PRIVATE_SYNTHETIC|Grupo sintético|g\.us/);
  const reopened = createConfidentialSummaryStore(options);
  assert.deepEqual(await reopened.get(id), summary);
  assert.deepEqual((await reopened.list()).summaries, [summary]);
  assert.deepEqual(await reopened.reserve(id, fingerprint), summary);
  const wrongKey = createConfidentialSummaryStore({ ...options, key: randomBytes(32) });
  await assert.rejects(wrongKey.get(id), /PRIVATE_SUMMARY_CORRUPT/);
  await reopened.deleteSummary(id);
  assert.equal(await reopened.get(id), null);
  assert.equal((await reopened.list()).total, 0);
  store.close(); reopened.close(); wrongKey.close();
});

test('generation reserves a durable job before an async model call and rejects empty periods', async () => {
  const server = remote(), store = createConfidentialSummaryStore({
    url: 'https://synthetic.supabase.invalid', publishableKey: 'sb_publishable_synthetic',
    ownerId: owner, keyEpoch: 1, key: randomBytes(32), userJwt: async () => token,
    fetcher: server.fetcher,
  });
  let calls = 0;
  const instructions: string[] = [];
  const service = createConfidentialSummaryService({
    messages: { snapshot: async () => [{ chat_jid: 'group@g.us', id: 'm1', sender_jid: null,
      sender_name: 'Pessoa', from_me: false, body: 'Fechamos a data em 25/10.',
      msg_type: 'text', ts: new Date('2026-10-22T12:00:00.000Z') }] } as ConfidentialMessageStore,
    metadata: { chatList: async () => [{ jid: 'group@g.us', name: 'Grupo de teste', is_group: true }] } as ConfidentialMetadataStore,
    summaries: store,
    glm: { summarize: async (_id: string, _source: string, instruction: string) => {
      calls++; instructions.push(instruction);
      return { content: '## Combinado\nData 25/10.', model: 'glm-5.3-flash' };
    } } as ConfidentialGlm,
  });
  const request = { request_id: randomUUID(), chat_jid: 'group@g.us',
    start: '2026-10-22T00:00:00.000Z', end: '2026-10-23T00:00:00.000Z',
    analysis_type: 'general', template_version: JUICE_CATALOG_VERSION };
  assert.deepEqual(await service.generate(request), { state: 'pending' });
  for (let attempt = 0; attempt < 20 && (await service.status(request.request_id)).state === 'pending'; attempt++)
    await new Promise(resolve => setTimeout(resolve, 5));
  const completed = await service.status(request.request_id);
  assert.equal(completed.state, 'complete');
  assert.equal(completed.summary?.content, '## Combinado\nData 25/10.');
  assert.equal(calls, 1);
  assert.equal((await service.generate(request)).state, 'complete');
  assert.equal(calls, 1);
  const custom = { ...request, request_id: randomUUID(), analysis_type: 'custom',
    base_prompt: 'Liste somente os prazos mencionados, com o remetente.' };
  assert.equal((await service.generate(custom)).state, 'pending');
  for (let attempt = 0; attempt < 20 && (await service.status(custom.request_id)).state === 'pending'; attempt++)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await service.status(custom.request_id)).state, 'complete');
  assert.match(instructions[1], /Liste somente os prazos mencionados/);
  assert.equal(calls, 2);
  await assert.rejects(service.generate({ ...custom, request_id: randomUUID(), base_prompt: '' }),
    /PRIVATE_SUMMARY_INPUT/);
  await assert.rejects(service.generate({ ...request, request_id: randomUUID(),
    start: '2026-10-20T00:00:00.000Z', end: '2026-10-21T00:00:00.000Z' }),
  /PRIVATE_SUMMARY_NO_MESSAGES/);
  const daily = { request_id: randomUUID(), chat_jid: 'group@g.us',
    start: '2026-10-22T12:00:00.000Z', end: '2026-10-22T12:00:00.000Z',
    template_version: JUICE_CATALOG_VERSION };
  assert.equal((await service.generateAutomatic(daily)).state, 'pending');
  for (let attempt = 0; attempt < 20 && (await service.status(daily.request_id)).state === 'pending'; attempt++)
    await new Promise(resolve => setTimeout(resolve, 5));
  const automatic = await service.status(daily.request_id);
  assert.equal(automatic.summary?.analysis_type, 'daily_auto');
  assert.equal(automatic.summary?.auto, true);
  assert.match(instructions[2], /SUCO DIÁRIO/);
  store.close();
});

test('personal recipes are encrypted, revisioned, usable for generation and archivable', async () => {
  const server = remote(), store = createConfidentialSummaryStore({
    url: 'https://synthetic.supabase.invalid', publishableKey: 'sb_publishable_synthetic',
    ownerId: owner, keyEpoch: 1, key: randomBytes(32), userJwt: async () => token,
    fetcher: server.fetcher,
  });
  const id = randomUUID();
  const first = await store.saveType({ id, revision: 0, name: 'Acordos do grupo', category: 'Trabalho',
    base_type: 'general', instructions: 'Liste acordos com datas explícitas.' });
  assert.equal(first.revision, 1);
  assert.equal((await store.listTypes())[0].instructions, 'Liste acordos com datas explícitas.');
  assert.doesNotMatch(server.rawBodies.join(''), /Acordos do grupo|Liste acordos/);
  await assert.rejects(store.saveType({ ...first, revision: 0 }), /PRIVATE_SUMMARY_CONFLICT/);
  let receivedInstruction = '';
  const service = createConfidentialSummaryService({
    messages: { snapshot: async () => [{ chat_jid: 'group@g.us', id: 'm1', sender_jid: null,
      sender_name: 'Pessoa', from_me: false, body: 'Entrega em 25/10.',
      msg_type: 'text', ts: new Date('2026-10-22T12:00:00.000Z') }] } as ConfidentialMessageStore,
    metadata: { chatList: async () => [{ jid: 'group@g.us', name: 'Grupo', is_group: true }] } as ConfidentialMetadataStore,
    summaries: store,
    glm: { summarize: async (_id: string, _source: string, instruction: string) => {
      receivedInstruction = instruction;
      return { content: 'Entrega em 25/10.', model: 'glm-5.3-flash' };
    } } as ConfidentialGlm,
  });
  const request = { request_id: randomUUID(), chat_jid: 'group@g.us',
    start: '2026-10-22T00:00:00.000Z', end: '2026-10-23T00:00:00.000Z',
    analysis_type: `personal:${id}`, personal_revision: '1', template_version: JUICE_CATALOG_VERSION };
  assert.equal((await service.generate(request)).state, 'pending');
  for (let attempt = 0; attempt < 20 && (await service.status(request.request_id)).state === 'pending'; attempt++)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.match(receivedInstruction, /Liste acordos com datas explícitas/);
  assert.equal((await store.list()).total, 1);
  await store.archiveType(id, 1);
  assert.deepEqual(await store.listTypes(), []);
  assert.equal(await store.getType(id), null);
  await assert.rejects(service.generate({ ...request, request_id: randomUUID() }), /PRIVATE_PERSONAL_NOT_FOUND/);
  store.close();
});

test('daily digest uses the São Paulo day, saves encrypted result and stays out of manual sucos', async () => {
  const server = remote(), store = createConfidentialSummaryStore({
    url: 'https://synthetic.supabase.invalid', publishableKey: 'sb_publishable_synthetic',
    ownerId: owner, keyEpoch: 1, key: randomBytes(32), userJwt: async () => token,
    fetcher: server.fetcher,
  });
  let source = '';
  const service = createConfidentialSummaryService({
    messages: { snapshot: async () => [
      { chat_jid: 'group@g.us', id: 'a', sender_jid: null, sender_name: 'Ana', from_me: false,
        body: 'Fechamos dia 25/10.', msg_type: 'text', ts: new Date('2026-10-23T02:59:00Z') },
      { chat_jid: 'group@g.us', id: 'b', sender_jid: null, sender_name: 'Ana', from_me: false,
        body: 'Entrega em 26/10.', msg_type: 'text', ts: new Date('2026-10-23T03:01:00Z') },
    ] } as ConfidentialMessageStore,
    metadata: { chatList: async () => [{ jid: 'group@g.us', name: 'Projeto', is_group: true }] } as ConfidentialMetadataStore,
    summaries: store,
    glm: { summarize: async (_id: string, transcript: string) => { source = transcript;
      return { content: 'Resumo do dia: entrega 26/10.', model: 'glm-5.3-flash' }; } } as ConfidentialGlm,
  });
  const id = randomUUID();
  assert.equal((await service.generateDigest({ request_id: id, day: '2026-10-23' })).state, 'pending');
  for (let attempt = 0; attempt < 20 && (await service.status(id)).state === 'pending'; attempt++)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.match(source, /Entrega em 26\/10/);
  assert.doesNotMatch(source, /Fechamos dia 25\/10/);
  assert.equal((await service.listDigests()).total, 1);
  assert.equal((await service.list()).total, 0);
  assert.doesNotMatch(server.rawBodies.join(''), /Resumo do dia: entrega/);
  store.close();
});
