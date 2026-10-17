import {prepareReviewedCommit,pushReviewedCommit,publicationBranch,validatePublishRemote} from './publication.mjs';
import {git} from './git.mjs';
import {hasImplementationChanges,stageHasImplementation} from './review-policy.mjs';
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {demoFiles} from './templates.mjs';
import {generateWithOllama} from './llm.mjs';
import {writeAgentFiles,readSafeFile,listFiles,validateRelativeFile} from './policies.mjs';
import {checkProject,writeQualityReport} from './quality.mjs';
import {snapshots,buildChanges,latestDiff} from './revisions.mjs';
import {importRepository,gitSummary,gitDiff} from './git.mjs';
import {runCodingAgent} from './coding-agent.mjs';
import {runCodexAgent} from './codex-runner.mjs';
import {safeRead,applyExactPatch,repoFiles,statSafe} from './coding-files.mjs';

const errorText=e=>String(e?.message||e).slice(0,1200);
const now=()=>new Date().toISOString();
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export class Engine{
  constructor(store){
    this.store=store;this.active=new Set();this.locks=new Map();this.controllers=new Map();
    // One inference at a time suits a 16GB laptop; scale this on a GPU host.
    this.maxAgents=Math.max(1,Math.min(16,Number(process.env.TEAMFORGE_MAX_INFERENCE_REQUESTS||process.env.TEAMFORGE_MAX_CONCURRENT_AGENTS)||1));
    this.runningAgents=0;this.agentWaiters=[];this.projectSlots=new Map();this.maxProjectAgents=Math.max(1,Math.min(16,Number(process.env.TEAMFORGE_MAX_PROJECT_EXECUTIONS)||1));
  }
  async exclusive(id,fn){
    const previous=this.locks.get(id)||Promise.resolve();
    const op=previous.then(fn,fn);this.locks.set(id,op);
    try{return await op;}finally{if(this.locks.get(id)===op)this.locks.delete(id);}
  }
  start(id){return this.exclusive(id,()=>this.startLocked(id));}
  review(id,stage,input){return this.exclusive(id,()=>this.reviewLocked(id,stage,input));}
  edit(id,stage,input){return this.exclusive(id,()=>this.editLocked(id,stage,input));}
  async revisionHash(id){
    const root=this.workspace(id),p=this.store.getProject(id);
    const names=(p.repository?await repoFiles(root):await listFiles(root)).sort();
    const hash=crypto.createHash('sha256');
    for(const name of names){
      hash.update(JSON.stringify(name));
      if(p.repository){await statSafe(root,name);for await(const chunk of createReadStream(path.join(root,name)))hash.update(chunk);}
      else hash.update(await readSafeFile(root,name));
    }
    return hash.digest('hex');
  }
  async cancel(id){
    return this.exclusive(id,async()=>{
      const p=this.store.getProject(id);if(!p||!['running','paused','interrupted','failed','draft'].includes(p.status))throw Error('Execution cannot be cancelled in this state');
      this.controllers.get(id)?.abort();
      await this.store.mutate(id,x=>{x.status='cancelled';for(const t of x.tasks)if(t.status==='running')t.status='cancelled';});
      await this.store.event(id,'system','cancelled','Execution cancelled by human');return this.store.getProject(id);
    });
  }
  async withAgentSlot(fn,projectId='planning'){
    await new Promise(resolve=>{this.agentWaiters.push({projectId,resolve});this.drainQueue();});
    try{return await fn();}
    finally{this.runningAgents--;this.projectSlots.set(projectId,this.projectSlots.get(projectId)-1);this.drainQueue();}
  }
  drainQueue(){
    const maximum=Math.min(this.maxAgents,Math.max(1,Number(process.env.TEAMFORGE_MAX_GLOBAL_EXECUTIONS)||this.maxAgents));
    while(this.runningAgents<maximum){
      const index=this.agentWaiters.findIndex(w=>(this.projectSlots.get(w.projectId)||0)<this.maxProjectAgents);if(index<0)break;
      const [waiter]=this.agentWaiters.splice(index,1);this.runningAgents++;this.projectSlots.set(waiter.projectId,(this.projectSlots.get(waiter.projectId)||0)+1);waiter.resolve();
    }
  }
  workspace(id){return path.join(this.store.dataDir,'workspaces',id);}
  async archive(id){return this.exclusive(id,async()=>{
    const p=this.store.getProject(id);if(!p||p.archivedAt)return;
    this.controllers.get(id)?.abort();
    await this.store.mutate(id,x=>{x.archivedAt=now();x.statusBeforeArchive=x.status;x.autoStart=false;if(x.status!=='completed')x.status='cancelled';});
  });}
  async restore(id){return this.exclusive(id,async()=>{
    if(this.active.has(id))throw Error('کمی صبر کنید تا اجرای لغوشده متوقف شود.');
    await this.store.mutate(id,x=>{if(!x.archivedAt)return;x.archivedAt=null;x.status=x.statusBeforeArchive==='running'?'interrupted':x.statusBeforeArchive||'draft';x.autoStart=x.status==='draft';});
  });}
  async importRepo(id,source){
    const p=this.store.getProject(id);
    if(!p||p.status!=='draft'||p.repository)throw Error('Import فقط برای پروژه تازه و بدون منبع مجاز است.');
    if(p.mode!=='ollama')throw Error('برای توسعه ریپازیتوری واقعی حالت Ollama را انتخاب کنید.');
    const repo=await importRepository(this.store.dataDir,id,source);
    await this.store.mutate(id,x=>{x.repository={head:repo.head,branch:repo.branch,kind:repo.kind,sourceLabel:repo.sourceLabel,initializedEmpty:repo.initializedEmpty,publishRemote:repo.publishRemote,importedAt:now()};});
    await this.store.event(id,'system','success',`Worktree created on ${repo.branch}, base ${repo.head.slice(0,12)}`);
    return this.store.getProject(id);
  }
  async repoInfo(id){
    const p=this.store.getProject(id);if(!p?.repository)throw Error('پروژه Git وارد نشده است.');
    return{...p.repository,files:await repoFiles(this.workspace(id)),changed:await gitSummary(this.workspace(id))};
  }
  async repoFileDiff(id,filename){
    const p=this.store.getProject(id);if(!p?.repository)throw Error('پروژه Git وارد نشده است.');
    await statSafe(this.workspace(id),filename);
    return{path:filename,patch:await gitDiff(this.workspace(id),filename)};
  }
  async approvedPatch(id){
    const p=this.store.getProject(id);if(!p?.repository||p.status!=='completed')throw Error('Only completed, approved Git work can be exported as a patch');
    const revision=p.tasks.at(-1).revisions.at(-1);
    if(!revision?.workspaceHash||revision.workspaceHash!==await this.revisionHash(id))throw Error('Approved workspace changed; patch export denied');
    const names=[...new Set(p.tasks.flatMap(t=>t.revisions.flatMap(r=>r.changes.map(c=>c.path))))];
    const patches=[];for(const name of names)patches.push(await gitDiff(this.workspace(id),name));return patches.join('\n');
  }
  publish(id){return this.exclusive(id,()=>this.publishLocked(id));}
  async publishLocked(id){
    const p=this.store.getProject(id),branch=p?.publication?.branch||publicationBranch();
    if(p?.publication?.status==='pushed')return p;
    try{
      if(p?.archivedAt||p?.mode!=='ollama'||!p.repository||p.status!=='completed'||!p.tasks.every(t=>t.status==='approved'))throw Error('انتشار فقط پس از تأیید انسانی همه مراحل و QA مجاز است.');
      if(p.tasks.some(t=>['backend','frontend'].includes(t.id)&&!stageHasImplementation(t)))throw Error('مرحلهٔ پیاده‌سازی بدون کد قابل انتشار نیست.');
      const qa=p.tasks.find(t=>t.id==='qa'),revision=qa?.revisions.at(-1);
      if(!revision?.workspaceHash||revision.workspaceHash!==await this.revisionHash(id))throw Error('خروجی پس از تأیید QA تغییر کرده است؛ انتشار مجاز نیست.');
      if(qa.checks?.some(c=>c.status==='failed'))throw Error('تست ناموفق وجود دارد؛ انتشار مجاز نیست.');
      let remote=p.repository.publishRemote;
      if(!remote&&p.repository.kind==='git')remote=await git(['-C',this.workspace(id),'remote','get-url','origin']);
      validatePublishRemote(remote);
      const paths=[...new Set(p.tasks.flatMap(t=>t.revisions.flatMap(r=>r.changes.map(c=>c.path))))];
      const commit=await prepareReviewedCommit(this.workspace(id),{paths,branch,previousCommit:p.publication?.commit,message:`TeamForge: ${p.title} (QA approved)\n\nExecution: ${id}\nQA revision: ${revision.id}`});
      await this.store.mutate(id,x=>{x.publication={status:'pushing',branch,commit,at:now()};});
      if(revision.workspaceHash!==await this.revisionHash(id))throw Error('Workspace changed during publication');
      await pushReviewedCommit(this.workspace(id),{remote,branch,commit});
      await this.store.mutate(id,x=>{x.publication={...x.publication,status:'pushed',pushedAt:now(),error:null};});
      await this.store.event(id,'system','success',`Commit ${commit.slice(0,12)} pushed to ${branch}`);
    }catch(e){
      await this.store.mutate(id,x=>{x.publication={...x.publication,status:'failed',branch,error:errorText(e),at:now()};});
      await this.store.event(id,'system','warning',`انتشار در Git ناموفق بود: ${errorText(e)}`);
    }
    return this.store.getProject(id);
  }
  async startLocked(id){
    const p=this.store.getProject(id);
    if(!p||p.archivedAt)throw Error('پروژه وجود ندارد یا حذف شده است.');
    if(p.queueManaged){
      const earlier=this.store.state.projects.slice(0,this.store.state.projects.findIndex(x=>x.id===id)).filter(x=>x.organizationProjectId===p.organizationProjectId&&x.queueManaged&&!x.archivedAt&&x.status!=='cancelled');
      if(earlier.some(x=>x.status!=='completed'||process.env.TEAMFORGE_AUTO_PUBLISH==='1'&&x.publication?.status!=='pushed'))throw Error('تسک‌های قبلی صف هنوز تکمیل و منتشر نشده‌اند.');
    }
    if(p.mode==='ollama'&&!p.repository)throw Error('Real mode requires an imported Git Workspace repository.');
    if((p.dependsOnRuns||[]).some(dep=>this.store.getProject(dep)?.status!=='completed'))throw Error('Task dependencies are not completed.');
    if(this.active.has(id))throw Error('ایجنت در حال کار است.');
    if(p.runner==='codex_cli'&&!p.repository)throw Error('برای استفاده از Codex CLI ابتدا Git Workspace را وارد کنید.');
    if(!['draft','paused','failed','interrupted','running'].includes(p.status))throw Error('پروژه منتظر تأیید انسانی یا پایان‌یافته است.');
    const nextIndex=p.tasks.findIndex(t=>['pending','failed','running'].includes(t.status));
    const invalidPrior=p.mode==='ollama'&&p.tasks.slice(0,nextIndex).find(t=>['backend','frontend'].includes(t.id)&&t.status==='approved'&&!stageHasImplementation(t));
    if(invalidPrior)throw Error(`مرحلهٔ «${invalidPrior.title}» قبلاً بدون کد تأیید شده است؛ ابتدا آن را برای پیاده‌سازی بازگشایی کنید.`);
    await this.store.mutate(id,x=>{x.status='running';for(const t of x.tasks)if(t.status==='failed'||t.status==='running'){t.status='pending';t.error=null;}});
    this.active.add(id);this.controllers.set(id,new AbortController());
    void this.run(id).finally(()=>{this.active.delete(id);this.controllers.delete(id);});
    return this.store.getProject(id);
  }
  async continueAfterReview(id){
    for(let i=0;i<50;i++){
      if(!this.active.has(id)){try{await this.start(id);}catch(e){await this.store.event(id,'system','error',errorText(e));}return;}
      await wait(30);
    }
    await this.store.event(id,'system','warning','برای ادامه دکمه «شروع/ادامه» را بزنید.');
  }
  async pause(id){
    const p=this.store.getProject(id);if(!p||p.status!=='running')throw Error('پروژه در حال اجرا نیست.');
    await this.store.mutate(id,x=>{x.status='paused';});
    await this.store.event(id,'system','warning','پس از پایان وظیفه جاری متوقف می‌شود.');
    return this.store.getProject(id);
  }
  async reopenImplementation(id,taskId,{comment='بازگشایی مرحلهٔ تأییدشده با خروجی خالی برای پیاده‌سازی واقعی.',reviewer='بازبین انسانی'}={}){
    return this.exclusive(id,async()=>{
      const p=this.store.getProject(id),index=p?.tasks.findIndex(t=>t.id===taskId),task=p?.tasks[index];
      if(!p||p.mode!=='ollama'||!['backend','frontend'].includes(taskId)||task?.status!=='approved'||stageHasImplementation(task))throw Error('فقط مرحلهٔ اجراییِ تأییدشده با خروجی خالی قابل بازگشایی است.');
      if(this.active.has(id)||p.status==='running')throw Error('ابتدا اجرای جاری را متوقف کنید.');
      if(p.tasks.slice(index+1).some(t=>stageHasImplementation(t)))throw Error('مراحل بعدی کد دارند؛ بازگشایی خودکار مجاز نیست و بازبینی وابستگی‌ها لازم است.');
      const at=now();
      await this.store.mutate(id,x=>{
        for(const [offset,t] of x.tasks.slice(index).entries()){
          t.reviews.push({id:crypto.randomUUID(),action:'reopen',comment:offset===0?String(comment).slice(0,4000):'تأیید/بازبینی این مرحله به‌دلیل بازگشایی مرحلهٔ قبلی نیازمند اجرای مجدد است.',reviewer:String(reviewer).slice(0,80),revisionId:t.revisions.at(-1)?.id||null,at});
          t.status='pending';t.approvedAt=null;t.checks=[];t.error=null;
          if(offset===0)t.feedback=`${comment}\nImplement actual ${taskId} source files. Approved analysis is read-only.`;
        }
        x.status='running';x.approvedAt=null;
      });
      await this.store.event(id,task.agent,'warning',`مرحلهٔ «${task.title}» با خروجی خالی توسط ${reviewer} بازگشایی شد؛ تحلیل تأییدشده حفظ شد.`);
      void this.continueAfterReview(id);return this.store.getProject(id);
    });
  }
  async reviewLocked(id,taskId,{revisionId,action,comment='',filePath=null,line=null,reviewer='بازبین انسانی'}){
    const p=this.store.getProject(id),t=p?.tasks.find(t=>t.id===taskId);
    if(p?.archivedAt||!t||t.status!=='awaiting_review'||p.status!=='awaiting_review')throw Error('این مرحله برای تأیید آماده نیست.');
    const earlierEmpty=p.mode==='ollama'&&p.tasks.slice(0,p.tasks.findIndex(s=>s.id===taskId)).find(s=>['backend','frontend'].includes(s.id)&&s.status==='approved'&&!stageHasImplementation(s));
    if(earlierEmpty)throw Error(`مرحلهٔ «${earlierEmpty.title}» قبلاً بدون کد تأیید شده است؛ ابتدا همان مرحله را بازگشایی کنید.`);
    if(action==='approve'&&p.mode==='ollama'&&['backend','frontend'].includes(taskId)&&!stageHasImplementation(t))throw Error('این مرحله تغییر اجرایی ندارد و قابل تأیید نیست؛ اجرای اصلاح را درخواست کنید.');
    if(!['approve','request_changes','reject'].includes(action))throw Error('نوع تصمیم نامعتبر است.');
    if(typeof comment!=='string'||comment.length>4000||(action!=='approve'&&!comment.trim()))throw Error('برای رد یا اصلاح، توضیح ضروری است.');
    if(filePath!==null&&(!t.output.includes(filePath)||filePath.length>220))throw Error('فایل مربوط به این مرحله نیست.');
    const revision=t.revisions.at(-1);
    if(!revision||revisionId&&revisionId!==revision.id)throw Error('Stale review revision; reload before reviewing.');
    if(!revision.workspaceHash)throw Error('Legacy review snapshot has no workspace hash; save a manual revision before reviewing.');
    if(revision.workspaceHash!==await this.revisionHash(id))throw Error('Workspace changed after review snapshot; refresh the revision before approval.');
    const record={revisionId:revision.id,workspaceHash:revision.workspaceHash,id:crypto.randomUUID(),action,comment:comment.trim(),filePath,line:Number.isInteger(line)?line:null,reviewer:String(reviewer||'بازبین انسانی').slice(0,80),at:now(),attempt:t.attempts};
    await this.store.mutate(id,x=>{
      const task=x.tasks.find(v=>v.id===taskId);if(task.status!=='awaiting_review'||task.revisions.at(-1)?.id!==revision.id)throw Error('Review state changed');task.reviews.push(record);
      if(action==='approve'){
        task.status='approved';task.approvedAt=now();
        if(x.tasks.every(item=>item.status==='approved')){x.status='completed';x.approvedAt=now();}else x.status='running';
      }else{
        task.status='pending';task.feedback=`${comment.trim()}${filePath?`\nTarget file: ${filePath}`:''}${Number.isInteger(line)?`\nTarget line: ${line}`:''}`;
        x.status='running';
      }
    });
    await this.store.event(id,t.agent,action==='approve'?'success':'warning',action==='approve'?`مرحله «${t.title}» توسط انسان تأیید شد.`:`مرحله «${t.title}» با نظر بازبین برگشت داده شد: ${comment.slice(0,180)}`);
    const latest=this.store.getProject(id);
    if(latest.status==='completed'&&latest.mode==='ollama'&&latest.repository&&process.env.TEAMFORGE_AUTO_PUBLISH==='1')return this.publishLocked(id);
    if(latest.status==='running')void this.continueAfterReview(id);
    return latest;
  }
  async editLocked(id,taskId,{filePath,content,reviewer='بازبین انسانی'}){
    const p=this.store.getProject(id),t=p?.tasks.find(t=>t.id===taskId);
    if(!t||p.status!=='awaiting_review'||t.status!=='awaiting_review')throw Error('فقط خروجی مرحله در انتظار تأیید قابل ویرایش است.');
    if(!t.output.includes(filePath))throw Error('فایل باید در همین مرحله تولید شده باشد.');
    if(typeof content!=='string'||content.length>110000)throw Error('محتوای فایل نامعتبر است.');
    const root=this.workspace(id),old=p.repository?await safeRead(root,filePath):await readSafeFile(root,filePath);
    if(p.repository){await applyExactPatch(root,t.agent,{path:filePath,search:old,replace:content},p.filePolicy);}
    else{validateRelativeFile(filePath,t.agent);await writeAgentFiles(root,t.agent,[{path:filePath,content}]);}
    const workspaceHash=await this.revisionHash(id);
    await this.store.mutate(id,x=>{
      const task=x.tasks.find(v=>v.id===taskId);
      task.checks=[];task.partialChanges=[];task.revisions.push({id:crypto.randomUUID(),attempt:task.attempts,at:now(),source:'human',workspaceHash,summary:`ویرایش دستی توسط ${String(reviewer).slice(0,80)}`,changes:buildChanges({[filePath]:old},{[filePath]:content})});
    });
    await this.store.event(id,t.agent,'file',`فایل ${filePath} توسط بازبین ویرایش شد.`);
    return this.store.getProject(id);
  }
  diff(id,taskId,filePath){
    const t=this.store.getProject(id)?.tasks.find(t=>t.id===taskId);
    if(!t||!t.output.includes(filePath))throw Error('فایل مورد نظر وجود ندارد.');
    const change=latestDiff(t,filePath);
    return change||{path:filePath,type:'unchanged',before:null,after:null};
  }
  async run(id){
    const root=this.workspace(id);
    try{
      await fs.mkdir(root,{recursive:true});
      while(true){
        const p=this.store.getProject(id);
        if(p.status!=='running')return;
        const next=p.tasks.find(t=>t.status==='pending');
        if(!next){
          if(p.tasks.every(t=>t.status==='approved'))await this.store.mutate(id,x=>{x.status='completed';x.approvedAt=now();});
          else await this.store.mutate(id,x=>{x.status='awaiting_review';});
          return;
        }
        if(next.dependencies.some(dep=>p.tasks.find(t=>t.id===dep)?.status!=='approved')){
          await this.store.mutate(id,x=>{x.status='failed';});
          await this.store.event(id,'system','error','مرحله قبلی هنوز تأیید نشده است.');return;
        }
        await this.executeTask(id,next.id,root);
        return; // Each stage strictly waits for its human review.
      }
    }catch(e){if(this.store.getProject(id)?.status==='cancelled')return;await this.store.mutate(id,p=>{p.status='failed';});await this.store.event(id,'system','error',`خطای سیستم: ${errorText(e)}`);}
  }
  async executeTask(id,taskId,root){
    const p=this.store.getProject(id),t=p.tasks.find(t=>t.id===taskId);
    await this.store.mutate(id,x=>{const task=x.tasks.find(v=>v.id===taskId);task.status='running';task.startedAt=now();task.attempts++;});
    this.store.setProgress(id,t.agent,{phase:'preparing',detail:`شروع ${t.title}`,characters:0,files:[],preview:'',startedAt:now()});
    await this.store.event(id,t.agent,'working',`شروع: ${t.title}`);
    try{
      if(p.mode==='ollama')this.store.setProgress(id,t.agent,{phase:'queued',detail:'در صف استفاده از مدل محلی؛ هر تسک Worktree مستقل دارد.'});
      const perform=async()=>{
        const current=this.store.getProject(id);
        if(current.status!=='running')throw Error('Execution paused or cancelled before inference');
        return this.performRole(p,t.agent,root,t.feedback);
      };
      const output=p.mode==='ollama'?await this.withAgentSlot(perform,p.organizationProjectId||p.id):await perform();
      if(this.store.getProject(id)?.status==='cancelled')return;
      const workspaceHash=await this.revisionHash(id);
      await this.store.mutate(id,x=>{
        const task=x.tasks.find(v=>v.id===taskId);task.status='awaiting_review';task.output=[...new Set([...task.output,...output.files])];task.error=null;task.feedback='';task.finishedAt=now();
        task.partialChanges=[];task.revisions.push({id:crypto.randomUUID(),attempt:task.attempts,at:now(),source:'agent',workspaceHash,summary:output.message,changes:output.changes,checks:output.checks||[],actions:output.actions||[],repairRuns:output.repairRuns||0});
        if(output.quality)x.quality=output.quality;if(output.checks)task.checks=output.checks;
        x.status='awaiting_review';
      });
      await this.store.event(id,t.agent,'success',`خروجی «${t.title}» برای بازبینی انسانی آماده شد (${output.changes.length} فایل تغییرکرده).`);
    }catch(e){
      if(e.name==='TimeoutError')e=Error('مهلت اجرای مرحله پایان یافت؛ فایل‌های ذخیره‌شده حفظ شده‌اند. برای ادامه از همین فایل‌ها، اجرای مجدد را بزنید.');
      const status=this.store.getProject(id)?.status;if(status==='cancelled')return;
      if(status==='paused'){await this.store.mutate(id,x=>{x.tasks.find(v=>v.id===taskId).status='pending';});return;}
      await this.store.mutate(id,x=>{const task=x.tasks.find(v=>v.id===taskId);task.status='failed';task.error=errorText(e);task.finishedAt=now();x.status='failed';});
      await this.store.event(id,t.agent,'error',`اجرای مرحله ناموفق بود: ${errorText(e)}`);
    }finally{this.store.clearProgress(id,t.agent);}
  }
  async runAgent(project,role,root,feedback){
    const progress=patch=>this.store.setProgress(project.id,role,patch);
    const files=project.mode==='demo' ? demoFiles(role==='analyst'?'tech-lead':role,project) : null;
    if(project.mode==='ollama')await this.store.event(project.id,role,'info',`Ollama در حال تولید تغییرات واقعی با نقش ${role} است.`);
    const response=project.mode==='demo'?{summary:'قالب آزمایشی (نه پیاده‌سازی نیازمندی سفارشی)',files}:await generateWithOllama(role,project,root,feedback,progress);
    const relevant=response.files.map(f=>validateRelativeFile(f.path,role));
    const before=await snapshots(root,relevant);
    progress({phase:'writing',detail:'نوشتن فایل‌های تولیدشده در workspace',fileCount:0});
    const paths=await writeAgentFiles(root,role,response.files,async(file,index,total)=>{
      progress({phase:'writing',detail:`ذخیره ${index}/${total}: ${file}`,fileCount:index});
      await this.store.event(project.id,role,'file',`فایل تغییر کرد: ${file}`);
    });
    const after=await snapshots(root,paths);
    return{files:paths,changes:buildChanges(before,after),message:response.summary.slice(0,300)};
  }
  async performRole(project,role,root,feedback){
    if(project.repository){
      const codingRuntime=project.runner==='codex_cli'?runCodexAgent:runCodingAgent;
      const stage=project.tasks.find(t=>t.agent===role);
      const output=await codingRuntime({project,role,root,feedback,initialChanges:stage?.partialChanges||[],onCheckpoint:changes=>this.store.mutate(project.id,x=>{const t=x.tasks.find(t=>t.agent===role);t.partialChanges=changes;}),signal:this.controllers.get(project.id)?.signal,
        onEvent:(kind,message)=>this.store.event(project.id,role,kind,message),
        onProgress:patch=>this.store.setProgress(project.id,role,patch)});
      if(['backend','frontend'].includes(role)&&!hasImplementationChanges(output.changes))throw Object.assign(Error('این مرحله هیچ تغییر اجرایی ایجاد نکرده است؛ برای تأیید آماده نیست.'),{code:'NO_IMPLEMENTATION'});
      return output;
    }
    if(role!=='qa')return this.runAgent(project,role,root,feedback);
    const report=await this.runAgent(project,role,root,feedback);
    this.store.setProgress(project.id,'qa',{phase:'testing',detail:'اجرای بررسی‌های ساختاری و تست Node داخل Docker در صورت وجود'});
    const before=await snapshots(root,['docs/qa-report.md']);
    const quality=await checkProject(root);
    await writeQualityReport(root,quality);
    const after=await snapshots(root,['docs/qa-report.md']);
    if(!quality.passed)throw Error(`QA failed: ${quality.checks.filter(c=>c.status==='failed').map(c=>c.detail).join(' | ').slice(0,500)}`);
    if(!quality.verified)await this.store.event(project.id,'qa','warning','تست Docker اجرا نشد؛ فقط بررسی‌های ایستا انجام شدند.');
    return{...report,files:[...report.files,'docs/qa-report.md'],changes:[...report.changes,...buildChanges(before,after)],quality,message:quality.verified?'QA در Docker اجرا شد':'گزارش QA تولید شد؛ تست Docker اجرا نشده'};
  }
}
