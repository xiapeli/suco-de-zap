import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { GlmRuntime, MODEL, type ClientOptions, type CallOptions } from '../src/cloud-glm/client.js';
import { PgLedger, RuntimeError, SCHEMA, type Ledger, type Limits, type Usage } from '../src/cloud-glm/ledger.js';

const limits = { monthly: 1, daily: 1, accountConcurrency: 1, globalConcurrency: 1 };
const reply = () => Response.json({ model: MODEL, choices: [{ finish_reason: 'stop', message: { content: 'Resultado inteiramente fictício.' } }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } });
class ObservedLedger implements Ledger {
  reservations: { accountId: string; requestId: string; limits: Limits & { unmetered?: boolean } }[] = [];
  settlements: { id: string; state: string; usage?: Usage }[] = [];
  seen = new Set<string>();
  async reserve(accountId: string, requestId: string, value: Limits) {
    this.reservations.push({ accountId, requestId, limits: { ...value } });
    const key = `${accountId}:${requestId}`;
    if (this.seen.has(key)) throw new RuntimeError('REQUEST_ALREADY_USED', 409);
    this.seen.add(key); return key;
  }
  async settle(id: string, state: 'committed' | 'released' | 'unknown', _outcome: string, usage?: Usage) { this.settlements.push({ id, state, usage }); }
}
async function syntheticKey(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'suco-partner-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const keyFile = join(dir, 'synthetic-key'); await writeFile(keyFile, 'SYNTHETIC-NO-PROVIDER-KEY', { mode: 0o600 }); return keyFile;
}

test('trusted server callback marks owner usage unmetered while recording full usage metadata', async t => {
  const keyFile = await syntheticKey(t), ledger = new ObservedLedger(); let fetches = 0;
  const options = { keyFile, ledger, limits, unmetered: () => true, fetch: async () => { fetches++; return reply(); } };
  const runtime = new GlmRuntime(options);
  assert.equal((await runtime.call('synthetic-owner', 'trusted-callback', 'Texto fictício')).content, 'Resultado inteiramente fictício.');
  assert.equal(ledger.reservations[0].limits.unmetered, true); assert.equal(fetches, 1);
  assert.equal(ledger.settlements[0].state, 'committed'); assert.equal(ledger.settlements[0].usage?.totalTokens, 5);
});

test('caller supplied limits or per-call flags never grant unmetered privilege', async t => {
  const keyFile = await syntheticKey(t);
  for (const callback of [undefined, () => false, () => 'true' as unknown as boolean]) {
    const ledger = new ObservedLedger();
    const options = { keyFile, ledger, limits: { ...limits, unmetered: true }, ...(callback ? { unmetered: callback } : {}), fetch: async () => reply() };
    const runtime = new GlmRuntime(options);
    await runtime.call('synthetic-paid', 'forged-flag', 'Texto fictício', { unmetered: true } as unknown as CallOptions);
    assert.notEqual(ledger.reservations[0].limits.unmetered, true);
  }
});

test('existing runtime reevaluates grant and revocation on each new request', async t => {
  const keyFile = await syntheticKey(t), ledger = new ObservedLedger(); let granted = true;
  const options = { keyFile, ledger, limits, unmetered: () => granted, fetch: async () => reply() };
  const runtime = new GlmRuntime(options);
  await runtime.call('synthetic-partner', 'grant-before', 'Texto fictício'); granted = false;
  await runtime.call('synthetic-partner', 'grant-removed', 'Texto fictício'); granted = true;
  await runtime.call('synthetic-partner', 'grant-restored', 'Texto fictício');
  assert.deepEqual(ledger.reservations.map(r => r.limits.unmetered === true), [true, false, true]);
});

test('unmetered preserves same-request singleflight, concurrency one and completed request idempotency', async t => {
  const keyFile = await syntheticKey(t), ledger = new ObservedLedger(); let fetches = 0, release!: (r: Response) => void, entered!: () => void;
  const gate = new Promise<Response>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
  const options = { keyFile, ledger, limits, unmetered: () => true, fetch: async () => { fetches++; entered(); return gate; } };
  const runtime = new GlmRuntime(options), first = runtime.call('synthetic-owner', 'singleflight', 'Texto fictício');
  const duplicate = runtime.call('synthetic-owner', 'singleflight', 'Texto fictício'); assert.equal(first, duplicate);
  await assert.rejects(runtime.call('synthetic-owner', 'second-concurrent', 'Outro texto'), (e: unknown) => e instanceof RuntimeError && e.code === 'PROCESSING_BUSY');
  await started; release(reply()); await Promise.all([first, duplicate]);
  await assert.rejects(runtime.call('synthetic-owner', 'singleflight', 'Texto fictício'), (e: unknown) => e instanceof RuntimeError && e.code === 'REQUEST_ALREADY_USED');
  assert.equal(fetches, 1); assert.equal(ledger.seen.size, 1);
});

test('unmetered does not bypass source, token or instruction bounds', async t => {
  const keyFile = await syntheticKey(t), ledger = new ObservedLedger(); let fetches = 0;
  const options = { keyFile, ledger, limits, unmetered: () => true, fetch: async () => { fetches++; return reply(); } };
  const runtime = new GlmRuntime(options);
  for (const source of ['', '   ', 'x'.repeat(60_001)]) await assert.rejects(runtime.call('synthetic-owner', 'invalid-source', source), /INVALID_INPUT/);
  for (const invalid of [{ maxTokens: 0 }, { maxTokens: 4097 }, { instruction: 'x'.repeat(15001) }, { task: 'invalid' }]) {
    await assert.rejects(runtime.call('synthetic-owner', 'invalid-options', 'Texto fictício', invalid as CallOptions), /INVALID_OPTIONS/);
  }
  assert.equal(fetches, 0); assert.equal(ledger.reservations.length, 0);
});

test('trusted callback failure cannot silently grant privilege or send provider content', async t => {
  const keyFile = await syntheticKey(t), ledger = new ObservedLedger(); let fetches = 0;
  const options: ClientOptions & { unmetered: () => boolean } = { keyFile, ledger, limits, unmetered: () => { throw Error('SYNTHETIC_AUTHORIZATION_UNAVAILABLE'); }, fetch: async () => { fetches++; return reply(); } };
  await assert.rejects(new GlmRuntime(options).call('synthetic-owner', 'authorization-failed', 'Texto fictício'), /SYNTHETIC_AUTHORIZATION_UNAVAILABLE/);
  assert.equal(fetches, 0); assert.equal(ledger.reservations.length, 0);
});

const url = process.env.SUCO_PARTNER_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' || parsed.port !== '5436' || !/^\/suco_partner_[a-f0-9]{12}$/.test(parsed.pathname) || parsed.username !== parsed.pathname.slice(1)) throw Error('SYNTHETIC_PARTNER_DATABASE_REQUIRED');
}
test('real PostgreSQL partner limits bypass only budget and monitoring quotas', { skip: !url }, async t => {
  const pool = new pg.Pool({ connectionString: url }); t.after(() => pool.end());
  await pool.query(SCHEMA); const keyFile = await syntheticKey(t), ledger = new PgLedger(pool);
  await pool.query('CREATE TABLE wa_chats(jid text PRIMARY KEY,tracked boolean NOT NULL DEFAULT false,archived boolean NOT NULL DEFAULT false,updated_at timestamptz NOT NULL DEFAULT now())');
  const overBudget = async () => {
    await pool.query('TRUNCATE suco_llm_usage');
    await pool.query("INSERT INTO suco_llm_usage(id,account_id,request_id,month_key,day_key,state) SELECT 'seed-'||n,'synthetic-partner','seed-'||n,to_char(now() AT TIME ZONE 'UTC','YYYY-MM'),to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD'),'committed' FROM generate_series(1,3) n");
  };
  await t.test('owner can exceed daily/monthly while a metered request still cannot', async () => {
    await overBudget();
    const unlimited = { ...limits, unmetered: true };
    const id = await ledger.reserve('synthetic-partner', 'owner-past-budget', unlimited); await ledger.settle(id, 'committed', 'SYNTHETIC');
    assert.equal((await pool.query('SELECT count(*)::int n FROM suco_llm_usage')).rows[0].n, 4);
    await assert.rejects(ledger.reserve('synthetic-partner', 'paid-past-budget', { ...limits, unmetered: false }), /USAGE_LIMIT_REACHED/);
    await assert.rejects(ledger.reserve('synthetic-partner', 'owner-past-budget', unlimited), /REQUEST_ALREADY_USED/);
  });
  await t.test('dynamic revocation uses the same runtime and blocks at SQL budget without another provider call', async () => {
    await overBudget(); let granted = true, fetches = 0;
    const options = { keyFile, ledger, limits, unmetered: () => granted, fetch: async () => { fetches++; return reply(); } };
    const runtime = new GlmRuntime(options);
    await runtime.call('synthetic-partner', 'dynamic-unlimited', 'Texto fictício'); granted = false;
    await assert.rejects(runtime.call('synthetic-partner', 'dynamic-revoked', 'Texto fictício'), /USAGE_LIMIT_REACHED/);
    assert.equal(fetches, 1); assert.equal((await pool.query('SELECT count(*)::int n FROM suco_llm_usage')).rows[0].n, 4);
  });
  await t.test('ten concurrent unmetered SQL reservations still admit one active job', async () => {
    await pool.query('TRUNCATE suco_llm_usage');
    const all = await Promise.allSettled(Array.from({ length: 10 }, (_, n) => ledger.reserve('synthetic-partner', 'racing-' + n, { ...limits, unmetered: true })));
    assert.equal(all.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(all.filter(r => r.status === 'rejected' && r.reason.code === 'PROCESSING_BUSY').length, 9);
    await assert.rejects(ledger.reserve('another-partner', 'global-concurrency', { ...limits, unmetered: true }), /PROCESSING_BUSY/);
  });
  await t.test('unmetered flag cannot disable positive numeric limits, lease or request validation', async () => {
    for (const field of ['monthly', 'daily', 'accountConcurrency', 'globalConcurrency']) {
      for (const value of [0, -1, NaN, Infinity, 1.1]) await assert.rejects(ledger.reserve('synthetic-partner', 'bad-numeric', { ...limits, [field]: value, unmetered: true }), /INVALID_LIMIT_CONFIG/);
    }
    for (const value of ['true', 1, null, {}]) await assert.rejects(ledger.reserve('synthetic-partner', 'bad-flag', { ...limits, unmetered: value } as unknown as Limits), /INVALID_LIMIT_CONFIG/);
    await assert.rejects(ledger.reserve('synthetic-partner', 'bad/request', { ...limits, unmetered: true }), /INVALID_REQUEST_ID/);
    await assert.rejects(ledger.reserve('synthetic-partner', 'bad-lease', { ...limits, unmetered: true }, 999), /INVALID_LEASE_CONFIG/);
  });
  await t.test('owner monitoring exceeds cap; paid and free regain the cap; usage keeps counts and unlimited flag', async () => {
    await pool.query('TRUNCATE suco_llm_usage,wa_chats');
    process.env.DATABASE_URL = url; process.env.API_TOKEN = 'SYNTHETIC-PARTNER-TEST'; process.env.SUCO_GLM_REGULAR_KEY_FILE = keyFile;
    process.env.SUCO_TENANT_ID = 'synthetic-partner'; process.env.SUCO_ACCOUNT_ID = 'synthetic-partner'; process.env.SUCO_WORKER_KEY = 'k'.repeat(64); process.env.SUCO_CONTROL_PLANE_URL = 'https://synthetic-partner.convex.site';
    process.env.SUCO_MONITORED_LIMIT = '2'; process.env.SUCO_LLM_DAILY_LIMIT = '1'; process.env.SUCO_LLM_MONTHLY_LIMIT = '1';
    let role = 'owner'; const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ allowed: true, canRead: true, canIngest: true, access: role, consented: true, validUntil: Date.now() + 60_000, paidUntil: role === 'paid' ? Date.now() + 60_000 : 0, trial: { limit: 3, completed: 0, reserved: 0, remaining: 3 } });
    const { pool: appPool } = await import('../src/db.js'); t.after(() => appPool.end());
    try {
      const { tenantAuthorizer, authorizeTenant } = await import('../src/tenant-context.js');
      const { trackCloudChat, usageSnapshot } = await import('../src/cloud-runtime.js');
      await pool.query("INSERT INTO wa_chats(jid,tracked) SELECT 'chat-'||n,n<=2 FROM generate_series(1,8) n");
      assert.equal(await authorizeTenant(), true);
      for (const id of ['chat-3', 'chat-4', 'chat-5', 'chat-6', 'chat-7']) assert((await trackCloudChat(id, undefined, pool))?.tracked);
      const ownerUsage = await usageSnapshot() as { unlimited?: boolean; monitoredUsed: number };
      assert.equal(ownerUsage.unlimited, true); assert.equal(ownerUsage.monitoredUsed, 7);
      for (const next of ['paid', 'trial']) {
        role = next; tenantAuthorizer!.invalidate(); assert.equal(await authorizeTenant(), true);
        await assert.rejects(trackCloudChat('chat-8', undefined, pool), /MONITORED_LIMIT_REACHED/);
        const meteredUsage = await usageSnapshot() as { unlimited?: boolean; monitoredUsed: number };
        assert.notEqual(meteredUsage.unlimited, true); assert.equal(meteredUsage.monitoredUsed, 7);
      }
    } finally { globalThis.fetch = originalFetch; }
  });
});
