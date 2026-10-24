import test from 'node:test';
import assert from 'node:assert/strict';
import { juiceTypes,juiceGroups,juicesInGroup,requestedJuice,generationRequest,JUICE_CATALOG_VERSION } from '../src/lib/juice-types.ts';

test('all seventeen themes stay discoverable, with RH/relationship/finance paths',()=>{
 assert.equal(juiceTypes.length,17);assert.equal(juicesInGroup('all').length,17);
 const visible=new Set(juiceGroups.flatMap(group=>juicesInGroup(group.id).map(type=>type.id)));
 assert.equal(visible.size,17);assert.equal(juicesInGroup('hr').length,4);assert.equal(juicesInGroup('relationship')[0].id,'relationship');assert.equal(juicesInGroup('accounting').length,5);
});
test('each theme builds a server-versioned request, optional focus and no browser prompt substitution',()=>{
 for(const type of juiceTypes){const full=generationRequest(type,'somente viagem');assert.equal(full.analysis_type,type.id);assert.equal(full.template_version,JUICE_CATALOG_VERSION);assert.equal(full.focus,'somente viagem');assert(!('base_prompt'in full));assert(!('focus'in generationRequest(type,'   ')));}
});
test('freeform is a real selectable type and empty custom input cannot silently become a general juice',()=>{
 const custom=requestedJuice('custom');assert(custom);assert.equal(generationRequest(custom,'a viagem').base_prompt,'a viagem');assert.throws(()=>generationRequest(custom,''));assert.throws(()=>generationRequest(requestedJuice('relationship')!,'x'.repeat(2001)));assert.equal(requestedJuice('unknown'),undefined);
});
