import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { importContentKey, encryptPrivateObject, decryptPrivateObject } from '../src/lib/private-cipher.ts';

test('encrypted object binds account, object and epoch; tampering fails', async () => {
  const key = await importContentKey(randomBytes(32));
  const context = { accountId: randomUUID(), objectId: randomUUID(), keyEpoch: 1 };
  const input = new TextEncoder().encode('Mensagem privada de teste; sem conteúdo real.');
  const one = await encryptPrivateObject(key, context, input);
  const two = await encryptPrivateObject(key, context, input);
  assert.equal(one.ciphertext.byteLength, 4112);
  assert.notDeepEqual(one.nonce, two.nonce);
  assert.notDeepEqual(one.ciphertext, two.ciphertext);
  assert.deepEqual(await decryptPrivateObject(key, one), input);
  for (const changed of [
    { ...one, accountId: randomUUID() },
    { ...one, objectId: randomUUID() },
    { ...one, keyEpoch: 2 },
    { ...one, nonce: Uint8Array.from(one.nonce, (n, i) => i === 0 ? n ^ 1 : n) },
    { ...one, ciphertext: Uint8Array.from(one.ciphertext, (n, i) => i === 0 ? n ^ 1 : n) },
  ]) await assert.rejects(decryptPrivateObject(key, changed), /AUTHENTICATION_FAILED/);
  await assert.rejects(decryptPrivateObject(await importContentKey(randomBytes(32)), one), /AUTHENTICATION_FAILED/);
});

test('invalid context, key and size fail before encryption', async () => {
  await assert.rejects(importContentKey(randomBytes(31)), /INVALID_CONTENT_KEY/);
  const key = await importContentKey(randomBytes(32));
  const context = { accountId: randomUUID(), objectId: randomUUID(), keyEpoch: 1 };
  await assert.rejects(encryptPrivateObject(key, { ...context, accountId: 'owner' }, new Uint8Array(32)), /INVALID_PRIVATE_OBJECT_CONTEXT/);
  await assert.rejects(encryptPrivateObject(key, context, new Uint8Array(0)), /INVALID_PRIVATE_OBJECT_SIZE/);
});
