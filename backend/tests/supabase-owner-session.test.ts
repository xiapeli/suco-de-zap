import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseOwnerSession, OwnerSessionError } from '../src/lib/supabase-owner-session.js';

const ownerId = '00000000-0000-4000-8000-000000000001';
const email = 'partner@example.com';
const fakeJwt = (exp: number, sub = ownerId) =>
  ['x', Buffer.from(JSON.stringify({ role: 'authenticated', sub, exp })).toString('base64url'), 'x'].join('.');
const expires = Math.floor(Date.now() / 1000) + 3600;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test('refresh rotates token, checks Supabase identity and denies pending account', async () => {
  const paths: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    if (path === '/auth/v1/token') {
      assert.equal(JSON.parse(String(init?.body)).refresh_token, 'old-refresh');
      return response({ access_token: fakeJwt(expires), refresh_token: 'new-refresh' });
    }
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${fakeJwt(expires)}`);
    if (path === '/auth/v1/user') return response({ id: ownerId, email, email_confirmed_at: '2026-10-23T00:00:00Z' });
    if (path === '/rest/v1/rpc/suco_account_status') return response({
      accountId: ownerId, email, entitlement: 'partner_full', privateState: 'private_setup_pending',
    });
    throw Error('unexpected');
  };
  const session = createSupabaseOwnerSession({
    url: 'https://test.supabase.co', publishableKey: 'sb_publishable_test', ownerId,
    accessToken: fakeJwt(1), refreshToken: 'old-refresh', fetcher,
  });
  assert.equal((await session.verifiedAccount()).entitlement, 'partner_full');
  assert.equal(await session.canIngest(), false);
  assert.deepEqual(paths, ['/auth/v1/token', '/auth/v1/user', '/rest/v1/rpc/suco_account_status',
    '/auth/v1/user', '/rest/v1/rpc/suco_account_status']);
  session.close();
  await assert.rejects(session.userJwt(), (e: unknown) => e instanceof OwnerSessionError && e.code === 'OWNER_SESSION_CLOSED');
});

test('foreign Auth user fails closed before account RPC', async () => {
  const paths: string[] = [];
  const session = createSupabaseOwnerSession({
    url: 'https://test.supabase.co', publishableKey: 'sb_publishable_test', ownerId,
    accessToken: fakeJwt(expires), refreshToken: 'refresh',
    fetcher: async url => {
      paths.push(new URL(String(url)).pathname);
      return response({ id: '00000000-0000-4000-8000-000000000002', email, email_confirmed_at: '2026-10-23T00:00:00Z' });
    },
  });
  assert.equal(await session.canIngest(), false);
  assert.deepEqual(paths, ['/auth/v1/user']);
});

test('active grant is checked once for concurrent message callbacks', async () => {
  const paths: string[] = [];
  const session = createSupabaseOwnerSession({
    url: 'https://test.supabase.co', publishableKey: 'sb_publishable_test', ownerId,
    accessToken: fakeJwt(expires), refreshToken: 'refresh',
    fetcher: async url => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === '/auth/v1/user') return response({ id: ownerId, email, email_confirmed_at: '2026-10-23T00:00:00Z' });
      return response({ accountId: ownerId, email, entitlement: 'partner_full', privateState: 'active' });
    },
  });
  assert.deepEqual(await Promise.all([session.canIngest(), session.canIngest(), session.canIngest()]), [true, true, true]);
  assert.equal(await session.canIngest(), true);
  assert.deepEqual(paths, ['/auth/v1/user', '/rest/v1/rpc/suco_account_status']);
  session.close();
  assert.equal(await session.canIngest(), false);
});

test('a reattached browser replaces credentials and invalidates the active grant cache', async () => {
  const oldToken = fakeJwt(expires);
  const nextToken = fakeJwt(expires + 90);
  const seen: string[] = [];
  const session = createSupabaseOwnerSession({
    url: 'https://test.supabase.co', publishableKey: 'sb_publishable_test', ownerId,
    accessToken: oldToken, refreshToken: 'old-refresh',
    fetcher: async (url, init) => {
      seen.push((init?.headers as Record<string, string>).Authorization);
      const path = new URL(String(url)).pathname;
      if (path === '/auth/v1/user') return response({ id: ownerId, email, email_confirmed_at: '2026-10-23T00:00:00Z' });
      return response({ accountId: ownerId, email, entitlement: 'partner_full', privateState: 'active' });
    },
  });
  assert.equal(await session.canIngest(), true);
  await assert.rejects(session.replaceCredentials(fakeJwt(expires, 'wrong-user'), 'wrong'),
    (error: unknown) => error instanceof OwnerSessionError && error.code === 'OWNER_SESSION_AUTH');
  await session.replaceCredentials(nextToken, 'next-refresh');
  assert.deepEqual(session.currentCredentials(), { accessToken: nextToken, refreshToken: 'next-refresh' });
  assert.equal(await session.canIngest(), true);
  assert.deepEqual(seen, [`Bearer ${oldToken}`, `Bearer ${oldToken}`,
    `Bearer ${nextToken}`, `Bearer ${nextToken}`]);
  session.close();
});

test('reattach preserves a healthy worker refresh chain when the browser holds older credentials', async () => {
  const workerToken = fakeJwt(expires + 120);
  const browserToken = fakeJwt(expires);
  const session = createSupabaseOwnerSession({
    url: 'https://test.supabase.co', publishableKey: 'sb_publishable_test', ownerId,
    accessToken: workerToken, refreshToken: 'worker-current',
    fetcher: async url => new URL(String(url)).pathname === '/auth/v1/user'
      ? response({ id: ownerId, email, email_confirmed_at: '2026-10-23T00:00:00Z' })
      : response({ accountId: ownerId, email, entitlement: 'partner_full', privateState: 'active' }),
  });
  assert.equal(await session.recoverCredentials(browserToken, 'browser-stale'), 'preserved');
  assert.deepEqual(session.currentCredentials(), { accessToken: workerToken, refreshToken: 'worker-current' });
  session.close();
});

test('reattach recovers from a revoked worker session only with a verified replacement', async () => {
  const oldToken = fakeJwt(expires);
  const freshToken = fakeJwt(expires + 120);
  const session = createSupabaseOwnerSession({
    url: 'https://test.supabase.co', publishableKey: 'sb_publishable_test', ownerId,
    accessToken: oldToken, refreshToken: 'worker-revoked',
    fetcher: async (url, init) => {
      const token = (init?.headers as Record<string, string>).Authorization;
      if (token === `Bearer ${oldToken}`) return response({ code: 'invalid_token' }, 401);
      return new URL(String(url)).pathname === '/auth/v1/user'
        ? response({ id: ownerId, email, email_confirmed_at: '2026-10-23T00:00:00Z' })
        : response({ accountId: ownerId, email, entitlement: 'partner_full', privateState: 'active' });
    },
  });
  assert.equal(await session.recoverCredentials(freshToken, 'browser-fresh'), 'replaced');
  assert.deepEqual(session.currentCredentials(), { accessToken: freshToken, refreshToken: 'browser-fresh' });
  session.close();
});
