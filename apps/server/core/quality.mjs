import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {listFiles,writeAgentFiles} from './policies.mjs';

const MUST_HAVE=['docs/architecture.md','docs/api-contract.md','backend/package.json','backend/src/server.mjs','backend/test/server.test.mjs','frontend/package.json','frontend/index.html','frontend/src/main.jsx','tests/checklist.md'];
const image=process.env.DOCKER_IMAGE||'node:22-alpine';
function dockerAvailable(){
  const ping=spawnSync('docker',['image','inspect',image],{stdio:'ignore',timeout:5000});
  return ping.status===0;
}
function spawnLimited(bin,args,options){
  return new Promise((resolve)=>{
    let output='',settled=false;
    const proc=spawn(bin,args,{...options,stdio:['ignore','pipe','pipe']});
    const timer=setTimeout(()=>{proc.kill('SIGKILL');finish({status:'failed',output:output+'\nExecution timed out.'});},60000);
    function finish(value){if(settled)return;settled=true;clearTimeout(timer);resolve(value);}
    proc.stdout.on('data',b=>output=(output+b.toString()).slice(-12000));
    proc.stderr.on('data',b=>output=(output+b.toString()).slice(-12000));
    proc.on('error',e=>finish({status:'failed',output:e.message}));
    proc.on('exit',code=>finish({status:code===0?'passed':'failed',output:output.slice(-10000),exitCode:code}));
  });
}
export async function checkProject(root){
  const existing=await listFiles(root);
  const missing=MUST_HAVE.filter(f=>!existing.includes(f));
  const checks=[{name:'وجود فایل‌های ضروری',status:missing.length?'failed':'passed',detail:missing.length?`فایل‌های پیدا نشده: ${missing.join(', ')}`:'همه فایل‌های ضروری وجود دارند.'}];
  let packageError=false;
  for(const file of ['backend/package.json','frontend/package.json']){
    if(!existing.includes(file))continue;
    try{const data=JSON.parse(await fs.readFile(path.join(root,file),'utf8'));if(!data.scripts||typeof data.scripts!=='object')throw Error('scripts not found');checks.push({name:`ساختار ${file}`,status:'passed',detail:'JSON و scripts معتبر است.'});}
    catch(e){packageError=true;checks.push({name:`ساختار ${file}`,status:'failed',detail:e.message});}
  }
  let runtime={status:'skipped',output:`Docker یا Image ${image} آماده نیست. تست اجرایی اجرا نشده؛ اول Docker نصب و docker pull ${image} اجرا شود.`};
  if(missing.length===0&&!packageError){
    if(dockerAvailable()){
      runtime=await spawnLimited('docker',[
        'run','--rm','--network','none','--memory','512m','--cpus','1','--pids-limit','128',
        '--cap-drop','ALL','--security-opt','no-new-privileges','--user','10001:10001',
        '--read-only','--tmpfs','/tmp:rw,nosuid,nodev,size=128m',
        '--mount',`type=bind,src=${path.resolve(root)},dst=/work,readonly`,
        '--workdir','/work/backend',image,'node','--test'
      ],{cwd:root});
    }
  }
  checks.push({name:'اجرای Node Backend Tests در Sandbox',status:runtime.status,detail:runtime.output.slice(-1500)});
  const passed=!checks.some(c=>c.status==='failed');
  return{passed,verified:passed&&runtime.status==='passed',checks,finishedAt:new Date().toISOString(),runtimeOutput:runtime.output};
}
export async function writeQualityReport(root,quality){
  const status=x=>x==='passed'?'✅':x==='failed'?'❌':'⚠️';
  const content=`# Quality report\n\n- Static checks: ${quality.passed?'PASS':'FAIL'}\n- Runtime tests: ${quality.verified?'VERIFIED':'NOT FULLY VERIFIED'}\n- Date: ${quality.finishedAt}\n\n${quality.checks.map(c=>`## ${status(c.status)} ${c.name}\n\n${c.detail.replaceAll('```','\\`\\`\\`')}\n`).join('\n')}\n> این گزارش توسط بررسی‌های قطعی سیستم تولید شده است، نه ادعای زبانی Agent.\n`;
  await writeAgentFiles(root,'qa',[{path:'docs/qa-report.md',content}]);
}
