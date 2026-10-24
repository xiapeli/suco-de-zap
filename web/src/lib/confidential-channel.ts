import { Aes128Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from '@hpke/core';
import { verifyWorkerAttestation, workerAudience } from './worker-attestation.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(), aead: new Aes128Gcm() });
const bytes = (value: string) => encoder.encode(value);
const concat = (...parts: Uint8Array[]) => new Uint8Array(parts.flatMap(part => [...part]));
function b64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function unb64(value: string, length?: number): Uint8Array {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error('CHANNEL_FORMAT');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const decoded = Uint8Array.from(atob(padded), c => c.charCodeAt(0));
  if (length !== undefined && decoded.length !== length) throw Error('CHANNEL_FORMAT');
  if (b64(decoded) !== value) throw Error('CHANNEL_FORMAT');
  return decoded;
}

async function jsonPost(url: string, value: object, fetcher: typeof fetch): Promise<Record<string, unknown>> {
  const response = await fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value), cache: 'no-store', signal: AbortSignal.timeout(25_000) });
  if (!response.ok) {
    // The gateway returns only allowlisted error codes. Keep that code so a
    // failed first entry can be diagnosed without logging a key or token.
    try {
      const body = await response.json() as { error?: unknown };
      if (typeof body.error === 'string' && /^[A-Z][A-Z_]{3,63}$/.test(body.error))
        throw Error(body.error);
    } catch (error) {
      if (error instanceof Error && /^[A-Z][A-Z_]{3,63}$/.test(error.message)) throw error;
    }
    throw Error('CHANNEL_REMOTE');
  }
  const result: unknown = await response.json();
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error('CHANNEL_FORMAT');
  return result as Record<string, unknown>;
}

async function seal(key: CryptoKey, nonce: Uint8Array, aad: Uint8Array, value: object) {
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: aad as BufferSource },
    key, bytes(JSON.stringify(value)) as BufferSource));
  return { nonce: b64(nonce), ciphertext: b64(ciphertext) };
}
async function open(key: CryptoKey, aad: Uint8Array, value: Record<string, unknown>) {
  const nonce = unb64(value.nonce as string, 12);
  const ciphertext = unb64(value.ciphertext as string);
  const clear = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: aad as BufferSource },
    key, ciphertext as BufferSource);
  return JSON.parse(decoder.decode(clear)) as Record<string, unknown>;
}

export interface ConfidentialChannel {
  rpc<T = unknown>(method: 'GET' | 'POST', path: string, body?: object): Promise<{ status: number; body: T }>;
  close(): void;
}

export interface LegacyIdentityHandoff {
  jid: string;
  proof: { version: 1; salt: string; digest: string };
}

export function parseLegacyIdentityHandoff(value: unknown): LegacyIdentityHandoff {
  if (!value || typeof value !== 'object') throw Error('OWNER_HANDOFF_INVALID');
  const bundle = value as Record<string, unknown>;
  const proof = bundle.proof as Record<string, unknown> | null;
  if (bundle.version !== 1 || bundle.requiresOwnerScan !== true ||
      typeof bundle.jid !== 'string' || !/^\d{5,20}@s\.whatsapp\.net$/.test(bundle.jid) ||
      !proof || proof.version !== 1 || typeof proof.salt !== 'string' ||
      !/^[0-9a-f]{32}$/.test(proof.salt) || typeof proof.digest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(proof.digest)) throw Error('OWNER_HANDOFF_INVALID');
  return { jid: bundle.jid, proof: { version: 1, salt: proof.salt, digest: proof.digest } };
}

/** The image digest must come from the independently approved client release. */
export async function openConfidentialChannel(args: {
  baseUrl: string;
  imageDigest: string;
  ownerId: string;
  keyEpoch: number;
  userKey: Uint8Array;
  accessToken: string;
  refreshToken: string;
  legacyIdentity?: LegacyIdentityHandoff;
  fetcher?: typeof fetch;
}): Promise<ConfidentialChannel> {
  const base = new URL(args.baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash ||
      !/^[0-9a-f-]{36}$/i.test(args.ownerId) || args.userKey.length !== 32 ||
      !Number.isInteger(args.keyEpoch) || args.keyEpoch < 1 || args.keyEpoch > 1_000_000_000)
    throw Error('CHANNEL_INPUT');
  const fetcher = args.fetcher ?? fetch;
  const root = base.toString().replace(/\/$/, '');
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const attested = await jsonPost(`${root}/channel/attest`, { challenge: b64(challenge) }, fetcher);
  if (attested.audience !== workerAudience || typeof attested.id !== 'string' ||
      !/^[A-Za-z0-9_-]{22}$/.test(attested.id)) throw Error('CHANNEL_ATTESTATION');
  const publicKey = unb64(attested.publicKey as string, 32);
  await verifyWorkerAttestation({ token: attested.token as string, challenge, publicKey,
    imageDigest: args.imageDigest, fetcher });
  const sender = await suite.createSenderContext({
    recipientPublicKey: await suite.kem.deserializePublicKey(publicKey),
  });
  const sessionKey = crypto.getRandomValues(new Uint8Array(32));
  const release = {
    version: 1, ownerId: args.ownerId, keyEpoch: args.keyEpoch,
    key: b64(args.userKey), sessionKey: b64(sessionKey),
    accessToken: args.accessToken, refreshToken: args.refreshToken,
    ...(args.legacyIdentity ? { legacyIdentity: args.legacyIdentity } : {}),
  };
  const ciphertext = new Uint8Array(await sender.seal(bytes(JSON.stringify(release)),
    concat(bytes('suco-worker-release-v1\0'), challenge)));
  const reply = await jsonPost(`${root}/channel/release`, {
    id: attested.id, enc: b64(new Uint8Array(sender.enc)), ciphertext: b64(ciphertext),
  }, fetcher);
  const aes = await crypto.subtle.importKey('raw', sessionKey as BufferSource,
    { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const established = await open(aes, concat(bytes('suco-worker-reply-v1\0'), challenge), reply);
  if (established.ready !== true || typeof established.sessionId !== 'string' ||
      !/^[A-Za-z0-9_-]{22}$/.test(established.sessionId)) throw Error('CHANNEL_RELEASE');
  const sessionId = established.sessionId;
  let closed = false;
  return {
    async rpc<T>(method: 'GET' | 'POST', path: string, body?: object) {
      if (closed) throw Error('CHANNEL_CLOSED');
      if (!/^\/api\/[A-Za-z0-9/_?&=.%:-]{1,512}$/.test(path) || path.includes('..')) throw Error('CHANNEL_PATH');
      const requestNonce = crypto.getRandomValues(new Uint8Array(12));
      const plaintext = { method, path, ...(body === undefined ? {} : { body }) };
      const packet = await seal(aes, requestNonce,
        concat(bytes('suco-worker-rpc-v1\0'), bytes(sessionId), requestNonce), plaintext);
      const response = await jsonPost(`${root}/rpc`, { sessionId, ...packet }, fetcher);
      const clear = await open(aes, concat(bytes('suco-worker-reply-v1\0'), requestNonce), response);
      if (!Number.isInteger(clear.status) || typeof clear.body === 'undefined') throw Error('CHANNEL_RESPONSE');
      return clear as { status: number; body: T };
    },
    close() { closed = true; sessionKey.fill(0); },
  };
}
