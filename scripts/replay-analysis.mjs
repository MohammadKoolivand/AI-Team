import {hasImplementationChanges} from '../apps/server/core/review-policy.mjs';
/** Read-only reproduction of a failed analysis in a disposable local Git worktree. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {safeRead} from '../apps/server/core/coding-files.mjs';
import {git,importRepository,gitDiff} from '../apps/server/core/git.mjs';
import {runCodingAgent} from '../apps/server/core/coding-agent.mjs';
const role=process.argv.includes('--backend')?'backend':'analyst';
const id=process.argv[2];if(!/^[a-f0-9-]{36}$/.test(id||''))throw Error('Supply the existing execution UUID');
const data=path.resolve(process.env.DATA_DIR||'./data');
// Do not initialize/mutate the user's Store or change its execution state.
const state=JSON.parse(await fs.readFile(path.join(data,'state.json'),'utf8'));const project=state.projects.find(p=>p.id===id);if(!project?.repository)throw Error('Imported project not found');
const filename='docs/teamforge/analysis.md',original=await safeRead(path.join(data,'workspaces',id),filename),root=await fs.mkdtemp(path.join(os.tmpdir(),'teamforge-replay-')),source=path.join(root,'source'),prior=process.env.TEAMFORGE_IMPORT_ROOTS;
try{
 await fs.mkdir(path.join(source,'docs/teamforge'),{recursive:true});await fs.writeFile(path.join(source,filename),original);
 await git(['init',source]);await git(['-C',source,'add','.']);await git(['-C',source,'-c','user.name=Replay fixture','-c','user.email=replay@example.invalid','-c','commit.gpgSign=false','commit','-m','existing analysis fixture']);
 process.env.TEAMFORGE_IMPORT_ROOTS=root;const repo=await importRepository(path.join(root,'runtime'),crypto.randomUUID(),{kind:'local',path:source});let last=0;
 const output=await runCodingAgent({project:{title:project.title,description:project.description,filePolicy:{analyst:['docs/teamforge/'],backend:['backend/']}},role,root:repo.workspace,feedback:role==='backend'?'خروجی قبلی کدی ایجاد نکرد. یک بخش کوچک و قابل اجرا از بک‌اند را مطابق تحلیل پیاده کن؛ فایل تحلیل فقط خواندنی است. کد کوتاه و متمرکز باشد.':project.tasks[0].feedback,signal:AbortSignal.timeout(360000),onEvent:async(kind,text)=>console.log(`${kind}: ${text}`),onProgress:p=>{if(Date.now()-last>15000){last=Date.now();console.log(JSON.stringify({phase:p.phase,elapsedMs:p.requestElapsedMs,characters:p.characters}));}}});
 const updated=await safeRead(repo.workspace,filename);if(!output.finished||(role==='backend'?!hasImplementationChanges(output.changes):updated===original||!/تعاریف|Definitions|Terminology/i.test(updated)))throw Error('The required implementation/correction was not produced');
 if(role==='backend'&&updated!==original)throw Error('Backend modified the read-only analysis');
 if(await safeRead(path.join(data,'workspaces',id),filename)!==original)throw Error('Original user workspace changed during isolated replay');
 if(!(await gitDiff(repo.workspace,role==='backend'?output.files[0]:filename)).includes('diff --git'))throw Error('No real revision diff');
 console.log(JSON.stringify({status:'PASS',type:'LIVE_MODEL',scenario:role==='backend'?'isolated-replay-of-user-backend-implementation':'isolated-replay-of-user-analysis-correction',actions:output.actions,changedFiles:output.files,userWorkspaceUnchanged:true}));
}finally{if(prior===undefined)delete process.env.TEAMFORGE_IMPORT_ROOTS;else process.env.TEAMFORGE_IMPORT_ROOTS=prior;await fs.rm(root,{recursive:true,force:true});}
