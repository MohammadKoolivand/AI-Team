import {authenticatedFetch,testAuthEnv} from './http-test-auth.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';

const dir=await fs.mkdtemp(path.join(os.tmpdir(),'teamforge-http-'));
const port=18787,base=`http://127.0.0.1:${port}`;
const proc=spawn(process.execPath,['apps/server/server.mjs'],{env:{...process.env,...testAuthEnv,PORT:String(port),DATA_DIR:dir},stdio:['ignore','pipe','pipe']});
let logs='';proc.stderr.on('data',d=>logs+=d.toString());
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function waitOnline(){for(let i=0;i<80;i++){try{const r=await authenticatedFetch(`${base}/api/health`);if(r.ok)return;}catch{}await sleep(90);}throw Error('API failed to start: '+logs);}
async function req(path,init){const r=await authenticatedFetch(base+path,init);const b=await r.json();assert.equal(r.status,200,JSON.stringify(b));return b;}
async function awaitReview(id,stage){for(let i=0;i<170;i++){const {project}=await req(`/api/projects/${id}`);if(project.status==='failed')throw Error(JSON.stringify(project.events.slice(-2)));if(project.status==='awaiting_review'&&project.tasks.find(t=>t.id===stage)?.status==='awaiting_review')return project;await sleep(60);}throw Error(`Timed out waiting for ${stage}`);}
const json=data=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
try{
 await waitOnline();
 const create=await authenticatedFetch(`${base}/api/projects`,json({title:'API integration demo',description:'Create an example React and Node task management app',mode:'demo'}));
 assert.equal(create.status,201);const {project}=await create.json();
 await req(`/api/projects/${project.id}/start`,{method:'POST'});
 const initial=await awaitReview(project.id,'analysis');
 const diff=await req(`/api/projects/${project.id}/tasks/analysis/diff?path=docs%2Farchitecture.md`);
 assert.equal(diff.diff.type,'added');
 await req(`/api/projects/${project.id}/tasks/analysis/review`,json({revisionId:initial.tasks[0].revisions.at(-1).id,action:'request_changes',comment:'Please revise the architecture'}));
 const revised=await awaitReview(project.id,'analysis');assert.equal(revised.tasks[0].attempts,2);
 for(const stage of ['analysis','backend','frontend','qa']){
  const current=await awaitReview(project.id,stage);
  await req(`/api/projects/${project.id}/tasks/${stage}/review`,json({action:'approve',revisionId:current.tasks.find(t=>t.id===stage).revisions.at(-1).id}));
 }
 const finished=(await req(`/api/projects/${project.id}`)).project;
 assert.equal(finished.status,'completed');
 const {files}=await req(`/api/projects/${project.id}/files`);
 assert(files.includes('frontend/src/main.jsx'));assert(files.includes('docs/qa-report.md'));
 const chosen=await req(`/api/projects/${project.id}/file?path=docs%2Farchitecture.md`);
 assert(chosen.content.includes('معماری'));
 const blocked=await authenticatedFetch(`${base}/api/projects/${project.id}/file?path=..%2Fstate.json`);
 assert.notEqual(blocked.status,200);
 const zip=await authenticatedFetch(`${base}/api/projects/${project.id}/download`);
 assert.equal(zip.status,200);const bytes=Buffer.from(await zip.arrayBuffer());assert.equal(bytes.subarray(0,2).toString(),'PK');
 console.log(`HTTP smoke PASS: 4 sequential stages, comment-triggered revision, per-stage approval, ${files.length} files, ZIP ${bytes.length} bytes.`);
}finally{proc.kill('SIGTERM');await fs.rm(dir,{recursive:true,force:true});}
