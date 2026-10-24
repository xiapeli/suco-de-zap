import { JUICE_CATALOG_VERSION, requestedJuice, personalJuiceId } from './juice-types.ts';
import { controlMode } from './suco-env.ts';
export const MANUAL_REQUEST_PREFIX='suco:manual:v1:';
export interface ManualJuiceRequest {request_id:string;chat_jid:string;start:string;end:string;analysis_type:string;template_version:string;personal_revision?:string;base_prompt?:string;focus?:string;}
type Store=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
export function manualRequestKey(origin:string) {const u=new URL(origin);if(u.username||u.password||u.search||u.hash||u.pathname!=='/'||!['https:','http:'].includes(u.protocol))throw Error('INVALID_MANUAL_SCOPE');return MANUAL_REQUEST_PREFIX+encodeURIComponent(u.origin);}
export function manualIdentity(value:Omit<ManualJuiceRequest,'request_id'>) {return JSON.stringify([value.chat_jid,value.start,value.end,value.analysis_type,value.template_version,value.base_prompt??null,value.focus??null,...(value.personal_revision?[value.personal_revision]:[])]);}
function valid(value:unknown):value is ManualJuiceRequest {
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const v=value as Record<string,unknown>,required=['request_id','chat_jid','start','end','analysis_type','template_version'];
 if(!required.every(k=>k in v)||Object.keys(v).some(k=>![...required,'base_prompt','focus','personal_revision'].includes(k)))return false;
 if(typeof v.request_id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v.request_id)||typeof v.chat_jid!=='string'||!v.chat_jid||v.chat_jid.length>200||/\s/.test(v.chat_jid))return false;
 if(typeof v.start!=='string'||typeof v.end!=='string'||v.start.length>40||v.end.length>40||!Number.isFinite(Date.parse(v.start))||!Number.isFinite(Date.parse(v.end))||Date.parse(v.start)>Date.parse(v.end))return false;
 if(typeof v.analysis_type!=='string'||(!requestedJuice(v.analysis_type)&&!personalJuiceId(v.analysis_type))||v.template_version!==JUICE_CATALOG_VERSION)return false;
 if(personalJuiceId(v.analysis_type)) {
  const revision=v.personal_revision;
  if(typeof revision!=='string'||!(controlMode()==='supabase'
    ? /^[1-9][0-9]{0,18}$/.test(revision)
    : !!personalJuiceId('personal:'+revision)))return false;
 }
 else if('personal_revision' in v)return false;
 if(v.analysis_type==='custom')return typeof v.base_prompt==='string'&&!!v.base_prompt.trim()&&v.base_prompt.length<=10000&&!('focus'in v);
 return !('base_prompt'in v)&&(!('focus'in v)||(typeof v.focus==='string'&&v.focus.length<=2000));
}
export function loadManualRequest(storage:Pick<Store,'getItem'>,key:string):{request:Readonly<ManualJuiceRequest>|null;problem:'unavailable'|'corrupt'|null} {
 let raw:string|null;try{raw=storage.getItem(key);}catch{return {request:null,problem:'unavailable'};}
 if(raw===null)return {request:null,problem:null};
 try{if(raw.length>18000)throw Error();const value=JSON.parse(raw);if(!valid(value))throw Error();return {request:Object.freeze(value),problem:null};}catch{return {request:null,problem:'corrupt'};}
}
export function saveManualRequest(storage:Store,key:string,request:ManualJuiceRequest):boolean {
 if(!valid(request))return false;
 try{const raw=JSON.stringify(request),existing=loadManualRequest(storage,key);if(existing.problem||existing.request&&(existing.request.request_id!==request.request_id||manualIdentity(existing.request)!==manualIdentity(request)))return false;storage.setItem(key,raw);return storage.getItem(key)===raw;}catch{return false;}
}
export function removeManualRequest(storage:Store,key:string,id:string):boolean {
 try{const value=loadManualRequest(storage,key);if(value.problem)return false;if(!value.request)return true;if(value.request.request_id!==id)return false;storage.removeItem(key);return storage.getItem(key)===null;}catch{return false;}
}
export function clearManualRequests(storage:Pick<Storage,'length'|'key'|'removeItem'>) {try{const keys:string[]=[];for(let i=0;i<storage.length;i++){const key=storage.key(i);if(key?.startsWith(MANUAL_REQUEST_PREFIX))keys.push(key);}keys.forEach(key=>storage.removeItem(key));}catch{}}
