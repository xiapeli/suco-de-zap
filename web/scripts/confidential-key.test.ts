import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  forgetLocalKey, formatRecoveryCode, loadLocalKey, parseRecoveryCode, saveLocalKey,
  type LocalKeyRecord, type LocalKeyStorage,
} from '../src/lib/confidential-key.ts';

const ownerA = '00000000-0000-4000-8000-000000000002';
const ownerB = 'dbfb2048-bd67-422d-9a66-94dc1bfacbad';

class MemoryStorage implements LocalKeyStorage {
  records = new Map<string, LocalKeyRecord>();
  async read(id: string) { return this.records.get(id) ?? null; }
  async insert(record: LocalKeyRecord) {
    if (this.records.has(record.id)) throw Error('DUPLICATE');
    this.records.set(record.id, record);
  }
  async remove(id: string) { this.records.delete(id); }
}

test('recovery code and local wrapped key survive a simulated F5, isolated by owner and epoch', async () => {
  const storage = new MemoryStorage();
  const raw = randomBytes(32);
  const code = formatRecoveryCode(raw);
  await saveLocalKey(ownerA, 1, raw, storage);
  assert.equal(storage.records.size, 1);
  const record = [...storage.records.values()][0];
  assert.equal(record.wrapKey.extractable, false);
  assert.equal(record.ciphertext.byteLength, 48);
  assert.notDeepEqual(Buffer.from(record.ciphertext), raw);
  raw.fill(0);
  assert.deepEqual(await loadLocalKey(ownerA, 1, storage), parseRecoveryCode(code));
  assert.equal(await loadLocalKey(ownerA, 2, storage), null);
  assert.equal(await loadLocalKey(ownerB, 1, storage), null);
  await forgetLocalKey(ownerA, 1, storage);
  assert.equal(await loadLocalKey(ownerA, 1, storage), null);
});

test('local ciphertext tampering fails closed and a recovery code cannot be guessed from a malformed value', async () => {
  const storage = new MemoryStorage();
  await saveLocalKey(ownerA, 1, randomBytes(32), storage);
  const record = [...storage.records.values()][0];
  const modified = new Uint8Array(record.ciphertext);
  modified[0] ^= 1;
  await assert.rejects(loadLocalKey(ownerA, 1, storage), /LOCAL_KEY_DAMAGED/);
  assert.throws(() => parseRecoveryCode('SUCO1-not-a-key'), /RECOVERY_CODE_INVALID/);
  await assert.rejects(saveLocalKey(ownerA, 1, randomBytes(32), storage), /LOCAL_KEY_EXISTS/);
});
