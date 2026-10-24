import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Aes128Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from '@hpke/core';
import { createOperationalGateway, workerAudience } from './operational-gateway.mjs';

const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(), aead: new Aes128Gcm() });
const b64 = value => Buffer.from(value).toString('base64url');
async function post(base, path, value) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value) });
  return { status: r.status, body: await r.json() };
}
function unwrap(key, aad, payload) {
  const sealed = Buffer.from(payload.ciphertext, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.nonce, 'base64url'));
  decipher.setAAD(aad); decipher.setAuthTag(sealed.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]).toString());
}

test('attested key release, private RPC response and replay denial', async () => {
  let nonceFromAttestor = '';
  let released = false;
  const worker = { dispatch: async call => ({ status: 200, body: { same: call.path } }), close() {} };
  const gateway = createOperationalGateway({
    tokenFn: async nonce => { nonceFromAttestor = nonce; return 'synthetic-token'; },
    onRelease: async data => {
      assert.deepEqual(data, { ownerId: 'owner', secret: 'synthetic' });
      released = true;
      return worker;
    },
  });
  await new Promise(resolve => gateway.server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${gateway.server.address().port}`;
    const challenge = randomBytes(32);
    const a = await post(base, '/channel/attest', { challenge: b64(challenge) });
    assert.equal(a.status, 200);
    assert.equal(a.body.audience, workerAudience);
    const publicKey = Buffer.from(a.body.publicKey, 'base64url');
    assert.equal(nonceFromAttestor, createHash('sha256').update('suco-worker-channel-v1\0')
      .update(challenge).update(publicKey).digest('base64url'));
    const sender = await suite.createSenderContext({
      recipientPublicKey: await suite.kem.deserializePublicKey(publicKey),
    });
    const key = randomBytes(32);
    const release = { ownerId: 'owner', secret: 'synthetic', sessionKey: b64(key) };
    const ciphertext = Buffer.from(await sender.seal(Buffer.from(JSON.stringify(release)),
      Buffer.concat([Buffer.from('suco-worker-release-v1\0'), challenge])));
    const payload = { id: a.body.id, enc: b64(sender.enc), ciphertext: b64(ciphertext) };
    const ready = await post(base, '/channel/release', payload);
    assert.equal(ready.status, 200);
    assert.equal(released, true);
    const session = unwrap(key, Buffer.concat([Buffer.from('suco-worker-reply-v1\0'), challenge]), ready.body);
    assert.equal(session.ready, true);
    const repeatRelease = await post(base, '/channel/release', payload);
    assert.equal(repeatRelease.status, 400);
    const requestNonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, requestNonce);
    cipher.setAAD(Buffer.concat([Buffer.from('suco-worker-rpc-v1\0'), Buffer.from(session.sessionId), requestNonce]));
    const requestCiphertext = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify({ method: 'GET', path: '/api/chats' }))),
      cipher.final(), cipher.getAuthTag(),
    ]);
    const rpc = { sessionId: session.sessionId, nonce: b64(requestNonce), ciphertext: b64(requestCiphertext) };
    const answer = await post(base, '/rpc', rpc);
    assert.equal(answer.status, 200);
    assert.deepEqual(unwrap(key, Buffer.concat([Buffer.from('suco-worker-reply-v1\0'), requestNonce]), answer.body),
      { status: 200, body: { same: '/api/chats' } });
    const replay = await post(base, '/rpc', rpc);
    assert.equal(replay.status, 409);
    assert.equal(replay.body.error, 'REPLAY_DENIED');

    // A page refresh can reattest and replace its lost encrypted session while
    // the same worker continues ingesting WhatsApp messages.
    const nextChallenge = randomBytes(32);
    const nextAttest = await post(base, '/channel/attest', { challenge: b64(nextChallenge) });
    assert.equal(nextAttest.status, 200);
    const nextSender = await suite.createSenderContext({
      recipientPublicKey: await suite.kem.deserializePublicKey(
        Buffer.from(nextAttest.body.publicKey, 'base64url')),
    });
    const nextKey = randomBytes(32);
    const nextPayload = Buffer.from(await nextSender.seal(Buffer.from(JSON.stringify({
      ownerId: 'owner', secret: 'synthetic', sessionKey: b64(nextKey),
    })), Buffer.concat([Buffer.from('suco-worker-release-v1\0'), nextChallenge])));
    const nextRelease = await post(base, '/channel/release', {
      id: nextAttest.body.id, enc: b64(nextSender.enc), ciphertext: b64(nextPayload),
    });
    assert.equal(nextRelease.status, 200);
    const nextSession = unwrap(nextKey,
      Buffer.concat([Buffer.from('suco-worker-reply-v1\0'), nextChallenge]), nextRelease.body);
    assert.notEqual(nextSession.sessionId, session.sessionId);
    const stale = await post(base, '/rpc', rpc);
    assert.equal(stale.status, 400);
    assert.equal(stale.body.error, 'SESSION_UNAVAILABLE');
    const nextNonce = randomBytes(12);
    const nextCipher = createCipheriv('aes-256-gcm', nextKey, nextNonce);
    nextCipher.setAAD(Buffer.concat([Buffer.from('suco-worker-rpc-v1\0'),
      Buffer.from(nextSession.sessionId), nextNonce]));
    const nextSealed = Buffer.concat([nextCipher.update(Buffer.from(JSON.stringify({
      method: 'GET', path: '/api/status',
    }))), nextCipher.final(), nextCipher.getAuthTag()]);
    const resumed = await post(base, '/rpc', {
      sessionId: nextSession.sessionId, nonce: b64(nextNonce), ciphertext: b64(nextSealed),
    });
    assert.equal(resumed.status, 200);
    assert.deepEqual(unwrap(nextKey,
      Buffer.concat([Buffer.from('suco-worker-reply-v1\0'), nextNonce]), resumed.body),
    { status: 200, body: { same: '/api/status' } });
  } finally { gateway.close(); }
});

test('origin policy: pinned origin passes, anything else is denied, unset fails closed', async () => {
  const start = origin => {
    process.env.SUCO_CHANNEL_ALLOWED_ORIGIN = origin;
    const gateway = createOperationalGateway({ tokenFn: async () => 't', onRelease: async () => worker });
    return gateway;
  };
  const worker = { dispatch: async () => ({ status: 200, body: {} }), close() {} };
  const port = gateway => new Promise(resolve => gateway.server.listen(0, '127.0.0.1',
    () => resolve(gateway.server.address().port)));

  const pinned = start('https://app.do-operador.exemplo');
  let p = await port(pinned);
  try {
    const challenge = b64(randomBytes(32));
    const ok = await fetch(`http://127.0.0.1:${p}/channel/attest`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://app.do-operador.exemplo' },
      body: JSON.stringify({ challenge }) });
    assert.equal(ok.status, 200);
    const evil = await fetch(`http://127.0.0.1:${p}/channel/attest`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://app.do-operador.exemplo.evil.example' },
      body: JSON.stringify({ challenge }) });
    assert.equal(evil.status, 403);
    assert.equal((await evil.json()).error, 'ORIGIN_DENIED');
  } finally { pinned.close(); }

  delete process.env.SUCO_CHANNEL_ALLOWED_ORIGIN;
  const failing = createOperationalGateway({ tokenFn: async () => 't', onRelease: async () => worker });
  p = await port(failing);
  try {
    const any = await fetch(`http://127.0.0.1:${p}/channel/attest`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://app.do-operador.exemplo' },
      body: JSON.stringify({ challenge: b64(randomBytes(32)) }) });
    assert.equal(any.status, 403);
  } finally { failing.close(); }

  process.env.SUCO_CHANNEL_ALLOWED_ORIGIN = 'not a url';
  assert.throws(() => createOperationalGateway({ tokenFn: async () => 't', onRelease: async () => worker }),
    /CHANNEL_ORIGIN_INVALID/);
  delete process.env.SUCO_CHANNEL_ALLOWED_ORIGIN;
});

test('attest capacity is reserved before the first await (no race past 32)', async () => {
  process.env.SUCO_CHANNEL_ALLOWED_ORIGIN = '';
  const gateway = createOperationalGateway({
    tokenFn: () => new Promise(resolve => setTimeout(() => resolve('t'), 60)),
    onRelease: async () => ({ dispatch: async () => ({ status: 200, body: {} }), close() {} }),
  });
  await new Promise(resolve => gateway.server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${gateway.server.address().port}`;
    const fire = i => fetch(base + '/channel/attest', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge: b64(randomBytes(32) /* per-request */), i }) })
      .then(r => r.status, () => 'network');
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => fire(i)));
    const accepted = results.filter(s => s === 200).length;
    const denied = results.filter(s => s === 400).length;
    assert.equal(accepted, 32);
    assert.equal(denied, 8);
  } finally { gateway.close(); }
});
