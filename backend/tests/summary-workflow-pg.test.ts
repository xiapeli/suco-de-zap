import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import {
  SUMMARY_REQUEST_SCHEMA, SqlSummaryStore, runSummaryWorkflow, summaryAiPermitted,
  type TrialControl,
} from '../src/summary-workflow.js';

const url = process.env.SUCO_SUMMARY_TEST_DATABASE_URL;
if (url) {
  const u = new URL(url);
  if (u.hostname !== '127.0.0.1' || u.port !== '5436' ||
      !/^\/suco_summary_[a-f0-9]{12}$/.test(u.pathname) || u.username !== u.pathname.slice(1)) {
    throw Error('SYNTHETIC_SUMMARY_DATABASE_REQUIRED');
  }
}

// Only the central quota service is synthetic here; request locks, UUID persistence,
// saved results and process-restart recovery use an actual isolated PostgreSQL DB.
class Quota implements TrialControl {
  rows = new Map<string, { state: string; reservationId: string; summaryId: string }>();
  failReserveAck = false;
  failCommitAck = false;
  commits = 0;
  releases = 0;
  async reserve(requestId: string, summaryId: string) {
    let row = this.rows.get(requestId);
    if (row && row.summaryId !== summaryId) throw Error('SUMMARY_REQUEST_ALREADY_USED');
    if (!row) {
      if ([...this.rows.values()].filter(v => v.state !== 'released').length >= 3) {
        return { allowed: false, state: 'denied', reservationId: null, summaryId };
      }
      row = { state: 'reserved', reservationId: randomUUID(), summaryId };
      this.rows.set(requestId, row);
    }
    if (this.failReserveAck) { this.failReserveAck = false; throw Error('RESERVE_RESPONSE_LOST'); }
    return { ...row, allowed: row.state === 'reserved' };
  }
  async commit(requestId: string, reservationId: string, summaryId: string) {
    const row = this.rows.get(requestId)!;
    assert.equal(row.reservationId, reservationId);
    assert.equal(row.summaryId, summaryId);
    assert.notEqual(row.state, 'released');
    if (row.state !== 'committed') { row.state = 'committed'; this.commits++; }
    if (this.failCommitAck) throw Error('COMMIT_RESPONSE_LOST');
    return { state: row.state };
  }
  async release(requestId: string, reservationId: string) {
    const row = this.rows.get(requestId)!;
    assert.equal(row.reservationId, reservationId);
    assert.notEqual(row.state, 'committed');
    if (row.state !== 'released') { row.state = 'released'; this.releases++; }
    return { state: row.state };
  }
}

test('durable three-Suco workflow on isolated real PostgreSQL', { skip: !url }, async t => {
  const pool = new pg.Pool({ connectionString: url, max: 16 });
  t.after(() => pool.end());
  await pool.query(SUMMARY_REQUEST_SCHEMA);
  await pool.query('CREATE TABLE summaries(id uuid PRIMARY KEY,content text NOT NULL,model text NOT NULL)');
  const reset = async () => pool.query('TRUNCATE suco_summary_requests,summaries');
  const persisted = async () => Number((await pool.query('SELECT count(*)::int n FROM summaries')).rows[0].n);
  function scenario() {
    const quota = new Quota();
    let calls = 0;
    const process = async () => { calls++; assert.equal(summaryAiPermitted(), true); return { content: 'Synthetic result', model: 'test-only' }; };
    const persist = async (value: { content: string; model: string }, id: string) =>
      (await pool.query('INSERT INTO summaries(id,content,model) VALUES($1,$2,$3) RETURNING *', [id, value.content, value.model])).rows[0];
    const run = (requestId: string, options: Partial<Parameters<typeof runSummaryWorkflow<{ content: string; model: string }>>[0]> = {}) =>
      runSummaryWorkflow({ requestId, fingerprint: 'immutable-payload', store: new SqlSummaryStore(pool), control: quota, process, persist, ...options });
    return { quota, run, process, persist, calls: () => calls };
  }

  await t.test('twelve concurrent different requests save exactly three; fourth remains denied after store recreation', async () => {
    await reset(); const s = scenario();
    const outcomes = await Promise.allSettled(Array.from({ length: 12 }, (_, n) => s.run(`concurrent-${n}`)));
    assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 3);
    assert.equal(outcomes.filter(r => r.status === 'rejected' && r.reason.code === 'TRIAL_EXHAUSTED').length, 9);
    assert.equal(await persisted(), 3); assert.equal(s.calls(), 3); assert.equal(s.quota.commits, 3);
    await assert.rejects(s.run('after-restart'), /TRIAL_EXHAUSTED/);
  });

  await t.test('same request across independent SQL stores cannot call provider twice and survives reload', async () => {
    await reset(); const s = scenario();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    const waiting = new Promise<void>(r => { release = r; });
    const first = s.run('same-request', { process: async () => { const value = await s.process(); entered(); await waiting; return value; } });
    await started;
    const duplicates = await Promise.allSettled(Array.from({ length: 6 }, () => s.run('same-request')));
    assert.equal(duplicates.filter(r => r.status === 'rejected' && r.reason.code === 'SUMMARY_REQUEST_BUSY').length, 6);
    release(); const saved = await first;
    const reloaded = await s.run('same-request');
    assert.equal(reloaded.id, saved.id); assert.equal(s.calls(), 1); assert.equal(await persisted(), 1); assert.equal(s.quota.commits, 1);
    await assert.rejects(s.run('same-request', { fingerprint: 'changed-payload' }), /SUMMARY_REQUEST_CHANGED/);
  });

  await t.test('failed provider refunds its reservation and three later successes remain available', async () => {
    await reset(); const s = scenario();
    await assert.rejects(s.run('provider-failed', { process: async () => { throw Error('CONFIRMED_PROVIDER_FAILURE'); } }), /CONFIRMED_PROVIDER_FAILURE/);
    assert.equal(s.quota.releases, 1); assert.equal(await persisted(), 0);
    await assert.rejects(s.run('provider-failed'), /SUMMARY_REQUEST_ALREADY_USED/);
    for (let n = 0; n < 3; n++) await s.run(`after-failure-${n}`);
    assert.equal(s.calls(), 3); assert.equal(s.quota.commits, 3); assert.equal(await persisted(), 3);
    await assert.rejects(s.run('one-too-many'), /TRIAL_EXHAUSTED/);
  });

  await t.test('lost reservation acknowledgement reuses the central reservation and still calls provider once', async () => {
    await reset(); const s = scenario(); s.quota.failReserveAck = true;
    await assert.rejects(s.run('reserve-lost'), /RESERVE_RESPONSE_LOST/);
    assert.equal(s.calls(), 0); assert.equal(s.quota.rows.size, 1);
    await s.run('reserve-lost');
    assert.equal(s.calls(), 1); assert.equal(s.quota.rows.size, 1); assert.equal(s.quota.commits, 1);
  });

  await t.test('result committed to PostgreSQL despite lost response is recovered without another AI call', async () => {
    await reset(); const s = scenario();
    await assert.rejects(s.run('persist-lost', { persist: async (value, id) => { await s.persist(value, id); throw Error('DB_RESPONSE_LOST'); } }), /TRIAL_PERSIST_PENDING/);
    assert.equal(await persisted(), 1); assert.equal(s.quota.releases, 0); assert.equal(s.quota.commits, 0);
    await s.run('persist-lost');
    assert.equal(await persisted(), 1); assert.equal(s.calls(), 1); assert.equal(s.quota.commits, 1);
  });

  await t.test('lost commit acknowledgement retries only quota confirmation after process restart', async () => {
    await reset(); const s = scenario(); s.quota.failCommitAck = true;
    await assert.rejects(s.run('commit-lost'), /TRIAL_COMMIT_PENDING/);
    assert.equal(await persisted(), 1); assert.equal(s.quota.commits, 1); assert.equal(s.quota.releases, 0);
    s.quota.failCommitAck = false;
    await s.run('commit-lost');
    assert.equal(s.calls(), 1); assert.equal(s.quota.commits, 1); assert.equal(await persisted(), 1);
  });

  await t.test('uncertain persistence with no saved result never triggers another paid provider call or refund', async () => {
    await reset(); const s = scenario();
    await assert.rejects(s.run('persist-uncertain', { persist: async () => { throw Error('UNKNOWN_PERSISTENCE'); } }), /TRIAL_PERSIST_PENDING/);
    await assert.rejects(s.run('persist-uncertain'), /SUMMARY_REQUEST_PENDING/);
    assert.equal(s.calls(), 1); assert.equal(s.quota.releases, 0); assert.equal(s.quota.rows.size, 1); assert.equal(await persisted(), 0);
  });
});
