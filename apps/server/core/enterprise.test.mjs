import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {Auth,validateOrigin} from './auth.mjs';
import {Store} from './store.mjs';
import {Engine} from './engine.mjs';
import {Portfolio} from './portfolio.mjs';
import {validatePlan} from './planning.mjs';
import {git} from './git.mjs';
import {applyExactPatch} from './coding-files.mjs';
const fixture=()=>fs.mkdtemp(path.join(os.tmpdir(),'teamforge-enterprise-'));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const plan={phases:[{title:'User Management',features:[{title:'Authentication',tasks:[{title:'API',description:'Implement authentication API',acceptanceCriteria:['valid credentials accepted'],dependencies:[]},{title:'Login UI',description:'Implement login interface',acceptanceCriteria:['show errors'],dependencies:[0]}]}]}],risks:['Clarify identity provider'],questions:['Session lifetime?']};

test('persistent accounts, hashed credentials, project isolation and role permissions',async()=>{
 const root=await fixture();try{
 const auth=new Auth(root);const admin=await auth.create({username:'administrator',password:'test-only-password-123',admin:true});
 const reviewer=await auth.create({username:'backend-user',password:'test-only-password-456'});await auth.assign(reviewer.id,'project-a','backend');
 const header='Basic '+Buffer.from('backend-user:test-only-password-456').toString('base64');const actor=auth.authenticate({headers:{authorization:header},socket:{remoteAddress:'test'}});
 assert.equal(actor.admin,false);assert.equal(auth.can(actor,'project-a',['backend']),true);assert.equal(auth.can(actor,'project-a',['analysis']),false);assert.equal(auth.can(actor,'project-b'),false);
 assert.throws(()=>auth.authenticate({headers:{},socket:{}}),{status:401});assert.throws(()=>auth.require(actor,'project-b'),{status:403});
 assert.equal(auth.can(admin,'project-b'),true);assert.ok(!(await fs.readFile(auth.file,'utf8')).includes('test-only-password'));
 const restarted=new Auth(root);await restarted.init();assert.equal(restarted.authenticate({headers:{authorization:header},socket:{}}).id,reviewer.id);
 assert.throws(()=>validateOrigin({method:'POST',headers:{origin:'https://attacker.invalid'}}),{status:403});assert.throws(()=>validateOrigin({method:'POST',headers:{'sec-fetch-site':'cross-site'}}));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('project hierarchy CRUD, dependency validation and editable human planning gate',async()=>{
 const root=await fixture();try{
 const store=new Store(root);await store.init();const engine=new Engine(store),board=new Portfolio(root,store,engine);await board.init();
 const p=await board.addProject({title:'Project one'});await board.updateProject(p.id,{description:'Updated description'});assert.equal(board.snapshot()[0].description,'Updated description');
 const ph=await board.addPhase(p.id,{title:'Phase'});const f=await board.addFeature(p.id,{phaseId:ph.id,title:'Feature'});
 const a=await board.addTask(p.id,{featureId:f.id,title:'First',description:'First requirement'});const b=await board.addTask(p.id,{featureId:f.id,title:'Second',description:'Second requirement',dependencies:[a.id],acceptanceCriteria:['Works']});
 await assert.rejects(engine.start(b.runId),/dependencies/);await assert.rejects(board.addTask(p.id,{featureId:f.id,title:'Bad',description:'Invalid dependency',dependencies:['unknown']}));
 await assert.rejects(board.deleteItem(p.id,'tasks',a.id),/dependents/);await board.updateItem(p.id,'tasks',b.id,{priority:'high'});await board.deleteItem(p.id,'tasks',b.id);await board.deleteItem(p.id,'tasks',a.id);await board.deleteItem(p.id,'features',f.id);await board.deleteItem(p.id,'phases',ph.id);
 const draft=await board.draftPlan(p.id,plan,'human-manager');assert.equal(board.snapshot()[0].phases.length,0);assert.equal(draft.status,'draft');
 await assert.rejects(board.approvePlan(p.id,'stale-id','human-manager'),/stale/);
 const results=await Promise.allSettled([board.approvePlan(p.id,draft.id,'human-manager'),board.approvePlan(p.id,draft.id,'human-manager')]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const tasks=board.snapshot()[0].phases[0].features[0].tasks;assert.equal(tasks.length,2);assert.equal(store.getProject(tasks[0].runId).status,'draft');assert.deepEqual(tasks[1].dependencies,[tasks[0].id]);
 assert.throws(()=>validatePlan({...plan,phases:[{title:'Invalid',features:[{title:'Feature',tasks:[{title:'Cycle',description:'Cycle',acceptanceCriteria:['No cycle'],dependencies:[0]}]}]}]}));
 const empty=await board.addProject({title:'Delete me'});await board.deleteProject(empty.id);assert.equal(board.snapshot().length,1);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('duplicate starts and reviews are rejected, revision changes invalidate approval, manual edits tracked',async()=>{
 const root=await fixture();try{
 const store=new Store(root);await store.init();const engine=new Engine(store),board=new Portfolio(root,store,engine);const p=await store.create({title:'Review test',description:'Requirements',mode:'demo'});
 const starts=await Promise.allSettled([engine.start(p.id),engine.start(p.id)]);assert.equal(starts.filter(x=>x.status==='fulfilled').length,1);await board.waitForReview(p.id,'analysis');
 const original=store.getProject(p.id).tasks[0].revisions.at(-1);await assert.rejects(engine.review(p.id,'analysis',{action:'approve',revisionId:'stale'}),/Stale/);
 const file=store.getProject(p.id).tasks[0].output[0],current=await fs.readFile(path.join(engine.workspace(p.id),file),'utf8');
 await fs.writeFile(path.join(engine.workspace(p.id),file),current+'\nexternal change');await assert.rejects(engine.review(p.id,'analysis',{action:'approve'}),/Workspace changed/);
 await fs.writeFile(path.join(engine.workspace(p.id),file),current);await engine.edit(p.id,'analysis',{filePath:file,content:current+'\nhuman edit',reviewer:'assigned analyst'});
 const revision=store.getProject(p.id).tasks[0].revisions.at(-1);assert.notEqual(original.id,revision.id);assert.equal(revision.source,'human');
 const decisions=await Promise.allSettled([engine.review(p.id,'analysis',{action:'approve',revisionId:revision.id}),engine.review(p.id,'analysis',{action:'approve',revisionId:revision.id})]);assert.equal(decisions.filter(x=>x.status==='fulfilled').length,1);
 await board.waitForReview(p.id,'backend');assert.equal(store.getProject(p.id).tasks[0].reviews[0].revisionId,revision.id);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('queued cancellation never invokes model, scheduler recovers interrupted tasks, inference limit spans projects',async()=>{
 const root=await fixture();try{
 const store=new Store(root);await store.init();const engine=new Engine(store);let active=0,max=0;
 await Promise.all(['project-a','project-b','project-c'].map(id=>engine.withAgentSlot(async()=>{active++;max=Math.max(max,active);await wait(15);active--;},id)));assert.equal(max,1);
 const p=await store.create({title:'Interrupted',description:'Requirements',mode:'demo'});await store.mutate(p.id,x=>{x.status='running';x.tasks[0].status='running';});
 const restored=new Store(root);await restored.init();assert.equal(restored.getProject(p.id).status,'interrupted');assert.equal(restored.getProject(p.id).tasks[0].status,'pending');
 const run=await store.create({title:'Cancel',description:'Requirements',mode:'demo'});await engine.cancel(run.id);assert.equal(store.getProject(run.id).status,'cancelled');await assert.rejects(engine.start(run.id));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('repository-specific role policies override defaults and deny unclassified files',async()=>{
 const root=await fixture();try{await fs.mkdir(path.join(root,'custom'));const policy={backend:['custom/'],frontend:[],analyst:['docs/teamforge/'],qa:['tests/']};
 await applyExactPatch(root,'backend',{path:'custom/api.mjs',search:'',replace:'export const ok=true;'},policy);
 await assert.rejects(applyExactPatch(root,'frontend',{path:'custom/ui.jsx',search:'',replace:'export const ok=true;'},policy));
 await assert.rejects(applyExactPatch(root,'backend',{path:'backend/api.mjs',search:'',replace:'export const ok=true;'},policy));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('mandatory five-project real-file scenario with four independent stages, corrections, Git patch and restart (MOCK model)',async()=>{
 const root=await fixture(),source=path.join(root,'source');await fs.mkdir(source);await fs.writeFile(path.join(source,'README.md'),'# Safe authentication fixture\n');await git(['init',source]);await git(['-C',source,'add','.']);await git(['-C',source,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture']);
 const oldURL=process.env.OLLAMA_URL,oldRoots=process.env.TEAMFORGE_IMPORT_ROOTS;let inFlight=0,maximum=0;
 const model=http.createServer(async(req,res)=>{
  inFlight++;maximum=Math.max(maximum,inFlight);res.on('close',()=>inFlight--);
  let raw='';for await(const part of req)raw+=part;const b=JSON.parse(raw),system=b.messages[0].content;
  const role=['analyst','backend','frontend','qa'].find(x=>system.includes(`'s ${x} coding agent`));const context=b.messages[1].content;const corrected=context.includes('CORRECT THIS');const toolResults=b.messages.filter(x=>x.content.startsWith('TOOL RESULT (apply_patch)'));
  const file=role==='analyst'?'docs/teamforge/analysis.md':role==='backend'?'backend/auth.mjs':role==='frontend'?'frontend/login.jsx':'docs/teamforge/checks.md';
  const action=toolResults.length?{action:'finish',summary:`${role} fixture complete`}:{action:'apply_patch',path:file,search:corrected?'export const result="initial";':'',replace:role==='backend'?`export const result="${corrected?'corrected':'initial'}";`:`# ${role} fixture\n`};
  await wait(5);res.writeHead(200,{'Content-Type':'application/x-ndjson'});res.end(JSON.stringify({message:{content:JSON.stringify(action)},done:true})+'\n');
 });await new Promise(r=>model.listen(0,'127.0.0.1',r));
 try{
 process.env.OLLAMA_URL=`http://127.0.0.1:${model.address().port}`;process.env.TEAMFORGE_IMPORT_ROOTS=root;
 const data=path.join(root,'data'),store=new Store(data);await store.init();const engine=new Engine(store),board=new Portfolio(data,store,engine);await board.init();const projects=[];
 for(let i=0;i<5;i++)projects.push(await board.addProject({title:`Project ${i+1}`,team:['analysis','backend','frontend','qa'].map(role=>({name:`Human ${role}`,role}))}));
 const p=projects[0];await board.attachRepository(p.id,{kind:'local',path:source});const phase=await board.addPhase(p.id,{title:'User Management'}),feature=await board.addFeature(p.id,{phaseId:phase.id,title:'Authentication'});
 const items=[];for(const title of ['Authentication API','Login UI','Password Reset','Authentication Validation Rules'])items.push(await board.addTask(p.id,{featureId:feature.id,title,description:`Implement ${title}`,mode:'ollama'}));
 const lanes=['analysis','backend','frontend','qa'];for(let i=0;i<items.length;i++){for(let j=0;j<3-i;j++){await board.waitForReview(items[i].runId,lanes[j]);await engine.review(items[i].runId,lanes[j],{action:'approve',reviewer:`Human ${lanes[j]}`});}await board.waitForReview(items[i].runId,lanes[3-i]);}
 assert.deepEqual(board.snapshot()[0].phases[0].features[0].tasks.map(t=>[t.stage,t.stageStatus]),[['qa','awaiting_review'],['frontend','awaiting_review'],['backend','awaiting_review'],['analysis','awaiting_review']]);
 const c=items[2],before=store.getProject(c.runId).tasks[1].revisions.at(-1);await engine.review(c.runId,'backend',{action:'reject',comment:'CORRECT THIS response',filePath:'backend/auth.mjs',line:1,reviewer:'Human backend'});await board.waitForReview(c.runId,'backend');const after=store.getProject(c.runId).tasks[1].revisions.at(-1);assert.notEqual(before.id,after.id);assert.notEqual(before.workspaceHash,after.workspaceHash);
 assert.match(await fs.readFile(path.join(engine.workspace(c.runId),'backend/auth.mjs'),'utf8'),/corrected/);await engine.review(c.runId,'backend',{action:'approve',revisionId:after.id});await board.waitForReview(c.runId,'frontend');
 for(const [index,stage] of [[0,'qa'],[1,'frontend'],[3,'analysis']])assert.equal(store.getProject(items[index].runId).tasks.find(t=>t.id===stage).status,'awaiting_review');
 await engine.review(items[0].runId,'qa',{action:'approve'});assert.match(await engine.approvedPatch(items[0].runId),/diff --git/);assert.equal(maximum,1);
 const restored=new Store(data);await restored.init();const history=restored.getProject(c.runId).tasks[1];assert.equal(history.reviews.length,2);assert.equal(history.reviews[0].comment,'CORRECT THIS response');const board2=new Portfolio(data,restored,new Engine(restored));await board2.init();assert.equal(board2.snapshot().length,5);
 assert.equal(await git(['-C',source,'status','--porcelain']),'');assert.equal(await fs.readFile(path.join(source,'README.md'),'utf8'),'# Safe authentication fixture\n');
 }finally{await new Promise(r=>model.close(r));if(oldURL===undefined)delete process.env.OLLAMA_URL;else process.env.OLLAMA_URL=oldURL;if(oldRoots===undefined)delete process.env.TEAMFORGE_IMPORT_ROOTS;else process.env.TEAMFORGE_IMPORT_ROOTS=oldRoots;await fs.rm(root,{recursive:true,force:true});}
});
