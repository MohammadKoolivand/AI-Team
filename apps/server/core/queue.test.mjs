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

test('bulk tasks form durable FIFO queue, wait for human stages and publication; delete, restore, fresh source at dispatch',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'teamforge-queue-')),oldRoots=process.env.TEAMFORGE_IMPORT_ROOTS,oldPublish=process.env.TEAMFORGE_AUTO_PUBLISH;
 try{
  process.env.TEAMFORGE_IMPORT_ROOTS=root;process.env.TEAMFORGE_AUTO_PUBLISH='0';
  const source=path.join(root,'source');await git(['init',source]);await git(['-C',source,'-c','user.name=Fixture','-c','user.email=f@example.invalid','commit','--allow-empty','-m','base']);
  const store=new Store(path.join(root,'data'));await store.init();const engine=new Engine(store),board=new Portfolio(store.dataDir,store,engine);await board.init();
  const p=await board.addProject({title:'Queued project',queueMode:'sequential'});await board.attachRepository(p.id,{kind:'local',path:source});
  engine.performRole=async(project,role,workspace)=>{const file={analyst:'docs/teamforge/analysis.md',backend:'backend/api.mjs',frontend:'frontend/app.mjs',qa:'docs/teamforge/qa.md'}[role];const change=await writeObservedFile(workspace,role,{path:file,content:`${role}: ${project.id}`},new Map());return{files:[file],changes:[change],checks:[],message:'Fixture output'};};
  await assert.rejects(board.enqueue(p.id,{tasks:['valid','']}));assert.equal(store.getProjects().length,0);
  const tasks=await board.enqueue(p.id,{tasks:['First task','Second task','Third task']});assert.equal(board.snapshot()[0].phases[0].features[0].tasks.length,3);
  assert.equal(store.getProject(tasks[1].runId).repository,null);
  await Promise.all([board.dispatch(),board.dispatch()]);await board.waitForReview(tasks[0].runId,'analysis');
  assert.equal(store.getProject(tasks[1].runId).status,'draft');await board.dispatch();assert.equal(store.getProject(tasks[1].runId).repository,null);
  await board.deleteItem(p.id,'tasks',tasks[2].id);assert.equal(store.getProject(tasks[2].runId).archivedAt!==undefined,true);assert.equal(store.getProjects().length,2);
  await board.restoreTask(p.id,tasks[2].id);assert.equal(store.getProjects().length,3);
  for(const stage of ['analysis','backend','frontend','qa']){await board.waitForReview(tasks[0].runId,stage);const r=store.getProject(tasks[0].runId).tasks.find(t=>t.id===stage).revisions.at(-1);await engine.review(tasks[0].runId,stage,{action:'approve',revisionId:r.id});}
  process.env.TEAMFORGE_AUTO_PUBLISH='1';await board.dispatch();assert.equal(store.getProject(tasks[1].runId).repository,null);
  await fs.writeFile(path.join(source,'latest.txt'),'fresh base');await git(['-C',source,'add','latest.txt']);await git(['-C',source,'-c','user.name=Fixture','-c','user.email=f@example.invalid','commit','-m','latest']);
  await store.mutate(tasks[0].runId,x=>{x.publication={status:'pushed'};});
  await board.dispatch();await board.waitForReview(tasks[1].runId,'analysis');assert.equal(await fs.readFile(path.join(engine.workspace(tasks[1].runId),'latest.txt'),'utf8'),'fresh base');
  await board.deleteItem(p.id,'tasks',tasks[1].id);assert.equal(store.getProject(tasks[1].runId).status,'cancelled');await assert.rejects(engine.start(tasks[1].runId),/حذف/);
  await board.deleteProject(p.id);assert.equal(board.snapshot().length,0);assert.equal(store.getProjects().length,0);
  const reloaded=new Portfolio(store.dataDir,store,engine);await reloaded.init();assert.equal(reloaded.snapshot().length,0);assert.equal(reloaded.snapshot(true).length,1);
  await reloaded.restoreProject(p.id);assert.equal(reloaded.snapshot().length,1);assert.equal(reloaded.snapshot()[0].phases[0].features[0].tasks.length,2);
 }finally{if(oldRoots===undefined)delete process.env.TEAMFORGE_IMPORT_ROOTS;else process.env.TEAMFORGE_IMPORT_ROOTS=oldRoots;if(oldPublish===undefined)delete process.env.TEAMFORGE_AUTO_PUBLISH;else process.env.TEAMFORGE_AUTO_PUBLISH=oldPublish;await fs.rm(root,{recursive:true,force:true});}
});
