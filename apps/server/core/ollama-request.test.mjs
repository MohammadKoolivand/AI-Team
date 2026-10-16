import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {requestOllama} from './ollama-request.mjs';
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',r));
async function usingServer(handler,fn){const previous=process.env.OLLAMA_URL,s=http.createServer(handler);await listen(s);process.env.OLLAMA_URL=`http://127.0.0.1:${s.address().port}`;try{await fn();}finally{s.closeAllConnections();await new Promise(r=>s.close(r));if(previous===undefined)delete process.env.OLLAMA_URL;else process.env.OLLAMA_URL=previous;}}
const payload={model:'fixture',stream:true,messages:[]};

test('slow active model streams survive the idle threshold, reset on received data and finish on done without waiting for HTTP close',async()=>{
 await usingServer((req,res)=>{req.resume();res.writeHead(200,{'Content-Type':'application/x-ndjson'});let n=0;res.write(JSON.stringify({message:{content:'start'},done:false})+'\n');const timer=setInterval(()=>{n++;res.write(JSON.stringify(n===5?{done:true}:{message:{content:'x'},done:false})+'\n');if(n===5)clearInterval(timer);},30);res.on('close',()=>clearInterval(timer));},async()=>{
 const began=Date.now();const result=await requestOllama(payload,{timeouts:{firstByteMs:1000,idleMs:100,totalMs:2000}});assert.equal(result,'startxxxx');assert.ok(Date.now()-began>100);
 });
});

test('model stream stalls produce a specific idle timeout and cancel its connection',async()=>{
 await usingServer((req,res)=>{req.resume();res.writeHead(200,{'Content-Type':'application/x-ndjson'});res.write(JSON.stringify({message:{content:'{"action":'},done:false})+'\n');},async()=>{
 await assert.rejects(requestOllama(payload,{timeouts:{firstByteMs:1000,idleMs:40,totalMs:1000}}),{code:'OLLAMA_IDLE_TIMEOUT'});
 });
});

test('model startup and absolute response limits are distinct and remain bounded',async()=>{
 await usingServer((req,res)=>{req.resume();},async()=>{await assert.rejects(requestOllama(payload,{timeouts:{firstByteMs:40,idleMs:1000,totalMs:1000}}),{code:'OLLAMA_START_TIMEOUT'});});
 await usingServer((req,res)=>{req.resume();res.writeHead(200,{'Content-Type':'application/x-ndjson'});const timer=setInterval(()=>res.write(JSON.stringify({message:{content:' '},done:false})+'\n'),15);res.on('close',()=>clearInterval(timer));},async()=>{await assert.rejects(requestOllama(payload,{timeouts:{firstByteMs:1000,idleMs:1000,totalMs:80}}),{code:'OLLAMA_RESPONSE_TIMEOUT'});});
});

test('token-limited output cannot be accepted as a complete action',async()=>{
 await usingServer((req,res)=>{req.resume();res.writeHead(200,{'Content-Type':'application/x-ndjson'});res.end(JSON.stringify({message:{content:'{"action":"finish"}'},done:true,done_reason:'length'})+'\n');},async()=>{await assert.rejects(requestOllama(payload),{code:'OLLAMA_OUTPUT_LIMIT'});});
});
