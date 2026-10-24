import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Aes128Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from '@hpke/core';

export const audience = 'https://app.sucodezap.xyz/attestation/channel-v1';
const launcherSocket = '/run/container_launcher/teeserver.sock';
const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(), aead: new Aes128Gcm() });
const requests = new Map();
const ttlMs = 60_000;

export function channelNonce(challenge, publicKey) {
  if (!Buffer.isBuffer(challenge) || challenge.length !== 32 ||
      !Buffer.isBuffer(publicKey) || publicKey.length !== 32)
    throw Error('CHANNEL_BINDING_INPUT');
  return createHash('sha256').update('suco-channel-v1\0')
    .update(challenge).update(publicKey).digest('base64url');
}

async function readJson(req) {
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 8192) throw Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function decode(value, length, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value))
    throw Error(name);
  const result = Buffer.from(value, 'base64url');
  if (result.length !== length || result.toString('base64url') !== value)
    throw Error(name);
  return result;
}

export function launcherToken(nonce, socketPath = launcherSocket, tokenAudience = audience) {
  const body = JSON.stringify({ audience: tokenAudience, token_type: 'OIDC', nonces: [nonce] });
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: '/v1/token', method: 'POST',
      timeout: 10_000, headers: { 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body) } }, response => {
      const parts = []; let size = 0;
      response.on('data', part => {
        size += part.length;
        if (size > 16_384) { response.destroy(); reject(Error('TOKEN_TOO_LARGE')); return; }
        parts.push(part);
      });
      response.on('end', () => {
        if (response.statusCode !== 200) { reject(Error('ATTESTATION_UNAVAILABLE')); return; }
        const raw = Buffer.concat(parts).toString('utf8').trim();
        const token = raw.startsWith('{') ? JSON.parse(raw).token : raw;
        if (typeof token !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
          { reject(Error('ATTESTATION_INVALID')); return; }
        resolve(token);
      });
      response.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Error('ATTESTATION_TIMEOUT')));
    req.on('error', reject);
    req.end(body);
  });
}

export function createServer(tokenFn = launcherToken) {
  return http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'GET' && req.url === '/health') {
      res.end(JSON.stringify({ status: 'channel_probe_only', acceptsUserData: false }));
      return;
    }
    if (req.method !== 'POST' || !['/channel/attest', '/channel/prove'].includes(req.url)) {
      res.statusCode = 404; res.end(JSON.stringify({ error: 'NOT_FOUND' })); return;
    }
    try {
      const body = await readJson(req);
      if (req.url === '/channel/attest') {
        const challenge = decode(body.challenge, 32, 'INVALID_CHALLENGE');
        for (const [id, item] of requests) if (item.expiresAt <= Date.now()) requests.delete(id);
        if (requests.size >= 64) throw Error('CHANNEL_CAPACITY');
        const keypair = await suite.kem.generateKeyPair();
        const publicKey = Buffer.from(await suite.kem.serializePublicKey(keypair.publicKey));
        const nonce = channelNonce(challenge, publicKey);
        const token = await tokenFn(nonce);
        const id = randomBytes(16).toString('base64url');
        requests.set(id, { privateKey: keypair.privateKey, challenge,
          expiresAt: Date.now() + ttlMs });
        res.end(JSON.stringify({ id, publicKey: publicKey.toString('base64url'), token, audience }));
        return;
      }
      const id = body.id;
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(id))
        throw Error('INVALID_CHANNEL');
      const item = requests.get(id);
      requests.delete(id);
      if (!item || item.expiresAt <= Date.now()) throw Error('CHANNEL_EXPIRED');
      const enc = decode(body.enc, 32, 'INVALID_ENC');
      const ciphertext = decode(body.ciphertext, 74, 'INVALID_CIPHERTEXT');
      const recipient = await suite.createRecipientContext({ recipientKey: item.privateKey, enc });
      const plaintext = Buffer.from(await recipient.open(ciphertext,
        Buffer.concat([Buffer.from('suco-channel-proof-v1\0'), item.challenge])));
      const expected = Buffer.concat([Buffer.from('SUCO_CHANNEL_SYNTHETIC_V1:'), item.challenge]);
      if (!plaintext.equals(expected)) throw Error('PROOF_MISMATCH');
      res.end(JSON.stringify({ proven: true, digest: createHash('sha256').update(plaintext).digest('hex') }));
    } catch (error) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: /^[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'CHANNEL_FAILED' }));
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  createServer().listen(8080, '0.0.0.0');
