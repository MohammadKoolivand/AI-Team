import test from 'node:test';
import assert from 'node:assert/strict';
import {readOllamaStream} from './llm.mjs';

function responseFromPieces(pieces){
  const enc=new TextEncoder();
  return {body:new ReadableStream({start(controller){for(const p of pieces)controller.enqueue(enc.encode(p));controller.close();}})};
}

test('streaming Ollama NDJSON survives split lines and publishes output fragments',async()=>{
  const frames=[
    {message:{content:'{"summary":"done",'},done:false},
    {message:{content:'"files":[{}]}'},done:false},
    {done:true}
  ].map(x=>JSON.stringify(x)+'\n').join('');
  const pieces=[frames.slice(0,7),frames.slice(7,31),frames.slice(31,64),frames.slice(64)];
  const fragments=[];
  const result=await readOllamaStream(responseFromPieces(pieces),part=>fragments.push(part));
  assert.equal(result,'{"summary":"done","files":[{}]}');
  assert.equal(fragments.length,2);
});

test('stream ending before Ollama done is a real error',async()=>{
  await assert.rejects(readOllamaStream(responseFromPieces(['{"message":{"content":"partial"}}\n'])),/پیش از پایان/);
});

test('Ollama streaming error propagates',async()=>{
  await assert.rejects(readOllamaStream(responseFromPieces(['{"error":"model crashed"}\n'])),/model crashed/);
});
