import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {Store,ROLES,STAGES} from './core/store.mjs';
import {Engine} from './core/engine.mjs';
import {Auth,validateOrigin} from './core/auth.mjs';
import {Portfolio} from './core/portfolio.mjs';
import {listFiles,readSafeFile} from './core/policies.mjs';
import {modelConfig} from './core/llm.mjs';
import {runSandboxCommand} from './core/sandbox.mjs';
import {safeRead,repoFiles} from './core/coding-files.mjs';

const PORT=Number(process.env.PORT||8787),HOST=process.env.HOST||'127.0.0.1';
const store=new Store(path.resolve(process.env.DATA_DIR||'./data'));
await store.init();
const engine=new Engine(store);
const portfolio=new Portfolio(store.dataDir,store,engine);
await portfolio.init();
const auth=new Auth(store.dataDir);await auth.init();
let dispatching=false;const scheduler=setInterval(async()=>{if(dispatching)return;dispatching=true;try{await portfolio.dispatch();}catch(e){console.error('Scheduler:',e.message);}finally{dispatching=false;}},1000);scheduler.unref();
let auditQueue=Promise.resolve();
const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
async function body(req){let total=0,parts=[];for await(const part of req){total+=part.length;if(total>170000)throw Object.assign(Error('درخواست بیش از حد بزرگ است.'),{status:413});parts.push(part);}try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw Object.assign(Error('JSON نامعتبر است.'),{status:400});}}
const bad=(res,status,message)=>send(res,status,{error:message});
const validUUID=s=>/^[a-f0-9-]{36}$/.test(s);
async function downloadZip(res,id){
 const workspace=engine.workspace(id),files=await listFiles(workspace);if(!files.length)return bad(res,404,'فایلی برای دانلود وجود ندارد.');
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'teamforge-')),zipPath=path.join(temp,`project-${id}.zip`);
 try{
  // Export safe text-only files for imported Git projects. In particular,
  // NEVER include .git metadata, private .env values or local credentials.
  const exportRoot=path.join(temp,'export');await fs.mkdir(exportRoot);
  if(store.getProject(id)?.repository){
   for(const filename of await repoFiles(workspace)){
    let text;try{text=await safeRead(workspace,filename);}catch{continue;}
    const dest=path.join(exportRoot,...filename.split('/'));
    await fs.mkdir(path.dirname(dest),{recursive:true});await fs.writeFile(dest,text);
   }
  }else{
   for(const filename of files){
    let text;try{text=await readSafeFile(workspace,filename);}catch{continue;}
    const dest=path.join(exportRoot,...filename.split('/'));
    await fs.mkdir(path.dirname(dest),{recursive:true});await fs.writeFile(dest,text);
   }
  }
  await new Promise((resolve,reject)=>{const p=spawn('zip',['-q','-r',zipPath,'.'],{cwd:exportRoot,stdio:'ignore'});const tm=setTimeout(()=>p.kill('SIGKILL'),25000);p.on('error',reject);p.on('close',code=>{clearTimeout(tm);code===0?resolve():reject(Error('ساخت ZIP ناموفق بود.'));});});
  const buffer=await fs.readFile(zipPath);
  res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':`attachment; filename="project-${id}.zip"`,'Content-Length':buffer.length,'X-Content-Type-Options':'nosniff'});res.end(buffer);
 }finally{await fs.rm(temp,{recursive:true,force:true});}
}
async function handler(req,res){
 try{
  const url=new URL(req.url||'/',`http://${HOST}:${PORT}`),pathname=url.pathname;
  if(req.method==='GET'&&pathname==='/api/health')return send(res,200,{ok:true,version:'0.7.0-mvp',capabilities:{reviewedGitPublish:true}});
  validateOrigin(req);
  const actor=auth.authenticate(req);
  if(!['GET','HEAD','OPTIONS'].includes(req.method))res.once('finish',()=>{
   const event={id:crypto.randomUUID(),at:new Date().toISOString(),actorId:actor.id,actor:actor.username,method:req.method,path:pathname,status:res.statusCode};
   auditQueue=auditQueue.then(()=>fs.appendFile(path.join(store.dataDir,'audit.jsonl'),JSON.stringify(event)+'\n',{mode:0o600})).catch(e=>console.error('Audit persistence failed:',e.message));
  });
  if(req.method==='GET'&&pathname==='/api/session')return send(res,200,{user:actor});
  if(pathname==='/api/users'){
   if(!actor.admin)throw Object.assign(Error('Administrator required'),{status:403});
   if(req.method==='GET')return send(res,200,{users:auth.users.map(u=>auth.public(u))});
   if(req.method==='POST')return send(res,201,{user:await auth.create(await body(req))});
  }
  const membership=pathname.match(/^\/api\/users\/([a-f0-9-]{36})\/memberships$/);
  if(membership&&req.method==='POST'){
   if(!actor.admin)throw Object.assign(Error('Administrator required'),{status:403});
   const input=await body(req);portfolio.project(input.projectId);
   const user=await auth.assign(membership[1],input.projectId,input.role);
   await portfolio.mutate(()=>{const project=portfolio.project(input.projectId);project.team=project.team.filter(m=>!(m.userId===user.id&&m.role===input.role));project.team.push({id:crypto.randomUUID(),userId:user.id,name:user.username,role:input.role});});
   return send(res,200,{user});
  }
  const portfolioId=pathname.match(/^\/api\/portfolio\/projects\/([a-f0-9-]{36})/);
  if(portfolioId)auth.require(actor,portfolioId[1],req.method==='GET'?undefined:['manager']);
  if(req.method==='POST'&&['/api/portfolio/demo','/api/portfolio/projects','/api/projects'].includes(pathname)&&!actor.admin)throw Object.assign(Error('Administrator required'),{status:403});
  const runPath=pathname.match(/^\/api\/projects\/([a-f0-9-]{36})/);
  if(runPath){
   const run=store.getProject(runPath[1]);
   if(req.method==='POST'&&run?.runner==='codex_cli')throw Error('Codex CLI execution is unavailable in the secured API; use the internal Ollama runtime.');
   const operation=pathname.match(/\/tasks\/(analysis|backend|frontend|qa)\/(review|edit|reopen)$/);
   const allowed=req.method==='GET'?undefined:operation?[operation[1]]:['manager'];
   auth.require(actor,run?.organizationProjectId||runPath[1],allowed);
   if(operation&&!actor.admin&&run?.assignedReviewers?.[operation[1]]&&run.assignedReviewers[operation[1]]!==actor.id)throw Object.assign(Error('Assigned reviewer required'),{status:403});
  }
  if(req.method==='GET'&&pathname==='/api/config')return send(res,200,{...modelConfig(),hasAuth:true,serverMode:'authenticated-local'});
  if(req.method==='GET'&&pathname==='/api/model/health'){
    const {url:base,model}=modelConfig();
    try{
      const resp=await fetch(`${base.replace(/\/$/,'')}/api/tags`,{signal:AbortSignal.timeout(3000),redirect:'error'});
      if(!resp.ok)throw Error(`HTTP ${resp.status}`);
      const data=await resp.json();
      const installed=(data.models||[]).map(x=>x.name||x.model).filter(Boolean);
      return send(res,200,{connected:true,model,modelInstalled:installed.includes(model),installed});
    }catch(e){return send(res,200,{connected:false,model,modelInstalled:false,error:String(e.message||e)});}
  }
  if(req.method==='GET'&&pathname==='/api/agents')return send(res,200,{agents:ROLES,stages:STAGES});
  if(pathname==='/api/portfolio/trash'&&req.method==='GET')return send(res,200,{projects:portfolio.snapshot(true).filter(p=>auth.can(actor,p.id))});
  if(pathname==='/api/portfolio/cleanup-demo'&&req.method==='POST'){if(!actor.admin)throw Object.assign(Error('Administrator required'),{status:403});await portfolio.cleanupDemo();return send(res,200,{ok:true});}
  const restorePath=pathname.match(/^\/api\/portfolio\/projects\/([a-f0-9-]{36})(?:\/tasks\/([a-f0-9-]{36}))?\/restore$/);
  if(restorePath&&req.method==='POST'){if(restorePath[2])await portfolio.restoreTask(restorePath[1],restorePath[2]);else await portfolio.restoreProject(restorePath[1]);return send(res,200,{ok:true});}
  const retryPath=pathname.match(/^\/api\/portfolio\/projects\/([a-f0-9-]{36})\/tasks\/([a-f0-9-]{36})\/retry$/);
  if(retryPath&&req.method==='POST'){await portfolio.retryTask(retryPath[1],retryPath[2]);return send(res,200,{ok:true});}
  const bulkPath=pathname.match(/^\/api\/portfolio\/projects\/([a-f0-9-]{36})\/tasks\/bulk$/);
  if(bulkPath&&req.method==='POST')return send(res,201,{tasks:await portfolio.enqueue(bulkPath[1],await body(req))});
  const projectEdit=pathname.match(/^\/api\/portfolio\/projects\/([a-f0-9-]{36})$/);
  if(projectEdit&&req.method==='PATCH')return send(res,200,{project:await portfolio.updateProject(projectEdit[1],await body(req))});
  if(projectEdit&&req.method==='DELETE'){await portfolio.deleteProject(projectEdit[1]);return send(res,200,{ok:true});}
  const itemEdit=pathname.match(/^\/api\/portfolio\/projects\/([a-f0-9-]{36})\/(phases|features|tasks)\/([a-f0-9-]{36})$/);
  if(itemEdit&&req.method==='PATCH')return send(res,200,{item:await portfolio.updateItem(itemEdit[1],itemEdit[2],itemEdit[3],await body(req))});
  if(itemEdit&&req.method==='DELETE'){await portfolio.deleteItem(itemEdit[1],itemEdit[2],itemEdit[3]);return send(res,200,{ok:true});}
  const planning=pathname.match(/^\/api\/portfolio\/projects\/([a-f0-9-]{36})\/plan(?:\/(approve))?$/);
  if(planning&&req.method==='POST'){
   const input=await body(req);
   const plan=planning[2]?await portfolio.approvePlan(planning[1],input.planId,actor.username):await portfolio.draftPlan(planning[1],input.content||null,actor.username);
   return send(res,200,{plan});
  }
  if(req.method==='GET'&&pathname==='/api/portfolio')return send(res,200,{organization:portfolio.state.organization,projects:portfolio.snapshot().filter(p=>auth.can(actor,p.id))});
  if(req.method==='POST'&&pathname==='/api/portfolio/demo'){
   const result=await portfolio.seed();return send(res,200,{...result,projects:portfolio.snapshot()});
  }
  const attach=pathname.match(/^\/api\/portfolio\/projects\/([a-f0-9-]{36})\/repository$/);
  if(req.method==='POST'&&attach)return send(res,200,{repository:await portfolio.attachRepository(attach[1],await body(req))});
  if(req.method==='POST'&&pathname==='/api/portfolio/projects')return send(res,201,{project:await portfolio.addProject(await body(req))});
  const orgPath=pathname.match(/^\/api\/portfolio\/projects\/([a-f0-9-]{36})\/(phases|features|tasks|members)$/);
  if(req.method==='POST'&&orgPath){
   const [,projectId,kind]=orgPath,b=await body(req);
   if(b.runner==='codex_cli')throw Error('Use the internal Ollama runtime; host CLI execution is disabled.');
   const result=kind==='phases'?await portfolio.addPhase(projectId,b):kind==='features'?await portfolio.addFeature(projectId,b):kind==='members'?await portfolio.addMember(projectId,b):await portfolio.addTask(projectId,b);
   return send(res,201,{item:result});
  }
  if(req.method==='GET'&&pathname==='/api/projects')return send(res,200,{projects:store.getProjects().filter(p=>auth.can(actor,store.getProject(p.id)?.organizationProjectId||p.id))});
  if(req.method==='POST'&&pathname==='/api/projects'){
   const b=await body(req);if(b.runner==='codex_cli')throw Error('Host CLI execution disabled');const title=typeof b.title==='string'?b.title.trim():'',description=typeof b.description==='string'?b.description.trim():'';
   if(title.length<3||title.length>100||description.length<10||description.length>5000||!['demo','ollama'].includes(b.mode)||!['builtin','codex_cli'].includes(b.runner??'builtin')||(b.runner==='codex_cli'&&b.mode!=='ollama'))return bad(res,400,'عنوان، نیازمندی و حالت اجرا نامعتبر است.');
   return send(res,201,{project:await store.create({title,description,mode:b.mode,runner:b.runner??'builtin'})});
  }
  const m=pathname.match(/^\/api\/projects\/([^/]+)(?:\/(.*))?$/);
  if(!m)return bad(res,404,'مسیر پیدا نشد.');
  const id=m[1],sub=m[2]||'';
  if(!validUUID(id))return bad(res,400,'شناسه نامعتبر است.');
  const p=store.getProject(id);if(!p)return bad(res,404,'پروژه یافت نشد.');
  if((req.method==='DELETE'&&!sub)||(req.method==='POST'&&sub==='restore')){
   const item=p.organizationProjectId?portfolio.project(p.organizationProjectId).phases.flatMap(ph=>ph.features.flatMap(f=>f.tasks)).find(t=>t.runId===id):null;
   if(p.organizationProjectId&&!item)throw Error('Linked task not found');
   if(req.method==='DELETE'){if(item)await portfolio.deleteItem(p.organizationProjectId,'tasks',item.id);else await engine.archive(id);}
   else{if(item)await portfolio.restoreTask(p.organizationProjectId,item.id);else await engine.restore(id);}
   return send(res,200,{ok:true});
  }
  if(req.method==='GET'&&!sub)return send(res,200,{project:p});
  if(req.method==='POST'&&sub==='repo/import')return send(res,200,{project:await engine.importRepo(id,await body(req))});
  if(req.method==='POST'&&sub==='repo/publish')return send(res,200,{project:await engine.publish(id)});
  if(req.method==='GET'&&sub==='repo')return send(res,200,{repository:await engine.repoInfo(id)});
  if(req.method==='GET'&&sub==='repo/patch'){const patch=await engine.approvedPatch(id);res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':`attachment; filename=teamforge-${id}.patch`});res.end(patch);return;}
  if(req.method==='GET'&&sub==='repo/diff')return send(res,200,{diff:await engine.repoFileDiff(id,url.searchParams.get('path')||'')});
  if(req.method==='POST'&&sub==='repo/check'){
    if(!p.repository)throw Error('این پروژه ریپازیتوری Git ندارد.');
    const result=await runSandboxCommand(engine.workspace(id),await body(req));await store.mutate(id,x=>{const task=x.tasks.find(t=>t.status==='awaiting_review'||t.status==='running');if(task){task.checks.push({...result,at:new Date().toISOString(),workspaceHash:null,source:'human'});}});await store.event(id,'system','test',`${actor.username}: ${result.command} ${result.status}`);return send(res,200,{result});
  }
  if(req.method==='POST'&&sub==='cancel')return send(res,200,{project:await engine.cancel(id)});
  if(req.method==='POST'&&['start','resume','pause'].includes(sub))return send(res,200,{project:sub==='pause'?await engine.pause(id):await engine.start(id)});
  const taskPath=sub.match(/^tasks\/(analysis|backend|frontend|qa)\/(review|edit|diff|reopen)$/);
  if(taskPath){
    const [,taskId,operation]=taskPath;
    if(req.method==='POST'&&operation==='review'){const input=await body(req);if(typeof input.revisionId!=='string')throw Error('revisionId is required for review');return send(res,200,{project:await engine.review(id,taskId,{...input,reviewer:actor.username})});}
    if(req.method==='POST'&&operation==='reopen')return send(res,200,{project:await engine.reopenImplementation(id,taskId,{...await body(req),reviewer:actor.username})});
    if(req.method==='POST'&&operation==='edit')return send(res,200,{project:await engine.edit(id,taskId,{...await body(req),reviewer:actor.username})});
    if(req.method==='GET'&&operation==='diff')return send(res,200,{diff:engine.diff(id,taskId,url.searchParams.get('path')||'')});
  }
  if(req.method==='GET'&&sub==='files')return send(res,200,{files:p.repository?await repoFiles(engine.workspace(id)):await listFiles(engine.workspace(id))});
  if(req.method==='GET'&&sub==='file')return send(res,200,{path:url.searchParams.get('path'),content:await (p.repository?safeRead:readSafeFile)(engine.workspace(id),url.searchParams.get('path'))});
  if(req.method==='GET'&&sub==='download')return downloadZip(res,id);
  if(req.method==='GET'&&sub==='events'){
   res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
   res.write(`data: ${JSON.stringify({type:'connected',progress:store.getProgress(id)})}\n\n`);
   const unsubscribe=store.subscribe(id,data=>res.write(`data: ${JSON.stringify(data)}\n\n`));
   const ping=setInterval(()=>res.write(': heartbeat\n\n'),15000);
   req.on('close',()=>{clearInterval(ping);unsubscribe();});return;
  }
  return bad(res,404,'مسیر پیدا نشد.');
 }catch(e){if(e.status===401)res.setHeader('WWW-Authenticate','Basic realm="TeamForge", charset="UTF-8"');console.error('[API]',e.message);return bad(res,e.status||400,String(e.message||e));}
}
http.createServer(handler).listen(PORT,HOST,()=>console.log(`TeamForge API v0.7.0-mvp ready: http://${HOST}:${PORT} (local-only)`));
