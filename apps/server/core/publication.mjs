import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {git,execFileLimited} from './git.mjs';
import {safeRelative} from './coding-files.mjs';

export function publicationBranch(){return process.env.TEAMFORGE_PUBLISH_BRANCH||'develop';}
export function validatePublishRemote(remote){
 if(typeof remote!=='string'||remote.length>500||!/^https:\/\/[a-z0-9.-]+\/[\w./-]+$/i.test(remote)||remote.includes('..'))throw Error('انتشار به HTTPS remote معتبر و بدون اطلاعات ورود نیاز دارد. برای مخزن محلی origin اصلی را تنظیم و دوباره import کنید.');
 return remote;
}
// Build the reviewed tree with a private index. Neither the worktree HEAD nor its
// index is changed, so retries and approved patch downloads remain reproducible.
export async function prepareReviewedCommit(root,{paths,branch,previousCommit,message}){
 await git(['check-ref-format',`refs/heads/${branch}`]);
 const allowed=new Set(paths.map(safeRelative));
 const changed=(await git(['-C',root,'diff','--name-only','--no-renames','-z','HEAD'])).split('\0').filter(Boolean);
 const untracked=(await git(['-C',root,'ls-files','--others','--exclude-standard','-z'])).split('\0').filter(Boolean);
 if([...changed,...untracked].some(name=>!allowed.has(name)))throw Error('تغییر خارج از فایل‌های بازبینی‌شده وجود دارد؛ انتشار متوقف شد.');
 if(!changed.length&&!untracked.length)throw Error('تغییری برای Commit وجود ندارد.');
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'teamforge-index-'));
 try{
  const env={GIT_INDEX_FILE:path.join(temp,'index')};
  await git(['-C',root,'read-tree','HEAD'],{env});
  const existing=new Set((await git(['-C',root,'ls-files','-z'])).split('\0'));
  const names=[...allowed].filter(name=>existing.has(name)||untracked.includes(name));
  for(let i=0;i<names.length;i+=100)await git(['-C',root,'add','-A','--',...names.slice(i,i+100)],{env});
  const tree=await git(['-C',root,'write-tree'],{env});
  if(previousCommit&&await git(['-C',root,'rev-parse',`${previousCommit}^{tree}`])===tree)return previousCommit;
  const parent=await git(['-C',root,'rev-parse','HEAD']);
  return await git(['-C',root,'-c','commit.gpgSign=false','commit-tree',tree,'-p',parent,'-m',message],{env:{...env,GIT_AUTHOR_NAME:process.env.TEAMFORGE_GIT_AUTHOR_NAME||'TeamForge',GIT_AUTHOR_EMAIL:process.env.TEAMFORGE_GIT_AUTHOR_EMAIL||'workspace@teamforge.invalid',GIT_COMMITTER_NAME:process.env.TEAMFORGE_GIT_AUTHOR_NAME||'TeamForge',GIT_COMMITTER_EMAIL:process.env.TEAMFORGE_GIT_AUTHOR_EMAIL||'workspace@teamforge.invalid'}});
 }finally{await fs.rm(temp,{recursive:true,force:true});}
}
export async function pushReviewedCommit(root,{remote,branch,commit}){
 validatePublishRemote(remote);
 await git(['check-ref-format',`refs/heads/${branch}`]);
 if(!/^[a-f0-9]{40,64}$/.test(commit))throw Error('Invalid publication commit');
 // Full refspec without +: Git rejects non-fast-forward updates and protected branches.
 const credentials=[];
 if(new URL(remote).hostname==='github.com'){
  const login=await execFileLimited('gh',['auth','status','--hostname','github.com'],{timeout:10000}).catch(()=>null);
  if(login?.code===0)credentials.push('-c','credential.helper=','-c','credential.helper=!gh auth git-credential');
 }
 await git(['-C',root,...credentials,'-c','push.followTags=false','push','--porcelain','--',remote,`${commit}:refs/heads/${branch}`],{timeout:120000});
}
