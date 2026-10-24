import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { Hono } from 'hono';
import type { Pool } from 'pg';
import type { TenantConfig } from '../src/tenant-access.js';
import { extractMeetingCandidates, meetingProposalRoutes, signMeetingTicket, type MeetingMessage } from '../src/meeting-proposals.js';

const NOW = Date.parse('2030-01-10T12:00:00.000Z');
const SUMMARY_ID = '10000000-0000-4000-8000-000000000001';
const CHAT = 'synthetic-person@s.whatsapp.net';
const TENANT: TenantConfig = {
  tenantId: 'synthetic-tenant-a', accountId: 'synthetic-account-a',
  workerKey: 'synthetic-only-meeting-source-signing-key-0001',
  controlUrl: 'https://synthetic-only.convex.site',
};
function message(patch: Partial<MeetingMessage> = {}): MeetingMessage {
  return { id: 'synthetic-message-1', sender_jid: 'synthetic-person@s.whatsapp.net', sender_name: 'Pessoa sintética', from_me: false, body: 'Vamos marcar uma reunião? Meu e-mail é pessoa@example.test.', ts: new Date(NOW), ...patch };
}
const extract = (messages: MeetingMessage[], chat = CHAT, tenant = TENANT.tenantId) => extractMeetingCandidates(messages, chat, tenant);
function claims(ticket: string) {
  const [prefix, encoded, signature] = ticket.split('.');
  assert.equal(prefix, 'meeting1');
  assert.equal(signature, createHmac('sha256', TENANT.workerKey).update('suco-meeting-v1.' + encoded).digest('hex'));
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
}

test('a literal email without a meeting request produces no proposal', () => {
  for (const body of ['Meu e-mail é pessoa@example.test.', 'A chave Pix é pessoa@example.test.', 'Segue o boleto de pessoa@example.test.', 'A reunião de ontem foi boa. pessoa@example.test']) {
    assert.deepEqual(extract([message({ body })]), []);
  }
});

test('an explicit meeting request and peer self-email in the same context form one reviewed candidate', () => {
  const [candidate] = extract([
    message({ from_me: true, body: 'Podemos marcar uma reunião?', id: 'anchor' }),
    message({ id: 'email', body: 'Meu e-mail é pessoa@example.test.', ts: new Date(NOW + 60_000) }),
  ]);
  assert.deepEqual(candidate.emails, ['pessoa@example.test']);
  assert.deepEqual(candidate.suggestedEmails, ['pessoa@example.test']);
  assert.equal(candidate.ambiguous, false);
  assert.deepEqual(candidate.evidence.map(item => item.id), ['anchor', 'email']);
  assert.equal(candidate.evidence[0].sender, 'Você');
  assert.equal(candidate.evidence[1].sender, 'Pessoa sintética');
  assert.equal(candidate.evidence[1].ts, '2030-01-10T12:01:00.000Z');
});

test('the owner email remains evidence and never becomes an automatically suggested guest', () => {
  const [candidate] = extract([message({ from_me: true, body: 'Vamos marcar uma reunião. Meu e-mail é owner@example.test.' })]);
  assert.deepEqual(candidate.emails, ['owner@example.test']);
  assert.deepEqual(candidate.suggestedEmails, []);
  assert.equal(candidate.ambiguous, true);
});

test('an address explicitly attributed to a third person is never selected for a different meeting', () => {
  const [candidate] = extract([
    message({ id: 'anchor', from_me: true, body: 'Vamos marcar uma reunião com Ana?' }),
    message({ id: 'third-person', body: 'O e-mail do contador João é joao@example.test.', ts: new Date(NOW + 60_000) }),
  ]);
  assert.deepEqual(candidate.emails, ['joao@example.test']);
  assert.deepEqual(candidate.suggestedEmails, []);
  assert.equal(candidate.ambiguous, true);
});

test('a group with more than one peer sender preserves evidence without assigning the email automatically', () => {
  const [candidate] = extract([
    message({ id: 'anchor', sender_jid: 'synthetic-ana', sender_name: 'Ana sintética', body: 'Vamos marcar uma reunião?' }),
    message({ id: 'email', sender_jid: 'synthetic-bruno', sender_name: 'Bruno sintético', body: 'Meu e-mail é bruno@example.test.', ts: new Date(NOW + 60_000) }),
  ], 'synthetic-group@g.us');
  assert.deepEqual(candidate.emails, ['bruno@example.test']);
  assert.deepEqual(candidate.suggestedEmails, []);
  assert.equal(candidate.ambiguous, true);
});

for (const [label, body] of [
  ['negative scheduling', 'Não vamos marcar reunião. Meu e-mail é pessoa@example.test.'],
  ['negative desire', 'Não quero reunião. Meu e-mail é pessoa@example.test.'],
  ['cancelled request', 'Vamos marcar a reunião cancelada? pessoa@example.test.'],
] as const) {
  test(`${label} does not create a meeting proposal`, () => assert.deepEqual(extract([message({ body })]), []));
}

test('a later cancellation suppresses the earlier proposal in the same evidence window', () => {
  assert.deepEqual(extract([
    message({ id: 'anchor' }),
    message({ id: 'cancelled', body: 'A reunião foi cancelada.', ts: new Date(NOW + 60_000) }),
  ]), []);
});

test('an unrelated Pix address near a meeting request is not used as its guest', () => {
  const [candidate] = extract([
    message({ id: 'anchor', body: 'Vamos marcar uma reunião?' }),
    message({ id: 'pix', body: 'Minha chave Pix é pagamento@example.test.', ts: new Date(NOW + 60_000) }),
  ]);
  assert.deepEqual(candidate.emails, []);
  assert.deepEqual(candidate.suggestedEmails, []);
});

test('an email beyond 36 hours or beyond the seven-message context is not attached to the anchor', () => {
  const [late] = extract([
    message({ id: 'anchor', body: 'Vamos marcar uma reunião?' }),
    message({ id: 'late', body: 'Meu e-mail é pessoa@example.test.', ts: new Date(NOW + 36 * 3600_000 + 1) }),
  ]);
  assert.deepEqual(late.emails, []);
  const messages = [message({ id: 'anchor', body: 'Vamos marcar uma reunião?' })];
  for (let index = 1; index <= 6; index++) messages.push(message({ id: `unrelated-${index}`, body: 'Mensagem sem endereço.', ts: new Date(NOW + index * 1000) }));
  messages.push(message({ id: 'outside-window', body: 'Meu e-mail é pessoa@example.test.', ts: new Date(NOW + 7000) }));
  assert.deepEqual(extract(messages)[0].emails, []);
});

test('duplicate literal emails are deduplicated case-insensitively and evidence is bounded around the address', () => {
  const body = 'Vamos marcar uma reunião. ' + 'x'.repeat(1500) + ' Meu e-mail é pessoa@example.test. pessoa@EXAMPLE.test ' + 'y'.repeat(1500);
  const [candidate] = extract([message({ body })]);
  assert.deepEqual(candidate.emails, ['pessoa@example.test']);
  assert.equal(candidate.evidence.length, 1);
  assert(candidate.evidence[0].body.includes('pessoa@example.test'));
  assert(candidate.evidence[0].body.length <= 1202);
});

test('a proposal has at most ten recipient candidates and never auto-selects multiple peers', () => {
  const emails = Array.from({ length: 11 }, (_, i) => `p${i}@example.test`);
  const [candidate] = extract([message({ body: 'Vamos marcar uma reunião. Emails: ' + emails.join(', ') })]);
  assert.deepEqual(candidate.emails, emails.slice(0, 10));
  assert.deepEqual(candidate.suggestedEmails, []);
  assert.equal(candidate.ambiguous, true);
});

test('the same message anchor in two saved sucos has one tenant/chat-bound stable intent key', () => {
  const anchor = message({ id: 'anchor-preserved-across-summaries' });
  const first = extract([anchor])[0].intentKey;
  const overlappingSummary = extract([anchor, message({ id: 'later', body: 'Obrigado!', ts: new Date(NOW + 1000) })])[0].intentKey;
  assert.equal(first, overlappingSummary);
  assert.equal(first, createHash('sha256').update(JSON.stringify(['suco-meeting-v1', TENANT.tenantId, CHAT, anchor.id])).digest('hex'));
  assert.notEqual(first, extract([anchor], 'other-chat@s.whatsapp.net')[0].intentKey);
  assert.notEqual(first, extract([anchor], CHAT, 'other-tenant')[0].intentKey);
  assert.notEqual(first, extract([message({ id: 'other-anchor' })])[0].intentKey);
});

test('extraction caps separate meeting proposals at twelve', () => {
  const messages = Array.from({ length: 13 }, (_, i) => message({ id: `anchor-${i}`, ts: new Date(NOW + i * 48 * 3600_000) }));
  const result = extract(messages);
  assert.equal(result.length, 12);
  assert.equal(new Set(result.map(item => item.intentKey)).size, 12);
});

test('a source ticket has an independent exact HMAC, server account/tenant and five-minute TTL', () => {
  const input = { summaryId: SUMMARY_ID, intentKey: 'a'.repeat(64), title: 't'.repeat(201), emails: ['pessoa@example.test'] };
  const ticket = signMeetingTicket(input, TENANT, NOW);
  assert.deepEqual(claims(ticket), { v: 1, accountId: TENANT.accountId, tenantId: TENANT.tenantId, summaryId: SUMMARY_ID, intentKey: input.intentKey, title: 't'.repeat(200), emails: input.emails, exp: NOW + 300_000 });
  assert(!ticket.includes(TENANT.workerKey));
});

type SqlCall = { text: string; values: unknown[] };
function fixture(options: { exists?: boolean; messages?: MeetingMessage[]; chat?: string } = {}) {
  const calls: SqlCall[] = [];
  const row = { id: SUMMARY_ID, chat_jid: options.chat ?? CHAT, title: 'Reunião sintética', period_start: new Date(NOW - 86400_000), period_end: new Date(NOW + 86400_000) };
  const pool = { async query(text: string, values: unknown[] = []) {
    calls.push({ text, values });
    return { rows: text.startsWith('SELECT id,chat_jid,title,period_start,period_end FROM summaries') ? (options.exists === false ? [] : [row]) : (options.messages ?? [message()]) };
  } } as unknown as Pool;
  return { pool, calls, row };
}
function harness(pool: Pool, tenant: TenantConfig | null = TENANT) {
  const app = new Hono();
  app.use('/api/*', async (c, next) => c.req.header('Authorization') === 'Bearer synthetic-only' ? next() : c.json({ error: 'Unauthorized' }, 401));
  app.route('/api/summaries', meetingProposalRoutes(pool, tenant));
  return app;
}
const requestOptions = { headers: { Authorization: 'Bearer synthetic-only' } };

test('the synthetic parent auth harness rejects unauthenticated proposal requests before SQL', async () => {
  const { pool, calls } = fixture();
  const app = harness(pool);
  assert.equal((await app.request(`/api/summaries/${SUMMARY_ID}/calendar-proposals`)).status, 401);
  assert.equal(calls.length, 0);
});

test('a worker without a native tenant binding cannot produce signed proposals', async () => {
  const { pool, calls } = fixture();
  const app = harness(pool, null);
  const result = await app.request(`/api/summaries/${SUMMARY_ID}/calendar-proposals`, requestOptions);
  assert.equal(result.status, 503);
  assert.equal((await result.json()).code, 'CALENDAR_NATIVE_REQUIRED');
  assert.equal(calls.length, 0);
});

test('invalid UUIDs and injection-like summary paths are rejected before SQL', async () => {
  const { pool, calls } = fixture();
  const app = harness(pool);
  for (const id of ['not-a-uuid', '00000000-0000-0000-0000-000000000000', "x' OR 1=1--"]) {
    assert.equal((await app.request(`/api/summaries/${encodeURIComponent(id)}/calendar-proposals`, requestOptions)).status, 404);
  }
  assert.equal(calls.length, 0);
});

test('an unknown summary returns 404 without querying messages', async () => {
  const { pool, calls } = fixture({ exists: false });
  const result = await harness(pool).request(`/api/summaries/${SUMMARY_ID}/calendar-proposals`, requestOptions);
  assert.equal(result.status, 404);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].values, [SUMMARY_ID]);
});

test('route SQL is parameterized and bounded by the saved summary chat and period, ignoring caller account overrides', async () => {
  const { pool, calls, row } = fixture({ chat: "synthetic' OR 1=1--@s.whatsapp.net" });
  const before = Date.now();
  const result = await harness(pool).request(`/api/summaries/${SUMMARY_ID}/calendar-proposals?account_id=other&tenant_id=other&start=1900-01-01`, requestOptions);
  const after = Date.now();
  assert.equal(result.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].text, 'SELECT id,chat_jid,title,period_start,period_end FROM summaries WHERE id=$1');
  assert.deepEqual(calls[0].values, [SUMMARY_ID]);
  assert.equal(calls[1].text, 'SELECT id,sender_jid,sender_name,from_me,body,ts FROM wa_messages WHERE chat_jid=$1 AND ts >= $2 AND ts <= $3 ORDER BY ts,seq LIMIT 10001');
  assert.deepEqual(calls[1].values, [row.chat_jid, row.period_start, row.period_end]);
  assert(!calls[1].text.includes(row.chat_jid));
  const body = await result.json();
  assert.equal(body.summaryId, SUMMARY_ID);
  assert.equal(body.sourceScope, 'summary_period');
  assert.equal(body.automaticGeneration, false);
  assert.equal(body.truncated, false);
  assert.equal(body.candidates.length, 1);
  const signed = claims(body.candidates[0].sourceTicket);
  assert.equal(signed.accountId, TENANT.accountId);
  assert.equal(signed.tenantId, TENANT.tenantId);
  assert.deepEqual(signed.emails, ['pessoa@example.test']);
  assert(signed.exp >= before + 300_000 && signed.exp <= after + 300_000);
  assert(!JSON.stringify(body).includes(TENANT.workerKey));
});

test('an ambiguous group route signs an empty suggested-recipient list while retaining the source evidence', async () => {
  const { pool } = fixture({ chat: 'synthetic-group@g.us', messages: [message(), message({ id: 'other-person', sender_jid: 'synthetic-other', body: 'Estou acompanhando.', ts: new Date(NOW + 1000) })] });
  const result = await harness(pool).request(`/api/summaries/${SUMMARY_ID}/calendar-proposals`, requestOptions);
  const body = await result.json();
  assert.equal(result.status, 200);
  assert.equal(body.candidates[0].ambiguous, true);
  assert.deepEqual(body.candidates[0].emails, ['pessoa@example.test']);
  assert.deepEqual(claims(body.candidates[0].sourceTicket).emails, []);
});

test('the extraction route reports truncation and never inspects the 10001st message', async () => {
  const messages = Array.from({ length: 10000 }, (_, i) => message({ id: `unrelated-${i}`, body: 'Sem reunião nem endereço.' }));
  messages.push(message({ id: 'outside-database-page' }));
  const { pool } = fixture({ messages });
  const result = await harness(pool).request(`/api/summaries/${SUMMARY_ID}/calendar-proposals`, requestOptions);
  const body = await result.json();
  assert.equal(result.status, 200);
  assert.equal(body.truncated, true);
  assert.deepEqual(body.candidates, []);
});

test('the proposal rate limit blocks request twenty-one before another SQL read', async () => {
  const { pool, calls } = fixture();
  const app = harness(pool);
  for (let i = 0; i < 20; i++) assert.equal((await app.request(`/api/summaries/${SUMMARY_ID}/calendar-proposals`, requestOptions)).status, 200);
  assert.equal(calls.length, 40);
  assert.equal((await app.request(`/api/summaries/${SUMMARY_ID}/calendar-proposals`, requestOptions)).status, 429);
  assert.equal(calls.length, 40);
});
