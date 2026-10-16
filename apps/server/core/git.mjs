import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';

export function execFileLimited(bin,args,{cwd,timeout=45000,env}={}){
 return new Promise((resolve,reject)=>{
  const child=spawn(bin,args,{cwd,env:{...process.env,...env,GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1'},stdio:['ignore','pipe','pipe'],shell:false});
  let stdout='',stderr='',ended=false;
  const done=(error,result)=>{if(ended)return;ended=true;clearTimeout(timer);if(error)reject(error);else resolve(result);};
  const timer=setTimeout(()=>{child.kill('SIGKILL');done(Error(`${bin} timed out`));},timeout);
  child.stdout.on('data',d=>{stdout=(stdout+d).slice(-160000);});
  child.stderr.on('data',d=>{stderr=(stderr+d).slice(-16000);});
  child.on('error',e=>done(e));
  child.on('close',code=>done(null,{code,stdout,stderr}));
 });
}
const gitArgs=['-c','core.hooksPath=/dev/null','-c','init.templateDir=/dev/null','-c','filter.lfs.smudge=','-c','filter.lfs.required=false'];
export async function git(args,options={}){const r=await execFileLimited('git',[...gitArgs,...args],options);if(r.code!==0)throw Error(`Git failed: ${(r.stderr||r.stdout).slice(-900)}`);return r.stdout.trim();}
/** Resolve a usable commit without assuming the remote default branch is valid. */
export async function resolveImportedHead(repo,{initializeEmpty=false}={}){
 try{return{head:await git(['-C',repo,'rev-parse','--verify','HEAD^{commit}']),initializedEmpty:false};}catch{}
 const refs=(await git(['-C',repo,'for-each-ref','--format=%(refname)','refs/remotes/origin/'])).split('\n').filter(ref=>ref&&ref!=='refs/remotes/origin/HEAD');
 const selected=refs.find(ref=>ref==='refs/remotes/origin/main')||refs.find(ref=>ref==='refs/remotes/origin/master')||(refs.length===1?refs[0]:null);
 if(selected)return{head:await git(['-C',repo,'rev-parse','--verify',`${selected}^{commit}`]),initializedEmpty:false};
 if(refs.length)throw Error('شاخهٔ پیش‌فرض مخزن معتبر نیست. شاخهٔ پیش‌فرض را در GitHub روی شاخهٔ موردنظر تنظیم کنید و دوباره وارد کنید.');
 if(!initializeEmpty)throw Error('این مخزن هنوز هیچ commit ندارد. گزینهٔ «آماده‌سازی مخزن خالی در کپی ایزوله» را فعال کنید یا ابتدا در GitHub یک README بسازید، سپس دوباره وارد کنید.');
 await git(['-C',repo,'-c','user.name=TeamForge Workspace','-c','user.email=workspace@teamforge.invalid','-c','commit.gpgSign=false','commit','--allow-empty','-m','Initialize isolated TeamForge workspace']);
 return{head:await git(['-C',repo,'rev-parse','--verify','HEAD^{commit}']),initializedEmpty:true};
}
/** Validate a trusted on-disk Git repository BEFORE an organization links to it.
 * The allowed root is an explicit admin-set parent, not a browser-supplied sandbox root. */
export async function validateLocalSource(source){
 if(!source||source.kind!=='local'||typeof source.path!=='string'||!path.isAbsolute(source.path))throw Error('مسیر مطلق مخزن Git محلی لازم است.');
 const roots=(process.env.TEAMFORGE_IMPORT_ROOTS||'').split(path.delimiter).filter(Boolean);
 if(!roots.length)throw Error('TEAMFORGE_IMPORT_ROOTS را روی پوشه والد پروژه‌ها تنظیم کنید.');
 const origin=await fs.realpath(source.path);
 const allowed=await Promise.all(roots.map(root=>fs.realpath(root).catch(()=>null)));
 if(!allowed.some(root=>root&&(origin===root||origin.startsWith(root+path.sep))))throw Error('مسیر بیرون از محدوده مجاز import است.');
 if(!(await fs.stat(origin)).isDirectory())throw Error('پوشه Git پیدا نشد.');
 const inside=await git(['-C',origin,'rev-parse','--show-toplevel']);
 if(await fs.realpath(inside)!==origin)throw Error('لطفاً مسیر ریشه مخزن Git را بدهید، نه زیرپوشه آن.');
 const head=await git(['-C',origin,'rev-parse','HEAD']);
 if(!/^[a-f0-9]{40,64}$/.test(head))throw Error('مخزن Git حداقل یک commit لازم دارد.');
 return{kind:'local',path:origin,head,sourceLabel:`local: ${path.basename(origin)}`};
}
export async function importRepository(dataDir,id,source){
 if(!source||!['local','git'].includes(source.kind))throw Error('نوع منبع Git معتبر نیست.');
 const repositories=path.join(dataDir,'repositories');const workspaces=path.join(dataDir,'workspaces');
 const repo=path.join(repositories,id),workspace=path.join(workspaces,id);
 await fs.mkdir(repositories,{recursive:true});await fs.mkdir(workspaces,{recursive:true});
 if(await fs.stat(repo).catch(()=>null)||await fs.stat(workspace).catch(()=>null))throw Error('این پروژه قبلاً وارد شده است.');
 let origin,sourceLabel;
 if(source.kind==='local'){
  const roots=(process.env.TEAMFORGE_IMPORT_ROOTS||'').split(path.delimiter).filter(Boolean);
  if(!roots.length)throw Error('برای import محلی ابتدا TEAMFORGE_IMPORT_ROOTS را تنظیم کنید.');
  if(typeof source.path!=='string'||!path.isAbsolute(source.path))throw Error('مسیر باید مطلق باشد.');
  origin=await fs.realpath(source.path);
  const allowed=await Promise.all(roots.map(root=>fs.realpath(root).catch(()=>null)));
  if(!allowed.some(root=>root&&(origin===root||origin.startsWith(root+path.sep))))throw Error('این مسیر خارج از محدوده مجاز import است.');
  if(!(await fs.stat(origin)).isDirectory())throw Error('منبع پوشه نیست.');
  sourceLabel=`local: ${path.basename(origin)}`;
 }else{
  if(process.env.TEAMFORGE_ALLOW_REMOTE_GIT!=='1')throw Error('Git remote به‌صورت پیش‌فرض بسته است. TEAMFORGE_ALLOW_REMOTE_GIT=1 را فقط برای ریپازیتوری مورد اعتماد فعال کنید.');
  if(typeof source.url!=='string'||source.url.length>500||!/^https:\/\/[a-z0-9.-]+\/[\w./-]+(?:\.git)?$/i.test(source.url)||source.url.includes('..'))throw Error('تنها HTTPS Git URL ساده مجاز است.');
  origin=source.url;sourceLabel=`git: ${new URL(origin).hostname}`;
 }
 try{
  if(source.branch)await git(['check-ref-format',`refs/heads/${source.branch}`]);
  await git(['clone',...(source.branch?['--branch',source.branch]:[]),'--no-local','--no-hardlinks','--no-checkout','--',origin,repo],{timeout:120000});
  const {head,initializedEmpty}=await resolveImportedHead(repo,{initializeEmpty:source.initializeEmpty===true});
  const branch=`teamforge/${id.slice(0,12)}`;
  await git(['-C',repo,'worktree','add','-b',branch,'--',workspace,head],{timeout:120000});
  // Do not allow a workspace to contain symlinks with a path to outside the repository.
  const publishRemote=source.kind==='git'?origin:await git(['-C',origin,'remote','get-url','origin']).catch(()=>null);
  return{repo,workspace,head,branch,sourceLabel,kind:source.kind,initializedEmpty,publishRemote};
 }catch(e){await fs.rm(repo,{recursive:true,force:true}).catch(()=>{});await fs.rm(workspace,{recursive:true,force:true}).catch(()=>{});throw e;}
}
export async function gitSummary(root){
 const output=await git(['-C',root,'status','--short','--untracked-files=normal']);
 return output.split('\n').filter(Boolean).slice(0,180);
}
export async function gitDiff(root,relative){
 const status=await git(['-C',root,'ls-files','--',relative]);
 if(status)return await git(['-C',root,'diff','--no-ext-diff','--no-textconv','--no-color','HEAD','--',relative]);
 // Untracked files are absent from `git diff HEAD`; explicitly compare to /dev/null.
 const r=await execFileLimited('git',[...gitArgs,'-C',root,'diff','--no-ext-diff','--no-textconv','--no-color','--no-index','--','/dev/null',relative]);
 if(r.code!==0&&r.code!==1)throw Error(r.stderr.slice(0,500));
 return r.stdout.replaceAll(root+'/', '').slice(0,40000);
}
