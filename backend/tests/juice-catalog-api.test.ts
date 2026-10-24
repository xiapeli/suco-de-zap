import test from 'node:test';
import assert from 'node:assert/strict';
process.env.API_TOKEN='synthetic-juice-catalog-test-token';
process.env.DATABASE_URL='postgres://synthetic:synthetic@127.0.0.1:1/synthetic';
const { app }=await import('../src/api.js');
const { generateSummary }=await import('../src/summarizer.js');
test('catalog is authenticated, no-store, all17 and contains no executable prompts', async()=>{
  assert.equal((await app.request('/api/juice-catalog')).status,401);
  const response=await app.request('/api/juice-catalog',{headers:{Authorization:'Bearer '+process.env.API_TOKEN}});
  assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
  const result=await response.json();assert.equal(result.version,'suco-17-v1');assert.equal(result.types.length,17);
  assert(!result.types.some((type:any)=>'prompt'in type));
});
test('invalid versioned generation fails before connecting to SQL or spending model/quota',async()=>{
  const args={chatJid:'synthetic@g.us',start:new Date('2026-10-01'),end:new Date('2026-10-02'),analysisType:'unknown',basePrompt:'ignored',templateVersion:'suco-17-v1'};
  await assert.rejects(generateSummary(args),(error:any)=>error.code==='UNKNOWN_JUICE_TEMPLATE'&&error.status===400);
  await assert.rejects(generateSummary({...args,analysisType:'custom',basePrompt:''}),(error:any)=>error.code==='CUSTOM_JUICE_REQUEST_REQUIRED');
});
