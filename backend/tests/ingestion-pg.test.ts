import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const url = process.env.SUCO_INGESTION_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' ||
      !/^\/suco_ingestion_[a-f0-9]{12}$/.test(parsed.pathname) ||
      parsed.username !== parsed.pathname.slice(1)) {
    throw Error('SYNTHETIC_INGESTION_DATABASE_REQUIRED');
  }
}

test('Postgres commits message and chat timestamp atomically; duplicate and rollback do not advance it', { skip: !url }, async (t) => {
  const pool = new pg.Pool({ connectionString: url });
  t.after(() => pool.end());
  const schema = readFileSync(fileURLToPath(new URL('../schema.sql', import.meta.url)), 'utf8');
  await pool.query(schema);
  await pool.query("INSERT INTO wa_chats (jid, is_group) VALUES ('synthetic-chat', false)");

  const savedTimestamp = async () => (await pool.query<{ last_message_at: Date | null }>(
    "SELECT last_message_at FROM wa_chats WHERE jid='synthetic-chat'"
  )).rows[0]?.last_message_at?.toISOString() ?? null;
  const put = async (id: string, ts: string) => pool.query(
    `INSERT INTO wa_messages (chat_jid,id,body,ts) VALUES ('synthetic-chat',$1,'synthetic only',$2)
     ON CONFLICT (chat_jid,id) DO NOTHING`,
    [id, ts]
  );
  assert.equal(await savedTimestamp(), null);

  await put('a', '2026-10-23T08:00:00.000Z');
  assert.equal(await savedTimestamp(), '2026-10-23T08:00:00.000Z');
  await put('a', '2026-10-23T10:00:00.000Z');
  assert.equal(await savedTimestamp(), '2026-10-23T08:00:00.000Z');
  await put('b', '2026-10-23T07:00:00.000Z');
  assert.equal(await savedTimestamp(), '2026-10-23T08:00:00.000Z');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO wa_messages (chat_jid,id,body,ts) VALUES ('synthetic-chat','rolled-back','synthetic only','2026-10-23T11:00:00.000Z')"
    );
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  assert.equal(await savedTimestamp(), '2026-10-23T08:00:00.000Z');
  await put('c', '2026-10-23T09:00:00.000Z');
  assert.equal(await savedTimestamp(), '2026-10-23T09:00:00.000Z');
  const rows = await pool.query<{ n: number; ingested: number }>(
    "SELECT COUNT(*)::int AS n, COUNT(ingested_at)::int AS ingested FROM wa_messages WHERE chat_jid='synthetic-chat'"
  );
  assert.deepEqual(rows.rows[0], { n: 3, ingested: 3 });
});
