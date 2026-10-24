import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile}from'node:fs/promises';
import {EventEmitter}from'node:events';
import {basename,dirname,join,resolve}from'node:path';
import ts from 'typescript';
import {ConnectionTracker,FencedTimer,QR_TTL_MS}from'../src/lib/connection-state.js';
import {randomBytes,randomUUID,scryptSync,timingSafeEqual}from'node:crypto';
const source=await readFile(new URL('../src/wa.ts',import.meta.url),'utf8');
function deferred<T>(){let resolve!:(x:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve};}
async function harness(existingFs?:Map<string,any>){
 const linkedJid='5511999999999@s.whatsapp.net';
 const h:any={allowed:true,sockets:[],writes:[],committedMessages:[],deletions:0,authCalls:0,saveCalls:0,timers:[],fs:existingFs??new Map([['/synthetic-auth',{type:'directory',mode:0o700,linkedJid}]]),backups:[],authorize:async()=>h.allowed,save:null};
 h.auth=async(path:string)=>({state:{creds:{me:h.fs.get(path)?.linkedJid?{id:h.fs.get(path).linkedJid}:undefined},keys:{set:async()=>{h.keyCalls=(h.keyCalls||0)+1;await h.keySave?.();}}},saveCreds:async()=>{h.saveCalls++;await h.save?.();}});
 class Query{withLIDProtocol(){return this;}withContactProtocol(){return this;}withUser(){return this;}withId(){return this;}withLid(){return this;}}
 const bindings:any={
  ConnectionTracker,FencedTimer,QR_TTL_MS,
  makeWASocket:(options:any)=>{h.socketOptions=options;const s:any={ev:new EventEmitter(),end:()=>{s.ended=true;},logout:async()=>{},user:{id:linkedJid,name:'Synthetic'},groupFetchAllParticipating:async()=>({}),resyncAppState:async()=>{},executeUSyncQuery:async()=>({list:[]})};s.fire=async(name:string,value:any)=>{for(const fn of s.ev.listeners(name))await fn(value);};h.sockets.push(s);return s;},
  useMultiFileAuthState:async(path:string)=>{h.authCalls++;const value=await h.auth(resolve(path));h.state=value.state;return value;},
  fetchLatestBaileysVersion:async(options:any)=>{h.versionOptions=options;return{version:[1,1,1],isLatest:true};},
  Browsers:{ubuntu:()=>['Ubuntu','Desktop','1']},USyncQuery:Query,USyncUser:Query,SocksProxyAgent:class{},pino:()=>({}),
  jidNormalizedUser:(jid:string)=>{const match=/^([^:@_]+)(?:_\d+)?(?::\d+)?@([^@]+)$/.exec(jid||'');return match?`${match[1]}@${match[2]==='c.us'?'s.whatsapp.net':match[2]}`:'';},
  lstatSync:(path:string)=>{const entry=h.fs.get(path);if(!entry)throw Object.assign(new Error('missing'),{code:'ENOENT'});return{isSymbolicLink:()=>entry.type==='symlink',isDirectory:()=>entry.type==='directory',isFile:()=>entry.type==='file',mode:entry.mode,size:Buffer.byteLength(entry.data||'')};},
  readFileSync:(path:string)=>{const entry=h.fs.get(path);if(!entry||entry.type!=='file')throw Object.assign(new Error('missing'),{code:'ENOENT'});return entry.data;},
  writeFileSync:(path:string,data:string,options:any)=>{if(h.lockWriteFailure)throw Object.assign(new Error('write failed'),{code:'EIO'});if(options.flag==='wx'&&h.fs.has(path))throw Object.assign(new Error('exists'),{code:'EEXIST'});h.fs.set(path,{type:'file',mode:options.mode,data});},
  chmodSync:(path:string,mode:number)=>{if(h.chmodFailure)throw new Error('synthetic chmod failure');h.fs.get(path).mode=mode;},
  renameSync:(src:string,dest:string)=>{if(h.renameFailure)throw new Error('synthetic rename failure');const entry=h.fs.get(src);if(!entry)throw new Error('synthetic missing source');h.fs.delete(src);h.fs.set(dest,entry);if(dest!==bindings.config.authDir)h.backups.push(dest);},
  mkdirSync:(path:string,options:any)=>{if(h.mkdirFailure)throw new Error('synthetic mkdir failure');h.fs.set(path,{type:'directory',mode:options.mode});},
  rmSync:(path:string)=>{h.deletions++;h.fs.delete(path);},
  randomBytes,randomUUID,scryptSync,timingSafeEqual,basename,dirname,join,resolve,
  safeErrorCode:(error:any)=>typeof error?.code==='string'?error.code:'UNKNOWN',
  config:{authDir:'/synthetic-auth',waProxy:''},authorizeTenant:()=>h.authorize(),authorizeIngestion:async()=>await h.authorize()&&h.allowed,tenantAllowed:()=>h.allowed,pool:{query:async()=>({rows:[{n:5}]})}
 };
 h.config=bindings.config;
 for(const name of ['upsertChat','upsertContact','upsertLidMap','insertMessage'])bindings[name]=async(...args:any[])=>{h.writes.push({name,args});if(name==='upsertChat')await h.chatWrite?.();if(name==='insertMessage'){await h.messageWrite?.(args[0]);h.committedMessages.push(args[0].id);}};
 const key=randomUUID();(globalThis as any).__waRaceBindings??=new Map();(globalThis as any).__waRaceBindings.set(key,bindings);
 let js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
 js=js.replace(/^import[\s\S]*?from\s*['"][^'"]+['"];\s*$/gm,'');
 bindings.h=h;
 const pre=`const {${Object.keys(bindings).join(',')}}=globalThis.__waRaceBindings.get(${JSON.stringify(key)});const setTimeout=(fn,ms)=>{const timer={fn,ms,cancelled:false};h.timers.push(timer);return timer;};const clearTimeout=(timer)=>{timer.cancelled=true;};\n`;
 const wa=await import('data:text/javascript;base64,'+Buffer.from(pre+js).toString('base64'));(globalThis as any).__waRaceBindings.delete(key);return{h,wa};
}
const message={key:{remoteJid:'123@s.whatsapp.net',id:'synthetic-msg',fromMe:false},message:{conversation:'synthetic only'},messageTimestamp:1780000000,pushName:'Synthetic'};
function metadataMock(events:string[]=[]){return{
 load:async()=>{events.push('load');},
 putChat:async()=>{events.push('chat');},
 putContact:async()=>{events.push('contact');},
 putLidMap:async()=>{events.push('lid');},
 chatList:async()=>[],contactList:async()=>[],lidMapList:async()=>[],
 contactName:async()=>null,resolveLid:async()=>null,close:()=>{},
};}
test('connected socket stores a new group message through the live upsert path',{timeout:3000},async()=>{
 const{h,wa}=await harness();await wa.startWhatsApp();
 const socket=h.sockets[0];await socket.fire('connection.update',{connection:'open'});
 await socket.fire('messages.upsert',{messages:[{key:{remoteJid:'fictitious@g.us',participant:'sender@s.whatsapp.net',id:'synthetic-group-msg',fromMe:false},message:{conversation:'synthetic test only'},messageTimestamp:1780000000,pushName:'Synthetic'}]});
 assert.deepEqual(h.writes.map((write:any)=>write.name),['upsertChat','insertMessage','upsertContact']);
 assert.deepEqual(h.writes[0].args.slice(0,3),['fictitious@g.us',null,true]);
 assert.equal(h.writes[1].args[0].chat_jid,'fictitious@g.us');
 assert.equal(h.writes[1].args[0].id,'synthetic-group-msg');
 assert.equal(h.writes[1].args[0].msg_type,'text');
 assert.equal(h.writes[1].args[0].ts.getTime(),1780000000*1000);
 wa.pauseWhatsApp();
});
test('expired entitlement cache refreshes before deciding whether to ingest a live message',{timeout:3000},async()=>{
 const{h,wa}=await harness();await wa.startWhatsApp();
 const socket=h.sockets[0];await socket.fire('connection.update',{connection:'open'});
 h.allowed=false;let checks=0;
 h.authorize=async()=>{checks++;h.allowed=true;return true;};
 await socket.fire('messages.upsert',{messages:[message]});
 assert.ok(checks>0);
 assert.deepEqual(h.writes.map((write:any)=>write.name),['upsertChat','insertMessage','upsertContact']);
 wa.pauseWhatsApp();
});
test('renewed read entitlement without ingestion permission does not store a message',{timeout:3000},async()=>{
 const{h,wa}=await harness();await wa.startWhatsApp();
 h.allowed=false;h.authorize=async()=>true;
 await h.sockets[0].fire('messages.upsert',{messages:[message]});
 assert.equal(h.writes.length,0);
 wa.pauseWhatsApp();
});
test('pause during pending auth-state prevents late socket construction',{timeout:3000},async()=>{const{h,wa}=await harness();const gate=deferred<any>();h.auth=()=>gate.promise;const starting=wa.startWhatsApp();while(!h.authCalls)await new Promise(r=>setImmediate(r));wa.pauseWhatsApp();gate.resolve({state:{keys:{}},saveCreds:async()=>{}});await starting;assert.equal(h.sockets.length,0);assert.equal(wa.getStatus().connectionState,'disconnected');});
test('pause while message authorization pending fences every new DB write',{timeout:3000},async()=>{const{h,wa}=await harness();await wa.startWhatsApp();const socket=h.sockets[0];const gate=deferred<boolean>();h.authorize=()=>gate.promise;const incoming=socket.fire('messages.upsert',{messages:[message]});wa.pauseWhatsApp();gate.resolve(true);await incoming;assert.equal(h.writes.length,0);});
test('pause during first message write prevents message insert and contact followups',{timeout:3000},async()=>{const{h,wa}=await harness();await wa.startWhatsApp();const gate=deferred<void>();h.chatWrite=()=>gate.promise;const incoming=h.sockets[0].fire('messages.upsert',{messages:[message]});while(!h.writes.length)await new Promise(r=>setImmediate(r));wa.pauseWhatsApp();gate.resolve();await incoming;assert.deepEqual(h.writes.map((x:any)=>x.name),['upsertChat']);});
test('old401 cannot erase credentials or replace newer QR',{timeout:3000},async()=>{const{h,wa}=await harness();await wa.startWhatsApp();const old=h.sockets[0];const stale=old.ev.listeners('connection.update')[0];await wa.reconnectWhatsApp();const current=h.sockets[1];await current.fire('connection.update',{qr:'synthetic-secret-qr'});stale({connection:'close',lastDisconnect:{error:{output:{statusCode:401}}}});assert.equal(h.deletions,0);assert.equal(wa.getStatus().qr,'synthetic-secret-qr');wa.pauseWhatsApp();});
test('confirmed401 detaches socket and drains already started creds write before deletion',{timeout:3000},async()=>{const{h,wa}=await harness();await wa.startWhatsApp();const s=h.sockets[0],gate=deferred<void>();h.save=()=>gate.promise;await s.fire('creds.update',{});while(!h.saveCalls)await new Promise(r=>setImmediate(r));await s.fire('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:401}}}});assert.equal(h.deletions,0);await s.fire('creds.update',{});gate.resolve();while(!h.deletions)await new Promise(r=>setImmediate(r));assert.equal(h.saveCalls,1);assert.equal(wa.getStatus().reason,'logged_out');wa.pauseWhatsApp();});
test('entitlement revoked during chat batch stops later contact/group writes',{timeout:3000},async()=>{const{h,wa}=await harness();await wa.startWhatsApp();const gate=deferred<void>();h.chatWrite=()=>gate.promise;const incoming=h.sockets[0].fire('chats.upsert',[{id:'1@g.us'},{id:'2@g.us'}]);while(!h.writes.length)await new Promise(r=>setImmediate(r));h.allowed=false;gate.resolve();await incoming;assert.equal(h.writes.length,1);await h.sockets[0].fire('contacts.upsert',[{id:'3@s.whatsapp.net',name:'Synthetic'}]);assert.equal(h.writes.length,1);wa.pauseWhatsApp();});

test('confirmed401 drains Signal-key write and rejects later stale key persistence',{timeout:3000},async()=>{const{h,wa}=await harness();await wa.startWhatsApp();const s=h.sockets[0],gate=deferred<void>();h.keySave=()=>gate.promise;const writing=h.state.keys.set({synthetic:{}});while(!h.keyCalls)await new Promise(r=>setImmediate(r));await s.fire('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:401}}}});assert.equal(h.deletions,0);gate.resolve();await writing;while(!h.deletions)await new Promise(r=>setImmediate(r));await h.state.keys.set({late:{}});assert.equal(h.keyCalls,1);wa.pauseWhatsApp();});
test('explicit logout drains auth persistence and concurrent reconnect starts one fresh socket',{timeout:3000},async()=>{const{h,wa}=await harness();await wa.startWhatsApp();const gate=deferred<void>();h.save=()=>gate.promise;await h.sockets[0].fire('creds.update',{});while(!h.saveCalls)await new Promise(r=>setImmediate(r));const logout=wa.logoutWhatsApp();const first=wa.startWhatsApp(),second=wa.startWhatsApp();assert.equal(h.deletions,0);assert.equal(h.sockets.length,1);gate.resolve();await Promise.all([logout,first,second]);assert.equal(h.deletions,1);assert.equal(h.sockets.length,2);wa.pauseWhatsApp();});
test('group fetch completing after pause does not write stale group metadata',{timeout:3000},async()=>{const{h,wa}=await harness();await wa.startWhatsApp();const gate=deferred<any>();let fetching=false;h.sockets[0].groupFetchAllParticipating=()=>{fetching=true;return gate.promise;};const syncing=wa.syncGroupNames();while(!fetching)await new Promise(r=>setImmediate(r));wa.pauseWhatsApp();gate.resolve({'synthetic@g.us':{subject:'Synthetic'}});await syncing;assert.equal(h.writes.length,0);});
test('concurrent startup requests share a single pending attempt',{timeout:3000},async()=>{const{h,wa}=await harness();const gate=deferred<any>();h.auth=()=>gate.promise;const first=wa.startWhatsApp(),second=wa.startWhatsApp();while(!h.authCalls)await new Promise(r=>setImmediate(r));gate.resolve({state:{keys:{set:async()=>{}}},saveCreds:async()=>{}});await Promise.all([first,second]);assert.equal(h.authCalls,1);assert.equal(h.sockets.length,1);wa.pauseWhatsApp();});
test('graceful flush waits in-progress authentication writes after pause',{timeout:3000},async()=>{const{h,wa}=await harness();await wa.startWhatsApp();const gate=deferred<void>();h.save=()=>gate.promise;await h.sockets[0].fire('creds.update',{});while(!h.saveCalls)await new Promise(r=>setImmediate(r));wa.pauseWhatsApp();let done=false;const flushing=wa.flushWhatsAppState().then(()=>{done=true;});await new Promise(r=>setImmediate(r));assert.equal(done,false);gate.resolve();await flushing;assert.equal(done,true);assert.equal(h.deletions,0);});

test('silent socket times out, retains credentials and schedules one retry',{timeout:3000},async()=>{
 const{h,wa}=await harness();await wa.startWhatsApp();
 assert.equal(h.versionOptions.timeout,10_000);
 assert.equal(h.socketOptions.qrTimeout,QR_TTL_MS);
 const watchdog=h.timers.find((timer:any)=>timer.ms===45_000);
 assert.ok(watchdog);
 watchdog.fn();
 assert.equal(h.sockets[0].ended,true);
 assert.equal(wa.getStatus().connectionState,'reconnecting');
 assert.equal(wa.getStatus().reason,'timed_out');
 assert.equal(h.deletions,0);
 assert.equal(h.timers.filter((timer:any)=>!timer.cancelled&&timer.ms===3_000).length,1);
 wa.pauseWhatsApp();
});

test('QR progress renews watchdog; open cancels it and pause fences old callbacks',{timeout:3000},async()=>{
 const{h,wa}=await harness();await wa.startWhatsApp();
 const first=h.timers.find((timer:any)=>timer.ms===45_000);
 await h.sockets[0].fire('connection.update',{qr:'synthetic-qr-one'});
 assert.equal(first.cancelled,true);
 const qrTimer=h.timers.find((timer:any)=>timer.ms===QR_TTL_MS+10_000);
 assert.ok(qrTimer);
 assert.equal(wa.getStatus().connectionState,'qr_required');
 await h.sockets[0].fire('connection.update',{connection:'open'});
 assert.equal(qrTimer.cancelled,true);
 assert.equal(wa.getStatus().connected,true);
 first.fn();qrTimer.fn();
 assert.equal(h.sockets[0].ended,undefined);
 assert.equal(h.deletions,0);
 wa.pauseWhatsApp();
});

test('new pairing fences the old socket and backs up auth after pending credential writes',{timeout:3000},async()=>{
 const {h,wa}=await harness();
 await wa.startWhatsApp();
 const old=h.sockets[0];
 const gate=deferred<void>();
 h.save=()=>gate.promise;
 await old.fire('creds.update',{});
 while(!h.saveCalls)await new Promise(r=>setImmediate(r));
 const pairing=wa.beginFreshPairing();
 const keeperStart=wa.startWhatsApp();
 await new Promise(r=>setImmediate(r));
 assert.equal(old.ended,true);
 assert.equal(h.backups.length,0);
 assert.equal(h.sockets.length,1);
 gate.resolve();
 await Promise.all([pairing,keeperStart]);
 assert.equal(h.backups.length,1);
 assert.equal(h.fs.get(h.backups[0]).mode,0o700);
 assert.equal(h.fs.get('/synthetic-auth').mode,0o700);
 assert.equal(h.deletions,0);
 assert.equal(h.sockets.length,2);
 await h.sockets[1].fire('connection.update',{qr:'synthetic-new-qr'});
 assert.equal(wa.getStatus().connectionState,'qr_required');
 wa.pauseWhatsApp();
});

test('concurrent new pairing requests share one rotation and one new socket',{timeout:3000},async()=>{
 const {h,wa}=await harness();
 await wa.startWhatsApp();
 const first=wa.beginFreshPairing();
 const second=wa.beginFreshPairing();
 assert.equal(first,second);
 await Promise.all([first,second]);
 assert.equal(h.backups.length,1);
 assert.equal(h.sockets.length,2);
 wa.pauseWhatsApp();
});

test('new pairing fences an in-progress startup before moving auth',{timeout:3000},async()=>{
 const {h,wa}=await harness();
 const oldAuth=deferred<any>();
 h.auth=()=>oldAuth.promise;
 const oldStart=wa.startWhatsApp();
 while(!h.authCalls)await new Promise(r=>setImmediate(r));
 const pairing=wa.beginFreshPairing();
 h.auth=async(path:string)=>({state:{creds:{me:h.fs.get(path)?.linkedJid?{id:h.fs.get(path).linkedJid}:undefined},keys:{set:async()=>{}}},saveCreds:async()=>{}});
 oldAuth.resolve({state:{keys:{set:async()=>{}}},saveCreds:async()=>{}});
 await Promise.all([oldStart,pairing]);
 assert.equal(h.authCalls,3);
 assert.equal(h.backups.length,1);
 assert.equal(h.sockets.length,1);
 wa.pauseWhatsApp();
});

test('new pairing rejects unsafe auth paths without moving or deleting them',{timeout:3000},async()=>{
 const {h,wa}=await harness();
 await wa.startWhatsApp();
 h.fs.set('/synthetic-auth',{type:'symlink',mode:0o700});
 h.config.authDir='/synthetic-auth/';
 await assert.rejects(wa.beginFreshPairing(),{code:'PAIRING_BACKUP_UNSAFE',message:'PAIRING_BACKUP_UNSAFE'});
 assert.equal(h.backups.length,0);
 assert.equal(h.deletions,0);
 assert.equal(h.sockets.length,1);
 assert.equal(h.fs.get('/synthetic-auth').type,'symlink');
});

test('new pairing refuses filesystem root as auth directory',{timeout:3000},async()=>{
 const {h,wa}=await harness();
 h.config.authDir='/';
 await assert.rejects(wa.beginFreshPairing(),{code:'PAIRING_BACKUP_UNSAFE'});
 assert.equal(h.backups.length,0);
 assert.equal(h.deletions,0);
});

test('new pairing starts from missing auth after a confirmed logout without inventing a backup',{timeout:3000},async()=>{
 const {h,wa}=await harness();
 await wa.startWhatsApp();
 assert.ok(h.fs.has('/synthetic-auth.identity-lock.json'));
 h.fs.delete('/synthetic-auth');
 await wa.beginFreshPairing();
 assert.equal(h.backups.length,0);
 assert.equal(h.fs.get('/synthetic-auth').mode,0o700);
 assert.equal(h.sockets.length,2);
 wa.pauseWhatsApp();
});

test('new pairing restores prior auth if fresh directory creation fails',{timeout:3000},async()=>{
 const {h,wa}=await harness();
 await wa.startWhatsApp();
 h.mkdirFailure=true;
 await assert.rejects(wa.beginFreshPairing(),{code:'PAIRING_BACKUP_FAILED',message:'PAIRING_BACKUP_FAILED'});
 assert.equal(h.backups.length,1);
 assert.equal(h.fs.get('/synthetic-auth').type,'directory');
 assert.equal(h.fs.has(h.backups[0]),false);
 assert.equal(h.sockets.length,1);
});

test('new pairing does not touch prior auth when backup rename fails',{timeout:3000},async()=>{
 const {h,wa}=await harness();
 await wa.startWhatsApp();
 h.renameFailure=true;
 await assert.rejects(wa.beginFreshPairing(),{code:'PAIRING_BACKUP_FAILED',message:'PAIRING_BACKUP_FAILED'});
 assert.equal(h.fs.get('/synthetic-auth').type,'directory');
 assert.equal(h.deletions,0);
 assert.equal(h.sockets.length,1);
});

test('fresh QR accepts the previously linked WhatsApp with a different device suffix',{timeout:3000},async()=>{
 const {h,wa}=await harness();
 await wa.startWhatsApp();
 await wa.beginFreshPairing();
 const next=h.sockets[1];
 await next.fire('connection.update',{qr:'synthetic-qr'});
 await next.fire('messaging-history.set',{chats:[{id:'synthetic@g.us'}],contacts:[],messages:[],isLatest:true});
 assert.equal(h.writes.length,0,'history stays fenced until identity is verified');
 next.user.id='5511999999999:42@s.whatsapp.net';
 await next.fire('connection.update',{connection:'open'});
 await next.fire('messages.upsert',{messages:[message]});
 assert.equal(wa.getStatus().connected,true);
 assert.equal(wa.getStatus().pairingError,null);
 assert.deepEqual(h.writes.map((write:any)=>write.name),['upsertChat','insertMessage','upsertContact']);
 assert.equal(h.backups.length,1);
 wa.pauseWhatsApp();
});

test('different WhatsApp at QR open is rejected before ingesting and leaves prior backup intact',{timeout:3000},async()=>{
 const {h,wa}=await harness();
 await wa.startWhatsApp();
 await wa.beginFreshPairing();
 const next=h.sockets[1];
 next.user.id='5511888888888@s.whatsapp.net';
 await next.fire('connection.update',{connection:'open'});
 await next.fire('messages.upsert',{messages:[message]});
 assert.equal(next.ended,true);
 assert.equal(h.writes.length,0);
 assert.equal(h.deletions,0);
 assert.equal(h.fs.get(h.backups[0]).linkedJid,'5511999999999@s.whatsapp.net');
 const status=wa.getStatus();
 assert.equal(status.connectionState,'action_required');
 assert.equal(status.pairingError,'PAIRING_ACCOUNT_MISMATCH');
 assert.equal(status.qr,null);
 assert.equal(status.me,null);
 assert.equal(JSON.stringify(status).includes('5511888888888'),false);
 await wa.reconnectWhatsApp();
 assert.equal(h.sockets.length,2,'ordinary reconnect cannot bypass the mismatch');
 await wa.beginFreshPairing();
 assert.equal(h.sockets.length,3,'explicit retry can issue a fresh QR against the same identity lock');
 await h.sockets[2].fire('connection.update',{connection:'open'});
 assert.equal(wa.getStatus().pairingError,null);
 assert.equal(wa.getStatus().connected,true);
 wa.pauseWhatsApp();
});

test('different WhatsApp in creds.update is refused before saving its credentials',{timeout:3000},async()=>{
 const {h,wa}=await harness();
 await wa.startWhatsApp();
 await wa.beginFreshPairing();
 const savedBefore=h.saveCalls;
 h.state.creds.me={id:'5511888888888@s.whatsapp.net'};
 await h.sockets[1].fire('creds.update',{});
 await wa.flushWhatsAppState();
 assert.equal(h.saveCalls,savedBefore);
 assert.equal(wa.getStatus().pairingError,'PAIRING_ACCOUNT_MISMATCH');
 assert.equal(h.backups.length,1);
 assert.equal(h.deletions,0);
});

test('missing prior WhatsApp identity fails closed before rotating auth or showing QR',{timeout:3000},async()=>{
 const {h,wa}=await harness();
 h.fs.get('/synthetic-auth').linkedJid=undefined;
 await assert.rejects(wa.beginFreshPairing(),{code:'PAIRING_IDENTITY_UNAVAILABLE',message:'PAIRING_IDENTITY_UNAVAILABLE'});
 assert.equal(wa.getStatus().pairingError,'PAIRING_IDENTITY_UNAVAILABLE');
 assert.equal(wa.getStatus().qr,null);
 assert.equal(h.backups.length,0);
 assert.equal(h.deletions,0);
 assert.equal(h.sockets.length,0);
});

test('identity lock survives process restart and blocks a mismatched active auth',{timeout:3000},async()=>{
 const first=await harness();
 await first.wa.startWhatsApp();
 await first.wa.beginFreshPairing();
 first.wa.pauseWhatsApp();
 const lock=first.h.fs.get('/synthetic-auth.identity-lock.json');
 assert.equal(lock.mode,0o600);
 assert.equal(lock.data.includes('5511999999999'),false,'the identity file contains no raw WhatsApp number');
 first.h.fs.get('/synthetic-auth').linkedJid='5511888888888@s.whatsapp.net';
 const resumed=await harness(first.h.fs);
 await resumed.wa.startWhatsApp();
 assert.equal(resumed.h.sockets.length,0);
 assert.equal(resumed.wa.getStatus().pairingError,'PAIRING_ACCOUNT_MISMATCH');
 assert.equal(resumed.h.fs.has(first.h.backups[0]),true);
});

test('history sync continues after one failed message and retries that message without false chat freshness',{timeout:3000},async()=>{
 const {h,wa}=await harness();await wa.startWhatsApp();
 const socket=h.sockets[0];await socket.fire('connection.update',{connection:'open'});
 let recovering=false;
 h.messageWrite=async(row:any)=>{if(row.id==='history-first'&&!recovering)throw Object.assign(new Error('synthetic outage'),{code:'ECONNRESET'});};
 const first={...message,key:{...message.key,id:'history-first'}};
 const second={...message,key:{...message.key,id:'history-second'}};
 await socket.fire('messaging-history.set',{chats:[{id:'123@s.whatsapp.net',conversationTimestamp:1780000010}],contacts:[],messages:[first,second],isLatest:true});
 assert.deepEqual(h.committedMessages,['history-second'],'a failed row does not stop the rest of the batch');
 assert.equal(wa.getPendingIngestionCount(),1);
 assert.ok(h.writes.filter((write:any)=>write.name==='upsertChat').every((write:any)=>write.args.length===3),'chat metadata never claims unsaved message freshness');
 recovering=true;
 const retry=h.timers.filter((timer:any)=>!timer.cancelled&&timer.ms===5_000).at(-1);
 assert.ok(retry,'failed message is held for retry');retry.fn();
 for(let i=0;i<20&&!h.committedMessages.includes('history-first');i++)await new Promise(r=>setImmediate(r));
 assert.deepEqual(h.committedMessages,['history-second','history-first']);
 assert.equal(wa.getPendingIngestionCount(),0);
 wa.pauseWhatsApp();
});

test('live upsert keeps a failed message while later messages continue',{timeout:3000},async()=>{
 const {h,wa}=await harness();await wa.startWhatsApp();
 const socket=h.sockets[0];await socket.fire('connection.update',{connection:'open'});
 let recovering=false;
 h.messageWrite=async(row:any)=>{if(row.id==='live-first'&&!recovering)throw Object.assign(new Error('synthetic outage'),{code:'ECONNRESET'});};
 await socket.fire('messages.upsert',{messages:[
   {...message,key:{...message.key,id:'live-first'}},
   {...message,key:{...message.key,id:'live-second'}},
 ]});
 assert.deepEqual(h.committedMessages,['live-second']);
 assert.equal(wa.getPendingIngestionCount(),1);
 recovering=true;
 const retry=h.timers.filter((timer:any)=>!timer.cancelled&&timer.ms===0).at(-1);
 assert.ok(retry);retry.fn();
 for(let i=0;i<20&&!h.committedMessages.includes('live-first');i++)await new Promise(r=>setImmediate(r));
 assert.deepEqual(h.committedMessages,['live-second','live-first']);
 assert.equal(wa.getPendingIngestionCount(),0);
 wa.pauseWhatsApp();
});

test('a live retry arriving during history backlog runs before the next history retry',{timeout:3000},async()=>{
 const {h,wa}=await harness();await wa.startWhatsApp();
 const socket=h.sockets[0];await socket.fire('connection.update',{connection:'open'});
 const gate=deferred<void>();
 const attempts:string[]=[];
 let recovering=false,liveAttempts=0,historyRetryStarted=false;
 h.messageWrite=async(row:any)=>{
   attempts.push(row.id);
   if(!recovering&&row.id.startsWith('history-'))throw Object.assign(new Error('synthetic outage'),{code:'ECONNRESET'});
   if(recovering&&row.id==='history-0'&&!historyRetryStarted){historyRetryStarted=true;await gate.promise;}
   if(row.id==='live-new'&&++liveAttempts===1)throw Object.assign(new Error('synthetic outage'),{code:'ECONNRESET'});
 };
 await socket.fire('messaging-history.set',{chats:[],contacts:[],messages:[0,1,2].map(i=>({...message,key:{...message.key,id:`history-${i}`}})),isLatest:true});
 assert.equal(wa.getPendingIngestionCount(),3);
 recovering=true;
 const retry=h.timers.filter((timer:any)=>!timer.cancelled&&timer.ms===5_000).at(-1);
 assert.ok(retry);retry.fn();
 for(let i=0;i<50&&!historyRetryStarted;i++)await new Promise(r=>setImmediate(r));
 assert.equal(historyRetryStarted,true);
 await socket.fire('messages.upsert',{messages:[{...message,key:{...message.key,id:'live-new'}}]});
 assert.equal(wa.getPendingIngestionCount(),4);
 gate.resolve();
 for(let i=0;i<100&&wa.getPendingIngestionCount();i++)await new Promise(r=>setImmediate(r));
 assert.equal(wa.getPendingIngestionCount(),0);
 assert.ok(attempts.lastIndexOf('live-new')<attempts.lastIndexOf('history-1'),
   'live retry is selected next even though older history remains queued');
 wa.pauseWhatsApp();
});

test('confidential spool replays before socket start, then stages before insert and acks after commit',{timeout:3000},async()=>{
 const {h,wa}=await harness();
 const order:string[]=[];
 h.chatWrite=async()=>{order.push('chat');};
 h.messageWrite=async()=>{order.push('insert');};
 const gate=deferred<void>();
 const spool={
   async *pending(){await gate.promise;yield {chat_jid:'123@s.whatsapp.net',id:'sealed-pending',sender_jid:null,sender_name:null,from_me:false,body:'synthetic only',msg_type:'text',ts:new Date(1780000000000)};},
   async stage(){order.push('stage');},
   async ack(){order.push('ack');},
   close(){},
 };
 const installing=wa.installIngestionSpool(spool);
 assert.equal(wa.hasDurableIngestionSpool(),false);
 await assert.rejects(wa.startWhatsApp(),{message:'INGESTION_SPOOL_NOT_READY'});
 gate.resolve();await installing;
 assert.equal(wa.hasDurableIngestionSpool(),true);
 assert.deepEqual(order,['chat','insert','ack']);
 order.length=0;
 await wa.startWhatsApp();
 await h.sockets[0].fire('connection.update',{connection:'open'});
 await h.sockets[0].fire('messages.upsert',{messages:[message]});
 assert.deepEqual(order,['stage','chat','insert','ack']);
 await assert.rejects(wa.installIngestionSpool(spool),{message:'INGESTION_SPOOL_INSTALL_ORDER'});
 wa.pauseWhatsApp();
});

test('spool stage failure cannot reach database and retains event for retry',{timeout:3000},async()=>{
 const {h,wa}=await harness();
 let failStage=true,acks=0;
 const spool={async *pending(){},async stage(){if(failStage)throw Object.assign(new Error('sealed write failed'),{code:'EIO'});},async ack(){acks++;},close(){}};
 await wa.installIngestionSpool(spool);
 await wa.startWhatsApp();
 await h.sockets[0].fire('connection.update',{connection:'open'});
 await h.sockets[0].fire('messages.upsert',{messages:[message]});
 assert.equal(h.writes.length,0);
 assert.equal(acks,0);
 assert.equal(wa.getPendingIngestionCount(),1);
 failStage=false;
 const retry=h.timers.filter((timer:any)=>!timer.cancelled&&timer.ms===0).at(-1);
 assert.ok(retry);retry.fn();
 for(let i=0;i<20&&acks===0;i++)await new Promise(r=>setImmediate(r));
 assert.equal(acks,1);
 assert.equal(wa.getPendingIngestionCount(),0);
 wa.pauseWhatsApp();
});

test('injected confidential auth rotates encrypted state without touching legacy auth files',{timeout:3000},async()=>{
 const {h,wa}=await harness();
 let loads=0,rotations=0,clears=0;
 const adapter={
  load:async()=>{loads++;return h.auth('/synthetic-auth');},
  hasIdentity:()=>true,hasImportedLegacyIdentity:()=>true,
  identityMatches:(jid:string)=>jid==='5511999999999@s.whatsapp.net',
  assertOrEstablishIdentity:async(jid:string)=>{if(jid!=='5511999999999@s.whatsapp.net')throw Object.assign(new Error('mismatch'),{code:'PAIRING_ACCOUNT_MISMATCH'});},
  beginFreshPairing:async()=>{rotations++;},
  clearCurrent:async()=>{clears++;},close:()=>{},
 };
 h.config.confidentialRuntime=true;
 wa.installConfidentialAuth(adapter,async()=>h.allowed,'existing-bound');
 await wa.installConfidentialMessageStore({replay:async()=>0,stage:async()=>{},commit:async()=>{},close:()=>{}});
 await wa.installConfidentialMetadataStore(metadataMock());
 await assert.rejects(async()=>wa.installConfidentialAuth(adapter,async()=>h.allowed,'existing-bound'),{message:'CONFIDENTIAL_AUTH_INSTALL_UNSAFE'});
 await wa.startWhatsApp();
 assert.equal(h.authCalls,0);
 assert.equal(loads,1);
 await wa.beginFreshPairing();
 assert.equal(rotations,1);
 assert.equal(h.authCalls,0);
 assert.equal(h.backups.length,0);
 assert.equal(h.deletions,0);
 assert.equal(h.sockets.length,2);
 assert.equal(clears,0);
 wa.pauseWhatsApp();
});

test('confidential auth refuses wrong WhatsApp at QR open before ingestion',{timeout:3000},async()=>{
 const {h,wa}=await harness();
 const adapter={
  load:async()=>h.auth('/synthetic-auth'),hasIdentity:()=>true,hasImportedLegacyIdentity:()=>true,
  identityMatches:(jid:string)=>jid==='5511999999999@s.whatsapp.net',
  assertOrEstablishIdentity:async(jid:string)=>{if(jid!=='5511999999999@s.whatsapp.net')throw Object.assign(new Error('mismatch'),{code:'PAIRING_ACCOUNT_MISMATCH'});},
  beginFreshPairing:async()=>{},clearCurrent:async()=>{},close:()=>{},
 };
 h.config.confidentialRuntime=true;
 wa.installConfidentialAuth(adapter,async()=>h.allowed,'existing-bound');
 await wa.installConfidentialMessageStore({replay:async()=>0,stage:async()=>{},commit:async()=>{},close:()=>{}});
 await wa.installConfidentialMetadataStore(metadataMock());
 await wa.startWhatsApp();
 h.sockets[0].user.id='5511888888888@s.whatsapp.net';
 await h.sockets[0].fire('connection.update',{connection:'open'});
 assert.equal(wa.getStatus().pairingError,'PAIRING_ACCOUNT_MISMATCH');
 await h.sockets[0].fire('messages.upsert',{messages:[message]});
 assert.equal(h.writes.length,0);
 assert.equal(h.deletions,0);
});

test('confidential credential write failure closes socket instead of showing connected',{timeout:3000},async()=>{
 const {h,wa}=await harness();
 h.save=async()=>{throw Object.assign(new Error('remote ciphertext write failed'),{code:'EIO'});};
 const adapter={
  load:async()=>h.auth('/synthetic-auth'),hasIdentity:()=>true,hasImportedLegacyIdentity:()=>true,
  identityMatches:(jid:string)=>jid==='5511999999999@s.whatsapp.net',
  assertOrEstablishIdentity:async()=>{},beginFreshPairing:async()=>{},clearCurrent:async()=>{},close:()=>{},
 };
 h.config.confidentialRuntime=true;
 wa.installConfidentialAuth(adapter,async()=>h.allowed,'existing-bound');
 await wa.installConfidentialMessageStore({replay:async()=>0,stage:async()=>{},commit:async()=>{},close:()=>{}});
 await wa.installConfidentialMetadataStore(metadataMock());
 await wa.startWhatsApp();
 await h.sockets[0].fire('connection.update',{connection:'open'});
 await h.sockets[0].fire('creds.update',{});
 await wa.flushWhatsAppState();
 assert.equal(wa.getStatus().connected,false);
 assert.equal(h.sockets[0].ended,true);
 assert.equal(h.deletions,0);
});

test('confidential message path replays before socket and never writes legacy chat/contact/message tables',{timeout:3000},async()=>{
 const {h,wa}=await harness();
 const steps:string[]=[];
 const adapter={
  load:async()=>h.auth('/synthetic-auth'),hasIdentity:()=>true,hasImportedLegacyIdentity:()=>true,
  identityMatches:(jid:string)=>jid==='5511999999999@s.whatsapp.net',
  assertOrEstablishIdentity:async()=>{},beginFreshPairing:async()=>{},clearCurrent:async()=>{},close:()=>{},
 };
 h.config.confidentialRuntime=true;
 wa.installConfidentialAuth(adapter,async()=>h.allowed,'existing-bound');
 const metaEvents:string[]=[];
 await wa.installConfidentialMetadataStore(metadataMock(metaEvents));
 await wa.installConfidentialMessageStore({
  replay:async()=>{steps.push('replay');return 0;},
  stage:async()=>{steps.push('stage');},commit:async()=>{steps.push('commit');},close:()=>{},
 });
 assert.equal(wa.hasDurableIngestionSpool(),false,'pre-stage failures are still only in process memory');
 await wa.startWhatsApp();
 assert.equal(steps[0],'replay');
 const s=h.sockets[0];
 await s.fire('messages.upsert',{messages:[message]});
 assert.equal(wa.getPendingIngestionCount(),1,'pre-open event held until account identity confirms');
 assert.equal(steps.length,1);
 await s.fire('connection.update',{connection:'open'});
 const retry=h.timers.filter((timer:any)=>!timer.cancelled&&timer.ms===0).at(-1);
 assert.ok(retry);retry.fn();
 for(let i=0;i<20&&steps.length<3;i++)await new Promise(r=>setImmediate(r));
 assert.deepEqual(steps,['replay','stage','commit']);
 await s.fire('chats.upsert',[{id:'synthetic@g.us',name:'Synthetic'}]);
 await s.fire('contacts.upsert',[{id:'1@s.whatsapp.net',name:'Synthetic'}]);
 await s.fire('groups.upsert',[{id:'synthetic@g.us',subject:'Synthetic'}]);
 await wa.syncContacts();
 await wa.syncGroupNames();
 assert.equal(h.writes.length,0);
 assert.ok(metaEvents.includes('chat'));
 assert.ok(metaEvents.includes('contact'));
 wa.pauseWhatsApp();
});

test('confidential history commits a bounded batch concurrently and finishes every message',{timeout:3000},async()=>{
 const {h,wa}=await harness();
 h.config.confidentialRuntime=true;
 const adapter={load:async()=>h.auth('/synthetic-auth'),hasIdentity:()=>true,hasImportedLegacyIdentity:()=>true,
  identityMatches:()=>true,assertOrEstablishIdentity:async()=>{},
  beginFreshPairing:async()=>{},clearCurrent:async()=>{},close:()=>{}};
 wa.installConfidentialAuth(adapter,async()=>h.allowed,'existing-bound');
 await wa.installConfidentialMetadataStore(metadataMock());
 const gate=deferred<void>();
 let inFlight=0,maxInFlight=0,committed=0;
 await wa.installConfidentialMessageStore({
  replay:async()=>0,stage:async()=>{},
  commit:async()=>{inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);await gate.promise;committed++;inFlight--;},
  close:()=>{},
 });
 await wa.startWhatsApp();
 const socket=h.sockets[0];
 await socket.fire('connection.update',{connection:'open'});
 const messages=Array.from({length:12},(_,i)=>({...message,key:{...message.key,id:`history-${i}`}}));
 const ingest=socket.fire('messaging-history.set',{chats:[],contacts:[],messages,isLatest:true});
 for(let i=0;i<100&&inFlight<6;i++)await new Promise(r=>setImmediate(r));
 assert.equal(inFlight,6);
 assert.equal(maxInFlight,6);
 gate.resolve();
 await ingest;
 assert.equal(committed,12);
 assert.equal(maxInFlight,6);
 wa.pauseWhatsApp();
});

test('confidential runtime needs an explicit grant and rejects legacy spool before any replay',{timeout:3000},async()=>{
 const {h,wa}=await harness();
 const adapter={load:async()=>h.auth('/synthetic-auth'),hasIdentity:()=>true,hasImportedLegacyIdentity:()=>true,
  identityMatches:()=>true,assertOrEstablishIdentity:async()=>{},
  beginFreshPairing:async()=>{},clearCurrent:async()=>{},close:()=>{}};
 h.config.confidentialRuntime=true;
 assert.throws(()=>wa.installConfidentialAuth(adapter),{message:'CONFIDENTIAL_AUTH_INSTALL_UNSAFE'});
 wa.installConfidentialAuth(adapter,async()=>false,'existing-bound');
 let replayed=false;
 await assert.rejects(wa.installConfidentialMessageStore({
  replay:async()=>{replayed=true;return 0;},stage:async()=>{},commit:async()=>{},close:()=>{},
 }),{message:'CONFIDENTIAL_MESSAGES_NOT_AUTHORIZED'});
 assert.equal(replayed,false);
 await assert.rejects(wa.installIngestionSpool({async *pending(){replayed=true;},stage:async()=>{},ack:async()=>{},close:()=>{}}),
  {message:'INGESTION_SPOOL_INSTALL_ORDER'});
 assert.equal(replayed,false);
 await assert.rejects(wa.startWhatsApp(),{message:'CONFIDENTIAL_STORES_NOT_READY'});
 assert.equal(h.sockets.length,0);
 assert.equal(h.writes.length,0);
});

test('confidential replay checks the injected grant and retains no legacy database writes',{timeout:3000},async()=>{
 const {h,wa}=await harness();
 let checks=0, replayed=false;
 const adapter={load:async()=>h.auth('/synthetic-auth'),hasIdentity:()=>true,hasImportedLegacyIdentity:()=>true,
  identityMatches:()=>true,assertOrEstablishIdentity:async()=>{},
  beginFreshPairing:async()=>{},clearCurrent:async()=>{},close:()=>{}};
 h.config.confidentialRuntime=true;
 wa.installConfidentialAuth(adapter,async()=>{checks++;return checks<2;},'existing-bound');
 await assert.rejects(wa.installConfidentialMessageStore({
  replay:async(beforeEach:()=>Promise<boolean>)=>{
    replayed=true;
    if(!await beforeEach())throw Object.assign(new Error('grant revoked'),{code:'INGESTION_SPOOL_AUTH'});
    return 0;
  },stage:async()=>{},commit:async()=>{},close:()=>{},
 }),{code:'INGESTION_SPOOL_AUTH'});
 assert.equal(replayed,true);
 assert.equal(h.writes.length,0);
 assert.equal(h.sockets.length,0);
});

test('existing owner cannot install a confidential QR socket before pinned identity import',{timeout:3000},async()=>{
 const {h,wa}=await harness();
 h.config.confidentialRuntime=true;
 const adapter={load:async()=>h.auth('/synthetic-auth'),hasIdentity:()=>false,hasImportedLegacyIdentity:()=>false,
  identityMatches:()=>false,assertOrEstablishIdentity:async()=>{},
  beginFreshPairing:async()=>{},clearCurrent:async()=>{},close:()=>{}};
 assert.throws(()=>wa.installConfidentialAuth(adapter,async()=>true,'existing-bound'),
  {code:'PAIRING_IDENTITY_UNAVAILABLE'});
 assert.equal(wa.confidentialModeEnabled(),false);
 assert.equal(h.sockets.length,0);
});

test('an unpinned first pairing cannot pose as the existing owner identity',{timeout:3000},async()=>{
 const {h,wa}=await harness();
 h.config.confidentialRuntime=true;
 const adapter={load:async()=>h.auth('/synthetic-auth'),hasIdentity:()=>true,
  hasImportedLegacyIdentity:()=>false,identityMatches:()=>true,
  assertOrEstablishIdentity:async()=>{},beginFreshPairing:async()=>{},clearCurrent:async()=>{},close:()=>{}};
 assert.throws(()=>wa.installConfidentialAuth(adapter,async()=>true,'existing-bound'),
  {code:'PAIRING_IDENTITY_UNAVAILABLE'});
 assert.equal(wa.confidentialModeEnabled(),false);
 assert.equal(h.sockets.length,0);
});
