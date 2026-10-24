import test from 'node:test';
import assert from 'node:assert/strict';
import { draftKey, freshDraft, freezeRequest, loadDraft, resetCorruptDraft, saveDraft } from '../src/lib/onboarding-state.ts';
const key=draftKey('https://api-synthetic.exemplo.com');
class Memory {map=new Map<string,string>();getItem(k:string){return this.map.get(k)??null;}setItem(k:string,v:string){this.map.set(k,v);}removeItem(k:string){this.map.delete(k);}}

test('explicit confirmed reset replaces only a corrupt local draft and never prepares a request',()=>{
  const storage=new Memory();storage.setItem(key,'{');storage.setItem('other','keep');
  const result=resetCorruptDraft(storage,key,true);
  assert(result.reset);assert.equal(result.problem,null);
  assert.deepEqual(result.draft,freshDraft());assert.equal(result.draft.request,null);
  assert.equal(storage.getItem('other'),'keep');assert.equal(loadDraft(storage,key).problem,null);
});
test('unconfirmed server state never discards a corrupt draft',()=>{
  const storage=new Memory();storage.setItem(key,'{');
  assert.equal(resetCorruptDraft(storage,key,false).reset,false);
  assert.equal(storage.getItem(key),'{');
});
test('a valid request from another tab is preserved even after a safe server response',()=>{
  const storage=new Memory();const request=freezeRequest('request-synthetic-123','synthetic@g.us','meeting','2026-10-01','2026-10-15');
  const draft={...freshDraft(),stage:'prepare' as const,goal:'meeting' as const,chatId:request.chat_jid,request,requestState:'uncertain' as const};
  saveDraft(storage,key,draft);const result=resetCorruptDraft(storage,key,true);
  assert.equal(result.reset,false);assert.deepEqual(result.draft,draft);assert.deepEqual(loadDraft(storage,key).draft,draft);
});
test('blocked storage is reported and never claims a durable reset',()=>{
  const storage={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');},removeItem(){}};
  const result=resetCorruptDraft(storage,key,true);assert.equal(result.reset,false);assert.equal(result.problem,'unavailable');
});
