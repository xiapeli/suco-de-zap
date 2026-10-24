import test from 'node:test';
import assert from 'node:assert/strict';
import pg, { type PoolClient } from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const url = process.env.SUCO_PRIVATE_MESSAGE_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' ||
      !/^\/suco_private_[a-f0-9]{12}$/.test(parsed.pathname) ||
      parsed.username !== parsed.pathname.slice(1)) throw Error('SYNTHETIC_PRIVATE_DATABASE_REQUIRED');
}
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const objectId = (n: number) => `33333333-3333-8333-8333-${n.toString(16).padStart(12, '0')}`;

test('private message SQL commits ciphertext immutably and pages only the verified owner', { skip: !url }, async (t) => {
  const pool = new pg.Pool({ connectionString: url });
  t.after(() => pool.end());
  await pool.query(`
    -- Re-runnable on a synthetic database: clear any previous run first.
    DROP SCHEMA IF EXISTS auth CASCADE;
    DROP SCHEMA IF EXISTS suco_control CASCADE;
    DROP SCHEMA IF EXISTS suco_migration CASCADE;
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
    GRANT USAGE ON SCHEMA public TO public;
    DO $do$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
    END $do$;
    CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA auth TO authenticated, anon;
    CREATE SCHEMA suco_control;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,is_anonymous boolean NOT NULL DEFAULT false);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    CREATE TABLE suco_control.private_storage_gate(singleton boolean PRIMARY KEY, writes_enabled boolean NOT NULL);
    INSERT INTO suco_control.private_storage_gate VALUES(true,false);
    CREATE FUNCTION public.suco_verified_uid() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path = '' AS $$
      SELECT u.id FROM auth.users u WHERE u.id=auth.uid() AND u.email IS NOT NULL
        AND u.email_confirmed_at IS NOT NULL AND u.is_anonymous=false
      $$;
    REVOKE ALL ON FUNCTION public.suco_verified_uid() FROM public,anon,service_role;
    GRANT EXECUTE ON FUNCTION public.suco_verified_uid() TO authenticated;
    INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
      ('${A}','synthetic-a@example.invalid',now()),
      ('${B}','synthetic-b@example.invalid',now());
  `);
  const migration = readFileSync(fileURLToPath(new URL('../../supabase/migrations/legacy/20261023_private_messages.sql', import.meta.url)), 'utf8');
  await pool.query(migration);
  const readMigration = readFileSync(fileURLToPath(new URL('../../supabase/migrations/legacy/20261023_private_message_read.sql', import.meta.url)), 'utf8');
  await pool.query(readMigration);
  async function asUser<T>(user: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE authenticated');
      await client.query('SELECT set_config($1,$2,true)', ['request.jwt.claim.sub', user]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  const commit = (c: PoolClient, id: string, cipher = 'ab'.repeat(48)) => c.query(
    'SELECT public.suco_message_commit($1,1,$2,$3) AS receipt',
    [id, '00112233445566778899aabb', cipher]
  );
  const list = (c: PoolClient, after: string | null, limit = 100) => c.query(
    'SELECT * FROM public.suco_message_list($1,$2)', [after, limit]
  );
  const read = (c: PoolClient, id: string) => c.query(
    'SELECT * FROM public.suco_message_read($1)', [id]
  );
  await assert.rejects(asUser(A, (c) => commit(c, objectId(1))), { code: '55000' });
  await pool.query('UPDATE suco_control.private_storage_gate SET writes_enabled=true WHERE singleton=true');
  assert.deepEqual((await asUser(A, (c) => commit(c, objectId(1)))).rows[0].receipt,
    { revision: 1, created: true });
  assert.deepEqual((await asUser(A, (c) => commit(c, objectId(1), 'cd'.repeat(48)))).rows[0].receipt,
    { revision: 1, created: false });
  assert.equal((await asUser(A, (c) => list(c, null))).rows[0].ciphertext_hex, 'ab'.repeat(48));
  assert.equal((await asUser(A, (c) => read(c, objectId(1)))).rows[0].ciphertext_hex, 'ab'.repeat(48));
  assert.deepEqual((await asUser(B, (c) => read(c, objectId(1)))).rows, []);
  assert.deepEqual((await asUser(B, (c) => list(c, null))).rows, []);
  await assert.rejects(asUser(A, (c) => c.query('SELECT * FROM public.suco_private_messages')), { code: '42501' });
  await assert.rejects(asUser(A, (c) => list(c, null, 101)), { code: '22023' });

  for (let n = 2; n <= 105; n++) {
    const nonce = n.toString(16).padStart(24, '0');
    await asUser(A, (c) => c.query('SELECT public.suco_message_commit($1,1,$2,$3)',
      [objectId(n), nonce, 'ab'.repeat(48)]));
  }
  const first = (await asUser(A, (c) => list(c, null))).rows;
  const second = (await asUser(A, (c) => list(c, first.at(-1).object_id))).rows;
  assert.equal(first.length, 100);
  assert.equal(second.length, 5);
  assert.equal(new Set([...first, ...second].map((r) => r.object_id)).size, 105);
  const columns = (await pool.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='suco_private_messages'"
  )).rows.map((r) => r.column_name);
  assert.deepEqual(columns.sort(), ['owner_id','object_id','key_epoch','nonce','ciphertext','revision','stored_at'].sort());
  const security = (await pool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
    "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='public.suco_private_messages'::regclass"
  )).rows[0];
  assert.deepEqual(security, { relrowsecurity: true, relforcerowsecurity: true });
});
