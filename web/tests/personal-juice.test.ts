import test from 'node:test';
import assert from 'node:assert/strict';
import {personalJuiceType,personalJuiceId,generationRequest} from '../src/lib/juice-types.ts';
import {manualIdentity,saveManualRequest,loadManualRequest,manualRequestKey} from '../src/lib/manual-juice-request.ts';
const id='10000000-0000-4000-8000-000000000001', revision='20000000-0000-4000-8000-000000000001';
const type=personalJuiceType({id,revision_id:revision,name:'Reuniões com clientes',instructions_preview:'Liste pedidos e fontes.'});
const request={request_id:'30000000-0000-4000-8000-000000000001',chat_jid:'fictional@g.us',start:'2026-10-01T00:00:00.000Z',end:'2026-10-02T00:00:00.000Z',...generationRequest(type,'projeto Aurora')};
function store(){const values=new Map<string,string>();return {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};}
test('a personal type generates only with the pinned revision; instructions remain server-side',()=>{
 assert.equal(personalJuiceId(type.id),id);assert.equal(personalJuiceId('personal:bad'),null);
 assert.deepEqual(generationRequest(type,'  projeto Aurora  '),{analysis_type:`personal:${id}`,template_version:'suco-17-v1',personal_revision:revision,focus:'projeto Aurora'});
 assert.throws(()=>generationRequest({...type,personalRevision:undefined},''));
 assert.throws(()=>generationRequest(type,'x'.repeat(2001)));
});
test('reload preserves a personal generation body and an edit cannot replace its original revision',()=>{
 const memory=store(),key=manualRequestKey('https://api-synthetic.exemplo.com');
 assert(saveManualRequest(memory,key,request));assert.deepEqual(loadManualRequest(memory,key).request,request);
 const changed={...request,personal_revision:'20000000-0000-4000-8000-000000000002'};
 assert.notEqual(manualIdentity(request),manualIdentity(changed));assert(!saveManualRequest(memory,key,changed));
 assert.deepEqual(loadManualRequest(memory,key).request,request);
});
test('personal drafts reject missing revisions, client prompts and revisions attached to built-ins',()=>{
 const memory=store(),key=manualRequestKey('https://api-synthetic.exemplo.com');
 const {personal_revision: omitted,...withoutRevision}=request;
 for(const invalid of [withoutRevision,{...request,personal_revision:'bad'},{...request,base_prompt:'client replacement'},{...request,analysis_type:'meeting'}]){
  assert(!saveManualRequest(memory,key,invalid));assert.equal(loadManualRequest(memory,key).request,null);
 }
});
