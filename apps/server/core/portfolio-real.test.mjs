import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {git} from './git.mjs';
import {Store} from './store.mjs';
import {Engine} from './engine.mjs';
import {Portfolio} from './portfolio.mjs';

const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function ready(store,id,stage){
 const until=Date.now()+15000;
 while(Date.now()<until){
  const run=store.getProject(id);
  if(run.status==='failed')throw Error(`${stage} failed: ${run.tasks.find(x=>x.status==='failed')?.error}`);
  if(run.tasks.find(x=>x.id===stage)?.status==='awaiting_review')return run;
  await wait(30);
 }
 throw Error(`${stage}: timeout`);
}

test('organization Git connection, two independent real tasks, Ollama agent changes, human gates',async()=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'teamforge-real-e2e-'));
 const repo=path.join(tmp,'fixture'),root=path.join(tmp,'data');await fs.mkdir(repo);
 await fs.mkdir(path.join(repo,'backend','src'),{recursive:true});await fs.mkdir(path.join(repo,'src'));
 await fs.writeFile(path.join(repo,'README.md'),'# sample\n');
 await fs.writeFile(path.join(repo,'backend','src','server.mjs'),`export const status = 'old';\n`);
 await fs.writeFile(path.join(repo,'src','App.jsx'),`export const title = 'old';\n`);
 await git(['init',repo]);await git(['-C',repo,'add','.']);
 await git(['-C',repo,'-c','user.name=Tester','-c','user.email=test@invalid.test','commit','-m','fixture']);
 const oldRoots=process.env.TEAMFORGE_IMPORT_ROOTS,oldOllama=process.env.OLLAMA_URL;
 const calls=new Map();
 const llm=http.createServer(async(req,res)=>{
  if(req.url!=='/api/chat'){res.writeHead(404).end();return;}
  let raw='';for await(const chunk of req)raw+=chunk;
  const b=JSON.parse(raw),system=b.messages[0].content;
  const role=['analyst','backend','frontend','qa'].find(x=>system.includes(`'s ${x} coding agent`));
  const message=b.messages.find(m=>m.role==='user')?.content||'';
  const item=message.includes('Task: alpha')?'alpha':'beta',key=`${item}/${role}`;
  const step=(calls.get(key)||0)+1;calls.set(key,step);
  let action;
  if(role==='analyst')action=step%2===1?{action:'apply_patch',path:`docs/teamforge/${item}.md`,search:'',replace:`# ${item} analyzed\n`}:{action:'finish',summary:'Analysis complete'};
  else if(role==='backend')action=step%2===1?{action:'apply_patch',path:`backend/src/${item}.mjs`,search:'',replace:`export const task = '${item}';\n`}:{action:'finish',summary:'Backend complete'};
  else if(role==='frontend')action=step%2===1?{action:'apply_patch',path:`src/${item}.jsx`,search:'',replace:`export const title = '${item}';\n`}:{action:'finish',summary:'Frontend complete'};
  else action={action:'finish',summary:'QA complete'};
  res.writeHead(200,{'Content-Type':'application/x-ndjson'});
  res.write(JSON.stringify({message:{content:JSON.stringify(action)},done:false})+'\n');
  res.end(JSON.stringify({done:true})+'\n');
 });
 await new Promise(r=>llm.listen(0,'127.0.0.1',r));
 try{
  process.env.TEAMFORGE_IMPORT_ROOTS=tmp;
  process.env.OLLAMA_URL=`http://127.0.0.1:${llm.address().port}`;
  const store=new Store(root);await store.init();const engine=new Engine(store);const board=new Portfolio(root,store,engine);await board.init();
  const project=await board.addProject({title:'Demo real project',description:'Two work items on same repository'});
  await assert.rejects(board.attachRepository(project.id,{kind:'local',path:'/etc'}),/خارج|مخزن|مسیر/);
  const linked=await board.attachRepository(project.id,{kind:'local',path:repo});
  assert.match(linked.head,/^[0-9a-f]{40}$/);
  const phase=await board.addPhase(project.id,{title:'Phase one'});
  const feature=await board.addFeature(project.id,{phaseId:phase.id,title:'Tracking requests'});
  const alpha=await board.addTask(project.id,{featureId:feature.id,title:'alpha',description:'Implement alpha function in API and UI.',mode:'ollama'});
  const beta=await board.addTask(project.id,{featureId:feature.id,title:'beta',description:'Implement beta function in API and UI.',mode:'ollama'});
  const ar=await ready(store,alpha.runId,'analysis'),br=await ready(store,beta.runId,'analysis');
  assert.equal(ar.repository.kind,'local');assert.notEqual(ar.repository.branch,br.repository.branch);
  const awork=engine.workspace(alpha.runId),bwork=engine.workspace(beta.runId);
  assert.equal(await fs.readFile(path.join(awork,'docs/teamforge/alpha.md'),'utf8'),'# alpha analyzed\n');
  await assert.rejects(fs.readFile(path.join(bwork,'docs/teamforge/alpha.md')),{code:'ENOENT'});
  assert.equal(await fs.readFile(path.join(repo,'README.md'),'utf8'),'# sample\n');
  await engine.review(alpha.runId,'analysis',{action:'approve',reviewer:'Human analyst'});
  await ready(store,alpha.runId,'backend');
  assert.equal(store.getProject(beta.runId).tasks.find(s=>s.id==='backend').status,'pending','beta cannot advance without its own human review');
  await engine.review(alpha.runId,'backend',{action:'approve',reviewer:'Backend developer'});
  await ready(store,alpha.runId,'frontend');
  await engine.review(alpha.runId,'frontend',{action:'approve',reviewer:'Frontend developer'});
  await ready(store,alpha.runId,'qa');
  await engine.review(alpha.runId,'qa',{action:'approve',reviewer:'Human QA'});
  assert.equal(store.getProject(alpha.runId).status,'completed');
  assert.equal(store.getProject(beta.runId).status,'awaiting_review');
  assert.equal(await fs.readFile(path.join(repo,'backend/src/server.mjs'),'utf8'),`export const status = 'old';\n`);
  assert.equal(await fs.readFile(path.join(awork,'backend/src/alpha.mjs'),'utf8'),`export const task = 'alpha';\n`);
  assert.equal(await fs.readFile(path.join(awork,'src/alpha.jsx'),'utf8'),`export const title = 'alpha';\n`);
  const changed=store.getProject(alpha.runId).tasks.find(s=>s.id==='frontend').revisions[0].changes;
  assert.ok(changed.some(x=>x.path==='src/alpha.jsx'));
  assert.equal(board.snapshot()[0].repository.path,await fs.realpath(repo));
  const recreated=new Portfolio(root,store,engine);await recreated.init();assert.equal(recreated.snapshot()[0].phases[0].features[0].tasks.length,2);
 }finally{
  await new Promise(resolve=>llm.close(resolve));await wait(300);if(oldRoots===undefined)delete process.env.TEAMFORGE_IMPORT_ROOTS;else process.env.TEAMFORGE_IMPORT_ROOTS=oldRoots;
  if(oldOllama===undefined)delete process.env.OLLAMA_URL;else process.env.OLLAMA_URL=oldOllama;
  await fs.rm(tmp,{recursive:true,force:true});
 }
});
