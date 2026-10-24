import { TenantAuthorizer, type TenantConfig } from './tenant-access.js';
export function loadTenantConfig(env:NodeJS.ProcessEnv=process.env):TenantConfig|null {
 const names=['SUCO_TENANT_ID','SUCO_ACCOUNT_ID','SUCO_WORKER_KEY','SUCO_CONTROL_PLANE_URL'] as const;
 const values=names.map(k=>env[k]);
 if(values.every(v=>!v))return null;
 if(values.some(v=>!v))throw Error('INCOMPLETE_TENANT_CONFIG');
 const [tenantId,accountId,workerKey,controlUrl]=values as [string,string,string,string];
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(tenantId)||!/^[A-Za-z0-9_-]{1,128}$/.test(accountId)||workerKey.length<32)throw Error('INVALID_TENANT_CONFIG');
 return {tenantId,accountId,workerKey,controlUrl};
}
export const tenantConfig=loadTenantConfig();
export const tenantAuthorizer=tenantConfig?new TenantAuthorizer(tenantConfig):null;
export function tenantAllowed():boolean{return tenantAuthorizer?tenantAuthorizer.canIngest():true;}
export async function authorizeTenant():Promise<boolean>{return tenantAuthorizer?tenantAuthorizer.allowed():true;}
export function cloudGlmConfigured():boolean{return Boolean(process.env.SUCO_GLM_REGULAR_KEY_FILE);}

export function tenantAccess(){return tenantAuthorizer?.snapshot()?.access??(tenantConfig?'trial_exhausted':'owner');}
export function tenantTrialUsage(){return tenantAuthorizer?.snapshot()?.trial??null;}
export function advancedAiAllowed(){return !tenantConfig||['owner','paid'].includes(tenantAccess());}
export async function authorizeIngestion(){return await authorizeTenant()&&tenantAllowed();}
