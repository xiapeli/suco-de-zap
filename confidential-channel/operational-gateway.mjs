import http from 'node:http';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Aes128Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from '@hpke/core';
import { launcherToken } from './server.mjs';

export const workerAudience = 'https://app.sucodezap.xyz/attestation/worker-v1';

const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(), aead: new Aes128Gcm() });
const releaseAadPrefix = Buffer.from('suco-worker-release-v1\0');
const rpcAadPrefix = Buffer.from('suco-worker-rpc-v1\0');
const replyAadPrefix = Buffer.from('suco-worker-reply-v1\0');

function base64(value, size, code) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error(code);
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== size || decoded.toString('base64url') !== value) throw Error(code);
  return decoded;
}

function boundNonce(challenge, publicKey) {
  return createHash('sha256').update('suco-worker-channel-v1\0')
    .update(challenge).update(publicKey).digest('base64url');
}

async function jsonBody(req, maximum) {
  const chunks = []; let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > maximum) throw Error('BODY_TOO_LARGE');
    chunks.push(part);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Error('INVALID_JSON'); }
}

function encrypted(key, aad, value) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const clear = Buffer.from(JSON.stringify(value));
  try {
    const ciphertext = Buffer.concat([cipher.update(clear), cipher.final(), cipher.getAuthTag()]);
    return { nonce: nonce.toString('base64url'), ciphertext: ciphertext.toString('base64url') };
  } finally { clear.fill(0); }
}

function decrypted(key, aad, nonce, ciphertext) {
  if (typeof ciphertext !== 'string' || ciphertext.length > 400_000 ||
      !/^[A-Za-z0-9_-]+$/.test(ciphertext)) throw Error('INVALID_CIPHERTEXT');
  const sealed = Buffer.from(ciphertext, 'base64url');
  if (sealed.length < 18 || sealed.length > 300_000 ||
      sealed.toString('base64url') !== ciphertext) throw Error('INVALID_CIPHERTEXT');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(sealed.subarray(-16));
    const clear = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
    try { return JSON.parse(clear.toString('utf8')); }
    catch { throw Error('INVALID_JSON'); }
    finally { clear.fill(0); }
  } finally { sealed.fill(0); }
}

/** A measured worker owns the key and dispatch. Nothing private is sent in plaintext HTTP. */
export function createOperationalGateway({
  tokenFn = nonce => launcherToken(nonce, undefined, workerAudience),
  onRelease,
  now = () => Date.now(),
}) {
  // The deployer pins which app origin may open a channel (their web
  // frontend). Unset => every Origin-bearing request is denied (fail
  // closed); local dev may pin http://localhost:<port>. Invalid shape
  // throws at startup rather than silently allowing a typo'd origin.
  const origin = (() => {
    const value = (process.env.SUCO_CHANNEL_ALLOWED_ORIGIN ?? '').trim();
    if (value === '') return null;
    if (/^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(value) ||
        /^http:\/\/(localhost|127\.0\.0\.1)(:[0-9]{1,5})?$/.test(value)) return value;
    throw Error('CHANNEL_ORIGIN_INVALID');
  })();

  if (typeof onRelease !== 'function') throw Error('RELEASE_HANDLER_REQUIRED');
  const pending = new Map();
  let active = null;
  let releasing = false;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const requestOrigin = req.headers.origin;
    if (requestOrigin) {
      if (origin === null || requestOrigin !== origin) {
        res.writeHead(403); res.end(JSON.stringify({ error: 'ORIGIN_DENIED' })); return;
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.end(JSON.stringify({ status: active ? 'ready' : 'locked', acceptsPlaintext: false }));
      return;
    }
    if (req.method !== 'POST' || !['/channel/attest', '/channel/release', '/rpc'].includes(req.url)) {
      res.writeHead(404); res.end(JSON.stringify({ error: 'NOT_FOUND' })); return;
    }
    try {
      const body = await jsonBody(req, req.url === '/rpc' ? 410_000 : 16_384);
      if (req.url === '/channel/attest') {
        const challenge = base64(body.challenge, 32, 'INVALID_CHALLENGE');
        for (const [id, item] of pending) if (item.until <= now()) pending.delete(id);
        if (pending.size >= 32) throw Error('CHANNEL_CAPACITY');
        // Reserve the slot synchronously, before the first await, so a burst
        // of concurrent attestations cannot exceed capacity; release on error.
        const id = randomBytes(16).toString('base64url');
        pending.set(id, { until: now() + 60_000 });
        let publicKey; let token;
        try {
          const keys = await suite.kem.generateKeyPair();
          publicKey = Buffer.from(await suite.kem.serializePublicKey(keys.publicKey));
          const nonce = boundNonce(challenge, publicKey);
          token = await tokenFn(nonce);
          pending.set(id, { privateKey: keys.privateKey, challenge, until: now() + 60_000 });
        } catch (error) { pending.delete(id); throw error; }
        res.end(JSON.stringify({ id, publicKey: publicKey.toString('base64url'), token,
          audience: workerAudience }));
        return;
      }
      if (req.url === '/channel/release') {
        const id = body.id;
        if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(id)) throw Error('INVALID_CHANNEL');
        const item = pending.get(id);
        pending.delete(id);
        if (!item || item.until <= now() || releasing) throw Error('CHANNEL_EXPIRED');
        const enc = base64(body.enc, 32, 'INVALID_ENC');
        if (typeof body.ciphertext !== 'string' || body.ciphertext.length > 16_000 ||
            !/^[A-Za-z0-9_-]+$/.test(body.ciphertext)) throw Error('INVALID_CIPHERTEXT');
        const sealed = Buffer.from(body.ciphertext, 'base64url');
        if (sealed.length < 18 || sealed.length > 12_000 ||
            sealed.toString('base64url') !== body.ciphertext) throw Error('INVALID_CIPHERTEXT');
        const recipient = await suite.createRecipientContext({ recipientKey: item.privateKey, enc });
        const clear = Buffer.from(await recipient.open(sealed,
          Buffer.concat([releaseAadPrefix, item.challenge])));
        let release;
        try { release = JSON.parse(clear.toString('utf8')); }
        finally { clear.fill(0); sealed.fill(0); }
        const sessionKey = base64(release.sessionKey, 32, 'INVALID_SESSION_KEY');
        delete release.sessionKey;
        if (releasing) { sessionKey.fill(0); throw Error('CHANNEL_EXPIRED'); }
        releasing = true;
        let worker;
        try { worker = await onRelease(release); }
        catch (error) { sessionKey.fill(0); throw error; }
        finally { releasing = false; }
        if (!worker || typeof worker.dispatch !== 'function' || typeof worker.close !== 'function') {
          sessionKey.fill(0); throw Error('INVALID_WORKER');
        }
        if (active && worker !== active.worker) {
          sessionKey.fill(0); throw Error('WORKER_REUSE_REQUIRED');
        }
        const sessionId = randomBytes(16).toString('base64url');
        const previous = active;
        active = { id: sessionId, key: sessionKey, worker, used: new Set(), inFlight: 0, retired: false };
        if (previous) {
          previous.retired = true;
          if (previous.inFlight === 0) previous.key.fill(0);
        }
        const reply = encrypted(sessionKey,
          Buffer.concat([replyAadPrefix, item.challenge]), { ready: true, sessionId });
        res.end(JSON.stringify(reply));
        return;
      }
      const session = active;
      if (!session || releasing || body.sessionId !== session.id) throw Error('SESSION_UNAVAILABLE');
      const nonce = base64(body.nonce, 12, 'INVALID_NONCE');
      const nonceId = body.nonce;
      if (session.used.has(nonceId)) throw Error('REPLAY_DENIED');
      session.used.add(nonceId);
      if (session.used.size > 10_000) throw Error('SESSION_EXHAUSTED');
      const aad = Buffer.concat([rpcAadPrefix, Buffer.from(session.id), nonce]);
      const call = decrypted(session.key, aad, nonce, body.ciphertext);
      if (!call || !['GET', 'POST'].includes(call.method) || typeof call.path !== 'string' ||
          !/^\/api\/[A-Za-z0-9/_?&=.%:-]{1,512}$/.test(call.path) || call.path.includes('..'))
        throw Error('INVALID_RPC');
      session.inFlight++;
      try {
        const result = await session.worker.dispatch(call);
        const payload = encrypted(session.key,
          Buffer.concat([replyAadPrefix, nonce]), result);
        res.end(JSON.stringify(payload));
      } finally {
        session.inFlight--;
        if (session.retired && session.inFlight === 0) session.key.fill(0);
      }
    } catch (error) {
      const code = typeof error?.message === 'string' && /^[A-Z_]+$/.test(error.message)
        ? error.message : 'CHANNEL_FAILED';
      res.writeHead(code === 'REPLAY_DENIED' ? 409 : 400);
      res.end(JSON.stringify({ error: code }));
    }
  });
  return {
    server,
    close() { if (active) { active.worker.close(); active.key.fill(0); active = null; } pending.clear(); server.close(); },
  };
}
