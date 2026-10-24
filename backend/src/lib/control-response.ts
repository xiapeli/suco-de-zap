/** A compromised/unavailable control service must not grow worker memory unboundedly. */
const MAX_CONTROL_BYTES=64*1024;
export async function readControlJson(response:Response,signal:AbortSignal):Promise<unknown>{
 const declared=response.headers.get('content-length');
 if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>MAX_CONTROL_BYTES)){
  void response.body?.cancel().catch(()=>{});throw Error('CONTROL_RESPONSE_TOO_LARGE');
 }
 const reader=response.body?.getReader();if(!reader)throw Error('CONTROL_RESPONSE_INVALID');
 const chunks:Uint8Array[]=[];let bytes=0;
 let abort!:()=>void;
 const aborted=new Promise<never>((_resolve,reject)=>{abort=()=>reject(Error('CONTROL_RESPONSE_TIMEOUT'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
 try{
  while(true){
   const part=await Promise.race([reader.read(),aborted]);if(part.done)break;
   bytes+=part.value.byteLength;if(bytes>MAX_CONTROL_BYTES)throw Error('CONTROL_RESPONSE_TOO_LARGE');chunks.push(part.value);
  }
  const value:unknown=JSON.parse(Buffer.concat(chunks,bytes).toString('utf8'));
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('CONTROL_RESPONSE_INVALID');return value;
 }catch(error){void reader.cancel().catch(()=>{});throw error;}
 finally{signal.removeEventListener('abort',abort);reader.releaseLock();}
}
