/** Supabase credentials are handed to the attested worker through the sealed channel. */
export interface OwnerSessionInput {
  url: string;
  publishableKey: string;
  ownerId: string;
  accessToken: string;
  refreshToken: string;
  fetcher?: typeof fetch;
}

export interface OwnerSession {
  userJwt(): Promise<string>;
  verifiedAccount(): Promise<{ accountId: string; email: string; entitlement: string; privateState: string }>;
  canIngest(): Promise<boolean>;
  currentCredentials(): { accessToken: string; refreshToken: string };
  /** After a fresh attested browser channel verifies a new Supabase session. */
  replaceCredentials(accessToken: string, refreshToken: string): Promise<void>;
  /** Keep the live worker's refresh chain unless Supabase rejects it. */
  recoverCredentials(accessToken: string, refreshToken: string): Promise<'preserved' | 'replaced'>;
  close(): void;
}

export class OwnerSessionError extends Error {
  constructor(readonly code: 'OWNER_SESSION_INPUT' | 'OWNER_SESSION_AUTH' | 'OWNER_SESSION_REMOTE' | 'OWNER_SESSION_CLOSED') {
    super(code);
    this.name = 'OwnerSessionError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function tokenExpiry(token: string, ownerId: string): number {
  if (!TOKEN.test(token)) throw new OwnerSessionError('OWNER_SESSION_INPUT');
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    if (payload.sub !== ownerId || payload.role !== 'authenticated' ||
      typeof payload.exp !== 'number' || !Number.isSafeInteger(payload.exp)) throw Error('claims');
    return payload.exp;
  } catch { throw new OwnerSessionError('OWNER_SESSION_AUTH'); }
}

export function createSupabaseOwnerSession(input: OwnerSessionInput): OwnerSession {
  let endpoint: URL;
  try { endpoint = new URL(input.url); } catch { throw new OwnerSessionError('OWNER_SESSION_INPUT'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
    !UUID.test(input.ownerId) || !input.publishableKey || input.publishableKey.startsWith('sb_secret_') ||
    !TOKEN.test(input.accessToken) || !input.refreshToken || input.refreshToken.length > 4096) {
    throw new OwnerSessionError('OWNER_SESSION_INPUT');
  }
  const base = endpoint.toString().replace(/\/$/, '');
  const fetcher = input.fetcher ?? fetch;
  let accessToken = input.accessToken;
  let refreshToken = input.refreshToken;
  let closed = false;
  let refreshFlight: Promise<void> | null = null;
  let allowUntil = 0;
  let authorizationFlight: Promise<boolean> | null = null;
  const open = () => { if (closed) throw new OwnerSessionError('OWNER_SESSION_CLOSED'); };
  const headers = (jwt?: string) => ({
    apikey: input.publishableKey,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
  });

  async function refresh() {
    open();
    if (refreshFlight) return refreshFlight;
    refreshFlight = (async () => {
      let response: Response;
      try {
        response = await fetcher(`${base}/auth/v1/token?grant_type=refresh_token`, {
          method: 'POST', headers: headers(), body: JSON.stringify({ refresh_token: refreshToken }),
          signal: AbortSignal.timeout(15_000), cache: 'no-store',
        });
      } catch { throw new OwnerSessionError('OWNER_SESSION_REMOTE'); }
      if (!response.ok) throw new OwnerSessionError('OWNER_SESSION_AUTH');
      let body: { access_token?: unknown; refresh_token?: unknown };
      try { body = await response.json() as typeof body; }
      catch { throw new OwnerSessionError('OWNER_SESSION_REMOTE'); }
      if (typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string' ||
        !body.refresh_token || body.refresh_token.length > 4096 ||
        tokenExpiry(body.access_token, input.ownerId) <= Math.floor(Date.now() / 1000) + 5) {
        throw new OwnerSessionError('OWNER_SESSION_AUTH');
      }
      open();
      accessToken = body.access_token;
      refreshToken = body.refresh_token;
    })().finally(() => { refreshFlight = null; });
    return refreshFlight;
  }

  async function userJwt() {
    open();
    if (tokenExpiry(accessToken, input.ownerId) <= Math.floor(Date.now() / 1000) + 60) await refresh();
    return accessToken;
  }

  async function request(path: string): Promise<unknown> {
    const jwt = await userJwt();
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, {
        method: path.startsWith('/rest/v1/rpc/') ? 'POST' : 'GET',
        headers: headers(jwt), cache: 'no-store', signal: AbortSignal.timeout(15_000),
      });
    } catch { throw new OwnerSessionError('OWNER_SESSION_REMOTE'); }
    if (response.status === 401 || response.status === 403) throw new OwnerSessionError('OWNER_SESSION_AUTH');
    if (!response.ok) throw new OwnerSessionError('OWNER_SESSION_REMOTE');
    try { return await response.json() as unknown; }
    catch { throw new OwnerSessionError('OWNER_SESSION_REMOTE'); }
  }

  async function verifiedAccount() {
    const user = await request('/auth/v1/user') as Record<string, unknown>;
    if (user.id !== input.ownerId || typeof user.email !== 'string' || !user.email_confirmed_at) {
      throw new OwnerSessionError('OWNER_SESSION_AUTH');
    }
    const status = await request('/rest/v1/rpc/suco_account_status') as Record<string, unknown>;
    if (!status || status.accountId !== input.ownerId || status.email !== user.email.toLowerCase() ||
      !['owner', 'partner_full'].includes(status.entitlement as string) ||
      typeof status.privateState !== 'string') throw new OwnerSessionError('OWNER_SESSION_AUTH');
    return status as { accountId: string; email: string; entitlement: string; privateState: string };
  }

  return {
    userJwt,
    verifiedAccount,
    currentCredentials() { open(); return { accessToken, refreshToken }; },
    async replaceCredentials(nextAccessToken, nextRefreshToken) {
      open();
      if (!nextRefreshToken || nextRefreshToken.length > 4096 ||
          tokenExpiry(nextAccessToken, input.ownerId) <= Math.floor(Date.now() / 1000) + 60)
        throw new OwnerSessionError('OWNER_SESSION_AUTH');
      // Do not let a refresh started before the handoff overwrite the newer
      // browser credentials after this method returns.
      if (refreshFlight) await refreshFlight.catch(() => undefined);
      open();
      accessToken = nextAccessToken;
      refreshToken = nextRefreshToken;
      allowUntil = 0;
    },
    async recoverCredentials(nextAccessToken, nextRefreshToken) {
      // Reattaching the browser must not overwrite a newer worker refresh
      // token with the browser's potentially stale copy of the same session.
      try {
        await verifiedAccount();
        return 'preserved';
      } catch (error) {
        if (!(error instanceof OwnerSessionError) || error.code !== 'OWNER_SESSION_AUTH') throw error;
      }
      await this.replaceCredentials(nextAccessToken, nextRefreshToken);
      await verifiedAccount();
      return 'replaced';
    },
    async canIngest() {
      if (closed) return false;
      // Replay checks every item. A short, single-flight lease avoids two
      // Auth/REST roundtrips per message while bounding grant revocation lag.
      if (allowUntil > Date.now()) return true;
      if (authorizationFlight) return authorizationFlight;
      authorizationFlight = (async () => {
        try {
          const allowed = (await verifiedAccount()).privateState === 'active';
          allowUntil = allowed ? Date.now() + 2_000 : 0;
          return allowed;
        } catch { allowUntil = 0; return false; }
      })().finally(() => { authorizationFlight = null; });
      return authorizationFlight;
    },
    close() { closed = true; allowUntil = 0; accessToken = ''; refreshToken = ''; },
  };
}
