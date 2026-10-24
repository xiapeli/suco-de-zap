import { rollbackPreservingError } from './lib/rollback.js';
import { Hono, type MiddlewareHandler } from "hono";
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";

function derive(value: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(
      value,
      salt,
      64,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
}
const TTL = 15 * 60_000;
const MAX_FAILURES = 5;
export const VAULT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS suco_vault_security (
 tenant_id text NOT NULL, account_id text NOT NULL,
 password_hash text, password_salt text, password_version integer NOT NULL DEFAULT 0,
 failures integer NOT NULL DEFAULT 0, window_started_ms bigint NOT NULL DEFAULT 0,
 PRIMARY KEY (tenant_id, account_id)
);
CREATE TABLE IF NOT EXISTS suco_vault_sessions (
 token_hash text PRIMARY KEY, tenant_id text NOT NULL, account_id text NOT NULL,
 password_version integer NOT NULL, expires_ms bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS suco_vault_sessions_owner ON suco_vault_sessions(tenant_id,account_id);
`;
interface Row {
  password_hash: string | null;
  password_salt: string | null;
  password_version: number;
  failures: number;
  window_started_ms: string;
}
class VaultError extends Error {
  constructor(
    public code: string,
    public status: 400 | 401 | 409 | 429,
  ) {
    super(code);
  }
}
const hashToken = (token: string) =>
  createHash("sha256")
    .update("suco-vault-v1:" + token)
    .digest("hex");
function password(value: unknown): string {
  if (
    typeof value !== "string" ||
    [...value].length < 12 ||
    Buffer.byteLength(value) > 1024
  )
    throw new VaultError("VAULT_PASSWORD_LENGTH", 400);
  return value;
}
async function matches(value: unknown, row: Row): Promise<boolean> {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > 1024 ||
    !row.password_hash ||
    !row.password_salt
  )
    return false;
  const actual = (await derive(value, row.password_salt)) as Buffer;
  const expected = Buffer.from(row.password_hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Mount only AFTER native tenant authentication and CSRF/body-size middleware.
// Scope comes from trusted process configuration, never browser headers/body.
export function createVaultSecurity(options: {
  pool: Pick<Pool, "connect" | "query">;
  tenantId: string;
  accountId: string;
  now?: () => number;
}) {
  const { pool, tenantId, accountId } = options;
  if (![tenantId, accountId].every((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id)))
    throw Error("VAULT_SCOPE_REQUIRED");
  const now = options.now ?? Date.now;
  async function transaction<T>(
    fn: (client: PoolClient, row: Row) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`suco-vault:${tenantId}:${accountId}`],
      );
      await client.query(
        "INSERT INTO suco_vault_security(tenant_id,account_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [tenantId, accountId],
      );
      const row = (
        await client.query<Row>(
          "SELECT * FROM suco_vault_security WHERE tenant_id=$1 AND account_id=$2 FOR UPDATE",
          [tenantId, accountId],
        )
      ).rows[0];
      const result = await fn(client, row);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      return await rollbackPreservingError(client,error);
    } finally {
      client.release();
    }
  }
  async function authenticate(
    client: PoolClient,
    row: Row,
    candidate: unknown,
  ): Promise<VaultError | null> {
    const start = Number(row.window_started_ms),
      fresh = now() - start >= TTL;
    if (!fresh && row.failures >= MAX_FAILURES)
      return new VaultError("VAULT_RATE_LIMITED", 429);
    if (!(await matches(candidate, row))) {
      await client.query(
        "UPDATE suco_vault_security SET failures=$3,window_started_ms=$4 WHERE tenant_id=$1 AND account_id=$2",
        [
          tenantId,
          accountId,
          fresh ? 1 : row.failures + 1,
          fresh ? now() : start,
        ],
      );
      return new VaultError("VAULT_PASSWORD_INVALID", 401);
    }
    await client.query(
      "UPDATE suco_vault_security SET failures=0,window_started_ms=0 WHERE tenant_id=$1 AND account_id=$2",
      [tenantId, accountId],
    );
    return null;
  }
  async function status(token?: string) {
    const configured = Boolean(
      (
        await pool.query(
          "SELECT password_hash FROM suco_vault_security WHERE tenant_id=$1 AND account_id=$2",
          [tenantId, accountId],
        )
      ).rows[0]?.password_hash,
    );
    if (!configured || !token || !/^[A-Za-z0-9_-]{43}$/.test(token))
      return { configured, locked: true, expiresAt: null };
    const row = (
      await pool.query(
        `SELECT s.expires_ms FROM suco_vault_sessions s JOIN suco_vault_security v ON v.tenant_id=s.tenant_id AND v.account_id=s.account_id AND v.password_version=s.password_version WHERE s.token_hash=$1 AND s.tenant_id=$2 AND s.account_id=$3 AND s.expires_ms>$4`,
        [hashToken(token), tenantId, accountId, now()],
      )
    ).rows[0];
    return {
      configured,
      locked: !row,
      expiresAt: row ? Number(row.expires_ms) : null,
    };
  }
  const routes = new Hono();
  routes.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });
  routes.onError((error, c) => {
    if (error instanceof VaultError) {
      if (error.status === 429) c.header("Retry-After", "900");
      return c.json(
        {
          code: error.code,
          error:
            "Não foi possível abrir o cofre. Confira a senha ou aguarde antes de tentar novamente.",
        },
        error.status,
      );
    }
    return c.json(
      {
        code: "VAULT_UNAVAILABLE",
        error: "Cofre indisponível. Tente novamente.",
      },
      503,
    );
  });
  async function body(request: Request): Promise<Record<string, unknown>> {
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 4096)
      throw new VaultError("VAULT_BODY_INVALID", 400);
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new VaultError("VAULT_BODY_INVALID", 400);
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new VaultError("VAULT_BODY_INVALID", 400);
    return value;
  }
  routes.get("/status", async (c) =>
    c.json(await status(c.req.header("X-Suco-Vault-Token"))),
  );
  routes.post("/password", async (c) => {
    const input = await body(c.req.raw),
      nextPassword = password(input.newPassword);
    const failure = await transaction(async (client, row) => {
      if (row.password_hash) {
        const error = await authenticate(client, row, input.currentPassword);
        if (error) return error;
      }
      const salt = randomBytes(32).toString("hex"),
        hash = ((await derive(nextPassword, salt)) as Buffer).toString("hex");
      await client.query(
        "UPDATE suco_vault_security SET password_hash=$3,password_salt=$4,password_version=password_version+1,failures=0,window_started_ms=0 WHERE tenant_id=$1 AND account_id=$2",
        [tenantId, accountId, hash, salt],
      );
      await client.query(
        "DELETE FROM suco_vault_sessions WHERE tenant_id=$1 AND account_id=$2",
        [tenantId, accountId],
      );
      return null;
    });
    if (failure) throw failure;
    return c.json({ configured: true, locked: true, expiresAt: null });
  });
  routes.post("/unlock", async (c) => {
    const input = await body(c.req.raw);
    const result = await transaction(async (client, row) => {
      if (!row.password_hash)
        return new VaultError("VAULT_NOT_CONFIGURED", 409);
      const error = await authenticate(client, row, input.password);
      if (error) return error;
      const token = randomBytes(32).toString("base64url"),
        expiresAt = now() + TTL;
      await client.query(
        "DELETE FROM suco_vault_sessions WHERE tenant_id=$1 AND account_id=$2 AND expires_ms<=$3",
        [tenantId, accountId, now()],
      );
      await client.query(
        "INSERT INTO suco_vault_sessions(token_hash,tenant_id,account_id,password_version,expires_ms) VALUES($1,$2,$3,$4,$5)",
        [
          hashToken(token),
          tenantId,
          accountId,
          row.password_version,
          expiresAt,
        ],
      );
      return { token, expiresAt };
    });
    if (result instanceof VaultError) throw result;
    return c.json(result);
  });
  routes.post("/lock", async (c) => {
    const token = c.req.header("X-Suco-Vault-Token");
    if (token && /^[A-Za-z0-9_-]{43}$/.test(token))
      await pool.query(
        "DELETE FROM suco_vault_sessions WHERE token_hash=$1 AND tenant_id=$2 AND account_id=$3",
        [hashToken(token), tenantId, accountId],
      );
    return c.json({ locked: true });
  });
  const guard: MiddlewareHandler = async (c, next) => {
    let state;
    try {
      state = await status(c.req.header("X-Suco-Vault-Token"));
    } catch {
      return c.json(
        { code: "VAULT_UNAVAILABLE", error: "Cofre indisponível." },
        503,
      );
    }
    if (state.locked)
      return c.json(
        {
          code: state.configured ? "VAULT_LOCKED" : "VAULT_NOT_CONFIGURED",
          error: "Abra o cofre com sua senha para continuar.",
        },
        423,
      );
    await next();
  };
  return { routes, guard };
}
