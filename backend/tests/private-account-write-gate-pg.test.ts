import test from 'node:test';
import assert from 'node:assert/strict';
import pg, { type PoolClient } from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const url = process.env.SUCO_PRIVATE_GATE_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' ||
      !/^\/suco_private_[a-f0-9]{12}$/.test(parsed.pathname) ||
      parsed.username !== parsed.pathname.slice(1)) throw Error('SYNTHETIC_PRIVATE_DATABASE_REQUIRED');
}
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-8333-8333-333333333333';
const authCipher = '5355434f4155544831' + 'aa'.repeat(40);
const nonce = '00112233445566778899aabb';
const cipher = 'ab'.repeat(48);
const sql = (name: string) => readFileSync(fileURLToPath(new URL(
  `../../supabase/migrations/legacy/${name}.sql`, import.meta.url)), 'utf8');

test('global gate plus private_state active gates every confidential mutation per verified account',
  { skip: !url }, async (t) => {
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
      REVOKE ALL ON SCHEMA suco_control FROM public, anon, authenticated, service_role;
      CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,
        is_anonymous boolean NOT NULL DEFAULT false);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
      CREATE TABLE suco_control.accounts (
        user_id uuid PRIMARY KEY REFERENCES auth.users(id),
        private_state text NOT NULL DEFAULT 'private_setup_pending'
          CHECK (private_state = 'private_setup_pending')
      );
      INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
        ('${A}','synthetic-owner@example.invalid',now()),
        ('${B}','synthetic-pending@example.invalid',now());
      INSERT INTO suco_control.accounts(user_id) VALUES ('${A}'),('${B}');
    `);
    for (const name of [
      '20261023_cipher_objects', '20261023_confidential_auth',
      '20261023_ingestion_spool', '20261023_private_messages',
      '20261023_private_metadata', '20261023_private_account_write_gate',
    ]) await pool.query(sql(name));
    // The migration is repeatable and must not change any account or switch.
    await pool.query(sql('20261023_private_account_write_gate'));
    const before = (await pool.query(`SELECT
      (SELECT writes_enabled FROM suco_control.private_storage_gate WHERE singleton) AS global,
      (SELECT COUNT(*)::integer FROM suco_control.accounts WHERE private_state='active') AS active`)).rows[0];
    assert.deepEqual(before, { global: false, active: 0 });

    async function asUser<T>(owner: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE authenticated');
        await client.query('SELECT set_config($1,$2,true)', ['request.jwt.claim.sub', owner]);
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const writes = [
      (c: PoolClient) => c.query('SELECT public.suco_auth_cas(0,$1)', [authCipher]),
      (c: PoolClient) => c.query('SELECT public.suco_auth_archive(1,$1)', [authCipher]),
      (c: PoolClient) => c.query('SELECT public.suco_ingestion_stage($1,1,$2,$3)', [ID, nonce, cipher]),
      (c: PoolClient) => c.query('SELECT public.suco_ingestion_ack($1,1)', [ID]),
      (c: PoolClient) => c.query('SELECT public.suco_message_commit($1,1,$2,$3)', [ID, nonce, cipher]),
      (c: PoolClient) => c.query('SELECT public.suco_meta_put($1,0,1,$2,$3)', [ID, nonce, cipher]),
      (c: PoolClient) => c.query("SELECT public.suco_cipher_put($1,0,1,decode($2,'hex'),decode($3,'hex'))", [ID, nonce, cipher]),
    ];
    for (const write of writes) {
      await assert.rejects(asUser(A, write), { code: '55000' }); // Global OFF.
      await assert.rejects(asUser(B, write), { code: '55000' });
    }
    await pool.query("UPDATE suco_control.accounts SET private_state='active' WHERE user_id=$1", [A]);
    await pool.query('UPDATE suco_control.private_storage_gate SET writes_enabled=true WHERE singleton=true');
    for (const write of writes) await assert.rejects(asUser(B, write), { code: '55000' });
    for (const write of writes) await asUser(A, write);
    const counts = (await pool.query(`SELECT
      (SELECT COUNT(*)::integer FROM public.suco_auth_state) AS auth,
      (SELECT COUNT(*)::integer FROM public.suco_auth_archive) AS archive,
      (SELECT COUNT(*)::integer FROM public.suco_private_messages) AS messages,
      (SELECT COUNT(*)::integer FROM public.suco_private_metadata) AS metadata,
      (SELECT COUNT(*)::integer FROM public.suco_cipher_objects) AS cipher`)).rows[0];
    assert.deepEqual(counts, { auth: 1, archive: 1, messages: 1, metadata: 1, cipher: 1 });
    await pool.query("UPDATE suco_control.accounts SET private_state='suspended' WHERE user_id=$1", [A]);
    await assert.rejects(asUser(A, (c) => c.query(
      'SELECT public.suco_meta_put($1,1,1,$2,$3)', [ID, '8899aabbccddeeff00112233', cipher])),
    { code: '55000' });
    await assert.rejects(asUser(A, (c) => c.query('SELECT suco_control.require_private_write($1)', [A])),
      { code: '42501' });
  });
