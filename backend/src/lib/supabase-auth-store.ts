import {
  ConfidentialAuthError,
  type EncryptedAuthStore,
  type SealedAuthRecord,
} from './confidential-auth-state.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVISION = /^[1-9][0-9]{0,18}$/;
const MAGIC_HEX = '5355434f4155544831';
const MAX_HEX = 4 * 1024 * 1024 * 2;

export interface SupabaseAuthStoreOptions {
  url: string;
  publishableKey: string;
  ownerId: string;
  /** Returns a refreshed, verified owner's Supabase Auth user JWT. */
  userJwt: () => Promise<string>;
  fetcher?: typeof fetch;
}

function fail(code: 'AUTH_STATE_INPUT' | 'AUTH_STATE_AUTH' | 'AUTH_STATE_CORRUPT' |
  'AUTH_STATE_CONFLICT' | 'AUTH_STATE_STORE'): never {
  throw new ConfidentialAuthError(code);
}

function validRevision(value: unknown): value is string {
  return typeof value === 'string' && REVISION.test(value) &&
    BigInt(value) < 9223372036854775807n;
}

function validCiphertextHex(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 76 && value.length <= MAX_HEX &&
    value.length % 2 === 0 && value.startsWith(MAGIC_HEX) && /^[0-9a-f]+$/.test(value);
}

function userToken(token: string, ownerId: string): boolean {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every(Boolean)) return false;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    return payload.role === 'authenticated' && payload.sub === ownerId &&
      typeof payload.exp === 'number' && payload.exp > Math.floor(Date.now() / 1000) + 5;
  } catch { return false; }
}

/** Supabase Auth JWT is the only credential sent; no service role or plaintext. */
export function createSupabaseAuthStore(options: SupabaseAuthStoreOptions): EncryptedAuthStore {
  let endpoint: URL;
  try { endpoint = new URL(options.url); }
  catch { return fail('AUTH_STATE_INPUT'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || !UUID.test(options.ownerId) ||
      !options.publishableKey || options.publishableKey.startsWith('sb_secret_') ||
      typeof options.userJwt !== 'function') fail('AUTH_STATE_INPUT');
  if (options.publishableKey.split('.').length === 3) {
    try {
      const role = JSON.parse(Buffer.from(options.publishableKey.split('.')[1], 'base64url').toString('utf8')).role;
      if (role !== 'anon') fail('AUTH_STATE_INPUT');
    } catch { fail('AUTH_STATE_INPUT'); }
  }
  const base = endpoint.toString().replace(/\/$/, '');
  const fetcher = options.fetcher ?? fetch;

  async function rpc(name: string, body: Record<string, unknown>, idempotent: boolean): Promise<unknown> {
    const attempts = idempotent ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const jwt = await options.userJwt();
      if (!userToken(jwt, options.ownerId)) fail('AUTH_STATE_AUTH');
      try {
        const response = await fetcher(`${base}/rest/v1/rpc/${name}`, {
          method: 'POST',
          headers: {
            apikey: options.publishableKey,
            Authorization: `Bearer ${jwt}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          cache: 'no-store',
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) fail('AUTH_STATE_AUTH');
          let code: unknown;
          try { code = (await response.json() as { code?: unknown }).code; } catch {}
          if (code === '40001') fail('AUTH_STATE_CONFLICT');
          if ((response.status === 429 || response.status >= 500) && attempt + 1 < attempts) continue;
          fail('AUTH_STATE_STORE');
        }
        return await response.json();
      } catch (error) {
        if (error instanceof ConfidentialAuthError) throw error;
        if (attempt + 1 >= attempts) fail('AUTH_STATE_STORE');
      }
    }
    return fail('AUTH_STATE_STORE');
  }

  return {
    async read() {
      const result = await rpc('suco_auth_read', {}, true);
      if (!Array.isArray(result) || result.length > 1) fail('AUTH_STATE_CORRUPT');
      if (result.length === 0) return null;
      const row = result[0] as { revision?: unknown; ciphertext_hex?: unknown };
      if (!validRevision(row.revision) || !validCiphertextHex(row.ciphertext_hex)) fail('AUTH_STATE_CORRUPT');
      return { revision: row.revision, ciphertext: Buffer.from(row.ciphertext_hex, 'hex') };
    },
    async compareAndSwap(expectedRevision, ciphertext) {
      if ((expectedRevision !== null && !validRevision(expectedRevision)) ||
          !(ciphertext instanceof Uint8Array)) fail('AUTH_STATE_INPUT');
      const hex = Buffer.from(ciphertext).toString('hex');
      if (!validCiphertextHex(hex)) fail('AUTH_STATE_INPUT');
      const result = await rpc('suco_auth_cas', {
        p_expected_revision: expectedRevision ?? '0',
        p_ciphertext_hex: hex,
      }, false);
      if (!validRevision(result)) fail('AUTH_STATE_STORE');
      const expectedNext = expectedRevision === null ? 1n : BigInt(expectedRevision) + 1n;
      if (BigInt(result) !== expectedNext) fail('AUTH_STATE_STORE');
      return result;
    },
    async archive(record: SealedAuthRecord) {
      if (!validRevision(record.revision) || !(record.ciphertext instanceof Uint8Array)) fail('AUTH_STATE_INPUT');
      const hex = Buffer.from(record.ciphertext).toString('hex');
      if (!validCiphertextHex(hex)) fail('AUTH_STATE_INPUT');
      const result = await rpc('suco_auth_archive', {
        p_expected_revision: record.revision,
        p_ciphertext_hex: hex,
      }, true);
      if (result !== true) fail('AUTH_STATE_STORE');
    },
  };
}
