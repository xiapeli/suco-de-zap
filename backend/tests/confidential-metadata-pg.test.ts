import test from 'node:test';
import assert from 'node:assert/strict';
import pg, { type PoolClient } from 'pg';
import { readFileSync } from 'node:fs';

const url = process.env.SUCO_META_SQL_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' ||
      !/^\/suco_meta_[a-f0-9]{12}$/.test(parsed.pathname) ||
      parsed.username !== parsed.pathname.slice(1)) throw Error('SYNTHETIC_METADATA_DATABASE_REQUIRED');
}
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const OBJECT = '33333333-3333-8333-8333-333333333333';
const NONCE = '00112233445566778899aabb';
const CIPHER = 'ab'.repeat(48);

test('encrypted metadata SQL isolates accounts, enforces CAS and keeps gate closed', { skip: !url }, async (t) => {
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
  const migration = readFileSync(new URL('../../supabase/migrations/legacy/20261023_private_metadata.sql', import.meta.url), 'utf8');
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
  const list = (client: PoolClient) => client.query('SELECT * FROM public.suco_meta_list(null,100)');
  const put = (client: PoolClient, revision: number, cipher = CIPHER) => client.query(
    'SELECT public.suco_meta_put($1,$2,1,$3,$4) AS revision', [OBJECT, revision, NONCE, cipher]);
  await assert.rejects(asUser(A, (client) => put(client, 0)), { code:'55000' });
  await assert.rejects(asUser(A, (client) => client.query('SELECT * FROM public.suco_private_metadata')), { code:'42501' });
  const security=(await pool.query(`SELECT
    (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='public.suco_private_metadata'::regclass) AS forced_rls,
    has_function_privilege('anon','public.suco_meta_list(uuid,integer)','EXECUTE') AS anon_list,
    has_function_privilege('service_role','public.suco_meta_put(uuid,bigint,integer,text,text)','EXECUTE') AS service_put,
    has_function_privilege('authenticated','public.suco_meta_put(uuid,bigint,integer,text,text)','EXECUTE') AS auth_put`)).rows[0];
  assert.deepEqual(security,{forced_rls:true,anon_list:false,service_put:false,auth_put:true});
  await pool.query('UPDATE suco_control.private_storage_gate SET writes_enabled=true WHERE singleton=true');
  assert.equal((await asUser(A,(client)=>put(client,0))).rows[0].revision,'1');
  assert.deepEqual((await asUser(B,list)).rows,[]);
  await assert.rejects(asUser(B,(client)=>put(client,1)),{code:'40001'});
  assert.equal((await asUser(B,(client)=>put(client,0))).rows[0].revision,'1');
  await assert.rejects(asUser(A,(client)=>put(client,0)),{code:'40001'});
  assert.equal((await asUser(A,(client)=>put(client,1,'cd'.repeat(48)))).rows[0].revision,'2');
  assert.equal((await asUser(A,list)).rows[0].ciphertext_hex,'cd'.repeat(48));
  await assert.rejects(asUser(A,(client)=>put(client,1)),{code:'40001'});
  await assert.rejects(asUser(A,(client)=>client.query(
    'SELECT public.suco_meta_put($1,2,1,$2,$3)',[OBJECT,'bad',CIPHER])),{code:'22023'});
  await pool.query('UPDATE suco_control.private_storage_gate SET writes_enabled=false WHERE singleton=true');
  await assert.rejects(asUser(A,(client)=>put(client,2)),{code:'55000'});
});
