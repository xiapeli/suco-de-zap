import test from 'node:test';
import assert from 'node:assert/strict';
import type { StagedMessage } from '../src/lib/ingestion-spool.js';
import type { ConfidentialMessageStore } from '../src/lib/confidential-message-store.js';
import type { ConfidentialMetadataStore } from '../src/lib/confidential-metadata-store.js';
import type { ConfidentialAuthAdapter } from '../src/lib/confidential-auth-state.js';

process.env.SUCO_CONFIDENTIAL_RUNTIME = '1';
process.env.API_TOKEN = '';
process.env.DATABASE_URL = '';
process.env.OPENAI_COMPAT_URL = '';
process.env.ANTHROPIC_API_KEY = '';

const { app, installConfidentialApiAuthorizer } = await import('../src/api.js');
const { installConfidentialSummaryService } = await import('../src/api.js');
const wa = await import('../src/wa.js');
const { pool } = await import('../src/db.js');
const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const auth = (owner = OWNER) => ({ Authorization: `Bearer synthetic-session:${owner}` });
const messages: StagedMessage[] = Array.from({ length: 105 }, (_, index) => ({
  chat_jid: index < 104 ? 'synthetic-group@g.us' : 'synthetic-contact@s.whatsapp.net',
  id: `message-${index}`, sender_jid: null, sender_name: index < 104 ? 'Pessoa' : null,
  from_me: false, body: `SYNTHETIC_PRIVATE_${index}`, msg_type: 'text',
  ts: new Date(Date.UTC(2026, 9, 23, 8, index)),
}));
const localMessageStore = {
  async replay() { return 0; }, async snapshot() { return [...messages]; },
  async evidence() { return {
    lastIngestedAt: null, lastSavedMessageAt: messages.at(-1)!.ts,
    lastCommittedMessageAt: null,
    writeHealth: { lastWriteSuccessAt: null, lastWriteFailureAt: null, consecutiveWriteFailures: 0 },
  }; },
} as ConfidentialMessageStore;
const localMetadataStore = {
  async load() {},
  async chatList() { return [
    { jid: 'synthetic-group@g.us', name: 'Grupo sintético', is_group: true },
    { jid: 'synthetic-empty@g.us', name: 'Sem mensagens', is_group: true },
  ]; },
  async contactList() { return [{ jid: 'synthetic-contact@s.whatsapp.net', name: 'Contato sintético', notify: null }]; },
  async lidMapList() { return []; },
} as unknown as ConfidentialMetadataStore;

test('confidential API fails closed until owner-bound authorizer and stores are installed', async () => {
  await assert.rejects(pool.query('SELECT 1'), { message: 'CONFIDENTIAL_SQL_DISABLED' });
  assert.equal((await app.request('/ready')).status, 503);
  assert.equal((await app.request('/api/chats', { headers: auth() })).status, 401);
  installConfidentialApiAuthorizer({ ownerId: OWNER,
    verifyBearerToken: async (token) => token.startsWith('synthetic-session:') ? token.slice(18) : null });
  assert.equal((await app.request('/api/chats', { headers: auth() })).status, 503);
  wa.installConfidentialAuth({} as ConfidentialAuthAdapter, async () => true, 'new-account');
  await wa.installConfidentialMetadataStore(localMetadataStore);
  await wa.installConfidentialMessageStore(localMessageStore);
  assert.equal((await app.request('/ready')).status, 200);
  assert.equal((await app.request('/api/chats', { headers: auth(OTHER) })).status, 401);
});

test('private conversation reads page and aggregate only decrypted local data', async () => {
  const headers = auth();
  const groups = await app.request('/api/chats?kind=group&limit=1&offset=1', { headers });
  assert.equal(groups.status, 200);
  const page = await groups.json();
  assert.equal(page.total, 2);
  assert.equal(page.chats.length, 1);
  assert.equal(page.chats[0].message_count, 0);
  const all = await (await app.request('/api/chats?kind=all&q=Contato', { headers })).json();
  assert.equal(all.total, 1);
  assert.equal(all.chats[0].name, 'Contato sintético');
  const response = await app.request('/api/chats/synthetic-group%40g.us/messages?limit=3&offset=100&end=2026-11-01T00%3A00%3A00Z', { headers });
  assert.equal(response.status, 200);
  const selected = await response.json();
  assert.equal(selected.total, 104);
  assert.deepEqual(selected.messages.map((message: { id: string }) => message.id),
    ['message-100', 'message-101', 'message-102']);
  const stats = await (await app.request('/api/chats/synthetic-group%40g.us/stats?end=2026-11-01T00%3A00%3A00Z', { headers })).json();
  assert.equal(stats.count, 104);
  assert.deepEqual(stats.by_sender, [{ sender_name: 'Pessoa', count: 104 }]);
  const status = await (await app.request('/api/status', { headers })).json();
  assert.equal(status.syncEvidence.available, true);
  assert.equal(status.syncEvidence.lastIngestedAt, null);
  assert.equal(status.syncEvidence.newMessageAfterConnect, false);
  assert.equal(status.syncEvidence.recoveryDurable, false);
  assert.equal((await app.request('/api/summaries', { headers })).status, 503);
  assert.equal((await app.request('/api/chats/synthetic-group%40g.us', { method: 'PATCH', headers })).status, 503);
  assert.equal((await app.request('/site/waitlist', { method: 'POST', headers })).status, 503);
});

test('all restored private product routes pass the allowlist and legacy SQL stays closed', async () => {
  const summary = { id: '33333333-3333-4333-8333-333333333333',
    chat_jid: 'synthetic-group@g.us', chat_name: 'Grupo sintético', title: 'Suco sintético',
    analysis_type: 'general', period_start: '2026-10-23T00:00:00.000Z',
    period_end: '2026-10-23T12:00:00.000Z', content: 'Resultado sintético',
    model: 'glm-synthetic', created_at: '2026-10-23T12:00:00.000Z', auto: false as const };
  installConfidentialSummaryService({
    generate: async () => ({ state: 'pending' }),
    status: async () => ({ state: 'complete', summary }),
    list: async () => ({ summaries: [summary], total: 1 }),
    listDigests: async () => ({ digests: [{ ...summary, analysis_type: 'digest' }], total: 1 }),
    personalTypes: async () => [],
    savePersonalType: async (input: { id: string; name: string; category: string; base_type: string; instructions: string }) =>
      ({ ...input, revision: 1, created_at: summary.created_at, updated_at: summary.created_at }),
    archivePersonalType: async () => {},
    generateDigest: async () => ({ state: 'pending' }),
  } as never);
  const headers = { ...auth(), 'Content-Type': 'application/json' };
  const cases: [string, string, object | undefined, number][] = [
    ['/api/summaries', 'GET', undefined, 200],
    [`/api/summaries/${summary.id}`, 'GET', undefined, 200],
    ['/api/summaries/generate', 'POST', { chat_jid: summary.chat_jid,
      start: summary.period_start, end: summary.period_end, request_id: summary.id }, 202],
    ['/api/private/personal-juices', 'GET', undefined, 200],
    ['/api/private/personal-juices/save', 'POST', { id: summary.id, revision: 0,
      name: 'Meu tipo', category: '', base_type: 'general', instructions: 'Liste prazos' }, 200],
    ['/api/private/personal-juices/archive', 'POST', { id: summary.id, revision: 1 }, 200],
    ['/api/digests', 'GET', undefined, 200],
    ['/api/digests/generate', 'POST', { day: '2026-10-23', request_id: summary.id }, 202],
    ['/api/search', 'POST', { query: 'SYNTHETIC_PRIVATE_0', kind: 'all' }, 200],
    ['/api/facts', 'GET', undefined, 503],
    ['/api/settings/extraction', 'GET', undefined, 503],
  ];
  for (const [path, method, body, expected] of cases) {
    const response = await app.request(path, { method, headers,
      ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, expected, `${method} ${path}`);
  }
});
