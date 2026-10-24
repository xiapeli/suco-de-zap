import test from'node:test';import assert from'node:assert/strict';
process.env.API_TOKEN='usage-legacy-test';process.env.DATABASE_URL='postgres://none:none@127.0.0.1:1/none';delete process.env.SUCO_GLM_REGULAR_KEY_FILE;for(const k of['SUCO_TENANT_ID','SUCO_ACCOUNT_ID','SUCO_WORKER_KEY','SUCO_CONTROL_PLANE_URL'])delete process.env[k];
const{app}=await import('../src/api.js');
test('legacy usage unavailable requires authentication and performs no database access',async()=>{assert.equal((await app.request('/api/usage')).status,401);const r=await app.request('/api/usage',{headers:{Authorization:'Bearer usage-legacy-test'}});assert.equal(r.status,200);assert.deepEqual(await r.json(),{available:false});});
