import fs from 'node:fs/promises';
import crypto from 'node:crypto';
/** Atomic replacement with fsync; never expose a partially written JSON document. */
export async function durableJSON(file, value) {
 const temp=`${file}.${crypto.randomUUID()}.tmp`;
 let handle;
 try {
  handle=await fs.open(temp,'wx',0o600);
  await handle.writeFile(JSON.stringify(value,null,2));await handle.sync();await handle.close();handle=null;
  await fs.rename(temp,file);
 } finally {await handle?.close();await fs.rm(temp,{force:true});}
}
/** Restore failed transactions without invalidating entities held by other queued operations. */
export function restoreInPlace(target,backup){
 if(Array.isArray(target)&&Array.isArray(backup)){
  const restored=backup.map((value,index)=>{
   if(value&&typeof value==='object'){
    const existing=value.id?target.find(x=>x?.id===value.id):target[index];
    if(existing&&typeof existing==='object'&&Array.isArray(existing)===Array.isArray(value)){restoreInPlace(existing,value);return existing;}
   }
   return structuredClone(value);
  });target.splice(0,target.length,...restored);return;
 }
 for(const key of Object.keys(target))if(!(key in backup))delete target[key];
 for(const [key,value] of Object.entries(backup)){
  if(value&&typeof value==='object'&&target[key]&&typeof target[key]==='object'&&Array.isArray(value)===Array.isArray(target[key]))restoreInPlace(target[key],value);
  else target[key]=structuredClone(value);
 }
}
