import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { prepareConfidentialRuntime, type ConfidentialRelease } from '../src/lib/confidential-runtime.js';
import { legacyIdentityLockFingerprint } from '../src/lib/confidential-auth-state.js';

const ID = '00000000-0000-4000-8000-000000000001';
const JID = '5511999999999@s.whatsapp.net'; // synthetic only
const jwt = () => ['x', Buffer.from(JSON.stringify({
  role: 'authenticated', sub: ID, exp: Math.floor(Date.now() / 1000) + 3600,
})).toString('base64url'), 'x'].join('.');
const key = randomBytes(32).toString('base64url');
const salt = randomBytes(16).toString('hex');
const proof = { version: 1 as const, salt,
  digest: scryptSync(JID, Buffer.from(salt, 'hex'), 32).toString('hex') };
const pin = { ownerId: ID, fingerprint: legacyIdentityLockFingerprint(proof) };
const baseRelease: ConfidentialRelease = {
  version: 1, ownerId: ID, keyEpoch: 1, key,
  accessToken: jwt(), refreshToken: 'synthetic-refresh',
};

function fakeSupabase(entitlement: 'owner' | 'partner_full', privateState = 'active') {
  let revision = 0;
  let ciphertextHex: string | null = null;
  const paths: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (path === '/auth/v1/user')
      return json({ id: ID, email: 'synthetic@example.test', email_confirmed_at: '2026-10-23T00:00:00Z' });
    if (path === '/rest/v1/rpc/suco_account_status')
      return json({ accountId: ID, email: 'synthetic@example.test', entitlement, privateState });
    if (path === '/rest/v1/rpc/suco_auth_read')
      return json(ciphertextHex ? [{ revision: String(revision), ciphertext_hex: ciphertextHex }] : []);
    if (path === '/rest/v1/rpc/suco_auth_cas') {
      const body = JSON.parse(String(init?.body)) as { p_expected_revision: string; p_ciphertext_hex: string };
      assert.equal(body.p_expected_revision, String(revision));
      assert.equal(body.p_ciphertext_hex.includes(Buffer.from(JID).toString('hex')), false);
      ciphertextHex = body.p_ciphertext_hex;
      revision++;
      return json(String(revision));
    }
    throw Error('unexpected synthetic RPC');
  };
  return { fetcher, paths, setEntitlement: (next: 'owner' | 'partner_full') => { entitlement = next; },
    get writes() { return revision; } };
}

const options = (fake: ReturnType<typeof fakeSupabase>, release: ConfidentialRelease,
  pinnedOwnerIdentity?: typeof pin) => ({
  release, supabaseUrl: 'https://synthetic.supabase.co', publishableKey: 'sb_publishable_synthetic',
  pinnedOwnerIdentity, fetcher: fake.fetcher,
});

test('verified owner policy requires measured pin and imports only matching legacy identity', async () => {
  const fake = fakeSupabase('owner');
  const release = { ...baseRelease, legacyIdentity: { jid: JID, proof },
    pairingPolicy: 'new-account' } as ConfidentialRelease;
  await assert.rejects(prepareConfidentialRuntime(options(fake, release)),
    { message: 'CONFIDENTIAL_OWNER_IDENTITY_PIN_REQUIRED' });
  assert.equal(fake.writes, 0);
  await assert.rejects(prepareConfidentialRuntime(options(fake, release,
    { ownerId: ID, fingerprint: '0'.repeat(64) })), { code: 'PAIRING_IDENTITY_UNAVAILABLE' });
  assert.equal(fake.writes, 0);
  const runtime = await prepareConfidentialRuntime(options(fake, release, pin));
  assert.equal(runtime.pairingPolicy, 'existing-bound');
  assert.equal(runtime.auth.hasImportedLegacyIdentity(), true);
  assert.equal(runtime.auth.identityMatches(JID), true);
  assert.equal(fake.writes, 2, 'empty encrypted auth is initialized before the bound import');
  runtime.close();

  const restarted = await prepareConfidentialRuntime(options(fake, baseRelease, pin));
  assert.equal(restarted.pairingPolicy, 'existing-bound');
  assert.equal(restarted.auth.hasImportedLegacyIdentity(), true);
  assert.equal(fake.writes, 2);
  restarted.close();
});

test('owner cannot start empty, import different JID, or trust a browser supplied pin', async () => {
  const fake = fakeSupabase('owner');
  await assert.rejects(prepareConfidentialRuntime(options(fake, baseRelease, pin)),
    { message: 'CONFIDENTIAL_LEGACY_IDENTITY_REQUIRED' });
  await assert.rejects(prepareConfidentialRuntime(options(fake, {
    ...baseRelease, legacyIdentity: { jid: '5511888888888@s.whatsapp.net', proof },
  }, pin)), { code: 'PAIRING_ACCOUNT_MISMATCH' });
  assert.equal(fake.writes, 0);
});

test('verified partner is a new account and rejects legacy identity even with forged owner policy', async () => {
  const fake = fakeSupabase('partner_full');
  await assert.rejects(prepareConfidentialRuntime(options(fake, {
    ...baseRelease, legacyIdentity: { jid: JID, proof }, pairingPolicy: 'existing-bound',
  } as ConfidentialRelease, pin)), { message: 'CONFIDENTIAL_PARTNER_LEGACY_IDENTITY_FORBIDDEN' });
  const runtime = await prepareConfidentialRuntime(options(fake, {
    ...baseRelease, pairingPolicy: 'existing-bound',
  } as ConfidentialRelease, pin));
  assert.equal(runtime.pairingPolicy, 'new-account');
  assert.equal(runtime.auth.hasIdentity(), false);
  runtime.close();
  assert.equal(fake.writes, 1, 'new partner auth starts as an encrypted empty document');
});

test('changed tier and pending account fail closed before owner socket startup', async () => {
  const fake = fakeSupabase('owner');
  const owner = await prepareConfidentialRuntime(options(fake,
    { ...baseRelease, legacyIdentity: { jid: JID, proof } }, pin));
  owner.close();
  fake.setEntitlement('partner_full');
  await assert.rejects(prepareConfidentialRuntime(options(fake, baseRelease, pin)),
    { message: 'CONFIDENTIAL_PARTNER_LEGACY_IDENTITY_FORBIDDEN' });
  const pending = fakeSupabase('owner', 'private_setup_pending');
  await assert.rejects(prepareConfidentialRuntime(options(pending,
    { ...baseRelease, legacyIdentity: { jid: JID, proof } }, pin)),
  { message: 'CONFIDENTIAL_ACCOUNT_PENDING' });
  assert.equal(pending.paths.includes('/rest/v1/rpc/suco_auth_read'), false);
});
