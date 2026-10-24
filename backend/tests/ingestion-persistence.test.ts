import test from 'node:test';
import assert from 'node:assert/strict';
import { retryIngestionWrite, retryableIngestionError } from '../src/lib/ingestion-write.js';

const transient = (code: string) => Object.assign(new Error('synthetic failure'), { code });

test('only retryable database and transport failures repeat idempotent writes', async () => {
  let calls = 0;
  const waits: number[] = [];
  const value = await retryIngestionWrite(async () => {
    calls++;
    if (calls < 3) throw transient('08006');
    return 'stored';
  }, async (ms) => { waits.push(ms); });
  assert.equal(value, 'stored');
  assert.equal(calls, 3);
  assert.deepEqual(waits, [75, 200]);
  assert.equal(retryableIngestionError(transient('23503')), false);
  assert.equal(retryableIngestionError(transient('ECONNRESET')), true);

  calls = 0;
  await assert.rejects(retryIngestionWrite(async () => {
    calls++;
    throw transient('23503');
  }, async () => {}), { code: '23503' });
  assert.equal(calls, 1);
});

test('persistent transient failures stop after four attempts', async () => {
  let calls = 0;
  await assert.rejects(retryIngestionWrite(async () => {
    calls++;
    throw transient('57P03');
  }, async () => {}), { code: '57P03' });
  assert.equal(calls, 4);
});

test('ambiguous commit retries the message with the same unique key and exposes metadata only', async () => {
  process.env.API_TOKEN ||= 'synthetic-api-token';
  process.env.DATABASE_URL ||= 'postgres://synthetic:synthetic@127.0.0.1:1/synthetic';
  const db = await import('../src/db.js');
  const originalQuery = db.pool.query;
  const persisted = new Set<string>();
  const seenParameters: unknown[][] = [];
  let attempts = 0;
  const ingestedAt = new Date('2026-10-23T08:00:00.000Z');
  try {
    db.pool.query = (async (sql: string, parameters?: unknown[]) => {
      if (sql.includes('INSERT INTO wa_messages')) {
        attempts++;
        seenParameters.push(parameters ?? []);
        persisted.add(`${parameters?.[0]}/${parameters?.[1]}`);
        if (attempts === 1) throw transient('ECONNRESET');
        return { rowCount: 0, rows: [] };
      }
      assert.match(sql, /SELECT seq::text/);
      assert.doesNotMatch(sql, /\b(body|sender_jid|chat_jid)\b/);
      return { rows: [{ max_saved_seq: '42', last_ingested_at: ingestedAt }] };
    }) as typeof db.pool.query;

    const message = {
      chat_jid: 'synthetic-chat', id: 'synthetic-message', sender_jid: null,
      sender_name: null, from_me: false, body: 'synthetic only', msg_type: 'text',
      ts: new Date('2026-10-23T07:59:00.000Z'),
    };
    await db.insertMessage(message);
    assert.equal(attempts, 2);
    assert.equal(persisted.size, 1);
    assert.deepEqual(seenParameters[0], seenParameters[1]);
    assert.equal(db.getIngestionWriteHealth().consecutiveWriteFailures, 0);
    assert.deepEqual(await db.getIngestionCursor(), {
      maxSavedSeq: '42', lastIngestedAt: ingestedAt,
    });

    db.pool.query = (async () => { throw Object.assign(transient('23503'), { detail: 'synthetic private value' }); }) as typeof db.pool.query;
    await assert.rejects(db.insertMessage(message), { code: '23503' });
    const health = db.getIngestionWriteHealth();
    assert.equal(health.consecutiveWriteFailures, 1);
    assert.ok(health.lastWriteFailureAt instanceof Date);
    assert.doesNotMatch(JSON.stringify(health), /synthetic private value/);
  } finally {
    db.pool.query = originalQuery;
    await db.pool.end();
  }
});
