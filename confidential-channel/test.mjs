import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { Aes128Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from '@hpke/core';
import { createServer, channelNonce } from './server.mjs';

const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(), aead: new Aes128Gcm() });
let issuedNonce;
const server = createServer(async nonce => { issuedNonce = nonce; return 'synthetic-token'; });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const post = async (path, body) => {
  const r = await fetch(base + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
try {
  const challenge = randomBytes(32);
  const a = await post('/channel/attest', { challenge: challenge.toString('base64url') });
  assert.equal(a.status, 200);
  const rawPub = Buffer.from(a.body.publicKey, 'base64url');
  assert.equal(issuedNonce, channelNonce(challenge, rawPub));
  const pub = await suite.kem.deserializePublicKey(rawPub);
  const sender = await suite.createSenderContext({ recipientPublicKey: pub });
  const plaintext = Buffer.concat([Buffer.from('SUCO_CHANNEL_SYNTHETIC_V1:'), challenge]);
  const aad = Buffer.concat([Buffer.from('suco-channel-proof-v1\0'), challenge]);
  const ciphertext = Buffer.from(await sender.seal(plaintext, aad));
  const packet = { id: a.body.id, enc: Buffer.from(sender.enc).toString('base64url'),
    ciphertext: ciphertext.toString('base64url') };
  const proven = await post('/channel/prove', packet);
  assert.deepEqual(proven, { status: 200, body: { proven: true,
    digest: createHash('sha256').update(plaintext).digest('hex') } });
  assert.equal((await post('/channel/prove', packet)).body.error, 'CHANNEL_EXPIRED');
  const b = await post('/channel/attest', { challenge: challenge.toString('base64url') });
  assert.equal(b.status, 200);
  const c = Buffer.from(ciphertext); c[3] ^= 1;
  const forged = await post('/channel/prove', { id: b.body.id, enc: packet.enc,
    ciphertext: c.toString('base64url') });
  assert.equal(forged.status, 400);
  assert.notEqual(forged.body.proven, true);
  console.log('channel local proof PASS');
} finally { server.close(); }
