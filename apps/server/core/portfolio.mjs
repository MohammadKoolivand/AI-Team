import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {durableJSON,restoreInPlace} from './durable.mjs';
import {validatePlan,proposePlan} from './planning.mjs';
import {validateLocalSource} from './git.mjs';

const uuid=()=>crypto.randomUUID();
const stamp=()=>new Date().toISOString();
const required=(v,name,max=150)=>{if(typeof v!=='string'||!v.trim()||v.trim().length>max)throw Error(`${name} نامعتبر است.`);return v.trim();};
const stages=['analysis','backend','frontend','qa'];

/** Organizational portfolio. Every work item maps to its OWN existing Engine run.
 * No shared global approval gate; the coding engine remains responsible for each task's approvals. */
export class Portfolio {
 constructor(dataDir,store,engine){this.file=path.join(dataDir,'portfolio.json');this.store=store;this.engine=engine;this.state={organization:{id:uuid(),name:'Local organization'},projects:[]};this.queue=Promise.resolve();}
 async init(){try{const data=JSON.parse(await fs.readFile(this.file,'utf8'));if(Array.isArray(data.projects))this.state=data;}catch(e){if(e.code!=='ENOENT')throw e;}this.state.organization||={id:uuid(),name:'Local organization'};for(const p of this.state.projects)if(p.plan?.status==='approving')p.plan.status='draft';await this.save();}
 async save(){await fs.mkdir(path.dirname(this.file),{recursive:true});await durableJSON(this.file,this.state);}
 async mutate(fn){const op=this.queue.then(async()=>{const backup=structuredClone(this.state);try{const result=fn();await this.save();return result;}catch(e){restoreInPlace(this.state,backup);throw e;}});this.queue=op.catch(()=>{});return op;}
 project(id){const p=this.state.projects.find(x=>x.id===id);if(!p)throw Error('پروژه سازمانی پیدا نشد.');return p;}
 snapshot(){
  const enriched=this.state.projects.map(p=>({
   ...p,
   phases:p.phases.map(phase=>({
    ...phase,
    features:phase.features.map(feature=>({
     ...feature,
     tasks:feature.tasks.map(t=>{
      const run=this.store.getProject(t.runId);
      const active=run?.tasks.find(s=>['running','awaiting_review','failed'].includes(s.status))||run?.tasks.find(s=>s.status==='pending');
      const paths=new Set(run?.tasks.flatMap(s=>s.revisions.flatMap(r=>r.changes.map(c=>c.path)))||[]);
      const conflicts=p.phases.flatMap(ph=>ph.features.flatMap(f=>f.tasks)).filter(other=>other.id!==t.id).flatMap(other=>{const peer=this.store.getProject(other.runId);const overlap=[...new Set(peer?.tasks.flatMap(s=>s.revisions.flatMap(r=>r.changes.map(c=>c.path))).filter(name=>paths.has(name))||[])];return overlap.length?[{taskId:other.id,title:other.title,files:overlap}]:[];});
      return {...t,conflicts,runStatus:run?.status||'unknown',stage:active?.id||'completed',stageStatus:active?.status||'completed',pipeline:run?.tasks.map(s=>({id:s.id,status:s.status,attempts:s.attempts}))||[]};
     })
    }))
   }))
  }));
  return structuredClone(enriched);
 }
 async addProject({title,description='',team=[]}){const p={id:uuid(),organizationId:this.state.organization.id,title:required(title,'عنوان پروژه'),description:String(description).slice(0,3000),team:Array.isArray(team)?team.slice(0,30).map(x=>({id:uuid(),name:required(x.name,'نام عضو'),role:required(x.role,'نقش',35)})):[],phases:[],createdAt:stamp()};await this.mutate(()=>this.state.projects.push(p));return p;}
 async attachRepository(pid,source){
  const p=this.project(pid);
  if(p.repository)throw Error('مخزن پروژه قبلاً متصل شده است.');
  if(p.phases.some(ph=>ph.features.some(f=>f.tasks.length)))throw Error('برای امنیت نسخه‌بندی، مخزن Git را پیش از ایجاد نخستین تسک وصل کنید. یک پروژه جدید بسازید.');
  const validated=await validateLocalSource(source);
  const repo={kind:'local',path:validated.path,head:validated.head,sourceLabel:validated.sourceLabel,connectedAt:stamp()};
  await this.mutate(()=>{p.repository=repo;});
  return repo;
 }
 async addMember(pid,{name,role}){
  const p=this.project(pid);
  if(!stages.includes(role))throw Error('نقش معتبر نیست.');
  const member={id:uuid(),name:required(name,'نام عضو'),role};
  await this.mutate(()=>p.team.push(member));return member;
 }
 async addPhase(pid,{title,description='',priority='medium',status='planned',plannedOrder=0}){const p=this.project(pid);if(!['low','medium','high'].includes(priority)||!['planned','active','completed'].includes(status)||!Number.isInteger(plannedOrder)||plannedOrder<0)throw Error('Invalid phase metadata');const phase={id:uuid(),title:required(title,'عنوان فاز'),description:String(description).slice(0,5000),priority,status,plannedOrder,features:[]};await this.mutate(()=>p.phases.push(phase));return phase;}
 async addFeature(pid,{phaseId,title,description='',businessRequirements='',acceptanceCriteria=[],priority='medium'}){const p=this.project(pid);const phase=p.phases.find(x=>x.id===phaseId);if(!phase)throw Error('فاز پیدا نشد.');if(!['low','medium','high'].includes(priority)||!Array.isArray(acceptanceCriteria)||acceptanceCriteria.some(x=>typeof x!=='string'||x.length>1000))throw Error('Invalid feature metadata');const feat={id:uuid(),title:required(title,'عنوان فیچر'),description:String(description).slice(0,5000),businessRequirements:String(businessRequirements).slice(0,5000),acceptanceCriteria,priority,tasks:[]};await this.mutate(()=>phase.features.push(feat));return feat;}
 async addTask(pid,{featureId,title,description,priority='medium',mode='demo',runner='builtin',dependencies=[],acceptanceCriteria=[]}){
  const p=this.project(pid),feat=p.phases.flatMap(x=>x.features).find(x=>x.id===featureId);
  if(!feat)throw Error('فیچر پیدا نشد.');
  if(!['low','medium','high'].includes(priority)||!['demo','ollama'].includes(mode)||!['builtin','codex_cli'].includes(runner))throw Error('تنظیمات تسک معتبر نیست.');
  const clean=required(title,'عنوان تسک'),desc=required(description,'شرح تسک',5000);
  const existing=p.phases.flatMap(ph=>ph.features.flatMap(f=>f.tasks));
  if(!Array.isArray(dependencies)||dependencies.length>100||new Set(dependencies).size!==dependencies.length||dependencies.some(id=>!existing.some(t=>t.id===id)))throw Error('وابستگی باید تسک موجود همین پروژه باشد.');
  if(!Array.isArray(acceptanceCriteria)||acceptanceCriteria.length>40||acceptanceCriteria.some(x=>typeof x!=='string'||!x.trim()||x.length>1000))throw Error('معیار پذیرش نامعتبر است.');
  // Existing Engine owns each work item's isolated workspace, agent state, reviews and human gates.
  if(mode==='ollama'&&!p.repository)throw Error('برای تسک واقعی ابتدا مخزن Git پروژه را در برد متصل کنید.');
  if(mode==='ollama'&&p.isDemo)throw Error('برای کدنویسی واقعی یک پروژه مستقل جدید بسازید.');
  const run=await this.store.create({title:`${p.title} / ${clean}`,description:`Organization: ${p.title}\nFeature: ${feat.title}\nTask: ${clean}\n${desc}`,mode,runner});
  // Every work item gets a fresh, isolated Git worktree. Its own approvals and edits
  // never modify sibling tasks or the organization's source repository.
  if(mode==='ollama'){
   try{await this.engine.importRepo(run.id,{kind:'local',path:p.repository.path});}
   catch(e){await this.store.deleteDraft(run.id);throw e;}
  }
  await this.store.mutate(run.id,x=>{x.organizationProjectId=pid;x.autoStart=mode==='ollama';x.dependsOnRuns=dependencies.map(id=>existing.find(t=>t.id===id).runId);x.acceptanceCriteria=acceptanceCriteria;x.filePolicy=p.filePolicy;x.assignedReviewers=Object.fromEntries(p.team.filter(m=>m.userId).map(m=>[m.role,m.userId]));});
  const t={id:uuid(),dependencies,acceptanceCriteria,title:clean,description:desc,priority,runId:run.id,mode,createdBy:'مدیر پروژه',createdAt:stamp()};
  await this.mutate(()=>feat.tasks.push(t));
  if(mode==='ollama'&&dependencies.every(id=>this.store.getProject(existing.find(t=>t.id===id).runId)?.status==='completed')){
   try{await this.engine.start(run.id);}catch(e){await this.store.event(run.id,'system','error',`Start failed: ${String(e.message||e)}`);}
  }
  return t;
 }
 async updateProject(pid,input){
  return this.mutate(()=>{const p=this.project(pid);if(input.filePolicy!==undefined){const policy=input.filePolicy;if(!policy||typeof policy!=='object'||Object.keys(policy).some(r=>!['analyst','backend','frontend','qa'].includes(r))||Object.values(policy).some(v=>!Array.isArray(v)||v.length>40||v.some(x=>typeof x!=='string'||!x||x.startsWith('/')||x.includes('..')||x.includes('\\')||x.split('/').some(s=>s.startsWith('.')))))throw Error('Invalid role path policy');p.filePolicy=structuredClone(policy);}
  if(input.title!==undefined)p.title=required(input.title,'عنوان پروژه');if(input.description!==undefined)p.description=required(input.description,'شرح پروژه',5000);return structuredClone(p);});
 }
 async deleteProject(pid){
  return this.mutate(()=>{const p=this.project(pid);if(p.phases.some(ph=>ph.features.some(f=>f.tasks.length)))throw Error('Remove tasks first; execution history is preserved separately');this.state.projects=this.state.projects.filter(x=>x.id!==pid);});
 }
 async updateItem(pid,kind,id,input){
  return this.mutate(()=>{
   const p=this.project(pid),all=kind==='phases'?p.phases:kind==='features'?p.phases.flatMap(ph=>ph.features):p.phases.flatMap(ph=>ph.features.flatMap(f=>f.tasks));
   const item=all.find(x=>x.id===id);if(!item)throw Error('Item not found');
   if(kind==='tasks'&&(input.title!==undefined||input.description!==undefined))throw Error('Task requirements are immutable; create a replacement draft or use review feedback');
   if(input.title!==undefined)item.title=required(input.title,'عنوان');
   if(input.description!==undefined)item.description=required(input.description,'شرح',5000);
   if(input.priority!==undefined){if(!['low','medium','high'].includes(input.priority))throw Error('Invalid priority');item.priority=input.priority;}
   if(kind==='tasks'){
    const run=this.store.getProject(item.runId);if(run?.status!=='draft')throw Error('Active task requirements are immutable; request corrections in review');
    if(input.dependencies!==undefined||input.acceptanceCriteria!==undefined)throw Error('Define dependencies and criteria when creating a task');
   }
   return structuredClone(item);
  });
 }
 async deleteItem(pid,kind,id){
  return this.mutate(()=>{
   const p=this.project(pid);const parent=kind==='phases'?p:kind==='features'?p.phases.find(ph=>ph.features.some(f=>f.id===id)):p.phases.flatMap(ph=>ph.features).find(f=>f.tasks.some(t=>t.id===id));
   if(!parent||!parent[kind]?.some(x=>x.id===id))throw Error('Item not found');
   const item=parent[kind].find(x=>x.id===id);
   if(item.features?.length||item.tasks?.length)throw Error('Remove child items first');
   if(kind==='tasks'){
    if(this.store.getProject(item.runId)?.status!=='draft')throw Error('Only draft tasks can be removed');
    if(p.phases.flatMap(ph=>ph.features.flatMap(f=>f.tasks)).some(t=>t.dependencies?.includes(id)))throw Error('Task has dependents');
   }
   parent[kind]=parent[kind].filter(x=>x.id!==id);
  });
 }
 async draftPlan(pid,input,actor){
  const p=this.project(pid),plan=input?validatePlan(input):await this.engine.withAgentSlot(()=>proposePlan(p),pid);
  return this.mutate(()=>{const current=this.project(pid);if(current.plan?.status==='approving')throw Error('Plan approval in progress');current.plan={id:uuid(),status:'draft',content:plan,createdAt:stamp(),createdBy:actor};return structuredClone(current.plan);});
 }
 async approvePlan(pid,planId,actor){
  const p=this.project(pid),plan=p.plan;
  if(!plan||plan.id!==planId||plan.status!=='draft')throw Error('Plan is stale or already approved');
  const content=validatePlan(plan.content);
  await this.mutate(()=>{if(p.plan.status!=='draft')throw Error('Plan already approved');p.plan.status='approving';});
  // Draft runs are activated individually by humans. AI plans never start executions.
  const created=[],phases=[];
  try{
   for(const phase of content.phases){const ph={id:uuid(),title:phase.title,description:phase.description,features:[]};phases.push(ph);
    for(const feature of phase.features){const f={id:uuid(),title:feature.title,description:feature.description,tasks:[]};ph.features.push(f);
     for(const task of feature.tasks){const run=await this.store.create({title:`${p.title} / ${task.title}`,description:task.description,mode:p.repository&&!p.isDemo?'ollama':'demo'});const t={...task,id:uuid(),runId:run.id,mode:run.mode,createdAt:stamp(),createdBy:actor,dependencies:task.dependencies.map(i=>created[i].id)};created.push(t);f.tasks.push(t);
      if(run.mode==='ollama')await this.engine.importRepo(run.id,{kind:'local',path:p.repository.path});
      await this.store.mutate(run.id,x=>{x.organizationProjectId=pid;x.acceptanceCriteria=task.acceptanceCriteria;x.filePolicy=p.filePolicy;x.assignedReviewers=Object.fromEntries(p.team.filter(m=>m.userId).map(m=>[m.role,m.userId]));x.dependsOnRuns=task.dependencies.map(i=>created[i].runId);});
     }
    }
   }
   await this.mutate(()=>{p.phases.push(...phases);p.plan.status='approved';p.plan.approvedBy=actor;p.plan.approvedAt=stamp();});return structuredClone(p.plan);
  }catch(e){for(const t of created)await this.store.deleteDraft(t.runId);await this.mutate(()=>{p.plan.status='draft';});throw e;}
 }
 async dispatch(){
  for(const p of this.state.projects)for(const t of p.phases.flatMap(ph=>ph.features.flatMap(f=>f.tasks))){
   const run=this.store.getProject(t.runId);
   if(!run||run.mode!=='ollama'||!['draft','interrupted'].includes(run.status)||!run.autoStart)continue;
   if((run.dependsOnRuns||[]).some(id=>this.store.getProject(id)?.status!=='completed'))continue;
   try{await this.engine.start(run.id);}catch(e){if(!this.engine.active.has(run.id))await this.store.event(run.id,'system','warning',String(e.message));}
  }
 }
 async seed(){
  const old=this.state.projects.find(x=>x.demoKey==='employee-requests');
  if(old)return {projectId:old.id,reused:true};
  const project=await this.addProject({title:'سامانه مدیریت درخواست‌های کارکنان',description:'پروژه آزمایشی برای نشان‌دادن اجرای هم‌زمان تحلیل، بک‌اند، فرانت‌اند و QA روی تسک‌های مستقل.',team:[{name:'نازنین',role:'analysis'},{name:'علی',role:'backend'},{name:'سارا',role:'frontend'},{name:'پیمان',role:'qa'}]});
  await this.mutate(()=>{project.demoKey='employee-requests';project.isDemo=true;});
  const phase1=await this.addPhase(project.id,{title:'فاز ۱ — درخواست و گردش تأیید'});
  const feature1=await this.addFeature(project.id,{phaseId:phase1.id,title:'ثبت درخواست و پیگیری'});
  const feature2=await this.addFeature(project.id,{phaseId:phase1.id,title:'مدیریت تأیید و قوانین'});
  const phase2=await this.addPhase(project.id,{title:'فاز ۲ — گزارش‌ها و مدیریت'});
  await this.addFeature(project.id,{phaseId:phase2.id,title:'گزارش‌گیری مدیریتی'});
  const specs=[
    {featureId:feature1.id,title:'ثبت و پیگیری درخواست',description:'API و صفحه فهرست درخواست‌ها؛ افزودن، مشاهده و نمایش وضعیت؛ تست اعتبارسنجی.',priority:'high',step:3},
    {featureId:feature1.id,title:'فرم ثبت درخواست جدید',description:'فرم ایجاد درخواست با اعتبارسنجی و اتصال به API مورد توافق.',priority:'high',step:2},
    {featureId:feature2.id,title:'API تأیید یا رد درخواست',description:'پیاده‌سازی مسیر تصمیم مدیر و ثبت تاریخچه وضعیت درخواست.',priority:'medium',step:1},
    {featureId:feature2.id,title:'تحلیل قوانین اولویت‌بندی',description:'معیارهای اولویت، وضعیت‌ها و معیارهای پذیرش جهت تأیید تحلیلگر.',priority:'medium',step:0}
  ];
  const tasks=[];
  for(const spec of specs)tasks.push({task:await this.addTask(project.id,{...spec,mode:'demo',runner:'builtin'}),level:spec.step});
  // Synthetic demo approvals are explicitly labelled. They MUST NOT be confused with real reviews.
  for(const {task,level} of tasks){
   await this.engine.start(task.runId);
   for(let i=0;i<level;i++){
    await this.waitForReview(task.runId,stages[i]);
    await this.engine.review(task.runId,stages[i],{action:'approve',comment:'تأیید ساختگی برای آماده‌سازی سناریوی آموزشی',reviewer:'DEMO SEED — بازبین فرضی'});
   }
   await this.waitForReview(task.runId,stages[level]);
  }
  return {projectId:project.id,reused:false};
 }
 async waitForReview(runId,stage,timeoutMs=25000){
  const until=Date.now()+timeoutMs;
  while(Date.now()<until){const p=this.store.getProject(runId);const t=p?.tasks.find(x=>x.id===stage);
   if(t?.status==='awaiting_review'&&!this.engine.active.has(runId))return;
   if(p?.status==='failed'||t?.status==='failed')throw Error(`سناریوی دمو در ${stage} شکست خورد: ${t?.error||'unknown'}`);
   await new Promise(r=>setTimeout(r,35));
  }
  throw Error(`مهلت اجرای مرحله ${stage} تمام شد.`);
 }
}
