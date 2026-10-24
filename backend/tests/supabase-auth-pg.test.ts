import test from 'node:test';
import assert from 'node:assert/strict';
import pg, { type PoolClient } from 'pg';
import { readFileSync } from 'node:fs';

const url = process.env.SUCO_AUTH_SQL_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' ||
      !/^\/suco_auth_[a-f0-9]{12}$/.test(parsed.pathname) ||
      parsed.username !== parsed.pathname.slice(1)) throw Error('SYNTHETIC_AUTH_DATABASE_REQUIRED');
}
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const UNVERIFIED = '33333333-3333-4333-8333-333333333333';
const sealed = Buffer.concat([Buffer.from('SUCOAUTH1'), Buffer.alloc(12, 1), Buffer.alloc(16, 2), Buffer.from([3])]);
const other = Buffer.concat([Buffer.from('SUCOAUTH1'), Buffer.alloc(12, 4), Buffer.alloc(16, 5), Buffer.from([6])]);

test('Supabase auth SQL enforces gate, owner isolation, CAS and exact ciphertext backup', { skip: !url }, async (t) => {
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
      ('${B}','synthetic-b@example.invalid',now()),
      ('${UNVERIFIED}','synthetic-unverified@example.invalid',null);
  `);
  const migration = readFileSync(new URL('../../supabase/migrations/legacy/20261023_confidential_auth.sql', import.meta.url), 'utf8');
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
  const read = (client: PoolClient) => client.query('SELECT * FROM public.suco_auth_read()');
  const cas = (client: PoolClient, revision: number, blob: Buffer) => client.query(
    'SELECT public.suco_auth_cas($1,$2) AS revision', [revision, blob.toString('hex')]);
  const archive = (client: PoolClient, revision: number, blob: Buffer) => client.query(
    'SELECT public.suco_auth_archive($1,$2) AS ok', [revision, blob.toString('hex')]);

  assert.deepEqual((await asUser(A, read)).rows, []);
  await assert.rejects(asUser(A, (client) => cas(client, 0, sealed)), { code: '55000' });
  await assert.rejects(asUser(A, (client) => archive(client, 1, sealed)), { code: '55000' });
  await assert.rejects(asUser(UNVERIFIED, read), { code: '28000' });
  await assert.rejects(asUser(A, (client) => client.query('SELECT * FROM public.suco_auth_state')), { code: '42501' });
  await assert.rejects(asUser(A, (client) => client.query('SELECT * FROM public.suco_auth_archive')), { code: '42501' });
  const privileges = (await pool.query(`SELECT
    has_function_privilege('anon','public.suco_auth_read()','EXECUTE') AS anon_read,
    has_function_privilege('service_role','public.suco_auth_cas(bigint,text)','EXECUTE') AS service_cas,
    has_function_privilege('authenticated','public.suco_auth_cas(bigint,text)','EXECUTE') AS auth_cas,
    (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='public.suco_auth_state'::regclass) AS state_rls,
    (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='public.suco_auth_archive'::regclass) AS archive_rls`)).rows[0];
  assert.deepEqual(privileges, { anon_read: false, service_cas: false, auth_cas: true, state_rls: true, archive_rls: true });

  await pool.query('UPDATE suco_control.private_storage_gate SET writes_enabled=true WHERE singleton=true');
  assert.equal((await asUser(A, (client) => cas(client, 0, sealed))).rows[0].revision, '1');
  assert.deepEqual((await asUser(B, read)).rows, []);
  await assert.rejects(asUser(B, (client) => cas(client, 1, other)), { code: '40001' });
  assert.equal((await asUser(B, (client) => cas(client, 0, other))).rows[0].revision, '1');
  await assert.rejects(asUser(A, (client) => cas(client, 0, other)), { code: '40001' });
  await assert.rejects(asUser(A, (client) => archive(client, 1, other)), { code: '40001' });
  assert.equal((await asUser(A, (client) => archive(client, 1, sealed))).rows[0].ok, true);
  assert.equal((await asUser(A, (client) => archive(client, 1, sealed))).rows[0].ok, true);
  await assert.rejects(asUser(A, (client) => archive(client, 1, other)), { code: '40001' });
  assert.equal((await asUser(A, (client) => cas(client, 1, other))).rows[0].revision, '2');
  assert.deepEqual((await asUser(A, read)).rows, [{ revision: '2', ciphertext_hex: other.toString('hex') }]);
  await assert.rejects(asUser(A, (client) => cas(client, 1, sealed)), { code: '40001' });
  const backups = (await pool.query('SELECT owner_id,source_revision,ciphertext FROM public.suco_auth_archive')).rows;
  assert.equal(backups.length, 1);
  assert.equal(backups[0].owner_id, A);
  assert.equal(backups[0].source_revision, '1');
  assert.deepEqual(backups[0].ciphertext, sealed);
  await pool.query('UPDATE suco_control.private_storage_gate SET writes_enabled=false WHERE singleton=true');
  await assert.rejects(asUser(A, (client) => cas(client, 2, sealed)), { code: '55000' });
});
