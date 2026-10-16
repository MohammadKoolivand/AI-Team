import fs from 'node:fs/promises';
import path from 'node:path';
import {readSafeFile} from './policies.mjs';

export async function snapshots(root,paths){
  const map={};
  for(const p of paths){try{map[p]=await readSafeFile(root,p);}catch(e){if(e.code!=='ENOENT')map[p]=null;else map[p]=null;}}
  return map;
}
export function buildChanges(before,after){
  const changes=[];
  for(const p of new Set([...Object.keys(before),...Object.keys(after)])){
    const old=before[p]??null,next=after[p]??null;
    if(old===next)continue;
    const count=s=>s===null?0:s.split('\n').length;
    changes.push({path:p,type:old===null?'added':next===null?'deleted':'modified',before:old,after:next,oldLines:count(old),newLines:count(next)});
  }
  return changes;
}
export async function snapshotFiles(root,paths){
  const result={};
  for(const name of paths){try{result[name]=await readSafeFile(root,name);}catch{result[name]=null;}}
  return result;
}
export function latestDiff(task,file){
  for(let i=task.revisions.length-1;i>=0;i--){const match=task.revisions[i].changes.find(c=>c.path===file);if(match)return match;}
  return null;
}
export async function updateFileSnapshot(root,name,content){
  await fs.mkdir(path.dirname(path.join(root,name)),{recursive:true});
  await fs.writeFile(path.join(root,name),content,'utf8');
}
