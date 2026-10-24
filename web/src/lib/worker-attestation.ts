import { pinnedGoogleKeys, pinnedGoogleKeysExpireAt } from './worker-attestation-pinned.ts';

const issuer = 'https://confidentialcomputing.googleapis.com';
const keysUrl = 'https://www.googleapis.com/service_accounts/v1/metadata/jwk/signer@confidentialspace-sign.iam.gserviceaccount.com';
export const workerAudience = 'https://app.sucodezap.xyz/attestation/worker-v1';
const encoder = new TextEncoder();

type Claims = {
  iss?: unknown; aud?: unknown; iat?: unknown; nbf?: unknown; exp?: unknown;
  eat_nonce?: unknown; swname?: unknown; dbgstat?: unknown; secboot?: unknown;
  hwmodel?: unknown;
  submods?: {
    confidential_space?: { support_attributes?: unknown; monitoring_enabled?: { memory?: unknown } };
    container?: { image_digest?: unknown };
    gce?: { project_id?: unknown; zone?: unknown };
  };
};

function fail(code: string): never { throw Error(code); }
/** Deployment pins for the worker VM's GCP project and zone; read lazily so
 *  both the Vite build (import.meta.env) and node:test (process.env) see them. */
function expectedGcpPins(): { projectId: string; zone: string } {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
    ?? process.env as Record<string, string | undefined>;
  return { projectId: env.VITE_SUCO_ATTESTATION_PROJECT_ID ?? '', zone: env.VITE_SUCO_ATTESTATION_ZONE ?? '' };
}
function decode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) fail('ATTEST_FORMAT');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, character => character.charCodeAt(0));
}
function jsonPart(value: string): Record<string, unknown> {
  try { return JSON.parse(new TextDecoder().decode(decode(value))) as Record<string, unknown>; }
  catch { return fail('ATTEST_FORMAT'); }
}
function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** Verify a fresh Google token before any user key is released. */
export async function verifyWorkerAttestation(args: {
  token: string;
  challenge: Uint8Array;
  publicKey: Uint8Array;
  imageDigest: string;
  fetcher?: typeof fetch;
  now?: number;
}): Promise<{ imageDigest: string; expiresAt: number }> {
  if (typeof args.token !== 'string' || args.token.length > 16_384 ||
      args.challenge.length !== 32 || args.publicKey.length !== 32 ||
      !/^sha256:[0-9a-f]{64}$/.test(args.imageDigest)) fail('ATTEST_INPUT');
  const parts = args.token.split('.');
  if (parts.length !== 3) fail('ATTEST_FORMAT');
  const [head, payload, signature] = parts;
  const header = jsonPart(head);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' ||
      header.jwk || header.jku || header.x5u) fail('ATTEST_ALGORITHM');
  const fetcher = args.fetcher ?? fetch;
  const now = args.now ?? Math.floor(Date.now() / 1000);
  let jwks: { keys?: JsonWebKey[] };
  try {
    const response = await fetcher(keysUrl, { cache: 'no-store', redirect: 'error',
      signal: AbortSignal.timeout(8_000) });
    if (!response.ok || Number(response.headers.get('content-length') || 0) > 128_000) fail('ATTEST_KEYS');
    const data = await response.text();
    if (data.length > 128_000) fail('ATTEST_KEYS');
    jwks = JSON.parse(data) as typeof jwks;
  } catch {
    // A user's network may block Google while the measured worker is reachable.
    // Only use public keys frozen in this release, and only until Google's own
    // JWKS cache expiry. A new release must refresh the pin after that.
    if (args.fetcher || now >= pinnedGoogleKeysExpireAt) return fail('ATTEST_KEYS');
    jwks = { keys: pinnedGoogleKeys };
  }
  if (!Array.isArray(jwks.keys)) fail('ATTEST_KEYS');
  const jwk = jwks.keys.find(key => (key as JsonWebKey & { kid?: string }).kid === header.kid);
  if (!jwk || jwk.kty !== 'RSA' || (jwk.alg && jwk.alg !== 'RS256') ||
      (jwk.use && jwk.use !== 'sig')) fail('ATTEST_KEY');
  let valid = false;
  try {
    const imported = await crypto.subtle.importKey('jwk', jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', imported,
      decode(signature) as BufferSource, encoder.encode(`${head}.${payload}`) as BufferSource);
  } catch { fail('ATTEST_SIGNATURE'); }
  if (!valid) fail('ATTEST_SIGNATURE');
  const claims = jsonPart(payload) as Claims;
  if (claims.iss !== issuer || claims.aud !== workerAudience) fail('ATTEST_ISSUER');
  if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.nbf) || !Number.isInteger(claims.exp))
    fail('ATTEST_TIME');
  const iat = claims.iat as number, nbf = claims.nbf as number, exp = claims.exp as number;
  if (iat > now + 30 || nbf > now + 30 || exp <= now || now - iat > 300 || exp - iat > 3600)
    fail('ATTEST_TIME');
  const expectedNonce = await crypto.subtle.digest('SHA-256',
    new Uint8Array([...encoder.encode('suco-worker-channel-v1\0'), ...args.challenge, ...args.publicKey]) as BufferSource);
  const nonce = base64url(new Uint8Array(expectedNonce));
  const nonces = Array.isArray(claims.eat_nonce) ? claims.eat_nonce : [claims.eat_nonce];
  if (nonces.length !== 1 || nonces[0] !== nonce)
    fail('ATTEST_NONCE');
  if (claims.swname !== 'CONFIDENTIAL_SPACE' || claims.dbgstat !== 'disabled-since-boot' ||
      claims.secboot !== true || !['GCP_AMD_SEV', 'GCP_INTEL_TDX'].includes(claims.hwmodel as string) ||
      !Array.isArray(claims.submods?.confidential_space?.support_attributes) ||
      !claims.submods.confidential_space.support_attributes.includes('STABLE') ||
      claims.submods.confidential_space.monitoring_enabled?.memory !== false)
    fail('ATTEST_PLATFORM');
  // Unset GCP pins reject every token (fail closed) until the deployer sets them.
  const pins = expectedGcpPins();
  if (claims.submods?.container?.image_digest !== args.imageDigest ||
      claims.submods?.gce?.project_id !== pins.projectId ||
      claims.submods?.gce?.zone !== pins.zone) fail('ATTEST_IMAGE');
  return { imageDigest: args.imageDigest, expiresAt: exp };
}
