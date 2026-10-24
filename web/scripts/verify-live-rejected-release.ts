/** Manual live QA: HPKE reaches the worker, but a fake JWT cannot open it. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openConfidentialChannel } from '../src/lib/confidential-channel';

// Manual live QA against YOUR deployment (no defaults — fail closed):
//   SUCO_LIVE_WORKER_URL=https://seu-worker.exemplo.com \
//   SUCO_LIVE_OWNER_ID=<uuid da conta> \
//   SUCO_LIVE_IMAGE_DIGEST=sha256:<digest medido> node --experimental-transform-types scripts/verify-live-rejected-release.ts
const baseUrl = process.env.SUCO_LIVE_WORKER_URL;
const ownerId = process.env.SUCO_LIVE_OWNER_ID;
const imageDigest = process.env.SUCO_LIVE_IMAGE_DIGEST;
if (!baseUrl || !ownerId || !/^sha256:[0-9a-f]{64}$/.test(imageDigest ?? '')) {
  throw new Error('Defina SUCO_LIVE_WORKER_URL, SUCO_LIVE_OWNER_ID e SUCO_LIVE_IMAGE_DIGEST do SEU deployment.');
}
const health = async () => (await (await fetch(`${baseUrl}/health`)).json()) as { status: string };
assert.equal((await health()).status, 'locked');
const payload = { sub: ownerId, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 900 };
const accessToken = [Buffer.from('{}').toString('base64url'),
  Buffer.from(JSON.stringify(payload)).toString('base64url'), 'c2ln'].join('.');
await assert.rejects(openConfidentialChannel({ baseUrl, ownerId, imageDigest,
  keyEpoch: 1, userKey: randomBytes(32), accessToken, refreshToken: 'synthetic-invalid-token' }),
/OWNER_SESSION_AUTH/);
assert.equal((await health()).status, 'locked');
console.log(JSON.stringify({ encryptedReleaseReachedWorker: true,
  fakeAuthDenied: true, workerRemainedLocked: true, realKeyReleased: false }));
