import test from 'node:test';
import assert from 'node:assert/strict';
import {draftKey,freshDraft,loadDraft,saveDraft,freezeRequest,period,expiredQr,summaryFailure,clearDrafts,DRAFT_PREFIX} from '../src/lib/onboarding-state.ts';
class Memory { map=new Map<string,string>();getItem(k:string){return this.map.get(k)??null;}setItem(k:string,v:string){this.map.set(k,v);}removeItem(k:string){this.map.delete(k);}get length(){return this.map.size;}key(i:number){return [...this.map.keys()][i]??null;} }
const key=draftKey('https://api-synthetic.exemplo.com');
const request=()=>freezeRequest('request-synthetic-123','synthetic@g.us','meeting','2026-10-01T00:00:00Z','2026-10-15T00:00:00Z');
test('draft scope is stable per API origin and excludes query credentials or fragments',()=>{
 assert.equal(key,draftKey('https://api-synthetic.exemplo.com/'));assert.notEqual(key,draftKey('https://api-other.exemplo.com'));
 for(const origin of ['https://x:secret@host.example','https://host.example?token=x','https://host.example#secret','https://host.example/path','javascript:secret'])assert.throws(()=>draftKey(origin));
});
test('first use has no stored request, permission or fabricated completion',()=>{const result=loadDraft(new Memory(),key);assert.deepEqual(result,{draft:freshDraft(),problem:null});assert.equal('consent'in result.draft,false);});
test('reload preserves exact immutable ID, period, goal and prompt without transcript or secrets',()=>{
 const memory=new Memory(),frozen=request();assert(Object.isFrozen(frozen));const draft={...freshDraft(),stage:'prepare' as const,goal:'meeting' as const,chatId:frozen.chat_jid,request:frozen,requestState:'uncertain' as const};
 assert(saveDraft(memory,key,draft));assert.deepEqual(loadDraft(memory,key).draft,draft);assert.equal(loadDraft(memory,key).draft.request?.request_id,frozen.request_id);assert.equal(loadDraft(memory,key).draft.request?.start,frozen.start);assert(!memory.getItem(key)!.includes('password'));
 assert.deepEqual(loadDraft(memory,draftKey('https://api-other.exemplo.com')).draft,freshDraft());
});
test('corrupt, oversized and unexpected data never silently becomes a valid resumed request',()=>{
 const memory=new Memory();for(const raw of ['{','x'.repeat(12001),JSON.stringify({...freshDraft(),accessToken:'DO_NOT_PERSIST'}),JSON.stringify({...freshDraft(),request:request(),stage:'prepare',chatId:'different@g.us',goal:'meeting',requestState:'pending'}),JSON.stringify({...freshDraft(),stage:'prepare',chatId:'synthetic@g.us',goal:'meeting',request:request(),requestState:null})]){memory.setItem(key,raw);assert.equal(loadDraft(memory,key).problem,'corrupt');}
});
test('blocked or lost storage never claims durable acceptance',()=>{
 const blocked={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');},removeItem(){}};assert.equal(loadDraft(blocked,key).problem,'unavailable');assert.equal(saveDraft(blocked,key,freshDraft()),false);
 const lost={getItem(){return null;},setItem(){},removeItem(){}};assert.equal(saveDraft(lost,key,freshDraft()),false);
});
test('period presets are bounded and all-history includes actual source bounds',()=>{
 const now=Date.parse('2026-10-15T00:00:00Z');assert.equal(period('7',now)?.start,'2026-10-08T00:00:00.000Z');assert.equal(period('30',now)?.start,'2026-09-15T00:00:00.000Z');
 assert.deepEqual(period('all',now,'2026-09-01T00:00:00Z','2026-10-01T00:00:00Z'),{start:'2026-08-31T23:59:59.000Z',end:'2026-10-01T00:00:01.000Z'});assert.equal(period('all',now,null,null),null);assert.equal(period('all',now,'bad','bad'),null);assert.equal(period('all',now,'2026-10-01','2026-09-01'),null);
});
test('only explicit terminal operation codes permit reviewing a fresh request',()=>{
 for(const code of [undefined,'BAD_GATEWAY','TRIAL_COMMIT_PENDING','TRIAL_PERSIST_PENDING','SUMMARY_REQUEST_PENDING','TRIAL_VERIFICATION_UNAVAILABLE','GLM_TIMEOUT'])assert.equal(summaryFailure(code),'uncertain');
 for(const code of ['SUMMARY_REQUEST_FAILED','SUMMARY_REQUEST_ALREADY_USED','INVALID_SUMMARY_REQUEST'])assert.equal(summaryFailure(code),'terminal');
});
test('expired QR is determined only from a real expiry timestamp',()=>{const now=10000;assert(expiredQr(new Date(now).toISOString(),now));assert(!expiredQr(new Date(now+1).toISOString(),now));assert(!expiredQr(null,now));assert(!expiredQr('invalid',now));});
test('logout removes all onboarding tenant drafts while preserving unrelated storage',()=>{const m=new Memory();m.setItem(key,'a');m.setItem(DRAFT_PREFIX+'other','b');m.setItem('unrelated','keep');clearDrafts(m);assert.equal(m.length,1);assert.equal(m.getItem('unrelated'),'keep');});
test('request cannot change intent, add fields or use an invalid date range on resume',()=>{
 assert.throws(()=>freezeRequest('short','x@g.us','general','2026-10-15','2026-10-01'));
 const m=new Memory();const frozen={...request(),extra:'untrusted'};m.setItem(key,JSON.stringify({...freshDraft(),stage:'prepare',goal:'meeting',chatId:'synthetic@g.us',request:frozen,requestState:'pending'}));assert.equal(loadDraft(m,key).problem,'corrupt');
});
