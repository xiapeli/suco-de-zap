import test from 'node:test';
import assert from 'node:assert/strict';
import {wallTimeInstants,wallTime,calendarPayloadFingerprint,calendarErrorCode} from '../src/lib/calendar.ts';
test('Shanghai and São Paulo wall times resolve to correct instants, independent of device timezone',()=>{
 assert.deepEqual(wallTimeInstants('2026-10-20T15:00','Asia/Shanghai'),['2026-10-20T07:00:00.000Z']);
 assert.deepEqual(wallTimeInstants('2026-10-20T15:00','America/Sao_Paulo'),['2026-10-20T18:00:00.000Z']);
 assert.equal(wallTime('2026-10-20T18:00:00.000Z','America/Sao_Paulo'),'2026-10-20T15:00');
});
test('DST missing and repeated wall times cannot silently choose an occurrence',()=>{
 assert.deepEqual(wallTimeInstants('2026-03-08T02:30','America/New_York'),[]);
 assert.deepEqual(wallTimeInstants('2026-11-01T01:30','America/New_York'),['2026-11-01T05:30:00.000Z','2026-11-01T06:30:00.000Z']);
 for(const value of ['2026-02-30T10:00','2026-10-20T24:00','invalid'])assert.deepEqual(wallTimeInstants(value,'UTC'),[]);
 assert.deepEqual(wallTimeInstants('2026-10-20T15:00','Not/AZone'),[]);
});
test('approval hash ignores recipient case/order but changes when event contents change',async()=>{
 const p={title:'  Reunião ',description:'',attendees:['ANA@example.test','beto@example.test'],start:'2026-10-20T18:00:00.000Z',end:'2026-10-20T18:30:00.000Z',timeZone:'America/Sao_Paulo'};
 assert.equal(await calendarPayloadFingerprint(p),await calendarPayloadFingerprint({...p,title:'Reunião',attendees:['beto@example.test','ana@example.test','ana@example.test']}));
 for(const change of [{title:'Outro assunto'},{description:'Texto compartilhado'},{end:'2026-10-20T19:00:00.000Z'},{attendees:['other@example.test']}])assert.notEqual(await calendarPayloadFingerprint(p),await calendarPayloadFingerprint({...p,...change}));
});
test('structured Convex errors remain actionable while network failures remain uncertain',()=>{
 assert.equal(calendarErrorCode({data:'INVALID_CALENDAR_ATTENDEE'}),'INVALID_CALENDAR_ATTENDEE');
 assert.equal(calendarErrorCode(new Error('Failed to fetch')),undefined);
});
