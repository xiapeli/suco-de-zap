import { createHmac, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { TenantConfig } from './tenant-access.js';
export type WorkerConnection='disconnected'|'qr_required'|'connecting'|'syncing'|'connected'|'reconnecting'|'action_required';
export interface KeeperOptions {
 config:TenantConfig; directory:string;
 allowed:()=>Promise<boolean>; invalidate:()=>void;
 start:()=>void|Promise<void>; pause:()=>void|Promise<void>;
 status:()=>{connectionState:string;syncing:boolean}; firstSummary:()=>Promise<boolean>;
 reconcile?:()=>Promise<void>;
 fetcher?:typeof fetch; now?:()=>number; intervalMs?:number;
}
/** One flight owns authorization, transition and report. No external module imports. */
export class TenantKeeper {
 private flight:Promise<void>|null=null;private stopped=false;private active=false;private timer:NodeJS.Timeout|null=null;
 private readonly fetcher:typeof fetch;private readonly now:()=>number;
 constructor(private o:KeeperOptions){this.fetcher=o.fetcher??fetch;this.now=o.now??Date.now;if(!o.directory||resolve(o.directory)!==o.directory)throw Error('PRIVATE_STATE_PATH_REQUIRED');}
 start(){if(this.timer)return;const interval=this.o.intervalMs??20_000;if(interval<1000||interval>30_000)throw Error('INVALID_KEEPER_INTERVAL');this.timer=setInterval(()=>void this.tick(),interval);this.timer.unref();void this.tick();}
 async tick():Promise<void>{if(this.stopped)return;if(this.flight)return this.flight;this.flight=this.run().finally(()=>{this.flight=null;});return this.flight;}
 private async run(){
  try{
   await this.o.reconcile?.();if(this.stopped)return;
   const allowed=await this.o.allowed();if(this.stopped)return;
   if(!allowed){this.o.invalidate();this.active=false;await this.o.pause();}
   else if(!this.active){this.active=true;void Promise.resolve().then(()=>{if(!this.stopped&&this.active)return this.o.start();}).catch(()=>{this.active=false;});}
   if(this.stopped)return;
   const status=this.o.status();const valid=new Set(['disconnected','qr_required','connecting','syncing','connected','reconnecting','action_required']);
   const connection=valid.has(status.connectionState)?(status.syncing?'syncing':status.connectionState):'disconnected';
   const first=await this.o.firstSummary();if(this.stopped)return;await this.report(connection as WorkerConnection,first);
  }catch{this.o.invalidate();this.active=false;await this.o.pause();}
 }
 private async report(connection:WorkerConnection,firstSummaryReady:boolean){
  await fs.mkdir(this.o.directory,{recursive:true,mode:0o700});const st=await fs.lstat(this.o.directory);if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077))throw Error('UNSAFE_STATE_DIRECTORY');
  const path=join(this.o.directory,'worker-sequence');let seq=0;
  try{const s=await fs.lstat(path);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077))throw Error('UNSAFE_SEQUENCE_FILE');seq=Number(await fs.readFile(path,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  if(!Number.isSafeInteger(seq)||seq<0||seq>=Number.MAX_SAFE_INTEGER)throw Error('INVALID_SEQUENCE');seq++;
  const tmp=join(this.o.directory,'.sequence-'+randomUUID());const handle=await fs.open(tmp,'wx',0o600);try{await handle.writeFile(String(seq));await handle.sync();}finally{await handle.close();}await fs.rename(tmp,path);const dirHandle=await fs.open(this.o.directory,'r');try{await dirHandle.sync();}finally{await dirHandle.close();}
  const stamp=String(this.now()),route='/worker/report';const body=JSON.stringify({tenantId:this.o.config.tenantId,sequence:seq,connection,firstSummaryReady});
  const signature=createHmac('sha256',this.o.config.workerKey).update(`${stamp}.${route}.${body}`).digest('hex');
  const r=await this.fetcher(this.o.config.controlUrl.replace(/\/$/,'')+route,{method:'POST',headers:{'content-type':'application/json','x-suco-timestamp':stamp,'x-suco-signature':signature},body,signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error('REPORT_UNAVAILABLE');
 }
 async stop(){this.stopped=true;this.active=false;if(this.timer)clearInterval(this.timer);this.timer=null;this.o.invalidate();await this.o.pause();await this.flight;}
}
