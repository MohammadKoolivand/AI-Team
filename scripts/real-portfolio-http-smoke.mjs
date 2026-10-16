import {authenticatedFetch,testAuthEnv} from './http-test-auth.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {git} from '../apps/server/core/git.mjs';

const baseDir=await fs.mkdtemp(path.join(os.tmpdir(),'teamforge-real-http-'));
const repo=path.join(baseDir,'source');const dataDir=path.join(baseDir,'data');
await fs.mkdir(path.join(repo,'backend'),{recursive:true});
await fs.mkdir(path.join(repo,'src'));
await fs.writeFile(path.join(repo,'README.md'),'# HTTP fixture\n');
await fs.writeFile(path.join(repo,'backend','server.mjs'),'export const hello = "old";\n');
await fs.writeFile(path.join(repo,'src','App.js'),'export const greeting = "old";\n');
await git(['init',repo]);await git(['-C',repo,'add','.']);await git(['-C',repo,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','initial']);
const counts={};
const mock=http.createServer(async(req,res)=>{
 if(req.url==='/api/tags'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({models:[{name:'qwen2.5-coder:7b'}]}));return;}
 let raw='';for await(const d of req)raw+=d;
 const body=JSON.parse(raw),system=body.messages[0].content;
 const role=['analyst','backend','frontend','qa'].find(x=>system.includes(`'s ${x} coding agent`));
 counts[role]=(counts[role]||0)+1;
 const action=role==='analyst'?counts[role]===1?{action:'apply_patch',path:'docs/teamforge/plan.md',search:'',replace:'# Plan\n'}:{action:'finish',summary:'Analyzed'}:
 role==='backend'?counts[role]===1?{action:'apply_patch',path:'backend/server.mjs',search:'"old"',replace:'"new"'}:{action:'finish',summary:'Backend'}:
 role==='frontend'?counts[role]===1?{action:'apply_patch',path:'src/App.js',search:'"old"',replace:'"new"'}:{action:'finish',summary:'Frontend'}:
 {action:'finish',summary:'QA check'};
 res.writeHead(200,{'Content-Type':'application/x-ndjson'});
 res.write(JSON.stringify({message:{content:JSON.stringify(action)},done:false})+'\n');res.end(JSON.stringify({done:true})+'\n');
});
await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
const port=18793,base=`http://127.0.0.1:${port}`;
const child=spawn(process.execPath,['apps/server/server.mjs'],{cwd:process.cwd(),env:{...process.env,...testAuthEnv,PORT:String(port),DATA_DIR:dataDir,TEAMFORGE_IMPORT_ROOTS:baseDir,OLLAMA_URL:`http://127.0.0.1:${mock.address().port}`,OLLAMA_MODEL:'qwen2.5-coder:7b'},stdio:['ignore','pipe','pipe']});
let logs='';child.stderr.on('data',x=>logs+=x.toString());
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const post=x=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(x)});
async function request(route,opt){const r=await authenticatedFetch(base+route,opt);const j=await r.json();assert(r.ok,`${r.status} ${JSON.stringify(j)} ${logs}`);return j;}
async function stage(id,name){for(let i=0;i<250;i++){const p=(await request(`/api/projects/${id}`)).project;const current=p.tasks.find(x=>x.id===name);if(current?.status==='awaiting_review')return p;if(current?.status==='failed')throw Error(`${name} failed: ${current.error} ${logs}`);await wait(35);}throw Error(`${name} timeout ${logs}`);}
try{
 let started=false;for(let i=0;i<150;i++){try{if((await authenticatedFetch(base+'/api/health')).ok){started=true;break;}}catch{}await wait(40);}assert(started,'API startup failed '+logs);
 const model=(await request('/api/model/health'));assert.equal(model.connected,true);assert.equal(model.modelInstalled,true);
 const org=(await request('/api/portfolio/projects',post({title:'Live Sample',description:'test local repo'}))).project;
 const linked=(await request(`/api/portfolio/projects/${org.id}/repository`,post({kind:'local',path:repo}))).repository;
 assert.match(linked.head,/^[a-f0-9]{40}$/);
 const phase=(await request(`/api/portfolio/projects/${org.id}/phases`,post({title:'Phase One'}))).item;
 const feature=(await request(`/api/portfolio/projects/${org.id}/features`,post({phaseId:phase.id,title:'Feature One'}))).item;
 const item=(await request(`/api/portfolio/projects/${org.id}/tasks`,post({featureId:feature.id,title:'Update greeting',description:'Change backend and frontend greeting and test it.',mode:'ollama',runner:'builtin'}))).item;
 await stage(item.runId,'analysis');
 for(const s of ['analysis','backend','frontend','qa']){
  const before=(await request(`/api/projects/${item.runId}`)).project;
  assert.equal(before.tasks.find(t=>t.id===s).status,'awaiting_review');
  await request(`/api/projects/${item.runId}/tasks/${s}/review`,post({revisionId:before.tasks.find(t=>t.id===s).revisions.at(-1).id,action:'approve',reviewer:'HTTP Human Reviewer'}));
  if(s!=='qa')await stage(item.runId,({analysis:'backend',backend:'frontend',frontend:'qa'})[s]);
 }
 const final=(await request(`/api/projects/${item.runId}`)).project;
 assert.equal(final.status,'completed');
 assert.equal(await fs.readFile(path.join(repo,'backend/server.mjs'),'utf8'),'export const hello = "old";\n');
 const state=(await request('/api/portfolio')).projects.find(x=>x.id===org.id);
 assert.equal(state.phases[0].features[0].tasks[0].stage,'completed');
 console.log('MOCK MODEL / REAL FILE HTTP smoke PASS: Git link -> task auto-start -> local-model tool actions -> 4 human approvals -> completed; original Git unchanged.');
}finally{
 child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));
 await new Promise(resolve=>mock.close(resolve));await fs.rm(baseDir,{recursive:true,force:true});
}
