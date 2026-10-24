/** Manual live QA: a Google JWKS network failure must not release any key. */
import assert from 'node:assert/strict';
import { verifyWorkerAttestation } from '../src/lib/worker-attestation';
import { pinnedGoogleKeysExpireAt } from '../src/lib/worker-attestation-pinned';

// Manual live QA against YOUR deployment (no defaults — fail closed):
//   SUCO_LIVE_WORKER_URL=https://seu-worker.exemplo.com \
//   SUCO_LIVE_ALLOWED_ORIGIN=https://app.seu-dominio.exemplo \
//   SUCO_LIVE_IMAGE_DIGEST=sha256:<digest medido> node --experimental-transform-types scripts/verify-live-attestation-fallback.ts
const challenge = crypto.getRandomValues(new Uint8Array(32));
const { SUCO_LIVE_WORKER_URL, SUCO_LIVE_ALLOWED_ORIGIN, SUCO_LIVE_IMAGE_DIGEST: imageDigest } = process.env;
if (!SUCO_LIVE_WORKER_URL || !SUCO_LIVE_ALLOWED_ORIGIN || !/^sha256:[0-9a-f]{64}$/.test(imageDigest ?? '')) {
  throw new Error('Defina SUCO_LIVE_WORKER_URL, SUCO_LIVE_ALLOWED_ORIGIN e SUCO_LIVE_IMAGE_DIGEST do SEU deployment.');
}
const url = `${SUCO_LIVE_WORKER_URL}/channel/attest`;
const response = await fetch(url, { method: 'POST',
  headers: { Origin: SUCO_LIVE_ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
  body: JSON.stringify({ challenge: Buffer.from(challenge).toString('base64url') }) });
assert.equal(response.status, 200);
const packet = await response.json() as { token: string; publicKey: string };
const publicKey = Buffer.from(packet.publicKey, 'base64url');
const originalFetch = globalThis.fetch;
try {
  const direct = await verifyWorkerAttestation({ token: packet.token, challenge,
    publicKey, imageDigest, fetcher: originalFetch });
  assert.equal(direct.imageDigest, imageDigest);
  globalThis.fetch = async () => { throw TypeError('offline'); };
  const result = await verifyWorkerAttestation({ token: packet.token, challenge,
    publicKey, imageDigest });
  assert.equal(result.imageDigest, imageDigest);
  await assert.rejects(verifyWorkerAttestation({ token: packet.token, challenge,
    publicKey, imageDigest, now: pinnedGoogleKeysExpireAt + 1 }), /ATTEST_KEYS/);
  console.log(JSON.stringify({ liveAttestationWithGoogle: true, liveAttestationWithoutGoogle: true,
    expiredPinDenied: true, userKeyReleased: false }));
} finally { globalThis.fetch = originalFetch; }
