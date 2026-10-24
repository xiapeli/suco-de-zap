import test from 'node:test';
import assert from 'node:assert/strict';
import pg, { type PoolClient } from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const url = process.env.SUCO_SPOOL_SQL_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' ||
      !/^\/suco_spool_[a-f0-9]{12}$/.test(parsed.pathname) ||
      parsed.username !== parsed.pathname.slice(1)) throw Error('SYNTHETIC_SPOOL_DATABASE_REQUIRED');
}

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const OBJECT = '33333333-3333-8333-8333-333333333333';
const NONCE = '00112233445566778899aabb';
const CIPHER = 'ab'.repeat(48);

test('Supabase spool SQL enforces gated ciphertext-only stage/list/ack per verified user', { skip: !url }, async (t) => {
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
  const migration = readFileSync(fileURLToPath(new URL('../../supabase/migrations/legacy/20261023_ingestion_spool.sql', import.meta.url)), 'utf8');
  await pool.query(migration);

  async function asUser<T>(user: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE authenticated');
      await client.query('SELECT set_config($1,$2,true)', ['request.jwt.claim.sub', user]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  const stage = (client: PoolClient, ciphertext = CIPHER, nonce = NONCE) => client.query(
    'SELECT public.suco_ingestion_stage($1,1,$2,$3) AS revision', [OBJECT, nonce, ciphertext]
  );
  const list = (client: PoolClient) => client.query(
    'SELECT * FROM public.suco_ingestion_list(null,100)'
  );

  await assert.rejects(asUser(A, (client) => stage(client)), { code: '55000' });
  const columns = (await pool.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='suco_ingestion_spool'"
  )).rows.map((r) => r.column_name);
  assert.deepEqual(columns.sort(), ['owner_id','object_id','key_epoch','nonce','ciphertext','revision','staged_at'].sort());
  const security = (await pool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
    "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='public.suco_ingestion_spool'::regclass"
  )).rows[0];
  assert.deepEqual(security, { relrowsecurity: true, relforcerowsecurity: true });

  await pool.query('UPDATE suco_control.private_storage_gate SET writes_enabled=true WHERE singleton=true');
  assert.equal((await asUser(A, (client) => stage(client))).rows[0].revision, '1');
  assert.equal((await asUser(A, (client) => stage(client, 'cd'.repeat(48), 'ffeeddccbbaa998877665544'))).rows[0].revision, '1');
  const aRows = (await asUser(A, list)).rows;
  assert.equal(aRows.length, 1);
  assert.equal(aRows[0].ciphertext_hex, CIPHER); // Retransmission did not overwrite.
  assert.deepEqual((await asUser(B, list)).rows, []);
  assert.equal((await asUser(B, (client) => client.query(
    'SELECT public.suco_ingestion_ack($1,1) AS ok', [OBJECT]
  ))).rows[0].ok, true);
  assert.equal((await asUser(A, list)).rows.length, 1);
  await assert.rejects(asUser(A, (client) => client.query('SELECT * FROM public.suco_ingestion_spool')), { code: '42501' });
  await assert.rejects(asUser(A, (client) => stage(client, CIPHER, 'bad')), { code: '22023' });
  await assert.rejects(asUser(A, (client) => client.query('SELECT * FROM public.suco_ingestion_list(null,101)')), { code: '22023' });
  assert.equal((await asUser(A, (client) => client.query(
    'SELECT public.suco_ingestion_ack($1,1) AS ok', [OBJECT]
  ))).rows[0].ok, true);
  assert.deepEqual((await asUser(A, list)).rows, []);

  await pool.query('UPDATE suco_control.private_storage_gate SET writes_enabled=false WHERE singleton=true');
  await assert.rejects(asUser(A, (client) => stage(client)), { code: '55000' });
  const count = (await pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM public.suco_ingestion_spool')).rows[0].n;
  assert.equal(count, 0);
});
