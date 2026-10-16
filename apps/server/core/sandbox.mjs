import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFileLimited} from './git.mjs';
import {repoFiles,safeRead} from './coding-files.mjs';
const IMAGE=process.env.TEAMFORGE_DOCKER_IMAGE||'node:22-alpine';
const commands={node_test:['node','--test'],npm_test:['npm','test'],npm_build:['npm','run','build'],npm_lint:['npm','run','lint'],npm_typecheck:['npm','run','typecheck'],node_check:['node','--check']};
export async function commandsForRepo(root){
 const files=await repoFiles(root);const detected=[];
 for(const p of files.filter(p=>p==='package.json'||/(^|\/)package\.json$/.test(p)).slice(0,15)){
  try{const d=JSON.parse(await safeRead(root,p));const dir=path.posix.dirname(p)==='.'?'':path.posix.dirname(p);
   for(const name of ['test','build','lint','typecheck'])if(typeof d.scripts?.[name]==='string')detected.push({key:`npm_${name}`,cwd:dir,script:d.scripts[name]});
  }catch{}
 }
 return detected;
}
async function sanitizedCopy(source,target){
 const paths=await repoFiles(source);let bytes=0,count=0;
 for(const p of paths){
  if(count>=1200)throw Error('Sandbox snapshot exceeds file limit; execution unavailable');
  try{const content=await safeRead(source,p);const size=Buffer.byteLength(content);if(bytes+size>12_000_000)throw Error('Sandbox snapshot exceeds size limit; execution unavailable');
   const dest=path.join(target,...p.split('/'));await fs.mkdir(path.dirname(dest),{recursive:true});await fs.writeFile(dest,content,{mode:0o644});bytes+=size;count++;
  }catch(e){throw Error(`Cannot create complete sandbox snapshot (${p}): ${e.message}`);}
 }
 return{files:count,bytes};
}
export async function runSandboxCommand(root,{key,cwd='',target=''}={}){
 if(!commands[key])throw Error('دستور خارج از فهرست مجاز است.');
 if(cwd&&(!/^[a-zA-Z0-9_./-]{1,100}$/.test(cwd)||cwd.includes('..')||cwd.startsWith('/')))throw Error('working directory نامعتبر است.');
 if(key==='node_check'&&(!/^[\w./-]{1,160}\.[cm]?js$/.test(target)||target.includes('..')||target.startsWith('/')))throw Error('فایل node_check نامعتبر است.');
 const entries=await commandsForRepo(root);
 if(key.startsWith('npm_')){
  if(!entries.some(e=>e.key===key&&e.cwd===cwd))return{status:'skipped',command:key,detail:`No matching npm script in ${cwd||'.'}`,output:''};
 }
 let probe;try{probe=await execFileLimited('docker',['image','inspect',IMAGE],{timeout:5000});}catch(e){return{status:'skipped',command:key,detail:`Docker not installed: ${e.message}`,output:''};}
 if(probe.code!==0)return{status:'skipped',command:key,detail:`Docker daemon or image ${IMAGE} unavailable: ${(probe.stderr||probe.stdout).slice(-500)}`,output:''};
 const containerName=`teamforge-${crypto.randomUUID()}`;
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'teamforge-sandbox-'));
 await fs.chmod(temp,0o755); // Docker's unprivileged user needs to traverse the bind-mounted snapshot.
 try{
  const copy=await sanitizedCopy(root,temp);if(!copy.files)return{status:'skipped',command:key,detail:'No safe files to test.',output:''};
  const args=['run','--rm','--name',containerName,'--network','none','--memory','768m','--cpus','1','--pids-limit','96','--cap-drop','ALL','--security-opt','no-new-privileges','--read-only','--user','10001:10001','--tmpfs','/tmp:rw,nosuid,nodev,size=128m','--tmpfs','/work:rw,nosuid,nodev,size=256m,mode=1777','-e','HOME=/tmp','-e','npm_config_cache=/tmp/npm','--mount',`type=bind,src=${temp},dst=/input,readonly`,'--workdir','/work',IMAGE,'sh','-c','cp -R /input/. /work/ && cd "/work/$1" && shift && exec "$@"','teamforge',cwd,...commands[key],...(key==='node_check'?[target]:[])];
  const result=await execFileLimited('docker',args,{timeout:100000});
  return{status:result.code===0?'passed':'failed',command:key,cwd,exitCode:result.code,detail:`Isolated Docker; ${copy.files} safe text files. Dependencies must already be vendored or available in image.`,output:(result.stdout+'\n'+result.stderr).slice(-9000)};
 }catch(e){return{status:'failed',command:key,detail:'Sandbox execution error',output:String(e).slice(0,1500)};}
 finally{await execFileLimited('docker',['rm','-f',containerName],{timeout:5000}).catch(()=>{});await fs.rm(temp,{recursive:true,force:true});}
}
export async function runAutomaticChecks(root,role,onCheck=()=>{}){
 const entries=await commandsForRepo(root);
 const priority=role==='backend'?['npm_test','npm_lint','npm_typecheck']:role==='frontend'?['npm_build','npm_lint','npm_typecheck']:['npm_test','npm_build','npm_lint','npm_typecheck'];
 const list=entries.filter(e=>priority.includes(e.key)).slice(0,6);
 if(!list.length)return[{status:'skipped',command:'auto',detail:'No supported package.json scripts detected',output:''}];
 const results=[];for(const e of list){const result=await runSandboxCommand(root,{key:e.key,cwd:e.cwd});results.push(result);await onCheck(result);}
 return results;
}
