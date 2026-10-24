import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createOperationalGateway, workerAudience } from '../../confidential-channel/operational-gateway.mjs';
import { openConfidentialChannel, parseLegacyIdentityHandoff } from '../src/lib/confidential-channel.ts';

process.env.VITE_SUCO_ATTESTATION_PROJECT_ID = 'attestation-test-project';
process.env.VITE_SUCO_ATTESTATION_ZONE = 'southamerica-east1-b';

const digest = `sha256:${'a'.repeat(64)}`;
const ownerId = '00000000-0000-4000-8000-000000000002';
const signing = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...signing.publicKey.export({ format: 'jwk' }), kid: 'synthetic', alg: 'RS256', use: 'sig' };
function signedToken(nonce: string) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: 'https://confidentialcomputing.googleapis.com', aud: workerAudience,
    iat: now, nbf: now, exp: now + 600, eat_nonce: [nonce],
    swname: 'CONFIDENTIAL_SPACE', dbgstat: 'disabled-since-boot', secboot: true,
    hwmodel: 'GCP_AMD_SEV',
    submods: {
      confidential_space: { support_attributes: ['STABLE'], monitoring_enabled: { memory: false } },
      container: { image_digest: digest },
      gce: { project_id: 'attestation-test-project', zone: 'southamerica-east1-b' },
    },
  };
  const parts = [Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'synthetic' })).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url')].join('.');
  return `${parts}.${sign('RSA-SHA256', Buffer.from(parts), signing.privateKey).toString('base64url')}`;
}

test('browser client verifies measurement before key release and reads encrypted response', async () => {
  let releases = 0;
  const gateway = createOperationalGateway({
    tokenFn: async nonce => signedToken(nonce),
    onRelease: async release => {
      releases++;
      assert.equal(release.ownerId, ownerId);
      assert.equal(Buffer.from(release.key, 'base64url').length, 32);
      assert.deepEqual(release.legacyIdentity, {
        jid: '123456789@s.whatsapp.net',
        proof: { version: 1, salt: 'a'.repeat(32), digest: 'b'.repeat(64) },
      });
      return { dispatch: async call => ({ status: 200, body: { path: call.path, text: 'mensagem fictícia' } }), close() {} };
    },
  });
  await new Promise<void>(resolve => gateway.server.listen(0, '127.0.0.1', resolve));
  try {
    const local = `http://127.0.0.1:${(gateway.server.address() as { port: number }).port}`;
    const fetcher: typeof fetch = (url, init) => String(url).includes('googleapis.com')
      ? Promise.resolve(new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }))
      : fetch(local + new URL(String(url)).pathname, init);
    const userKey = randomBytes(32);
    const base = { baseUrl: 'https://worker.example', ownerId, keyEpoch: 1,
      userKey, accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', fetcher,
      legacyIdentity: parseLegacyIdentityHandoff({ version: 1, jid: '123456789@s.whatsapp.net',
        proof: { version: 1, salt: 'a'.repeat(32), digest: 'b'.repeat(64) }, requiresOwnerScan: true }) };
    await assert.rejects(openConfidentialChannel({ ...base, imageDigest: `sha256:${'b'.repeat(64)}` }), /ATTEST_IMAGE/);
    assert.equal(releases, 0);
    const channel = await openConfidentialChannel({ ...base, imageDigest: digest });
    assert.equal(releases, 1);
    assert.deepEqual(await channel.rpc('GET', '/api/chats'),
      { status: 200, body: { path: '/api/chats', text: 'mensagem fictícia' } });
    channel.close();
    await assert.rejects(channel.rpc('GET', '/api/chats'), /CHANNEL_CLOSED/);
  } finally { gateway.close(); }
});

test('owner handoff rejects malformed identity before release', () => {
  assert.throws(() => parseLegacyIdentityHandoff({ version: 1, jid: 'name@g.us',
    proof: { version: 1, salt: 'a'.repeat(32), digest: 'b'.repeat(64) }, requiresOwnerScan: true }),
  /OWNER_HANDOFF_INVALID/);
});

test('a worker release error reaches the client without releasing a session', async () => {
  const gateway = createOperationalGateway({
    tokenFn: async nonce => signedToken(nonce),
    onRelease: async () => { throw Error('AUTH_STATE_STORE'); },
  });
  await new Promise<void>(resolve => gateway.server.listen(0, '127.0.0.1', resolve));
  try {
    const local = `http://127.0.0.1:${(gateway.server.address() as { port: number }).port}`;
    const fetcher: typeof fetch = (url, init) => String(url).includes('googleapis.com')
      ? Promise.resolve(new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }))
      : fetch(local + new URL(String(url)).pathname, init);
    await assert.rejects(openConfidentialChannel({
      baseUrl: 'https://worker.example', imageDigest: digest, ownerId, keyEpoch: 1,
      userKey: randomBytes(32), accessToken: 'synthetic-access',
      refreshToken: 'synthetic-refresh', fetcher,
    }), /AUTH_STATE_STORE/);
  } finally { gateway.close(); }
});
