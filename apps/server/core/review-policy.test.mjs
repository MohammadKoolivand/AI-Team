import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Store} from './store.mjs';
import {Engine} from './engine.mjs';
import {Portfolio} from './portfolio.mjs';
import {git} from './git.mjs';
import {writeObservedFile} from './coding-files.mjs';

test('legacy empty backend review is not approvable and can be rerun without resetting approved analysis',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'teamforge-legacy-empty-')),previous=process.env.TEAMFORGE_IMPORT_ROOTS;
 try{
  const source=path.join(root,'source');await git(['init',source]);await git(['-C',source,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','fixture']);process.env.TEAMFORGE_IMPORT_ROOTS=root;
  const data=path.join(root,'data'),store=new Store(data);await store.init();const engine=new Engine(store),board=new Portfolio(data,store,engine),p=await store.create({title:'Loans',description:'Implement eligibility',mode:'ollama'});await engine.importRepo(p.id,{kind:'local',path:source});
  await writeObservedFile(engine.workspace(p.id),'analyst',{path:'docs/teamforge/analysis.md',content:'# Approved analysis'},new Map());const hash=await engine.revisionHash(p.id);
  await store.mutate(p.id,x=>{x.status='awaiting_review';x.tasks[0].status='approved';x.tasks[1].status='awaiting_review';x.tasks[1].revisions.push({id:'legacy-zero',source:'agent',changes:[],workspaceHash:hash});});
  await assert.rejects(engine.review(p.id,'backend',{action:'approve',revisionId:'legacy-zero'}),/تغییر اجرایی/);assert.equal(store.getProject(p.id).tasks[2].status,'pending');
  engine.performRole=async(project,role,workspace)=>{assert.equal(role,'backend');const change=await writeObservedFile(workspace,role,{path:'backend/eligibility.mjs',content:'export const eligible=score=>score>=600;'},new Map());return{files:[change.path],changes:[change],checks:[],message:'Implemented actual code'};};
  await engine.review(p.id,'backend',{action:'request_changes',revisionId:'legacy-zero',comment:'Implement code; do not edit analysis'});await board.waitForReview(p.id,'backend');
  const repaired=store.getProject(p.id);assert.equal(repaired.tasks[0].status,'approved');assert.equal(repaired.tasks[1].status,'awaiting_review');assert.ok(repaired.tasks[1].revisions.at(-1).changes.some(c=>c.path==='backend/eligibility.mjs'));assert.equal(repaired.tasks[2].status,'pending');assert.equal(await fs.readFile(path.join(source,'README.md')).catch(()=>null),null);
 }finally{if(previous===undefined)delete process.env.TEAMFORGE_IMPORT_ROOTS;else process.env.TEAMFORGE_IMPORT_ROOTS=previous;await fs.rm(root,{recursive:true,force:true});}
});

test('previously approved empty backend can be explicitly reopened, preserving reviews and invalidating dependent empty frontend review',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'teamforge-reopen-empty-')),previous=process.env.TEAMFORGE_IMPORT_ROOTS;
 try{
  const source=path.join(root,'source');await git(['init',source]);await git(['-C',source,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','fixture']);process.env.TEAMFORGE_IMPORT_ROOTS=root;
  const data=path.join(root,'data'),store=new Store(data);await store.init();const engine=new Engine(store),board=new Portfolio(data,store,engine),p=await store.create({title:'Loans',description:'Backend eligibility and frontend form',mode:'ollama'});await engine.importRepo(p.id,{kind:'local',path:source});
  await writeObservedFile(engine.workspace(p.id),'analyst',{path:'docs/teamforge/analysis.md',content:'# Approved analysis'},new Map());const hash=await engine.revisionHash(p.id);
  await store.mutate(p.id,x=>{x.status='awaiting_review';x.tasks[0].status='approved';x.tasks[1].status='approved';x.tasks[1].reviews.push({id:'prior-approval',action:'approve',reviewer:'Human'});x.tasks[1].revisions.push({id:'empty-backend',source:'agent',changes:[],workspaceHash:hash});x.tasks[2].status='awaiting_review';x.tasks[2].revisions.push({id:'empty-frontend',source:'agent',changes:[],workspaceHash:hash});});
  await assert.rejects(engine.review(p.id,'frontend',{action:'approve',revisionId:'empty-frontend'}),/قبلاً بدون کد/);
  await store.mutate(p.id,x=>{x.status='interrupted';x.tasks[2].status='pending';});
  await assert.rejects(engine.start(p.id),/قبلاً بدون کد/);
  assert.equal(store.getProject(p.id).status,'interrupted');
  engine.performRole=async(project,role,workspace)=>{assert.equal(role,'backend');const change=await writeObservedFile(workspace,role,{path:'backend/eligibility.mjs',content:'export const eligible=score=>score>=600;'},new Map());return{files:[change.path],changes:[change],checks:[],message:'Implemented actual code'};};
  await engine.reopenImplementation(p.id,'backend',{reviewer:'Human backend',comment:'Reopen legacy approval without implementation'});await board.waitForReview(p.id,'backend');
  const result=store.getProject(p.id);assert.equal(result.tasks[0].status,'approved');assert.equal(result.tasks[1].status,'awaiting_review');assert.equal(result.tasks[1].reviews[0].id,'prior-approval');assert.ok(result.tasks[1].reviews.some(r=>r.action==='reopen'));assert.equal(result.tasks[2].status,'pending');assert.equal(result.tasks[2].revisions[0].id,'empty-frontend');assert.equal(await fs.readFile(path.join(engine.workspace(p.id),'docs/teamforge/analysis.md'),'utf8'),'# Approved analysis');assert.equal(await git(['-C',source,'status','--porcelain']),'');
  await assert.rejects(engine.reopenImplementation(p.id,'analysis'),/فقط مرحله/);
 }finally{if(previous===undefined)delete process.env.TEAMFORGE_IMPORT_ROOTS;else process.env.TEAMFORGE_IMPORT_ROOTS=previous;await fs.rm(root,{recursive:true,force:true});}
});
