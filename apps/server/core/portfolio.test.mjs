import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from './store.mjs';
import {Engine} from './engine.mjs';
import {Portfolio} from './portfolio.mjs';

const tasksOf=p=>p.phases.flatMap(ph=>ph.features.flatMap(feat=>feat.tasks));

test('demo creates real independent work-item runs in four human-review lanes and survives reload',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'teamforge-portfolio-'));
 try{
  const store=new Store(root);await store.init();const engine=new Engine(store),board=new Portfolio(root,store,engine);await board.init();
  const seeded=await board.seed();assert.equal(seeded.reused,false);
  const [p]=board.snapshot();assert.equal(p.title,'سامانه مدیریت درخواست‌های کارکنان');
  assert.equal(p.phases.length,2);assert.equal(p.team.length,4);
  const tasks=tasksOf(p);assert.equal(tasks.length,4);assert.equal(new Set(tasks.map(t=>t.runId)).size,4);
  assert.deepEqual(tasks.map(t=>t.stage).sort(),['analysis','backend','frontend','qa']);
  for(const t of tasks){assert.equal(t.stageStatus,'awaiting_review');const run=store.getProject(t.runId);assert.equal(run.status,'awaiting_review');}
  const approvals=tasks.flatMap(t=>store.getProject(t.runId).tasks.flatMap(s=>s.reviews));
  assert.equal(approvals.length,6);
  assert.ok(approvals.every(x=>x.reviewer.includes('DEMO SEED')));
  assert.equal((await board.seed()).reused,true);
  const other=tasks.find(t=>t.stage==='backend');const analyst=tasks.find(t=>t.stage==='analysis');
  await engine.review(analyst.runId,'analysis',{action:'request_changes',comment:'شرایط اولویت را شفاف‌تر کن',reviewer:'نازنین'});
  await board.waitForReview(analyst.runId,'analysis');
  assert.equal(store.getProject(other.runId).tasks.find(x=>x.id==='backend').status,'awaiting_review','other task must not be affected');
  assert.equal(store.getProject(analyst.runId).tasks.find(x=>x.id==='analysis').attempts,2,'comments must rerun the same agent');
  const persisted=new Portfolio(root,store,engine);await persisted.init();assert.equal(tasksOf(persisted.snapshot()[0]).length,4);
  const phase=await persisted.addPhase(p.id,{title:'فاز ۳ — توسعه'});
  const feature=await persisted.addFeature(p.id,{phaseId:phase.id,title:'توسعه گزارشات'});
  const item=await persisted.addTask(p.id,{featureId:feature.id,title:'خروجی گزارش',description:'دریافت و ذخیره گزارش در فایل CSV',mode:'demo'});
  assert.equal(store.getProject(item.runId).status,'draft');
  const member=await persisted.addMember(p.id,{name:'کیارش',role:'frontend'});assert.equal(member.role,'frontend');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
