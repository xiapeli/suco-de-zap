import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import pg from 'pg';
import {
  PERSONAL_JUICE_SCHEMA, PersonalJuiceError, SqlPersonalJuiceStore,
  personalInput, personalJuiceRoutes, resolvePersonalJuice,
  type PersonalJuiceInput, type PersonalJuiceRecord, type PersonalJuiceStore,
} from '../src/personal-juices.js';
import { JUICE_CATALOG_VERSION, JuiceTemplateError, juiceTemplates } from '../src/juice-catalog.js';

const account = 'synthetic-personal-account';
const id = '10000000-0000-4000-8000-000000000001';
const revisionId = '20000000-0000-4000-8000-000000000001';
const hiddenPrompt = 'SERVER_ONLY_CANONICAL_PROMPT_SENTINEL';
const input = (changes: Partial<PersonalJuiceInput> = {}): PersonalJuiceInput => ({
  id, revision_id: revisionId, name: 'Reuniões de clientes', category: 'Comercial livre',
  instructions: 'Liste decisões e cite as mensagens de origem.', base_type: 'custom', ...changes,
});
const row = (changes: Partial<PersonalJuiceRecord> = {}): PersonalJuiceRecord => ({
  ...input(), revision: 1, base_prompt_snapshot: hiddenPrompt,
  created_at: '2026-10-16T00:00:00.000Z', updated_at: '2026-10-16T00:00:00.000Z', archived: false, ...changes,
});
const isError = (code: string, status = 400) => (error: unknown) => {
  assert(error instanceof PersonalJuiceError);
  assert.equal(error.code, code); assert.equal(error.status, status); return true;
};

function recordingStore(overrides: Partial<PersonalJuiceStore> = {}) {
  const calls: { operation: string; account: string; args: unknown[] }[] = [];
  const store: PersonalJuiceStore = {
    async list(owner) { calls.push({ operation: 'list', account: owner, args: [] }); return [{ id, revision_id: revisionId, name: input().name, instructions_preview: 'Liste decisões.' }]; },
    async get(owner, target, revision) { calls.push({ operation: 'get', account: owner, args: [target, revision] }); return row(); },
    async save(owner, value, updating) { calls.push({ operation: 'save', account: owner, args: [value, updating] }); return row(value); },
    async archive(owner, target, expected) { calls.push({ operation: 'archive', account: owner, args: [target, expected] }); },
    ...overrides,
  };
  return { store, calls };
}

test('personal types accept free categories, every canonical base and exact text boundaries', () => {
  const normalized = personalInput({ ...input(), name: '  Clientes  ', category: '  Pós-venda / China  ', instructions: '  Cite as fontes.\nOrganize por pessoa.  ' });
  assert.equal(normalized.name, 'Clientes'); assert.equal(normalized.category, 'Pós-venda / China');
  assert.equal(normalized.instructions, 'Cite as fontes.\nOrganize por pessoa.');
  const { category: omittedCategory, base_type: omittedBase, ...required } = input();
  const defaults = personalInput(required);
  assert.equal(defaults.category, 'Meus tipos'); assert.equal(defaults.base_type, 'custom');
  assert.equal(personalInput({ ...input(), category: '   ' }).category, 'Meus tipos');
  const boundary = personalInput(input({ name: 'n'.repeat(80), category: 'c'.repeat(60), instructions: 'i'.repeat(10_000) }));
  assert.equal(boundary.instructions.length, 10_000);
  for (const base of ['custom', ...juiceTemplates.map(template => template.id)]) assert.equal(personalInput(input({ base_type: base })).base_type, base);
  assert.equal(personalInput(input({ expected_revision: revisionId }), id).expected_revision, revisionId);
});

test('invalid identity, protected fields, controls, missing values and overlong personal input fail closed', () => {
  const invalid: unknown[] = [
    null, [], 'text', 12, {},
    { ...input(), id: 'not-a-uuid' }, { ...input(), revision_id: 'not-a-uuid' },
    { ...input(), name: '' }, { ...input(), name: ' ' }, { ...input(), name: 42 },
    { ...input(), category: null }, { ...input(), instructions: null }, { ...input(), instructions: ' ' },
    input({ name: 'n'.repeat(81) }), input({ category: 'c'.repeat(61) }), input({ instructions: 'i'.repeat(10_001) }),
    input({ name: 'unsafe\0name' }), input({ category: 'unsafe\u000bcategory' }), input({ instructions: 'unsafe\u001finstruction' }),
    input({ base_type: 'unknown' }), { ...input(), base_type: 1 },
    { ...input(), account_id: 'another-account' }, { ...input(), base_prompt_snapshot: 'replace the server prompt' },
    { ...input(), archived: false }, { ...input(), revision: 99 },
  ];
  for (const value of invalid) assert.throws(() => personalInput(value), isError('INVALID_PERSONAL_JUICE'));
  for (const value of [input(), input({ expected_revision: 'bad' }), input({ id: randomUUID(), expected_revision: revisionId })]) {
    assert.throws(() => personalInput(value, id), isError('INVALID_PERSONAL_JUICE'));
  }
  assert.throws(() => personalInput(input({ expected_revision: revisionId }), 'bad-path-id'), isError('INVALID_PERSONAL_JUICE'));
});

test('malformed JSON, excess bytes and invalid route identifiers never reach the personal store', async () => {
  const { store, calls } = recordingStore(); const routes = personalJuiceRoutes(store, account);
  const invalidRequests = [
    { path: '/', method: 'POST', body: '{' },
    { path: '/', method: 'POST', body: 'null' },
    { path: '/', method: 'POST', body: '[]' },
    { path: '/', method: 'POST', body: ' '.repeat(48_001) + JSON.stringify(input()) },
    { path: '/', method: 'POST', body: JSON.stringify({ ...input(), account_id: 'other' }) },
    { path: '/bad', method: 'GET' },
    { path: `/${id}?revision=bad`, method: 'GET' },
    { path: '/bad', method: 'PATCH', body: JSON.stringify(input({ expected_revision: revisionId })) },
    { path: `/${id}`, method: 'PATCH', body: JSON.stringify(input()) },
    { path: '/bad', method: 'DELETE', body: JSON.stringify({ expected_revision: revisionId }) },
    { path: `/${id}`, method: 'DELETE', body: JSON.stringify({ expected_revision: 'bad' }) },
    { path: `/${id}`, method: 'DELETE', body: JSON.stringify({ expected_revision: revisionId, account_id: 'other' }) },
    { path: `/${id}`, method: 'DELETE', body: '[]' },
  ];
  for (const request of invalidRequests) {
    const response = await routes.request(request.path, { method: request.method, body: request.body });
    assert.equal(response.status, 400, `${request.method} ${request.path}`);
    assert.equal((await response.json()).code, 'INVALID_PERSONAL_JUICE');
  }
  assert.equal(calls.length, 0);
});

test('personal routes use only the server account and omit canonical base prompts from public records', async () => {
  const { store, calls } = recordingStore(); const routes = personalJuiceRoutes(store, account);
  const create = await routes.request('/', { method: 'POST', body: JSON.stringify(input()) });
  assert.equal(create.status, 201);
  const created = await create.json(); assert.equal(created.type.id, id); assert.equal(created.type.revision_id, revisionId);
  assert.equal(created.type.instructions, input().instructions);
  assert(!('base_prompt_snapshot' in created.type)); assert(!JSON.stringify(created).includes(hiddenPrompt));
  const get = await routes.request(`/${id}?revision=${revisionId}&account_id=other`);
  assert.equal(get.status, 200); assert(!JSON.stringify(await get.json()).includes(hiddenPrompt));
  const patch = await routes.request(`/${id}`, { method: 'PATCH', body: JSON.stringify(input({ expected_revision: revisionId })) });
  assert.equal(patch.status, 200); assert(!JSON.stringify(await patch.json()).includes(hiddenPrompt));
  const list = await routes.request('/'); assert.equal(list.status, 200); assert.equal((await list.json()).types.length, 1);
  const archive = await routes.request(`/${id}`, { method: 'DELETE', body: JSON.stringify({ expected_revision: revisionId }) });
  assert.equal(archive.status, 200); assert.deepEqual(await archive.json(), { ok: true });
  assert(calls.every(call => call.account === account));
  assert.deepEqual(calls.filter(call => call.operation === 'save').map(call => call.args[1]), [false, true]);
  assert.deepEqual(calls.find(call => call.operation === 'get')?.args, [id, revisionId]);
});

test('parent authentication denies every personal operation before invoking the store', async () => {
  const { store, calls } = recordingStore(); const app = new Hono();
  app.use('/api/*', async (c, next) => c.req.header('Authorization') === 'Bearer synthetic' ? next() : c.json({ error: 'Unauthorized' }, 401));
  app.route('/api/personal-juices', personalJuiceRoutes(store, account));
  for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
    const path = method === 'PATCH' || method === 'DELETE' ? `/api/personal-juices/${id}` : '/api/personal-juices';
    assert.equal((await app.request(path, { method })).status, 401);
  }
  assert.equal(calls.length, 0);
  const response = await app.request('/api/personal-juices', { headers: { Authorization: 'Bearer synthetic' } });
  assert.equal(response.status, 200); assert.equal(calls.length, 1);
});

test('recoverable personal errors do not disclose SQL details and the account mutation limit leaves reads available', async () => {
  const detail = 'PRIVATE_SQL_COLUMN_AND_PROMPT';
  const unavailable = personalJuiceRoutes(recordingStore({ async get() { throw Object.assign(new Error(detail), { code: detail, status: 404 }); } }).store, account);
  const failed = await unavailable.request(`/${id}`);
  assert.equal(failed.status, 503); const failure = await failed.json();
  assert.equal(failure.code, 'PERSONAL_JUICE_UNAVAILABLE'); assert(!JSON.stringify(failure).includes(detail));
  for (const [code, status] of [['PERSONAL_JUICE_NOT_FOUND', 404], ['PERSONAL_JUICE_CONFLICT', 409]] as const) {
    const routes = personalJuiceRoutes(recordingStore({ async get() { throw new PersonalJuiceError(code, status); } }).store, account);
    const response = await routes.request(`/${id}`); assert.equal(response.status, status); assert.equal((await response.json()).code, code);
  }
  const { store, calls } = recordingStore(); const routes = personalJuiceRoutes(store, account);
  for (let i = 0; i < 30; i++) assert.equal((await routes.request('/', { method: 'POST', body: JSON.stringify(input()) })).status, 201);
  const limited = await routes.request('/', { method: 'POST', body: JSON.stringify(input()) });
  assert.equal(limited.status, 429); assert(Number(limited.headers.get('Retry-After')) > 0);
  assert.equal(calls.filter(call => call.operation === 'save').length, 30);
  assert.equal((await routes.request('/')).status, 200);
});

function generation(typeId: string, versionId: string, changes: Record<string, unknown> = {}) {
  return {
    analysisType: `personal:${typeId}`, personalRevision: versionId, templateVersion: JUICE_CATALOG_VERSION,
    requestId: randomUUID(), chatJid: 'synthetic-team@g.us', start: new Date('2026-10-01T00:00:00Z'),
    end: new Date('2026-10-02T00:00:00Z'), focus: 'Projeto Aurora', title: 'Decisões sintéticas', auto: false, ...changes,
  };
}

test('unversioned, invalid and incomplete personal generation is rejected before accessing SQL', async () => {
  let calls = 0;
  const db = { async query() { calls++; throw Error('NO_DATABASE_ACCESS_ALLOWED'); }, async connect() { calls++; throw Error('NO_DATABASE_ACCESS_ALLOWED'); } } as unknown as pg.Pool;
  for (const args of [
    generation(id, revisionId, { templateVersion: 'old' }), generation(id, revisionId, { templateVersion: undefined }),
    generation('bad', revisionId), generation(id, 'bad'), generation(id, revisionId, { personalRevision: undefined }),
    generation(id, revisionId, { requestId: undefined }), generation(id, revisionId, { requestId: 'bad' }),
  ]) await assert.rejects(resolvePersonalJuice(db, account, args), isError('INVALID_PERSONAL_JUICE'));
  assert.equal(calls, 0);
});

async function syntheticDatabase(t: TestContext) {
  const configured = process.env.SUCO_PERSONAL_TEST_DATABASE_URL;
  assert(configured, 'SUCO_PERSONAL_TEST_DATABASE_URL is required for this integration test');
  const url = new URL(configured);
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '5436');
  assert.match(url.pathname.slice(1), /^suco_personal_[a-f0-9]{12}$/);
  assert.equal(url.search, '', 'Connection overrides are forbidden for the synthetic database');
  const db = new pg.Pool({ connectionString: url.toString(), max: 4, connectionTimeoutMillis: 3000, statement_timeout: 10_000 });
  t.after(() => db.end());
  assert.equal((await db.query('SELECT current_database() AS name')).rows[0].name, url.pathname.slice(1));
  await db.query(PERSONAL_JUICE_SCHEMA);
  await db.query('CREATE TABLE IF NOT EXISTS suco_summary_requests(request_id text PRIMARY KEY)');
  return db;
}

const postgres = { skip: !process.env.SUCO_PERSONAL_TEST_DATABASE_URL };

test('real PostgreSQL personal CRUD keeps identities, immutable revisions, private prompts and account boundaries', postgres, async t => {
  const db = await syntheticDatabase(t); const store = new SqlPersonalJuiceStore(db);
  const owner = `synthetic-owner-${randomUUID()}`, foreign = `synthetic-foreign-${randomUUID()}`;
  const original = input({ id: randomUUID(), revision_id: randomUUID(), base_type: juiceTemplates[0].id, instructions: 'x'.repeat(180) });
  const created = await store.save(owner, original, false);
  assert.equal(created.id, original.id); assert.equal(created.revision_id, original.revision_id); assert.equal(created.revision, 1);
  assert.equal(created.base_prompt_snapshot, juiceTemplates[0].prompt);
  assert.equal((await store.save(owner, original, false)).revision_id, original.revision_id);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM personal_juice_versions WHERE template_id=$1', [original.id])).rows[0].n, 1);
  await assert.rejects(store.save(owner, { ...original, name: 'Conflicting replay' }, false), isError('PERSONAL_JUICE_CONFLICT', 409));
  assert.equal(await store.get(foreign, original.id), null); assert.equal(await store.get(foreign, original.id, original.revision_id), null);
  await assert.rejects(store.save(foreign, { ...original, revision_id: randomUUID() }, false), isError('PERSONAL_JUICE_NOT_FOUND', 404));
  await assert.rejects(store.save(foreign, { ...original, revision_id: randomUUID(), expected_revision: original.revision_id }, true), isError('PERSONAL_JUICE_NOT_FOUND', 404));
  await assert.rejects(store.archive(foreign, original.id, original.revision_id), isError('PERSONAL_JUICE_NOT_FOUND', 404));
  assert.deepEqual(await store.list(foreign), []);
  const edited = { ...original, revision_id: randomUUID(), expected_revision: original.revision_id, name: 'Clientes atualizados', instructions: "Organize '; DROP TABLE personal_juice_types; -- como texto literal." };
  const changed = await store.save(owner, edited, true);
  assert.equal(changed.id, created.id); assert.equal(changed.revision_id, edited.revision_id); assert.equal(changed.revision, 2);
  assert.equal((await store.save(owner, edited, true)).revision_id, edited.revision_id);
  assert.equal((await store.get(owner, original.id))?.instructions, edited.instructions);
  assert.equal((await store.get(owner, original.id, original.revision_id))?.instructions, original.instructions);
  await assert.rejects(store.save(owner, { ...edited, revision_id: randomUUID(), expected_revision: original.revision_id }, true), isError('PERSONAL_JUICE_CONFLICT', 409));
  const duplicate = { ...original, id: randomUUID(), revision_id: randomUUID(), name: 'Cópia de clientes' };
  const copied = await store.save(owner, duplicate, false);
  assert.notEqual(copied.id, created.id); assert.notEqual(copied.revision_id, created.revision_id); assert.equal(copied.revision, 1);
  const listed = await store.list(owner) as Record<string, unknown>[];
  assert.equal(listed.length, 2); assert.equal(listed.find(item => item.id === original.id)?.revision_id, edited.revision_id);
  assert.equal((listed.find(item => item.id === duplicate.id)?.instructions_preview as string).length, 160);
  assert(listed.every(item => !('instructions' in item) && !('base_prompt_snapshot' in item) && !('account_id' in item)));
  assert(!JSON.stringify(listed).includes(juiceTemplates[0].prompt));
  await assert.rejects(store.archive(owner, original.id, original.revision_id), isError('PERSONAL_JUICE_CONFLICT', 409));
  await store.archive(owner, original.id, edited.revision_id); await store.archive(owner, original.id, edited.revision_id);
  assert.equal(await store.get(owner, original.id), null); assert.equal((await store.get(owner, original.id, original.revision_id))?.archived, true);
  assert.deepEqual((await store.list(owner) as { id: string }[]).map(item => item.id), [duplicate.id]);
  await assert.rejects(store.save(owner, edited, true), isError('PERSONAL_JUICE_ARCHIVED', 409));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM personal_juice_versions WHERE template_id=$1', [original.id])).rows[0].n, 2);
});

test('real PostgreSQL generation pins canonical revisions and only exact preexisting requests can retry an archived type', postgres, async t => {
  const db = await syntheticDatabase(t); const store = new SqlPersonalJuiceStore(db);
  const owner = `synthetic-generation-${randomUUID()}`, foreign = `synthetic-foreign-${randomUUID()}`;
  const first = input({ id: randomUUID(), revision_id: randomUUID(), base_type: juiceTemplates[0].id, instructions: 'INSTRUCTIONS_ORIGINAL_REVISION' });
  await store.save(owner, first, false);
  const args = generation(first.id, first.revision_id);
  const originalPrompt = await resolvePersonalJuice(db, owner, args);
  assert(originalPrompt.includes(juiceTemplates[0].prompt)); assert(originalPrompt.includes(first.instructions)); assert(originalPrompt.includes(args.focus));
  assert.equal(await resolvePersonalJuice(db, owner, args), originalPrompt);
  const boundaryFocus = generation(first.id, first.revision_id, { focus: 'f'.repeat(2000) });
  assert((await resolvePersonalJuice(db, owner, boundaryFocus)).includes('f'.repeat(2000)));
  const invalidFocus = [generation(first.id, first.revision_id, { focus: 'f'.repeat(2001) }), generation(first.id, first.revision_id, { focus: 'unsafe\0focus' })];
  for (const invalid of invalidFocus) await assert.rejects(resolvePersonalJuice(db, owner, invalid), (error: unknown) => {
    assert(error instanceof JuiceTemplateError); assert.equal(error.code, 'INVALID_JUICE_FOCUS'); assert.equal(error.status, 400); return true;
  });
  assert.equal((await db.query('SELECT count(*)::int AS n FROM personal_juice_request_refs WHERE account_id=$1 AND request_id=ANY($2::uuid[])', [owner, invalidFocus.map(invalid => invalid.requestId)])).rows[0].n, 0);
  await assert.rejects(resolvePersonalJuice(db, owner, { ...args, focus: 'Changed after confirmation' }), isError('PERSONAL_JUICE_REQUEST_CHANGED', 409));
  await assert.rejects(resolvePersonalJuice(db, foreign, { ...args, requestId: randomUUID() }), isError('PERSONAL_JUICE_NOT_FOUND', 404));
  const second = { ...first, revision_id: randomUUID(), expected_revision: first.revision_id, base_type: 'custom', instructions: 'INSTRUCTIONS_EDITED_REVISION' };
  await store.save(owner, second, true);
  assert.equal(await resolvePersonalJuice(db, owner, args), originalPrompt);
  const secondArgs = generation(first.id, second.revision_id);
  const editedPrompt = await resolvePersonalJuice(db, owner, secondArgs);
  assert(editedPrompt.includes(second.instructions)); assert(!editedPrompt.includes(first.instructions)); assert(!editedPrompt.includes(juiceTemplates[0].prompt));
  await assert.rejects(resolvePersonalJuice(db, owner, { ...args, personalRevision: second.revision_id }), isError('PERSONAL_JUICE_REQUEST_CHANGED', 409));
  await store.archive(owner, first.id, second.revision_id);
  assert.equal(await resolvePersonalJuice(db, owner, args), originalPrompt);
  assert.equal(await resolvePersonalJuice(db, owner, secondArgs), editedPrompt);
  const unrelated = randomUUID(); await db.query('INSERT INTO suco_summary_requests(request_id) VALUES($1)', [unrelated]);
  for (const change of [
    { requestId: randomUUID() }, { requestId: unrelated }, { chatJid: 'other-chat@g.us' }, { focus: 'Changed focus' },
    { personalRevision: second.revision_id }, { start: new Date('2026-10-01T01:00:00Z') }, { end: new Date('2026-10-02T01:00:00Z') },
    { title: 'Changed title' }, { auto: true },
  ]) await assert.rejects(resolvePersonalJuice(db, owner, { ...args, ...change }), (error: unknown) => {
    assert(error instanceof PersonalJuiceError); assert.equal(error.status, 409);
    assert(['PERSONAL_JUICE_ARCHIVED', 'PERSONAL_JUICE_REQUEST_CHANGED'].includes(error.code)); return true;
  });
  await assert.rejects(resolvePersonalJuice(db, foreign, args), isError('PERSONAL_JUICE_NOT_FOUND', 404));
});

test('real PostgreSQL concurrent edits and the one-hundred-type limit serialize per account', postgres, async t => {
  const db = await syntheticDatabase(t); const store = new SqlPersonalJuiceStore(db);
  const owner = `synthetic-race-${randomUUID()}`;
  const first = input({ id: randomUUID(), revision_id: randomUUID() }); await store.save(owner, first, false);
  const attempts = await Promise.allSettled(['A', 'B'].map(suffix => store.save(owner, { ...first, revision_id: randomUUID(), expected_revision: first.revision_id, name: `Concurrent ${suffix}` }, true)));
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  const denied = attempts.find(result => result.status === 'rejected') as PromiseRejectedResult;
  isError('PERSONAL_JUICE_CONFLICT', 409)(denied.reason);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM personal_juice_versions WHERE template_id=$1', [first.id])).rows[0].n, 2);
  for (let i = 1; i < 99; i++) await store.save(owner, input({ id: randomUUID(), revision_id: randomUUID(), name: `Capacity ${i}` }), false);
  const capacity = await Promise.allSettled([0, 1].map(i => store.save(owner, input({ id: randomUUID(), revision_id: randomUUID(), name: `Last slot ${i}` }), false)));
  assert.equal(capacity.filter(result => result.status === 'fulfilled').length, 1);
  const full = capacity.find(result => result.status === 'rejected') as PromiseRejectedResult;
  isError('PERSONAL_JUICE_LIMIT', 409)(full.reason);
  assert.equal((await store.list(owner)).length, 100);
  const latest = await store.get(owner, first.id); assert(latest); await store.archive(owner, first.id, latest.revision_id);
  await store.save(owner, input({ id: randomUUID(), revision_id: randomUUID(), name: 'Freed slot' }), false);
  assert.equal((await store.list(owner)).length, 100);
});
