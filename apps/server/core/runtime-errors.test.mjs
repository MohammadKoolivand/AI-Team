import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runCodingAgent} from './coding-agent.mjs';
import {modelConfig} from './llm.mjs';
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));

test('malformed model output is rejected, bounded retries never execute shell text, missing Ollama fails',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'teamforge-runtime-errors-'));const oldURL=process.env.OLLAMA_URL;let count=0;
 const server=http.createServer((req,res)=>{req.resume();count++;res.writeHead(200,{'Content-Type':'application/x-ndjson'});res.end(JSON.stringify({message:{content:'rm -rf /'},done:true})+'\n');});await listen(server);
 try{
  process.env.OLLAMA_URL=`http://127.0.0.1:${server.address().port}`;
  await assert.rejects(runCodingAgent({project:{title:'Test',description:'Test'},role:'analyst',root}),/JSON/);assert.equal(count,3);assert.deepEqual(await fs.readdir(root),[]);
  await new Promise(r=>server.close(r));await assert.rejects(runCodingAgent({project:{title:'Test',description:'Test'},role:'analyst',root}),/fetch|connect/i);
  process.env.OLLAMA_URL='https://example.invalid';assert.throws(()=>modelConfig(),/loopback/);
 }finally{server.close();if(oldURL===undefined)delete process.env.OLLAMA_URL;else process.env.OLLAMA_URL=oldURL;await fs.rm(root,{recursive:true,force:true});}
});

test('running model inference is abortable and no file action is applied after cancellation',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'teamforge-cancel-')),oldURL=process.env.OLLAMA_URL;
 let received;const started=new Promise(r=>received=r);const server=http.createServer((req,res)=>{req.resume();received();res.writeHead(200,{'Content-Type':'application/x-ndjson'});res.write('\n');});await listen(server);
 const controller=new AbortController();
 try{
  process.env.OLLAMA_URL=`http://127.0.0.1:${server.address().port}`;
  const run=runCodingAgent({project:{title:'Test',description:'Test'},role:'analyst',root,signal:controller.signal});await started;controller.abort();await assert.rejects(run,/abort/i);assert.deepEqual(await fs.readdir(root),[]);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));if(oldURL===undefined)delete process.env.OLLAMA_URL;else process.env.OLLAMA_URL=oldURL;await fs.rm(root,{recursive:true,force:true});}
});

test('empty repository uses native create_file content, missing reads return recovery guidance, existing files are never overwritten',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'teamforge-create-')),oldURL=process.env.OLLAMA_URL;let call=0;
 const events=[],actions=[{action:'read_file',path:'README.md'},{action:'create_file',path:'docs/teamforge/analysis.md',content:'# Analysis\nAcceptance criteria and risks.'},{action:'create_file',path:'docs/teamforge/analysis.md',content:'MUST NOT OVERWRITE'},{action:'finish',summary:'Analysis ready'}];
 const server=http.createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);
  if(call===0)assert.match(body.messages[1].content,/NO visible files/);
  if(call===1)assert.match(body.messages.at(-1).content,/"exists":false/);
  const action=actions[call++];res.writeHead(200,{'Content-Type':'application/x-ndjson'});res.end(JSON.stringify({message:{content:JSON.stringify(action)},done:true})+'\n');
 });await listen(server);
 try{process.env.OLLAMA_URL=`http://127.0.0.1:${server.address().port}`;const output=await runCodingAgent({project:{title:'Lending',description:'Analyze loan requirements'},role:'analyst',root,onEvent:async(kind,text)=>events.push({kind,text})});
  assert.equal(await fs.readFile(path.join(root,'docs/teamforge/analysis.md'),'utf8'),'# Analysis\nAcceptance criteria and risks.');assert.deepEqual(output.files,['docs/teamforge/analysis.md']);assert.ok(events.some(e=>e.text.includes('never overwrites')));
 }finally{await new Promise(r=>server.close(r));if(oldURL===undefined)delete process.env.OLLAMA_URL;else process.env.OLLAMA_URL=oldURL;await fs.rm(root,{recursive:true,force:true});}
});

test('repeated invalid create_file calls stop after three errors instead of cycling for thirty actions',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'teamforge-stalled-')),oldURL=process.env.OLLAMA_URL;let count=0;
 const server=http.createServer((req,res)=>{req.resume();count++;res.writeHead(200,{'Content-Type':'application/x-ndjson'});res.end(JSON.stringify({message:{content:JSON.stringify({action:'create_file',path:'docs/teamforge/analysis.md'})},done:true})+'\n');});await listen(server);
 try{process.env.OLLAMA_URL=`http://127.0.0.1:${server.address().port}`;await assert.rejects(runCodingAgent({project:{title:'Test',description:'Analyze'},role:'analyst',root}),/repeated tool errors/);assert.equal(count,3);assert.deepEqual(await fs.readdir(root),[]);
 }finally{await new Promise(r=>server.close(r));if(oldURL===undefined)delete process.env.OLLAMA_URL;else process.env.OLLAMA_URL=oldURL;await fs.rm(root,{recursive:true,force:true});}
});

test('analyst correction pre-reads its document and saves a complete revision with one model call',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'teamforge-analysis-correction-')),oldURL=process.env.OLLAMA_URL;
 const original='# Loan analysis\n\n## Requirements\nCredit eligibility review.\n',updated=original+'\n## Definitions\nBorrower: the person requesting a loan.\n';
 await fs.mkdir(path.join(root,'docs/teamforge'),{recursive:true});await fs.writeFile(path.join(root,'docs/teamforge/analysis.md'),original);
 let calls=0;
 const server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const b=JSON.parse(raw);calls++;
 assert.match(b.messages[1].content,/Credit eligibility review/);assert.match(b.messages[1].content,/Add Definitions/);assert.deepEqual(b.format.properties.action.enum,['write_file']);assert.deepEqual(b.format.required,['action','path','content']);
 res.writeHead(200,{'Content-Type':'application/x-ndjson'});res.end(JSON.stringify({message:{content:JSON.stringify({action:'write_file',path:'docs/teamforge/analysis.md',content:updated})},done:true})+'\n');});await listen(server);
 try{process.env.OLLAMA_URL=`http://127.0.0.1:${server.address().port}`;const output=await runCodingAgent({project:{title:'Loans',description:'Loan analysis'},role:'analyst',root,feedback:'Add Definitions'});assert.equal(calls,1);assert.deepEqual(output.actions,['read_file','write_file']);assert.equal(output.finished,true);assert.equal(output.changes.length,1);assert.equal(output.changes[0].before,original);assert.equal(output.changes[0].after,updated);assert.equal(await fs.readFile(path.join(root,'docs/teamforge/analysis.md'),'utf8'),updated);
 }finally{await new Promise(r=>server.close(r));if(oldURL===undefined)delete process.env.OLLAMA_URL;else process.env.OLLAMA_URL=oldURL;await fs.rm(root,{recursive:true,force:true});}
});

test('full-document edits reject stale reads, unauthorized paths and blindly replacing existing documents',async()=>{
 const {writeObservedFile,safeRead}=await import('./coding-files.mjs');const root=await fs.mkdtemp(path.join(os.tmpdir(),'teamforge-observed-'));const filename='docs/teamforge/analysis.md',observed=new Map();
 try{
  await writeObservedFile(root,'analyst',{path:filename,content:'Initial'},observed);
  await assert.rejects(writeObservedFile(root,'analyst',{path:filename,content:'Blind'},observed),/Read the existing/);
  observed.set(filename,await safeRead(root,filename));await fs.writeFile(path.join(root,filename),'Concurrent human edit');
  await assert.rejects(writeObservedFile(root,'analyst',{path:filename,content:'Stale overwrite'},observed),/changed since/);assert.equal(await safeRead(root,filename),'Concurrent human edit');
  await assert.rejects(writeObservedFile(root,'analyst',{path:'backend/server.mjs',content:'Unauthorized'},observed),/cannot write/);
  await assert.rejects(writeObservedFile(root,'analyst',{path:'../escape.md',content:'Unsafe'},observed));
  observed.set(filename,await safeRead(root,filename));await writeObservedFile(root,'analyst',{path:filename,content:'Reviewed Definitions'},observed);assert.equal(await safeRead(root,filename),'Reviewed Definitions');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

for(const role of ['backend','frontend'])test(`${role} cannot finish with zero implementation after trying to overwrite analysis`,async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'teamforge-backend-empty-')),oldURL=process.env.OLLAMA_URL;const filename='docs/teamforge/analysis.md',original='# Approved analysis\nImplement an eligibility API.';
 await fs.mkdir(path.join(root,'docs/teamforge'),{recursive:true});await fs.writeFile(path.join(root,filename),original);let count=0;
 const server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const payload=JSON.parse(raw);
 assert.ok(!payload.messages[0].content.includes('"path":"docs/teamforge/analysis.md"'));assert.match(payload.messages[1].content,/READ-ONLY/);assert.match(payload.messages[1].content,/Implement an eligibility API/);
 const action=count++===0?{action:'write_file',path:filename,content:'Forbidden rewrite'}:{action:'finish',summary:'Done without changes'};
 res.writeHead(200,{'Content-Type':'application/x-ndjson'});res.end(JSON.stringify({message:{content:JSON.stringify(action)},done:true})+'\n');});await listen(server);
 try{process.env.OLLAMA_URL=`http://127.0.0.1:${server.address().port}`;await assert.rejects(runCodingAgent({project:{title:'Loans',description:'Implement backend eligibility'},role,root}),{code:'NO_IMPLEMENTATION'});assert.equal(count,3);assert.equal(await fs.readFile(path.join(root,filename),'utf8'),original);assert.equal(await fs.stat(path.join(root,'backend')).catch(()=>null),null);
 }finally{await new Promise(r=>server.close(r));if(oldURL===undefined)delete process.env.OLLAMA_URL;else process.env.OLLAMA_URL=oldURL;await fs.rm(root,{recursive:true,force:true});}
});

test('a refused premature backend finish is repaired by a real role-appropriate file change',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'teamforge-backend-recovery-')),oldURL=process.env.OLLAMA_URL;let count=0;
 const actions=[{action:'finish',summary:'Nothing done yet'},{action:'create_file',path:'backend/eligibility.mjs',content:'export const eligible = score => Number.isFinite(score) && score >= 600;\n'},{action:'finish',summary:'Implemented eligibility'}];
 const server=http.createServer(async(req,res)=>{req.resume();const action=actions[count++];res.writeHead(200,{'Content-Type':'application/x-ndjson'});res.end(JSON.stringify({message:{content:JSON.stringify(action)},done:true})+'\n');});await listen(server);
 try{process.env.OLLAMA_URL=`http://127.0.0.1:${server.address().port}`;const output=await runCodingAgent({project:{title:'Loans',description:'Implement eligibility'},role:'backend',root});assert.equal(output.finished,true);assert.deepEqual(output.files,['backend/eligibility.mjs']);assert.match(await fs.readFile(path.join(root,'backend/eligibility.mjs'),'utf8'),/score >= 600/);assert.equal(count,3);
 }finally{await new Promise(r=>server.close(r));if(oldURL===undefined)delete process.env.OLLAMA_URL;else process.env.OLLAMA_URL=oldURL;await fs.rm(root,{recursive:true,force:true});}
});

test('creating then deleting a source file cannot bypass the implementation gate',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'teamforge-backend-revert-')),oldURL=process.env.OLLAMA_URL;let count=0;
 const actions=[{action:'create_file',path:'backend/temp.mjs',content:'export const temporary=true;'},{action:'delete_file',path:'backend/temp.mjs'},{action:'finish'},{action:'finish'}];
 const server=http.createServer(async(req,res)=>{req.resume();res.writeHead(200,{'Content-Type':'application/x-ndjson'});res.end(JSON.stringify({message:{content:JSON.stringify(actions[count++])},done:true})+'\n');});await listen(server);
 try{process.env.OLLAMA_URL=`http://127.0.0.1:${server.address().port}`;await assert.rejects(runCodingAgent({project:{title:'Test',description:'Implement backend'},role:'backend',root}),{code:'NO_IMPLEMENTATION'});assert.equal(count,4);await assert.rejects(fs.readFile(path.join(root,'backend/temp.mjs')),{code:'ENOENT'});
 }finally{await new Promise(r=>server.close(r));if(oldURL===undefined)delete process.env.OLLAMA_URL;else process.env.OLLAMA_URL=oldURL;await fs.rm(root,{recursive:true,force:true});}
});

test('saved implementation checkpoints survive abort and resume without rewriting or losing the original diff',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'teamforge-checkpoint-')),old=process.env.OLLAMA_URL,controller=new AbortController();let checkpoint=[],calls=0;
 const server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const payload=JSON.parse(raw);assert.ok(payload.format.oneOf.some(s=>s.properties.action.enum[0]==='apply_patch'&&s.properties.search.minLength===1));calls++;res.writeHead(200,{'Content-Type':'application/x-ndjson'});res.end(JSON.stringify({message:{content:JSON.stringify(calls===1?{action:'write_file',path:'backend/api.mjs',content:'export const ready=true;'}:{action:'finish',summary:'Resume saved implementation for review'})},done:true})+'\n');});await listen(server);
 try{
  process.env.OLLAMA_URL=`http://127.0.0.1:${server.address().port}`;
  const project={title:'Resume',description:'Implement backend'};
  await assert.rejects(runCodingAgent({project,role:'backend',root,signal:controller.signal,onCheckpoint:async changes=>{checkpoint=structuredClone(changes);controller.abort();}}),/abort/i);
  assert.equal(checkpoint[0].before,null);assert.equal(await fs.readFile(path.join(root,'backend/api.mjs'),'utf8'),checkpoint[0].after);
  const result=await runCodingAgent({project,role:'backend',root,initialChanges:checkpoint});assert.equal(result.finished,true);assert.equal(result.changes[0].before,null);assert.equal(result.changes[0].after,'export const ready=true;');assert.equal(calls,2);
  await fs.writeFile(path.join(root,'backend/api.mjs'),'external modification');await assert.rejects(runCodingAgent({project,role:'backend',root,initialChanges:checkpoint}),/تغییر کرده/);assert.equal(calls,2);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));if(old===undefined)delete process.env.OLLAMA_URL;else process.env.OLLAMA_URL=old;await fs.rm(root,{recursive:true,force:true});}
});

test('identical repeated writes stop with saved progress instead of consuming the stage timeout',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'teamforge-no-progress-')),old=process.env.OLLAMA_URL;let calls=0,checkpoint=[];
 const server=http.createServer((req,res)=>{req.resume();calls++;res.writeHead(200,{'Content-Type':'application/x-ndjson'});res.end(JSON.stringify({message:{content:JSON.stringify({action:'write_file',path:'backend/api.mjs',content:'export const ready=true;'})},done:true})+'\n');});await listen(server);
 try{process.env.OLLAMA_URL=`http://127.0.0.1:${server.address().port}`;await assert.rejects(runCodingAgent({project:{title:'Loop',description:'Implement backend'},role:'backend',root,onCheckpoint:async changes=>{checkpoint=changes;}}),e=>e.code==='AGENT_NO_PROGRESS');assert.equal(calls,3);assert.equal(checkpoint.length,1);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));if(old===undefined)delete process.env.OLLAMA_URL;else process.env.OLLAMA_URL=old;await fs.rm(root,{recursive:true,force:true});}
});
