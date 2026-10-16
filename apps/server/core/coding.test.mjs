import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import {git} from './git.mjs';
import {safeRead,applyExactPatch,searchWorkspace} from './coding-files.mjs';
import {runSandboxCommand} from './sandbox.mjs';

const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(){
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'teamforge-v04-test-'));const source=path.join(tmp,'src-repo');await fs.mkdir(source);
 for(const [name,content] of Object.entries({'package.json':JSON.stringify({name:'fixture',scripts:{test:'node --test',build:'node --check src/App.js'}},null,2),
 'backend/src/server.mjs':'export function greeting(){ return "old"; }\n','src/App.js':'export const label = "Old UI";\n','README.md':'# Fixture project\nFeature greeting\n'})){
 const p=path.join(source,name);await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,content);
 }
 await git(['init',source]);await git(['-C',source,'add','.']);await git(['-C',source,'-c','user.name=Testing','-c','user.email=test@example.invalid','commit','-m','initial']);
 return{tmp,source};
}
async function waitReview(store,id,stage){for(let i=0;i<150;i++){const p=store.getProject(id);if(p.status==='failed')throw Error(JSON.stringify(p.tasks.find(x=>x.status==='failed')));if(p.tasks.find(t=>t.id===stage).status==='awaiting_review')return p;await delay(35);}throw Error('Timed out on '+stage);}

test('local Git import is constrained, uses independent worktree and applies precise patches',async()=>{
 const {tmp,source}=await fixture();
 try{
  const {importRepository,gitSummary}=await import('./git.mjs');
  process.env.TEAMFORGE_IMPORT_ROOTS=tmp;
  const root=path.join(tmp,'state');const id=crypto.randomUUID();const rep=await importRepository(root,id,{kind:'local',path:source});
  assert.match(rep.branch,/^teamforge\//);assert.equal(rep.head.length,40);
  assert.equal(await safeRead(rep.workspace,'src/App.js'),'export const label = "Old UI";\n');
  assert.equal((await searchWorkspace(rep.workspace,'Old UI'))[0].path,'src/App.js');
  const p=await applyExactPatch(rep.workspace,'frontend',{path:'src/App.js',search:'Old UI',replace:'New UI'});
  assert.equal(p.after.includes('New UI'),true);
  assert.match((await gitSummary(rep.workspace)).join(''),/src\/App\.js/);
  assert.equal(await fs.readFile(path.join(source,'src/App.js'),'utf8'),'export const label = "Old UI";\n');
  await assert.rejects(applyExactPatch(rep.workspace,'frontend',{path:'backend/src/server.mjs',search:'old',replace:'hack'}),/مجاز/);
  await assert.rejects(applyExactPatch(rep.workspace,'frontend',{path:'../foo',search:'',replace:'hack'}));
  await assert.rejects(applyExactPatch(rep.workspace,'frontend',{path:'.env',search:'',replace:'hack'}));
  await fs.symlink(path.join(tmp,'outside'),path.join(rep.workspace,'src/link'));
  await assert.rejects(applyExactPatch(rep.workspace,'frontend',{path:'src/link/hack.js',search:'',replace:'hack'}),/Symlink/);
  const r=await runSandboxCommand(rep.workspace,{key:'rm -rf /'}).catch(e=>({error:e.message}));assert.match(r.error,/فهرست/);
 }finally{await fs.rm(tmp,{recursive:true,force:true});}
});

test('mock local Ollama performs actual sequential code changes with human review gates',async()=>{
 const {tmp,source}=await fixture();const calls={};
 const server=http.createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;
  const body=JSON.parse(raw);const system=body.messages[0].content;
  const role=['analyst','backend','frontend','qa'].find(s=>system.includes(`'s ${s} coding agent`));
  calls[role]=(calls[role]||0)+1;const n=calls[role];let action;
  if(role==='analyst')action=n===1?{action:'read_file',path:'README.md'}:n===2?{action:'apply_patch',path:'docs/teamforge/analysis.md',search:'',replace:'# Architecture\nAPI + UI.\n'}:{action:'finish',summary:'Analyzed existing repository'};
  else if(role==='backend')action=n===1?{action:'search_code',query:'greeting'}:n===2?{action:'apply_patch',path:'backend/src/server.mjs',search:'"old"',replace:'"new"'}:n===3?{action:'finish',summary:'Backend API changed'}:n===4?{action:'read_file',path:'backend/src/server.mjs'}:n===5?{action:'apply_patch',path:'backend/src/server.mjs',search:'"new"',replace:'"reviewed"'}:{action:'finish',summary:'Backend reviewer changes applied'};
  else if(role==='frontend')action=n===1?{action:'read_file',path:'src/App.js'}:n===2?{action:'apply_patch',path:'src/App.js',search:'"Old UI"',replace:'"New UI"'}:{action:'finish',summary:'Frontend changed'};
  else action={action:'finish',summary:'QA reviewed tests'};
  res.writeHead(200,{'Content-Type':'application/x-ndjson'});res.write(JSON.stringify({message:{content:JSON.stringify(action)},done:false})+'\n');res.end(JSON.stringify({done:true})+'\n');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  process.env.OLLAMA_URL=`http://127.0.0.1:${server.address().port}`;
  process.env.TEAMFORGE_IMPORT_ROOTS=tmp;
  const {Engine}=await import('./engine.mjs');const {Store}=await import('./store.mjs');
  const store=new Store(path.join(tmp,'runtime'));await store.init();const engine=new Engine(store);
  const p=await store.create({title:'Sample project',description:'Change backend and frontend greeting',mode:'ollama'});
  await engine.importRepo(p.id,{kind:'local',path:source});await engine.start(p.id);
  let current=await waitReview(store,p.id,'analysis');assert.equal(current.tasks[1].attempts,0);
  await engine.review(p.id,'analysis',{action:'approve'});
  current=await waitReview(store,p.id,'backend');assert.equal(current.tasks[2].attempts,0);
  assert.equal(await safeRead(engine.workspace(p.id),'backend/src/server.mjs'),'export function greeting(){ return "new"; }\n');
  await engine.review(p.id,'backend',{action:'request_changes',comment:'Return reviewed response'});
  current=await waitReview(store,p.id,'backend');assert.equal(current.tasks[1].attempts,2);
  assert.equal(await safeRead(engine.workspace(p.id),'backend/src/server.mjs'),'export function greeting(){ return "reviewed"; }\n');
  await engine.review(p.id,'backend',{action:'approve'});
  current=await waitReview(store,p.id,'frontend');assert.equal(current.tasks[3].attempts,0);
  assert.equal(await safeRead(engine.workspace(p.id),'src/App.js'),'export const label = "New UI";\n');
  await engine.review(p.id,'frontend',{action:'approve'});
  current=await waitReview(store,p.id,'qa');assert.ok(current.tasks[3].checks.length>0);
  await engine.review(p.id,'qa',{action:'approve'});
  assert.equal(store.getProject(p.id).status,'completed');
  assert.equal(await fs.readFile(path.join(source,'src/App.js'),'utf8'),'export const label = "Old UI";\n');
  assert.match(await safeRead(engine.workspace(p.id),'docs/teamforge/qa-report.md'),/SKIPPED|PASSED|FAILED/);
 }finally{server.close();delete process.env.OLLAMA_URL;await fs.rm(tmp,{recursive:true,force:true});}
});
