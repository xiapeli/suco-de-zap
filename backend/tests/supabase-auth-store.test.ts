import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseAuthStore } from '../src/lib/supabase-auth-store.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SEALED = Buffer.concat([Buffer.from('SUCOAUTH1'), Buffer.alloc(12, 1), Buffer.alloc(16, 2), Buffer.from([3])]);
const jwt = (sub: string, role = 'authenticated') => `header.${Buffer.from(JSON.stringify({
  sub, role, exp: Math.floor(Date.now() / 1000) + 3600,
})).toString('base64url')}.signature`;

test('remote auth store sends only sealed bytes with owner JWT and verifies revisions', async () => {
  const calls: Array<{ name: string; body: Record<string, unknown>; authorization: string }> = [];
  const ownerToken = jwt(OWNER);
  const fetcher: typeof fetch = async (input, init) => {
    const name = String(input).split('/').at(-1)!;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ name, body, authorization: new Headers(init?.headers).get('Authorization') || '' });
    const result = name === 'suco_auth_read'
      ? [{ revision: '1', ciphertext_hex: SEALED.toString('hex') }]
      : name === 'suco_auth_cas' ? '2' : true;
    return new Response(JSON.stringify(result), { status: 200 });
  };
  const store = createSupabaseAuthStore({ url: 'https://synthetic.supabase.co',
    publishableKey: 'sb_publishable_synthetic', ownerId: OWNER,
    userJwt: async () => ownerToken, fetcher });
  assert.deepEqual(await store.read(), { revision: '1', ciphertext: SEALED });
  assert.equal(await store.compareAndSwap('1', SEALED), '2');
  await store.archive({ revision: '1', ciphertext: SEALED });
  assert.deepEqual(calls.map((call) => call.name), ['suco_auth_read','suco_auth_cas','suco_auth_archive']);
  assert.equal(calls[1].body.p_expected_revision, '1');
  assert.equal(calls[1].body.p_ciphertext_hex, SEALED.toString('hex'));
  assert.equal(calls[2].body.p_ciphertext_hex, SEALED.toString('hex'));
  assert.ok(calls.every((call) => call.authorization === `Bearer ${ownerToken}`));
  assert.equal(JSON.stringify(calls).includes('5511999999999'), false);
});

test('wrong owner JWT or service role key never reaches the remote auth endpoint', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return new Response('[]'); };
  assert.throws(() => createSupabaseAuthStore({ url: 'https://synthetic.supabase.co',
    publishableKey: 'sb_secret_synthetic', ownerId: OWNER, userJwt: async () => jwt(OWNER), fetcher }),
  { code: 'AUTH_STATE_INPUT' });
  const store = createSupabaseAuthStore({ url: 'https://synthetic.supabase.co',
    publishableKey: 'sb_publishable_synthetic', ownerId: OWNER, userJwt: async () => jwt(OTHER), fetcher });
  await assert.rejects(store.read(), { code: 'AUTH_STATE_AUTH' });
  assert.equal(calls, 0);
});

test('remote conflict and write gate failures are distinct and never auto-retry CAS', async () => {
  let calls = 0;
  let mode: 'conflict' | 'gate' = 'conflict';
  const fetcher: typeof fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ code: mode === 'conflict' ? '40001' : '55000' }), { status: 409 });
  };
  const store = createSupabaseAuthStore({ url: 'https://synthetic.supabase.co',
    publishableKey: 'sb_publishable_synthetic', ownerId: OWNER, userJwt: async () => jwt(OWNER), fetcher });
  await assert.rejects(store.compareAndSwap(null, SEALED), { code: 'AUTH_STATE_CONFLICT' });
  assert.equal(calls, 1);
  mode = 'gate';
  await assert.rejects(store.compareAndSwap(null, SEALED), { code: 'AUTH_STATE_STORE' });
  assert.equal(calls, 2);
});

test('malformed ciphertext and remote read are rejected before using auth state', async () => {
  const store = createSupabaseAuthStore({ url: 'https://synthetic.supabase.co',
    publishableKey: 'sb_publishable_synthetic', ownerId: OWNER, userJwt: async () => jwt(OWNER),
    fetcher: async () => new Response(JSON.stringify([{ revision: '1', ciphertext_hex: '7b22706969223a3120' }])) });
  await assert.rejects(store.read(), { code: 'AUTH_STATE_CORRUPT' });
  await assert.rejects(store.compareAndSwap(null, Buffer.from('{"plaintext":true}')), { code: 'AUTH_STATE_INPUT' });
});
