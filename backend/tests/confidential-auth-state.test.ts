import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import {
  createConfidentialAuthState,
  legacyIdentityLockFingerprint,
  type EncryptedAuthStore,
  type SealedAuthRecord,
} from '../src/lib/confidential-auth-state.js';

const OWNER_JID = '5511999999999@s.whatsapp.net'; // synthetic only

class MemorySealedStore implements EncryptedAuthStore {
  current: SealedAuthRecord | null = null;
  archives: SealedAuthRecord[] = [];
  failArchive = false;
  async read() {
    return this.current && { revision: this.current.revision, ciphertext: Buffer.from(this.current.ciphertext) };
  }
  async compareAndSwap(expectedRevision: string | null, ciphertext: Uint8Array) {
    if (this.current?.revision !== (expectedRevision ?? undefined)) throw new Error('stale revision');
    const revision = String(Number(this.current?.revision || '0') + 1);
    this.current = { revision, ciphertext: Buffer.from(ciphertext) };
    return revision;
  }
  async archive(record: SealedAuthRecord) {
    if (this.failArchive) throw new Error('archive failed');
    if (this.current?.revision !== record.revision) throw new Error('stale archive');
    this.archives.push({ revision: record.revision, ciphertext: Buffer.from(record.ciphertext) });
  }
}

test('Baileys credentials, Signal keys and identity survive encrypted restart without plaintext store data', async () => {
  const key = randomBytes(32);
  const store = new MemorySealedStore();
  const first = await createConfidentialAuthState({ tenantId: 'owner-test', key, store });
  const { state, saveCreds } = await first.load();
  state.creds.me = { id: OWNER_JID };
  await first.assertOrEstablishIdentity(OWNER_JID);
  assert.equal(first.hasImportedLegacyIdentity(), false);
  await state.keys.set({ session: { 'synthetic@s.whatsapp.net': Uint8Array.from([4, 5, 6]) } });
  await saveCreds();
  const sealed = Buffer.from(store.current!.ciphertext);
  assert.equal(sealed.includes(Buffer.from(OWNER_JID)), false);
  assert.equal(sealed.includes(Buffer.from('synthetic@s.whatsapp.net')), false);
  first.close();

  const second = await createConfidentialAuthState({ tenantId: 'owner-test', key, store });
  const restored = await second.load();
  assert.equal(restored.state.creds.me?.id, OWNER_JID);
  assert.equal(second.identityMatches(OWNER_JID), true);
  assert.equal(second.hasImportedLegacyIdentity(), false);
  assert.deepEqual(Buffer.from((await restored.state.keys.get('session', ['synthetic@s.whatsapp.net']))['synthetic@s.whatsapp.net']), Buffer.from([4, 5, 6]));
  second.close();
});

test('new QR archives old ciphertext, clears keys and preserves same account identity across restart', async () => {
  const key = randomBytes(32);
  const store = new MemorySealedStore();
  const first = await createConfidentialAuthState({ tenantId: 'owner-test', key, store });
  const before = await first.load();
  before.state.creds.me = { id: OWNER_JID };
  await first.assertOrEstablishIdentity(OWNER_JID);
  await before.state.keys.set({ session: { old: Uint8Array.from([7]) } });
  await before.saveCreds();
  const oldCiphertext = Buffer.from(store.current!.ciphertext);

  await first.beginFreshPairing();
  assert.equal(store.archives.length, 1);
  assert.deepEqual(Buffer.from(store.archives[0].ciphertext), oldCiphertext);
  const fresh = await first.load();
  assert.equal(fresh.state.creds.me, undefined);
  assert.deepEqual(await fresh.state.keys.get('session', ['old']), {});
  assert.equal(first.identityMatches(OWNER_JID), true);
  await assert.rejects(first.assertOrEstablishIdentity('5511888888888@s.whatsapp.net'), { code: 'PAIRING_ACCOUNT_MISMATCH' });
  assert.equal(first.identityMatches(OWNER_JID), true);
  first.close();

  const restarted = await createConfidentialAuthState({ tenantId: 'owner-test', key, store });
  assert.equal(restarted.identityMatches(OWNER_JID), true);
  await restarted.assertOrEstablishIdentity(OWNER_JID);
  restarted.close();
});

test('archive failure leaves old auth usable and does not rotate the QR', async () => {
  const key = randomBytes(32);
  const store = new MemorySealedStore();
  const adapter = await createConfidentialAuthState({ tenantId: 'owner-test', key, store });
  const state = await adapter.load();
  state.state.creds.me = { id: OWNER_JID };
  await adapter.assertOrEstablishIdentity(OWNER_JID);
  await state.saveCreds();
  const old = Buffer.from(store.current!.ciphertext);
  store.failArchive = true;
  await assert.rejects(adapter.beginFreshPairing(), { code: 'PAIRING_BACKUP_FAILED' });
  assert.deepEqual(Buffer.from(store.current!.ciphertext), old);
  assert.equal((await adapter.load()).state.creds.me?.id, OWNER_JID);
  store.failArchive = false;
  await adapter.beginFreshPairing();
  adapter.close();
});

test('wrong key, wrong tenant, tampering and concurrent writer fail closed', async () => {
  const key = randomBytes(32);
  const store = new MemorySealedStore();
  const first = await createConfidentialAuthState({ tenantId: 'owner-test', key, store });
  await assert.rejects(createConfidentialAuthState({ tenantId: 'owner-test', key: randomBytes(32), store }), { code: 'AUTH_STATE_CORRUPT' });
  await assert.rejects(createConfidentialAuthState({ tenantId: 'other-tenant', key, store }), { code: 'AUTH_STATE_CORRUPT' });
  const second = await createConfidentialAuthState({ tenantId: 'owner-test', key, store });
  await (await first.load()).saveCreds();
  await assert.rejects(async () => { const loaded = await second.load(); await loaded.saveCreds(); }, { code: 'AUTH_STATE_STORE' });
  await assert.rejects(async () => { const loaded = await second.load(); await loaded.saveCreds(); }, { code: 'AUTH_STATE_STORE' });
  second.close();
  first.close();
  store.current!.ciphertext = Buffer.from(store.current!.ciphertext);
  (store.current!.ciphertext as Buffer)[store.current!.ciphertext.length - 1] ^= 1;
  await assert.rejects(createConfidentialAuthState({ tenantId: 'owner-test', key, store }), { code: 'AUTH_STATE_CORRUPT' });
});

test('confirmed logout archives sealed state and keeps the identity lock', async () => {
  const key = randomBytes(32);
  const store = new MemorySealedStore();
  const adapter = await createConfidentialAuthState({ tenantId: 'owner-test', key, store });
  const state = await adapter.load();
  state.state.creds.me = { id: OWNER_JID };
  await adapter.assertOrEstablishIdentity(OWNER_JID);
  await state.saveCreds();
  await adapter.clearCurrent();
  assert.equal(store.archives.length, 1);
  assert.equal((await adapter.load()).state.creds.me, undefined);
  assert.equal(adapter.identityMatches(OWNER_JID), true);
  adapter.close();
});

test('TEE imports only prior JID with pinned legacy verifier, then issues fresh auth for the same account', async () => {
  const key=randomBytes(32), store=new MemorySealedStore();
  const salt=randomBytes(16).toString('hex');
  const proof={version:1 as const,salt,digest:scryptSync(OWNER_JID,Buffer.from(salt,'hex'),32).toString('hex')};
  const pinned=legacyIdentityLockFingerprint(proof);
  const adapter=await createConfidentialAuthState({tenantId:'owner-test',key,store});
  await assert.rejects(adapter.beginFreshPairing(),{code:'PAIRING_IDENTITY_UNAVAILABLE'});
  await assert.rejects(adapter.importLegacyIdentity(OWNER_JID,proof,'0'.repeat(64)),{code:'PAIRING_IDENTITY_UNAVAILABLE'});
  await assert.rejects(adapter.importLegacyIdentity('5511888888888@s.whatsapp.net',proof,pinned),{code:'PAIRING_ACCOUNT_MISMATCH'});
  assert.equal(adapter.hasIdentity(),false);
  assert.equal(adapter.hasImportedLegacyIdentity(),false);
  await adapter.importLegacyIdentity(OWNER_JID,proof,pinned);
  await adapter.importLegacyIdentity(OWNER_JID,proof,pinned); // retry after ambiguous response
  assert.equal(adapter.identityMatches(OWNER_JID),true);
  assert.equal(adapter.hasImportedLegacyIdentity(),true);
  assert.equal((await adapter.load()).state.creds.me,undefined);
  assert.equal(Buffer.from(store.current!.ciphertext).includes(Buffer.from(OWNER_JID)),false);
  await adapter.beginFreshPairing();
  assert.equal(store.archives.length,1);
  assert.equal(adapter.hasImportedLegacyIdentity(),true);
  adapter.close();
  const restarted=await createConfidentialAuthState({tenantId:'owner-test',key,store});
  assert.equal(restarted.identityMatches(OWNER_JID),true);
  assert.equal(restarted.hasImportedLegacyIdentity(),true);
  assert.equal((await restarted.load()).state.creds.me,undefined);
  restarted.close();
});
