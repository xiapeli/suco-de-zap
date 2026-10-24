import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import pg from 'pg';
import { discoveryInput, discoveryRoutes, discoverySQL } from '../src/discovery.js';

test('natural questions keep topic words and bounded related vocabulary', () => {
  const input = discoveryInput({ query: 'O que ficou combinado sobre o lançamento?' });
  assert.deepEqual(input.terms, ['combinado', 'lançamento']);
  assert.match(input.alternatives, /decisão/);
  for (const query of ['', ' ', 'x'.repeat(501), 22, 'a\nsecret']) assert.throws(() => discoveryInput({ query }));
  for (const offset of [-1, 1001, '20', 1.1]) assert.throws(() => discoveryInput({ query: 'lançamento', offset }));
});

test('discovery excludes raw message/fact access and user SQL never enters statement', () => {
  const input = discoveryInput({ query: "pix %_' ; DROP TABLE summaries; --" });
  const sql = discoverySQL(input);
  assert(!sql.text.includes(input.query));
  assert(!/wa_messages|\bfacts\b/.test(sql.text));
  assert(sql.values.includes("%pix !%!_' ; DROP TABLE summaries; --%"));
  const api = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');
  assert(api.indexOf("app.route('/api/discover'") > api.indexOf('const authFailLimiter'));
  assert(api.includes("if(p.scope==='manage')"));
});

test('malformed and oversized discovery requests cannot reach the database', async () => {
  let calls = 0;
  const routes = discoveryRoutes({ query: async () => { calls++; throw Error(); } } as any);
  for (const [body, status] of [['{', 400], [JSON.stringify({ query: '' }), 400], [' '.repeat(4100), 413]] as const) {
    const res = await routes.request('/', { method: 'POST', body });
    assert.equal(res.status, status);
  }
  assert.equal(calls, 0);
});

test('database failures give recoverable errors without private details; rate limits bound repeated searches', async () => {
  let calls = 0;
  const routes = discoveryRoutes({ query: async () => { calls++; throw Error('secret SQL and evidence'); } } as any);
  const request = () => routes.request('/', { method: 'POST', body: JSON.stringify({ query: 'prazo' }) });
  const res = await request();
  assert.equal(res.status, 503);
  assert(!(await res.text()).includes('secret'));
  for (let i = 1; i < 30; i++) await request();
  const limited = await request();
  assert.equal(limited.status, 429); assert.equal(calls, 30);
  assert(limited.headers.has('Retry-After'));
});

test('discovery needs authentication before invoking a database', async () => {
  let called = false;
  const app = new Hono();
  app.use('*', async (c, next) => c.req.header('Authorization') === 'Bearer synthetic' ? next() : c.json({ error: 'Unauthorized' }, 401));
  app.route('/api/discover', discoveryRoutes({ query: async () => { called = true; return { rows: [{ results: [], total: 0, saved: 0 }] }; } } as any));
  assert.equal((await app.request('/api/discover', { method: 'POST', body: '{"query":"prazo"}' })).status, 401);
  assert.equal(called, false);
  const result = await app.request('/api/discover', { method: 'POST', headers: { Authorization: 'Bearer synthetic' }, body: '{"query":"prazo"}' });
  assert.equal(result.status, 200); assert.equal((await result.json()).generated, false);
});

test('real PostgreSQL retrieval: Portuguese stemming, ranking, pagination, safe excerpts and tenant boundaries', { skip: !process.env.SUCO_DISCOVERY_TEST_DATABASE_URL }, async () => {
  const url = new URL(process.env.SUCO_DISCOVERY_TEST_DATABASE_URL!);
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '5436');
  assert(/^suco_discovery_[a-f0-9]{12}$/.test(url.pathname.slice(1)));
  const db = new pg.Pool({ connectionString: url.toString(), max: 1 });
  try {
    await db.query(`CREATE TABLE summaries(id uuid PRIMARY KEY,chat_jid text,chat_name text,title text,analysis_type text,period_start timestamptz,period_end timestamptz,created_at timestamptz,content text)`);
    for (let i = 1; i <= 24; i++) await db.query(`INSERT INTO summaries VALUES($1,'synthetic@g.us','Equipe Sintética',$2,'meeting',now(),now(),now(),$3)`, [
      `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, i === 1 ? 'Lançamento Aurora' : `Suco ${i}`, i === 1 ? 'Decidimos lançar o produto Aurora na sexta. A Ana cuida das entregas.' : 'Entrega de materiais do lançamento na sexta.',
    ]);
    const run = async (query: string, offset = 0) => (await db.query(discoverySQL(discoveryInput({ query, offset })))).rows[0];
    const first = await run('lançamento');
    assert.equal(first.total, 24); assert.equal(first.results.length, 20);
    assert.equal(first.results[0].title, 'Lançamento Aurora');
    const next = await run('lançamento', 20); assert.equal(next.results.length, 4);
    assert(!next.results.some((hit: any) => first.results.some((before: any) => before.id === hit.id)));
    assert.equal((await run('entregas')).total, 24);
    assert.equal((await run('O que ficou combinado sobre o lançamento?')).total, 24);
    assert.equal((await run('assunto totalmente inexistente')).total, 0);
    assert.equal((await run("%_'; DROP TABLE summaries; --")).total, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM summaries')).rows[0].n, 24);
    assert(!JSON.stringify(first).includes('<b>'));
    assert(!('content' in first.results[0]));
    assert.equal((await db.query('SELECT current_database() AS name')).rows[0].name, url.pathname.slice(1));
  } finally { await db.end(); }
});
