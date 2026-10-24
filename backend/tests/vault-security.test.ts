import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { Hono } from "hono";
import {
  createVaultSecurity,
  VAULT_SCHEMA_SQL,
} from "../src/vault-security.js";
const url = process.env.SUCO_VAULT_TEST_DATABASE_URL;
if (url) {
  const u = new URL(url);
  if (
    u.hostname !== "127.0.0.1" ||
    u.port !== "5436" ||
    !/^\/suco_vault_[a-f0-9]{12}$/.test(u.pathname) ||
    !u.username.startsWith("suco_vault_")
  )
    throw Error("SYNTHETIC_VAULT_DATABASE_REQUIRED");
}
test("vault scope rejects browser-like untrusted IDs", () => {
  assert.throws(
    () =>
      createVaultSecurity({
        pool: {} as pg.Pool,
        tenantId: "../bad",
        accountId: "owner",
      }),
    /VAULT_SCOPE_REQUIRED/,
  );
});
test("unavailable storage fails closed without leaking internal errors", async () => {
  const pool = {
    query: async () => {
      throw Error("synthetic database credential must not leak");
    },
  } as unknown as pg.Pool;
  const vault = createVaultSecurity({
    pool,
    tenantId: "synthetic",
    accountId: "owner",
  });
  const app = new Hono();
  app.route("/vault", vault.routes);
  app.use("/protected", vault.guard);
  app.get("/protected", (c) => c.json({ secret: "must stay hidden" }));
  for (const path of ["/vault/status", "/protected"]) {
    const response = await app.request(path);
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /credential|must stay hidden/);
  }
});
test(
  "real PG vault password, parallel lockout, revocation and account isolation",
  { skip: !url },
  async (t) => {
    const pool = new pg.Pool({ connectionString: url, max: 12 });
    t.after(() => pool.end());
    await pool.query(VAULT_SCHEMA_SQL);
    let clock = 1700000000000;
    const vault = createVaultSecurity({
      pool,
      tenantId: "synthetic_tenant",
      accountId: "synthetic_owner",
      now: () => clock,
    });
    const app = new Hono();
    app.route("/api/vault", vault.routes);
    app.use("/protected", vault.guard);
    app.get("/protected", (c) => c.json({ ok: true }));
    const other = createVaultSecurity({
      pool,
      tenantId: "synthetic_tenant",
      accountId: "other_owner",
      now: () => clock,
    });
    const otherApp = new Hono();
    otherApp.route("/api/vault", other.routes);
    otherApp.use("/protected", other.guard);
    otherApp.get("/protected", (c) => c.json({ ok: true }));
    const post = (path: string, body: unknown, token?: string, target = app) =>
      target.request("/api/vault/" + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "X-Suco-Vault-Token": token } : {}),
        },
        body: JSON.stringify(body),
      });
    const protectedGet = (token?: string, target = app) =>
      target.request("/protected", {
        headers: token ? { "X-Suco-Vault-Token": token } : {},
      });
    const initialPassword = "synthetic vault password A";
    const newPassword = "synthetic vault password B";
    let token = "";
    await t.test(
      "setup validates strength and stores only salted hash, starts locked",
      async () => {
        assert.equal((await protectedGet()).status, 423);
        assert.deepEqual(
          await (await app.request("/api/vault/status")).json(),
          { configured: false, locked: true, expiresAt: null },
        );
        assert.equal(
          (await post("password", { newPassword: "too short" })).status,
          400,
        );
        assert.equal(
          (await post("password", { newPassword: initialPassword })).status,
          200,
        );
        assert.equal((await protectedGet()).status, 423);
        const row = (await pool.query("SELECT * FROM suco_vault_security"))
          .rows[0];
        assert.notEqual(row.password_hash, initialPassword);
        assert.equal(row.password_hash.length, 128);
        assert.equal(row.password_salt.length, 64);
        assert.equal((await post("password", { newPassword })).status, 401);
      },
    );
    await t.test(
      "concurrent failures persist and block the correct password too",
      async () => {
        const responses = await Promise.all(
          Array.from({ length: 8 }, () =>
            post("unlock", { password: "wrong-password" }),
          ),
        );
        // One earlier failed change also contributes to the same account bucket.
        assert.equal(responses.filter((r) => r.status === 401).length, 4);
        assert.equal(responses.filter((r) => r.status === 429).length, 4);
        const reloaded = createVaultSecurity({
          pool,
          tenantId: "synthetic_tenant",
          accountId: "synthetic_owner",
          now: () => clock,
        });
        assert.equal(
          (
            await reloaded.routes.request("/unlock", {
              method: "POST",
              body: JSON.stringify({ password: initialPassword }),
            })
          ).status,
          429,
        );
        assert.equal(
          (await post("unlock", { password: initialPassword })).status,
          429,
        );
        clock += 15 * 60000;
      },
    );
    await t.test(
      "unlock token is hashed, header-only and account bound; JWT rotation irrelevant",
      async () => {
        const response = await post("unlock", { password: initialPassword });
        assert.equal(response.status, 200);
        const data = await response.json();
        token = data.token;
        assert.equal(data.expiresAt, clock + 15 * 60000);
        assert.equal((await protectedGet(token)).status, 200);
        assert.equal((await protectedGet(token, otherApp)).status, 423);
        assert.equal(
          (await app.request("/protected?token=" + token)).status,
          423,
        );
        const row = (await pool.query("SELECT * FROM suco_vault_sessions"))
          .rows[0];
        assert.notEqual(row.token_hash, token);
        assert.equal(row.token_hash.length, 64);
        const status = await (
          await app.request("/api/vault/status", {
            headers: { "X-Suco-Vault-Token": token },
          })
        ).json();
        assert.deepEqual(status, {
          configured: true,
          locked: false,
          expiresAt: clock + 15 * 60000,
        });
      },
    );
    await t.test(
      "change cannot bypass old password, rotates version and revokes all sessions",
      async () => {
        assert.equal(
          (await post("password", { newPassword, currentPassword: "wrong" }))
            .status,
          401,
        );
        assert.equal((await protectedGet(token)).status, 200);
        assert.equal(
          (
            await post("password", {
              newPassword,
              currentPassword: initialPassword,
            })
          ).status,
          200,
        );
        assert.equal((await protectedGet(token)).status, 423);
        assert.equal(
          (await post("unlock", { password: initialPassword })).status,
          401,
        );
        const response = await post("unlock", { password: newPassword });
        assert.equal(response.status, 200);
        token = (await response.json()).token;
      },
    );
    await t.test(
      "explicit lock revokes current session and absolute TTL does not slide",
      async () => {
        assert.equal((await post("lock", {}, token)).status, 200);
        assert.equal((await protectedGet(token)).status, 423);
        token = (await (await post("unlock", { password: newPassword })).json())
          .token;
        clock += 14 * 60000;
        assert.equal((await protectedGet(token)).status, 200);
        clock += 60000;
        assert.equal((await protectedGet(token)).status, 423);
      },
    );
    await t.test(
      "malformed bodies are safe and same-password salts differ across accounts",
      async () => {
        assert.equal(
          (await post("password", { newPassword }, undefined, otherApp)).status,
          200,
        );
        const rows = (
          await pool.query(
            "SELECT password_hash,password_salt FROM suco_vault_security ORDER BY account_id",
          )
        ).rows;
        assert.equal(rows.length, 2);
        assert.notEqual(rows[0].password_salt, rows[1].password_salt);
        assert.notEqual(rows[0].password_hash, rows[1].password_hash);
        assert.equal((await post("unlock", [])).status, 400);
        assert.equal(
          (await post("unlock", { password: "x".repeat(5000) })).status,
          400,
        );
      },
    );
  },
);
