import { readControlJson } from './lib/control-response.js';
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TenantConfig { tenantId: string; accountId: string; workerKey: string; controlUrl: string; }
export interface TenantPayload { tenantId: string; accountId: string; expMs: number; scope: 'tenant'|'manage'; nonce: string; }

export function verifyTenantToken(token: string, config: TenantConfig, now=Date.now()): TenantPayload {
  if (token.length>4096 || !config.tenantId || !config.accountId || config.workerKey.length<32) throw new Error('INVALID_TENANT_TOKEN');
  const parts=token.split('.');
  if(parts.length!==4 || parts[0]!=='suco' || parts[1]!=='v1' || !/^[A-Za-z0-9_-]{1,2048}$/.test(parts[2]) || !/^[a-f0-9]{64}$/.test(parts[3])) throw new Error('INVALID_TENANT_TOKEN');
  const expected=createHmac('sha256',config.workerKey).update(`suco-session-v1.${parts[2]}`).digest();
  if(!timingSafeEqual(expected,Buffer.from(parts[3],'hex'))) throw new Error('INVALID_TENANT_TOKEN');
  let p: TenantPayload;
  try { p=JSON.parse(Buffer.from(parts[2],'base64url').toString('utf8')); } catch { throw new Error('INVALID_TENANT_TOKEN'); }
  if(!p || typeof p!=='object' || p.tenantId!==config.tenantId || p.accountId!==config.accountId || !['tenant','manage'].includes(p.scope) || !Number.isSafeInteger(p.expMs) || p.expMs<=now || p.expMs>now+300_000 || typeof p.nonce!=='string' || p.nonce.length<16 || p.nonce.length>80) throw new Error('INVALID_TENANT_TOKEN');
  return p;
}

export function manageRouteAllowed(method: string,path: string) {
  return (method==='GET' && ['/api/status','/api/account/export'].includes(path)) || (method==='DELETE' && path==='/api/account');
}

export type TenantAccess='owner'|'paid'|'trial'|'trial_exhausted';
export interface TrialUsage{limit:number;completed:number;reserved:number;remaining:number;}
export class TenantAuthorizer {
  private cached: {allowed:boolean;validUntil:number;checkedAt:number;canIngest:boolean;access:TenantAccess;trial:TrialUsage|null}|null=null;
  private generation=0;
  private flight: Promise<boolean>|null=null;
  constructor(private readonly config: TenantConfig, private readonly fetcher: typeof fetch=fetch, private readonly now: ()=>number=Date.now) {
    const u=new URL(config.controlUrl);
    if(u.protocol!=='https:' || !u.hostname.endsWith('.convex.site') || u.username || u.password || u.port || u.pathname!=='/' || u.search || u.hash) throw new Error('INVALID_CONTROL_URL');
  }
  async allowed(): Promise<boolean> {
    const now=this.now();
    if(this.cached && now-this.cached.checkedAt<(this.cached.allowed?30_000:3_000) && (!this.cached.allowed || this.cached.validUntil>now)) return this.cached.allowed;
    if(this.flight) return this.flight;
    this.flight=this.check().finally(()=>{this.flight=null;});return this.flight;
  }
  private async check() {
    const generation=this.generation;
    const stamp=String(this.now());const path='/worker/authorize';const body=JSON.stringify({tenantId:this.config.tenantId});
    const signature=createHmac('sha256',this.config.workerKey).update(`${stamp}.${path}.${body}`).digest('hex');
    try {
      const signal=AbortSignal.timeout(5000);
      const response=await this.fetcher(`${this.config.controlUrl.replace(/\/$/,'')}${path}`,{method:'POST',headers:{'Content-Type':'application/json','x-suco-timestamp':stamp,'x-suco-signature':signature},body,signal,redirect:'error'});
      if(!response.ok) throw new Error('CONTROL_UNAVAILABLE');
      const data=await readControlJson(response,signal) as {allowed?:boolean;canRead?:boolean;canIngest?:boolean;access?:TenantAccess;trial?:TrialUsage;validUntil?:number;consented?:boolean;paidUntil?:number};
      const now=this.now();
      if(generation!==this.generation)return false;
      const access:TenantAccess=['owner','paid','trial','trial_exhausted'].includes(data.access||'')?data.access!:'paid';
      const live=Number.isSafeInteger(data.validUntil)&&data.validUntil!>now;
      const paid=access!=='paid'||(Number.isSafeInteger(data.paidUntil)&&data.paidUntil!>now);
      const allowed=(data.canRead===true || (data.canRead===undefined&&data.allowed===true))&&data.consented===true&&live&&paid;
      const canIngest=allowed&&(data.canIngest??(data.allowed===true&&access!=='trial_exhausted'));
      const trial=data.trial&&[data.trial.limit,data.trial.completed,data.trial.reserved,data.trial.remaining].every(x=>Number.isSafeInteger(x)&&x>=0)?data.trial:null;
      this.cached={allowed,canIngest,access,trial,validUntil:allowed?(access==='paid'?Math.min(data.validUntil!,data.paidUntil!):data.validUntil!):now,checkedAt:now};return allowed;
    } catch { if(generation===this.generation)this.cached={allowed:false,canIngest:false,access:'trial_exhausted',trial:null,validUntil:this.now(),checkedAt:this.now()};return false; }
  }
  currentlyAllowed():boolean { return this.cached?.allowed===true && this.cached.validUntil>this.now() && this.now()-this.cached.checkedAt<30_000; }
  canIngest():boolean{return this.currentlyAllowed()&&this.cached!.canIngest;}
  snapshot(){return this.currentlyAllowed()?{access:this.cached!.access,trial:this.cached!.trial,canIngest:this.cached!.canIngest}:null;}
  invalidate() { this.generation++;this.cached=null; }
}
