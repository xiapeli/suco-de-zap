import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('runtime lock and installed cacheable dependencies exclude known malware and install hooks',async()=>{
 const root=new URL('../',import.meta.url);
 const lock=JSON.parse(await readFile(new URL('package-lock.json',root),'utf8'));
 const safe:{[name:string]:string}={'cacheable':'2.5.0','@cacheable/memory':'2.2.0','@cacheable/utils':'2.5.0'};
 for(const [name,version]of Object.entries(safe)){
  const matches=Object.entries(lock.packages as Record<string,{version?:string;hasInstallScript?:boolean}>).filter(([path])=>path.endsWith('/'+name));
  assert(matches.length>0,name+' missing');
  for(const [path,entry] of matches){
   assert.equal(entry.version,version);assert(!entry.hasInstallScript);
   const installed=JSON.parse(await readFile(new URL(path+'/package.json',root),'utf8'));
   assert.equal(installed.version,version);assert(!installed.scripts?.preinstall);assert(!installed.scripts?.install);assert(!installed.scripts?.postinstall);
  }
 }
 assert.match(await readFile(new URL('.npmrc',root),'utf8'),/^ignore-scripts=true$/m);
});
