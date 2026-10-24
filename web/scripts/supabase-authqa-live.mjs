import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { projectClient } from '../../control-plane/supabase/tools/project-db.mjs';

const root = resolve(import.meta.dirname, '../..');
const qa = JSON.parse(readFileSync(resolve(root,
  'marketing/supabase-migration-20261022/authqa.private.json'), 'utf8'));
const env = Object.fromEntries(readFileSync(resolve(root, 'web/.env.supabase.local'), 'utf8')
  .split(/\r?\n/).filter(line => line.includes('='))
  .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const url = env.VITE_SUPABASE_URL;
const key = env.VITE_SUPABASE_PUBLISHABLE_KEY;
assert.ok(url && key);
const newClient = () => createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const a = newClient();
const b = newClient();
const anonymous = newClient();
const db = projectClient();
const created = [];
let connected = false;
try {
  const loginA = await a.auth.signInWithPassword(qa.a);
  const loginB = await b.auth.signInWithPassword(qa.b);
  assert.equal(loginA.error, null, loginA.error?.message);
  assert.equal(loginB.error, null, loginB.error?.message);
  const idA = loginA.data.user.id;
  const idB = loginB.data.user.id;
  assert.notEqual(idA, idB);

  const statusA = await a.rpc('suco_account_status');
  const statusB = await b.rpc('suco_account_status');
  assert.equal(statusA.error, null, statusA.error?.message);
  assert.equal(statusB.error, null, statusB.error?.message);
  for (const [status, id, email] of [
    [statusA.data, idA, qa.a.email], [statusB.data, idB, qa.b.email],
  ]) {
    assert.equal(status.accountId, id);
    assert.equal(status.email, email);
    assert.equal(status.legacyLinked, false);
    assert.equal(status.admissionMode, 'closed');
    assert.equal(status.tenantCapacity, 0);
    assert.equal(status.entitlement, 'free');
  }

  const anonStatus = await anonymous.rpc('suco_account_status');
  assert.ok(anonStatus.error, 'anonymous status unexpectedly succeeded');

  await db.connect(); connected = true;
  const objects = [randomUUID(), randomUUID()];
  for (const [id, objectId] of [[idA, objects[0]], [idB, objects[1]]]) {
    await db.query(`insert into public.suco_cipher_objects
      (owner_id,object_id,key_epoch,nonce,ciphertext) values ($1,$2,1,$3,$4)`,
    [id, objectId, randomBytes(12), randomBytes(64)]);
    created.push([id, objectId]);
  }
  const readA = await a.from('suco_cipher_objects').select('owner_id,object_id,revision');
  const readB = await b.from('suco_cipher_objects').select('owner_id,object_id,revision');
  assert.equal(readA.error, null, readA.error?.message);
  assert.equal(readB.error, null, readB.error?.message);
  assert.deepEqual(readA.data.map(row => row.object_id), [objects[0]]);
  assert.deepEqual(readB.data.map(row => row.object_id), [objects[1]]);
  assert.equal(readA.data[0].owner_id, idA);
  assert.equal(readB.data[0].owner_id, idB);
  const cross = await a.from('suco_cipher_objects').select('object_id')
    .eq('object_id', objects[1]);
  assert.equal(cross.error, null, cross.error?.message);
  assert.deepEqual(cross.data, []);
  const anonRead = await anonymous.from('suco_cipher_objects').select('object_id');
  assert.ok(anonRead.error, 'anonymous object read unexpectedly succeeded');

  const direct = await a.from('suco_cipher_objects').insert({
    owner_id: idA, object_id: randomUUID(), key_epoch: 1,
    nonce: `\\x${randomBytes(12).toString('hex')}`,
    ciphertext: `\\x${randomBytes(64).toString('hex')}`,
  });
  assert.ok(direct.error, 'direct object insert unexpectedly succeeded');
  const gated = await a.rpc('suco_cipher_put', {
    p_object_id: randomUUID(), p_expected_revision: 0, p_key_epoch: 1,
    p_nonce: `\\x${randomBytes(12).toString('hex')}`,
    p_ciphertext: `\\x${randomBytes(64).toString('hex')}`,
  });
  assert.equal(gated.error?.code, '55000', gated.error?.message);
  console.log(JSON.stringify({ realAuth: true, confirmedAccounts: 2,
    ownObjectVisible: true, crossObjectHidden: true,
    anonymousDenied: true, directWriteDenied: true,
    privateWriteGateClosed: true, commercialAdmissionClosed: true }));
} finally {
  if (connected) {
    for (const [id, objectId] of created)
      await db.query('delete from public.suco_cipher_objects where owner_id=$1 and object_id=$2',
        [id, objectId]);
    await db.end();
  }
  await Promise.allSettled([a.auth.signOut(), b.auth.signOut()]);
}
