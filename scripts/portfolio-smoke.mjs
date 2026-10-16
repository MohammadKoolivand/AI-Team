import {authenticatedFetch,testAuthEnv} from './http-test-auth.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';

const dir=await fs.mkdtemp(path.join(os.tmpdir(),'teamforge-portfolio-http-'));
const port=18789,base=`http://127.0.0.1:${port}`;
const proc=spawn(process.execPath,['apps/server/server.mjs'],{env:{...process.env,...testAuthEnv,PORT:String(port),DATA_DIR:dir},stdio:['ignore','pipe','pipe']});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const data=(x)=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(x)});
async function req(url,init){const r=await authenticatedFetch(base+url,init);const b=await r.json();assert(r.ok,`${r.status}: ${JSON.stringify(b)}`);return b;}
const flat=x=>x.flatMap(p=>p.phases.flatMap(ph=>ph.features.flatMap(f=>f.tasks)));
try{
 let ready=false;
 for(let i=0;i<100;i++){try{if((await authenticatedFetch(base+'/api/health')).ok){ready=true;break;}}catch{}await sleep(75);}
 assert(ready,'server must start');
 const seed=await req('/api/portfolio/demo',{method:'POST'});
 const tasks=flat(seed.projects);assert.equal(tasks.length,4);
 assert.deepEqual(tasks.map(t=>t.stage).sort(),['analysis','backend','frontend','qa']);
 assert(tasks.every(x=>x.stageStatus==='awaiting_review'));
 assert.equal((await req('/api/portfolio/demo',{method:'POST'})).reused,true);
 const phase=await req(`/api/portfolio/projects/${seed.projectId}/phases`,data({title:'فاز آزمون HTTP'}));
 const feature=await req(`/api/portfolio/projects/${seed.projectId}/features`,data({phaseId:phase.item.id,title:'فیچر آزمون'}));
 const task=await req(`/api/portfolio/projects/${seed.projectId}/tasks`,data({featureId:feature.item.id,title:'تسک آزمون جدید',description:'مدیر این تسک را دستی ثبت کرده است.',mode:'demo'}));
 const added=await req(`/api/projects/${task.item.runId}`);assert.equal(added.project.status,'draft');
 await req(`/api/projects/${task.item.runId}/start`,{method:'POST'});
 for(let i=0;i<100;i++){const run=(await req(`/api/projects/${task.item.runId}`)).project;if(run.status==='awaiting_review')break;await sleep(50);}
 const now=(await req(`/api/projects/${task.item.runId}`)).project;assert.equal(now.tasks[0].status,'awaiting_review');
 const other=tasks.find(t=>t.stage==='backend');
 assert.equal((await req(`/api/projects/${other.runId}`)).project.tasks.find(t=>t.id==='backend').status,'awaiting_review');
 console.log('Portfolio HTTP smoke PASS: seed 4 simultaneous lanes, idempotent, phases, features, manager tasks, independent engine runs.');
}finally{proc.kill('SIGTERM');await fs.rm(dir,{recursive:true,force:true});}
