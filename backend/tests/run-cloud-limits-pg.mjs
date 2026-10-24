// Dedicated disposable database inside the already-approved Suco pilot PostgreSQL.
// Never points at legacy/postgres application tables. All generated resources removed in finally.
import{spawnSync}from'node:child_process';import{randomBytes}from'node:crypto';import{fileURLToPath}from'node:url';
const suffix=randomBytes(6).toString('hex');const name='suco_limits_'+suffix;const password=randomBytes(24).toString('hex');
if(!/^suco_limits_[a-f0-9]{12}$/.test(name))throw Error('SYNTHETIC_NAME_REQUIRED');
function sql(input){const r=spawnSync('docker',['exec','-i','suco-pilot-postgres','psql','-U','suco_pilot_admin','-v','ON_ERROR_STOP=1','-d','postgres'],{input,encoding:'utf8',timeout:20000});if(r.status!==0)throw Error('SYNTHETIC_PG_ADMIN_FAILED');}
let role=false,db=false;
try{
 sql(`CREATE ROLE ${name} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`);role=true;
 sql(`ALTER ROLE ${name} SET default_transaction_isolation TO 'repeatable read';`);
 sql(`CREATE DATABASE ${name} OWNER ${name};`);db=true;sql(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC;`);
 const cwd=fileURLToPath(new URL('..',import.meta.url));const r=spawnSync(cwd+'/node_modules/.bin/tsx',['--test','tests/cloud-limits.test.ts'],{cwd,env:{...process.env,SUCO_LIMIT_TEST_DATABASE_URL:`postgres://${name}:${password}@127.0.0.1:5436/${name}`},encoding:'utf8',timeout:90000});process.stdout.write(r.stdout);process.stderr.write(r.stderr);if(r.status!==0)process.exitCode=1;
}catch{console.error('Synthetic PostgreSQL limits verification failed; no credentials printed.');process.exitCode=1;}
finally{
 if(db)try{sql(`DROP DATABASE ${name} WITH (FORCE);`);}catch{console.error('Own synthetic database cleanup required.');process.exitCode=1;}
 if(role)try{sql(`DROP ROLE ${name};`);}catch{console.error('Own synthetic role cleanup required.');process.exitCode=1;}
}
