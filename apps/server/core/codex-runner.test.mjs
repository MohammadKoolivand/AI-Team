import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {git} from './git.mjs';
import {runCodexAgent,runCodexProcess,decodeCodexEvent,codexCommand,localhostOllama} from './codex-runner.mjs';
import {Store} from './store.mjs';
import {Engine} from './engine.mjs';
import {safeRead} from './coding-files.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function setup(){
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'teamforge-v05-test-')),repo=path.join(tmp,'repo');
 await fs.mkdir(path.join(repo,'backend'),{recursive:true});
 await fs.mkdir(path.join(repo,'src'),{recursive:true});
 await fs.writeFile(path.join(repo,'backend','api.js'),'export const greeting = "OLD";\n');
 await fs.writeFile(path.join(repo,'src','App.js'),'export const ui = "OLD";\n');
 await fs.writeFile(path.join(repo,'README.md'),'# Test repo\n');
 await fs.writeFile(path.join(repo,'.env'),'DUMMY_SECRET=SHOULD_NOT_BE_IN_CONTEXT\n');
 await git(['init',repo]);await git(['-C',repo,'add','.']);
 await git(['-C',repo,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','baseline']);
 return{tmp,repo};
}
async function waitStage(store,id,stage){
 for(let i=0;i<200;i++){
  const p=store.getProject(id);if(p.status==='failed')throw Error(p.tasks.find(x=>x.status==='failed')?.error);
  if(p.tasks.find(x=>x.id===stage)?.status==='awaiting_review')return p;
  await sleep(20);
 }
 throw Error('Timed out waiting for review');
}
test('Codex CLI args force local OSS Ollama, workspace sandbox and JSON stream',()=>{
 const a=codexCommand('qwen2.5-coder:7b');
 assert.ok(a.includes('--oss'));assert.ok(a.includes('--local-provider'));assert.ok(a.includes('--ignore-user-config'));
 assert.ok(a.includes('workspace-write'));assert.ok(a.includes('--json'));
 assert.ok(!a.includes('--yolo'));assert.ok(!a.includes('--dangerously-bypass-approvals-and-sandbox'));
 assert.equal(decodeCodexEvent({type:'item.completed',item:{type:'reasoning',text:'secret'}}),null);
 const old=process.env.OLLAMA_URL;
 try{process.env.OLLAMA_URL='https://example.org';assert.throws(()=>localhostOllama(),/local HTTP/);}finally{if(old===undefined)delete process.env.OLLAMA_URL;else process.env.OLLAMA_URL=old;}
});

test('CLI JSONL events genuinely stream from a spawned binary, no cloud authentication',async()=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'teamforge-cli-json-'));
 const fake=path.join(tmp,'fake-codex');
 const old=process.env.OLLAMA_URL;
 try{
  await fs.writeFile(fake,`#!/usr/bin/env node
let text='';process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>{
if(!process.argv.includes('--oss')||!process.argv.includes('--local-provider')||!text.includes('Test prompt'))process.exit(42);
console.log(JSON.stringify({type:'thread.started',thread_id:'test'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'npm test'}}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Changed code'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,output_tokens:4}}));
});
`);await fs.chmod(fake,0o755);
  process.env.OLLAMA_URL='http://127.0.0.1:11434';
  const updates=[];
  const r=await runCodexProcess({cwd:tmp,home:path.join(tmp,'home'),bin:fake,prompt:'Test prompt',onProgress:p=>updates.push(p),timeoutMs:5000});
  assert.equal(r.completed,true);assert.equal(r.finalMessage,'Changed code');assert.ok(updates.some(u=>u.phase==='tool'));
 }finally{if(old===undefined)delete process.env.OLLAMA_URL;else process.env.OLLAMA_URL=old;await fs.rm(tmp,{force:true,recursive:true});}
});

test('sanitized stage excludes secrets and unauthorized changes never enter worktree',async()=>{
 const {tmp,repo}=await setup();
 try{
  const roleRunner=async({cwd,prompt})=>{
   await assert.rejects(fs.stat(path.join(cwd,'.env')));
   const before=await fs.readFile(path.join(cwd,'backend/api.js'),'utf8');
   assert.ok(prompt.includes('CURRENT STAGE: backend'));
   await fs.writeFile(path.join(cwd,'backend/api.js'),before.replace('OLD','NEW'));
   await fs.writeFile(path.join(cwd,'src/App.js'),'UNAUTHORIZED\n');
   return{finalMessage:'Trying two paths',events:[]};
  };
  await assert.rejects(runCodexAgent({project:{title:'Test',description:'Feature'},role:'backend',root:repo,runner:roleRunner}),/outside backend scope/);
  assert.equal(await fs.readFile(path.join(repo,'backend/api.js'),'utf8'),'export const greeting = "OLD";\n');
  assert.equal(await fs.readFile(path.join(repo,'src/App.js'),'utf8'),'export const ui = "OLD";\n');
  await assert.rejects(runCodexAgent({project:{title:'Test',description:'Feature'},role:'analyst',root:repo,runner:async({cwd})=>{await fs.writeFile(path.join(cwd,'.env'),'FORBIDDEN');return{events:[]};}}),/ممنوع|نامعتبر|unsafe/);
 }finally{await fs.rm(tmp,{recursive:true,force:true});}
});

test('real sequential TeamForge workflow invokes open-source adapter with revision + comments',async()=>{
 const {tmp,repo}=await setup();const prev=process.env.TEAMFORGE_IMPORT_ROOTS;
 const {Store}=await import('./store.mjs');const {Engine}=await import('./engine.mjs');
 const codexModule=await import('./codex-runner.mjs');
 // A fake executable drives the SAME real subprocess adapter selected by the engine.
 const bin=path.join(tmp,'mock-codex');
 await fs.writeFile(bin,`#!/usr/bin/env node
const fs=require('fs'),path=require('path');
let prompt='';process.stdin.on('data',x=>prompt+=x);process.stdin.on('end',()=>{
const stage=prompt.match(/CURRENT STAGE: (\\w+)/)?.[1];
const f=stage==='analyst'?'docs/teamforge/analysis.md':stage==='backend'?'backend/api.js':stage==='frontend'?'src/App.js':'docs/teamforge/qa-report.md';
fs.mkdirSync(path.dirname(f),{recursive:true});
let current=fs.existsSync(f)?fs.readFileSync(f,'utf8'):'';
if(stage==='analyst')fs.writeFileSync(f,'# Analysis\\nAPI + UI requirements\\n');
if(stage==='backend')fs.writeFileSync(f, prompt.includes('HUMAN REVIEW FEEDBACK: Improve')?current.replace('NEW','REVIEWED'):current.replace('OLD','NEW'));
if(stage==='frontend')fs.writeFileSync(f,current.replace('OLD','NEW'));
if(stage==='qa')fs.writeFileSync(f,'# QA report\\nNo simulated passes\\n');
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Stage complete'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
});
`);await fs.chmod(bin,0o755);
 const oldBin=process.env.TEAMFORGE_CODEX_BIN;
 try{
  process.env.TEAMFORGE_IMPORT_ROOTS=tmp;process.env.TEAMFORGE_CODEX_BIN=bin;
  const store=new Store(path.join(tmp,'state'));await store.init();const engine=new Engine(store);
  const p=await store.create({title:'Feature on existing repo',description:'Add API and client behavior',mode:'ollama',runner:'codex_cli'});
  await assert.rejects(engine.start(p.id),/Git Workspace/);
  await engine.importRepo(p.id,{kind:'local',path:repo});await engine.start(p.id);
  let state=await waitStage(store,p.id,'analysis');assert.equal(state.tasks[1].attempts,0);
  await engine.review(p.id,'analysis',{action:'approve'});
  state=await waitStage(store,p.id,'backend');assert.ok(state.tasks[1].output.includes('backend/api.js'));
  await engine.review(p.id,'backend',{action:'request_changes',comment:'Improve backend response'});
  state=await waitStage(store,p.id,'backend');assert.equal(state.tasks[1].attempts,2);
  assert.match(await safeRead(engine.workspace(p.id),'backend/api.js'),/REVIEWED/);
  await engine.review(p.id,'backend',{action:'approve'});
  state=await waitStage(store,p.id,'frontend');assert.equal(state.tasks[3].attempts,0);
  await engine.review(p.id,'frontend',{action:'approve'});
  state=await waitStage(store,p.id,'qa');assert.ok(state.tasks[3].checks.length);
  await engine.review(p.id,'qa',{action:'approve'});
  assert.equal(store.getProject(p.id).status,'completed');
  assert.match(await fs.readFile(path.join(repo,'backend/api.js'),'utf8'),/OLD/);
 }finally{
  if(prev===undefined)delete process.env.TEAMFORGE_IMPORT_ROOTS;else process.env.TEAMFORGE_IMPORT_ROOTS=prev;
  if(oldBin===undefined)delete process.env.TEAMFORGE_CODEX_BIN;else process.env.TEAMFORGE_CODEX_BIN=oldBin;
  await fs.rm(tmp,{recursive:true,force:true});
 }
});
