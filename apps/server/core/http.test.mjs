import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

test('HTTP authentication, project isolation, assigned-role reviews, audit and SSE reconnect',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'teamforge-auth-http-'));
 const reservation=http.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const password=crypto.randomBytes(24).toString('hex'),admin='Basic '+Buffer.from(`admin:${password}`).toString('base64');
 const proc=spawn(process.execPath,['apps/server/server.mjs'],{env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:root,TEAMFORGE_ADMIN_PASSWORD:password},stdio:['ignore','pipe','pipe']});let log='';proc.stderr.on('data',d=>log+=d);proc.stdout.on('data',()=>{});
 const base=`http://127.0.0.1:${port}`;
 async function request(route,{method='GET',body,authorization=admin}={}){const response=await fetch(base+route,{method,headers:{authorization,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return{status:response.status,value:await response.json()};}
 async function reviewReady(runId,stage){for(let i=0;i<150;i++){const {value}=await request(`/api/projects/${runId}`);if(value.project?.tasks.find(t=>t.id===stage)?.status==='awaiting_review')return value.project;await sleep(25);}throw Error('Review timeout '+log);}
 try{
  let ready=false;for(let i=0;i<100;i++){try{const r=await fetch(base+'/api/health');if(r.ok){ready=true;break;}}catch{}await sleep(30);}assert.equal(ready,true,log);
  assert.equal((await request('/api/portfolio',{authorization:''})).status,401);
  const project=(await request('/api/portfolio/projects',{method:'POST',body:{title:'Protected project'}})).value.project;
  const privateProject=(await request('/api/portfolio/projects',{method:'POST',body:{title:'Other private project'}})).value.project;
  const secret=crypto.randomBytes(18).toString('hex'),user=(await request('/api/users',{method:'POST',body:{username:'analyst-test',password:secret}})).value.user;
  const analyst='Basic '+Buffer.from(`analyst-test:${secret}`).toString('base64');
  await request(`/api/users/${user.id}/memberships`,{method:'POST',body:{projectId:project.id,role:'analysis'}});
  const visible=await request('/api/portfolio',{authorization:analyst});assert.deepEqual(visible.value.projects.map(p=>p.id),[project.id]);
  assert.equal((await request(`/api/portfolio/projects/${privateProject.id}/phases`,{method:'POST',authorization:analyst,body:{title:'Malicious phase'}})).status,403);
  const phase=(await request(`/api/portfolio/projects/${project.id}/phases`,{method:'POST',body:{title:'Phase'}})).value.item;
  const feature=(await request(`/api/portfolio/projects/${project.id}/features`,{method:'POST',body:{phaseId:phase.id,title:'Feature'}})).value.item;
  const task=(await request(`/api/portfolio/projects/${project.id}/tasks`,{method:'POST',body:{featureId:feature.id,title:'Review task',description:'Test protected review workflow',mode:'demo'}})).value.item;
  const controller=new AbortController();const sse=await fetch(base+`/api/projects/${task.runId}/events`,{headers:{authorization:analyst},signal:controller.signal});assert.equal(sse.status,200);const reader=sse.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/connected/);
  await request(`/api/projects/${task.runId}/start`,{method:'POST'});assert.match(new TextDecoder().decode((await reader.read()).value),/update|progress/);controller.abort();await reader.cancel().catch(()=>{});
  let run=await reviewReady(task.runId,'analysis');
  assert.equal((await request(`/api/projects/${task.runId}/tasks/backend/reopen`,{method:'POST',authorization:analyst,body:{comment:'Unauthorized reopen'}})).status,403);
  assert.equal((await request(`/api/projects/${task.runId}/tasks/backend/review`,{method:'POST',authorization:analyst,body:{action:'approve'}})).status,403);
  assert.equal((await request(`/api/projects/${task.runId}/tasks/analysis/review`,{method:'POST',authorization:analyst,body:{action:'approve',revisionId:'wrong'}})).status,400);
  assert.equal((await request(`/api/projects/${task.runId}/tasks/analysis/review`,{method:'POST',authorization:analyst,body:{action:'approve',revisionId:run.tasks[0].revisions.at(-1).id,reviewer:'spoofed-admin'}})).status,200);
  run=await reviewReady(task.runId,'backend');assert.equal(run.tasks[0].reviews[0].reviewer,'analyst-test');
  const reconnect=new AbortController();const again=await fetch(base+`/api/projects/${task.runId}/events`,{headers:{authorization:analyst},signal:reconnect.signal});const reader2=again.body.getReader();assert.match(new TextDecoder().decode((await reader2.read()).value),/connected/);reconnect.abort();await reader2.cancel().catch(()=>{});
  await sleep(50);const audit=(await fs.readFile(path.join(root,'audit.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.ok(audit.some(e=>e.actor==='analyst-test'&&e.status===403));assert.ok(audit.some(e=>e.actor==='analyst-test'&&e.path.endsWith('/analysis/review')&&e.status===200));
 }finally{proc.kill('SIGTERM');await once(proc,'exit');await fs.rm(root,{recursive:true,force:true});}
});
