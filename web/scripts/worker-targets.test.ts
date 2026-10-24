import test from 'node:test';
import assert from 'node:assert/strict';
import { workerTargetForAccount } from '../src/lib/worker-targets.ts';

const owner = '00000000-0000-4000-8000-000000000002';
const parceiro = '00000000-0000-4000-8000-000000000001';
const env = {
  VITE_SUCO_OWNER_WORKER_ID: owner,
  VITE_SUCO_OWNER_WORKER_URL: 'https://operador.exemplo.com',
  VITE_SUCO_OWNER_WORKER_DIGEST: `sha256:${'a'.repeat(64)}`,
  VITE_SUCO_PARTNER_WORKER_ID: parceiro,
  VITE_SUCO_PARTNER_WORKER_URL: 'https://parceiro.exemplo.com',
  VITE_SUCO_PARTNER_WORKER_DIGEST: `sha256:${'b'.repeat(64)}`,
};

test('compiled owner and Ivan targets stay separate and unknown accounts fail closed', () => {
  assert.deepEqual(workerTargetForAccount(owner, env), { url: env.VITE_SUCO_OWNER_WORKER_URL,
    digest: env.VITE_SUCO_OWNER_WORKER_DIGEST });
  assert.deepEqual(workerTargetForAccount(parceiro, env), { url: env.VITE_SUCO_PARTNER_WORKER_URL,
    digest: env.VITE_SUCO_PARTNER_WORKER_DIGEST });
  assert.equal(workerTargetForAccount('ebac334f-4766-4766-a836-cc6680f4d728', env), null);
  assert.equal(workerTargetForAccount(parceiro, { ...env, VITE_SUCO_PARTNER_WORKER_DIGEST: '' }), null);
  assert.equal(workerTargetForAccount(owner, { ...env, VITE_SUCO_OWNER_WORKER_URL: 'http://operador.exemplo.com' }), null);
});
