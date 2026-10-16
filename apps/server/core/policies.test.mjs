import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {validateRelativeFile,writeAgentFiles,readSafeFile} from './policies.mjs';
import {Store} from './store.mjs';
import {Engine} from './engine.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(store,id,allowed,ms=10000){const stop=Date.now()+ms;while(Date.now()<stop){const p=store.getProject(id);if(allowed.includes(p.status))return p;await sleep(25);}throw Error(`Timed out: ${store.getProject(id).status}`);}

test('role scopes prevent traversal, secrets and symlink writes',async()=>{
 assert.equal(validateRelativeFile('frontend/src/App.jsx','frontend'),'frontend/src/App.jsx');
 assert.equal(validateRelativeFile('docs/architecture.md','analyst'),'docs/architecture.md');
 for(const value of ['../etc/passwd','frontend/../../etc/passwd','frontend/.env','backend/server.mjs','/tmp/f'])assert.throws(()=>validateRelativeFile(value,'frontend'));
 assert.throws(()=>validateRelativeFile('backend/index.mjs','analyst'));
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'tf-security-'));
 try{
  await writeAgentFiles(root,'frontend',[{path:'frontend/ok.jsx',content:'ok'}]);
  assert.equal(await readSafeFile(root,'frontend/ok.jsx'),'ok');
  await fs.symlink(os.tmpdir(),path.join(root,'frontend','link'));
  await assert.rejects(writeAgentFiles(root,'frontend',[{path:'frontend/link/pwn.jsx',content:'x'}]));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('strict human-gated sequential pipeline, comments, edits, diffs and final approval',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tf-engine-'));
 try{
  const store=new Store(dir);await store.init();const engine=new Engine(store);
  const created=await store.create({title:'Task Manager',description:'A basic task management application with a frontend and API',mode:'demo'});
  await engine.start(created.id);
  let p=await until(store,created.id,['awaiting_review','failed']);
  assert.equal(p.status,'awaiting_review');
  assert.deepEqual(p.tasks.map(t=>t.status),['awaiting_review','pending','pending','pending']);
  assert.equal(p.tasks[0].revisions[0].changes.length,2);
  const old=await readSafeFile(engine.workspace(created.id),'docs/architecture.md');
  await engine.edit(created.id,'analysis',{filePath:'docs/architecture.md',content:old+'\n## Extra reviewed section\n'});
  const updated=engine.diff(created.id,'analysis','docs/architecture.md');
  assert.match(updated.after,/Extra reviewed/);
  await engine.review(created.id,'analysis',{action:'request_changes',comment:'Please improve the architecture and edge cases.',filePath:'docs/architecture.md',line:3});
  p=await until(store,created.id,['awaiting_review','failed']);
  assert.equal(p.tasks[0].attempts,2);
  assert.equal(p.tasks[1].status,'pending');
  await engine.review(created.id,'analysis',{action:'approve'});
  p=await until(store,created.id,['awaiting_review','failed']);
  assert.equal(p.tasks[1].status,'awaiting_review');
  assert.equal(p.tasks[2].status,'pending');
  await engine.review(created.id,'backend',{action:'approve'});
  p=await until(store,created.id,['awaiting_review','failed']);
  assert.equal(p.tasks[2].status,'awaiting_review');
  assert.equal(p.tasks[3].status,'pending');
  await engine.review(created.id,'frontend',{action:'approve'});
  p=await until(store,created.id,['awaiting_review','failed']);
  assert.equal(p.tasks[3].status,'awaiting_review',JSON.stringify(p.events.slice(-2)));
  assert.equal(p.quality.passed,true);
  assert.equal((await fs.readFile(path.join(engine.workspace(created.id),'frontend/src/main.jsx'),'utf8')).includes('createRoot'),true);
  assert.notEqual(p.status,'completed');
  await engine.review(created.id,'qa',{action:'approve',comment:'Confirmed'});
  p=store.getProject(created.id);
  assert.equal(p.status,'completed');
  assert.equal(p.tasks.filter(t=>t.status==='approved').length,4);
  assert.equal(p.tasks[0].reviews.length,2);
  await assert.rejects(engine.review(created.id,'analysis',{action:'approve'}));
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
