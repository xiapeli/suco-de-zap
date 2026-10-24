import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { verifyWorkerAttestation, workerAudience } from '../src/lib/worker-attestation.ts';

// The verifier reads its GCP project/zone pins from the environment (fail closed).
process.env.VITE_SUCO_ATTESTATION_PROJECT_ID = 'attestation-test-project';
process.env.VITE_SUCO_ATTESTATION_ZONE = 'southamerica-east1-b';

const digest = `sha256:${'a'.repeat(64)}`;
const challenge = randomBytes(32);
const publicKey = randomBytes(32);
const nonce = createHash('sha256').update('suco-worker-channel-v1\0')
  .update(challenge).update(publicKey).digest('base64url');
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'synthetic', alg: 'RS256', use: 'sig' };
const fetcher: typeof fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
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
function token(payload: object, privateKey = keys.privateKey) {
  const encoded = [Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'synthetic' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url')].join('.');
  return `${encoded}.${sign('RSA-SHA256', Buffer.from(encoded), privateKey).toString('base64url')}`;
}

test('accepts bound signed token and rejects changed key/digest/signature', async () => {
  const valid = token(claims);
  const args = { token: valid, challenge, publicKey, imageDigest: digest, fetcher, now };
  assert.equal((await verifyWorkerAttestation(args)).imageDigest, digest);
  await assert.rejects(verifyWorkerAttestation({ ...args, publicKey: randomBytes(32) }), /ATTEST_NONCE/);
  await assert.rejects(verifyWorkerAttestation({ ...args, imageDigest: `sha256:${'b'.repeat(64)}` }), /ATTEST_IMAGE/);
  const forged = token(claims, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey);
  await assert.rejects(verifyWorkerAttestation({ ...args, token: forged }), /ATTEST_SIGNATURE/);
});
