// Isolated integration DB in the approved Suco PostgreSQL. No business tables or production credentials.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const name = 'suco_summary_' + randomBytes(6).toString('hex');
const password = randomBytes(24).toString('hex');
if (!/^suco_summary_[a-f0-9]{12}$/.test(name)) throw Error('SYNTHETIC_NAME_REQUIRED');
function sql(input) {
  const r = spawnSync('docker', ['exec', '-i', 'suco-pilot-postgres', 'psql', '-U', 'suco_pilot_admin', '-v', 'ON_ERROR_STOP=1', '-d', 'postgres'], { input, encoding: 'utf8', timeout: 20000 });
  if (r.status !== 0) throw Error('SYNTHETIC_PG_ADMIN_FAILED');
}
let role = false, db = false;
try {
  sql(`CREATE ROLE ${name} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`); role = true;
  sql(`CREATE DATABASE ${name} OWNER ${name};`); db = true;
  sql(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC;`);
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const result = spawnSync(process.execPath, [cwd + '/node_modules/tsx/dist/cli.mjs', '--test', 'tests/summary-workflow-pg.test.ts'], {
    cwd, env: { PATH: process.env.PATH, SUCO_SUMMARY_TEST_DATABASE_URL: `postgres://${name}:${password}@127.0.0.1:5436/${name}` },
    encoding: 'utf8', timeout: 90000,
  });
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  if (result.status !== 0) process.exitCode = 1;
} catch {
  console.error('Synthetic PostgreSQL summary verification failed; no credentials printed.'); process.exitCode = 1;
} finally {
  if (db) try { sql(`DROP DATABASE ${name} WITH (FORCE);`); } catch { console.error('Own synthetic summary database cleanup required.'); process.exitCode = 1; }
  if (role) try { sql(`DROP ROLE ${name};`); } catch { console.error('Own synthetic summary role cleanup required.'); process.exitCode = 1; }
}
