import {modelConfig,readOllamaStream} from './llm.mjs';
const setting=(name,fallback)=>{const value=Number(process.env[name]);return Number.isFinite(value)&&value>0?Math.min(value,1800000):fallback;};
export function ollamaTimeouts(){return{firstByteMs:setting('TEAMFORGE_OLLAMA_START_TIMEOUT_MS',180000),idleMs:setting('TEAMFORGE_OLLAMA_IDLE_TIMEOUT_MS',90000),totalMs:setting('TEAMFORGE_OLLAMA_RESPONSE_TIMEOUT_MS',600000)};}
const timeoutError=(code,text)=>Object.assign(Error(text),{code});
/** A slow, active stream is different from a stalled model; never execute a partial action. */
export async function requestOllama(payload,{signal,onChunk=()=>{},onStatus=()=>{},timeouts=ollamaTimeouts()}={}){
 const {url}=modelConfig(),controller=new AbortController(),started=Date.now();let idleTimer,bytes=0,received=false;
 const resetIdle=()=>{clearTimeout(idleTimer);idleTimer=setTimeout(()=>controller.abort(timeoutError(received?'OLLAMA_IDLE_TIMEOUT':'OLLAMA_START_TIMEOUT',received?'جریان پاسخ Ollama متوقف شد؛ خروجی ناقص اجرا نشد. دوباره تلاش کنید.':'Ollama در مهلت شروع پاسخ نداد؛ ممکن است مدل در صف یا در حال بارگذاری باشد.')),received?timeouts.idleMs:timeouts.firstByteMs);};
 const deadline=setTimeout(()=>controller.abort(timeoutError('OLLAMA_RESPONSE_TIMEOUT','زمان کل پاسخ Ollama به سقف مجاز رسید؛ هیچ دستور ناقصی اجرا نشد.')),timeouts.totalMs);
 const progress=()=>onStatus({phase:received?'generating':'waiting-model',requestElapsedMs:Date.now()-started,responseBytes:bytes,detail:received?`دریافت پاسخ مدل · ${Math.floor((Date.now()-started)/1000)} ثانیه`:`انتظار برای شروع پاسخ Ollama · ${Math.floor((Date.now()-started)/1000)} ثانیه`});
 resetIdle();progress();const heartbeat=setInterval(progress,1000);
 try{
  const response=await fetch(`${url.replace(/\/$/,'')}/api/chat`,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:signal?AbortSignal.any([signal,controller.signal]):controller.signal});
  if(!response.ok){await response.body?.cancel();throw Error(`Ollama HTTP ${response.status}`);}
  return await readOllamaStream(response,onChunk,{onBytes:count=>{bytes+=count;received=true;resetIdle();if(bytes>2000000)controller.abort(timeoutError('OLLAMA_OUTPUT_LIMIT','پاسخ مدل از اندازهٔ مجاز بیشتر شد؛ خروجی ناقص اجرا نشد.'));}});
 }catch(error){if(signal?.aborted)throw signal.reason;if(controller.signal.aborted)throw controller.signal.reason;throw error;}
 finally{clearTimeout(idleTimer);clearTimeout(deadline);clearInterval(heartbeat);}
}
