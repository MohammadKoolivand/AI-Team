import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {git,importRepository,gitDiff} from '../apps/server/core/git.mjs';
import {runCodingAgent} from '../apps/server/core/coding-agent.mjs';
import {modelConfig} from '../apps/server/core/llm.mjs';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'teamforge-live-')),source=path.join(root,'source');
const empty=process.argv.includes('--empty'),correction=process.argv.includes('--correction'),analysisMode=empty||correction;
const oldRoots=process.env.TEAMFORGE_IMPORT_ROOTS;
try{
 const config=modelConfig();const health=await fetch(`${config.url}/api/tags`,{signal:AbortSignal.timeout(3000),redirect:'error'}).then(r=>r.json());
 if(!health.models?.some(x=>x.name===config.model))throw Error(`Installed model required: ${config.model}; no model will be downloaded`);
 await fs.mkdir(path.join(source,'backend'),{recursive:true});if(!empty)await fs.writeFile(path.join(source,'README.md'),'# Safe live-model fixture\nOnly backend/greeting.mjs is in scope.\n');
 const original='export function greeting() { return "old"; }\n';if(!empty)await fs.writeFile(path.join(source,'backend/greeting.mjs'),original);
 if(correction){await fs.mkdir(path.join(source,'docs/teamforge'),{recursive:true});await fs.writeFile(path.join(source,'docs/teamforge/analysis.md'),'# Loan analysis\n\n## Requirements\nCredit eligibility review.\n');}
 await git(['init',source]);await git(['-C',source,'add','.']);await git(['-C',source,'-c','user.name=Live fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','fixture']);
 process.env.TEAMFORGE_IMPORT_ROOTS=root;const imported=await importRepository(path.join(root,'data'),'live-fixture',{kind:'local',path:source});
 const project=analysisMode?{title:'Loan management',description:'Analyze a new internal loan-management system. Propose credit eligibility rules, acceptance criteria, technical assumptions and unanswered questions. Use docs/teamforge/analysis.md for human review. Preserve existing analysis if present and apply reviewer feedback.',filePolicy:{analyst:['docs/teamforge/']}}:{title:'Change greeting',description:'Read backend/greeting.mjs. Change the returned string from "old" to "hello-teamforge". Keep the same function and export. Modify only that file. Then finish.',filePolicy:{backend:['backend/greeting.mjs']}};
 const role=analysisMode?'analyst':'backend',target=analysisMode?'docs/teamforge/analysis.md':'backend/greeting.mjs';
 const output=await runCodingAgent({project,role,feedback:correction?'Add a clearly titled Definitions section for loan, credit score, borrower and credit limit. Keep the existing requirements section.':'' ,root:imported.workspace,signal:AbortSignal.timeout(180000),onEvent:async(kind,message)=>console.log(`${kind}: ${message}`)});
 const content=await fs.readFile(path.join(imported.workspace,target),'utf8');
 if((analysisMode?!content.trim():!content.includes('hello-teamforge'))||!output.changes.some(x=>x.path===target))throw Error('Model did not produce the requested actual change');
 if((!empty&&await fs.readFile(path.join(source,'backend/greeting.mjs'),'utf8')!==original)||await git(['-C',source,'status','--porcelain']))throw Error('Original repository changed');
 if(correction&&(!/Definitions|تعاریف|Terminology/i.test(content)||!content.includes('Credit eligibility review.')||!output.actions.includes('read_file')||!output.actions.includes('write_file')))throw Error('Correction did not preserve requirements and add definitions through the safe read/write flow');
 const patch=await gitDiff(imported.workspace,target);if(analysisMode?!patch.includes('diff --git'):!patch.includes('hello-teamforge'))throw Error('No real Git diff');
 console.log(JSON.stringify({status:'PASS',type:'LIVE_MODEL',model:config.model,scenario:correction?'existing-analysis-review-correction':empty?'empty-repository-analysis':'existing-backend-edit',actions:output.actions,changedFiles:output.files,sourceUnchanged:true,sandboxChecks:output.checks},null,2));
}finally{if(oldRoots===undefined)delete process.env.TEAMFORGE_IMPORT_ROOTS;else process.env.TEAMFORGE_IMPORT_ROOTS=oldRoots;await fs.rm(root,{recursive:true,force:true});}
