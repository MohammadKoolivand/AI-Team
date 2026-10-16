const header=(p)=>`# ${p.title}\n\n${p.description}\n\n> این سند در حالت «دمو / قالب» ایجاد شده است. خروجی این حالت اسکلت عمومی است و پیاده‌سازی سفارشی نیازمندی شما نیست. برای کدنویسی وابسته به شرح پروژه، حالت Ollama را انتخاب کنید.\n`;
export function demoFiles(role,p){
  const title=JSON.stringify(p.title);
  if(role==='tech-lead')return [
    {path:'docs/architecture.md',content:header(p)+`\n## معماری پیشنهادی اولیه\n- Frontend: React + Vite\n- Backend: Node.js HTTP API\n- Workflow: human-gated staged reviews\n- Quality: Node built-in test runner\n\n## وظایف\n1. ساخت API پایه\n2. ساخت داشبورد React پایه\n3. بررسی و تأیید انسانی در هر مرحله\n4. تست صحت فایل‌ها و تست Backend\n`},
    {path:'docs/api-contract.md',content:`# API Contract (generic template)\n\nGET /api/health -> { ok: true }\n\nGET /api/items -> { items: [{id,title}] }\n\nPOST /api/items Body: {title: string} -> { item: {id,title} }\n\n> قرارداد نمونه است و باید برای محصول واقعی توسعه یابد.\n`}
  ];
  if(role==='backend')return [
    {path:'backend/package.json',content:JSON.stringify({name:'generated-starter-api',version:'0.1.0',private:true,type:'module',scripts:{start:'node src/server.mjs',test:'node --test'}},null,2)+'\n'},
    {path:'backend/src/server.mjs',content:`import http from 'node:http';
import { randomUUID } from 'node:crypto';
export function createApp() {
 const items=[];
 return http.createServer(async(req,res)=>{
   res.setHeader('Content-Type','application/json; charset=utf-8');
   res.setHeader('Access-Control-Allow-Origin','http://localhost:5173');
   res.setHeader('Access-Control-Allow-Headers','Content-Type');
   res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
   if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
   if(req.method==='GET'&&req.url==='/api/health')return res.end(JSON.stringify({ok:true}));
   if(req.method==='GET'&&req.url==='/api/items')return res.end(JSON.stringify({items}));
   if(req.method==='POST'&&req.url==='/api/items'){
     let raw='';for await(const part of req){raw+=part;if(raw.length>10000){res.writeHead(413);return res.end(JSON.stringify({error:'too large'}));}}
     let body;try{body=JSON.parse(raw)}catch{res.writeHead(400);return res.end(JSON.stringify({error:'invalid json'}));}
     if(typeof body.title!=='string'||!body.title.trim()||body.title.length>120){res.writeHead(400);return res.end(JSON.stringify({error:'invalid title'}));}
     const item={id:randomUUID(),title:body.title.trim()};items.push(item);res.writeHead(201);return res.end(JSON.stringify({item}));
   }
   res.writeHead(404);res.end(JSON.stringify({error:'not found'}));
 });
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){createApp().listen(Number(process.env.PORT||3001),'0.0.0.0',()=>console.log('API ready on :3001'));}
`},
    {path:'backend/test/server.test.mjs',content:`import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/server.mjs';
test('health and create item',async()=>{
 const server=createApp();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const base='http://127.0.0.1:'+server.address().port;
 const health=await(await fetch(base+'/api/health')).json();assert.equal(health.ok,true);
 const added=await fetch(base+'/api/items',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Example'})});assert.equal(added.status,201);
 const listing=await(await fetch(base+'/api/items')).json();assert.equal(listing.items[0].title,'Example');
 }finally{await new Promise(r=>server.close(r));}
});
`}
  ];
  if(role==='frontend')return [
    {path:'frontend/package.json',content:JSON.stringify({name:'generated-starter-ui',version:'0.1.0',private:true,type:'module',scripts:{dev:'vite --host 0.0.0.0',build:'vite build'},dependencies:{react:'^19.0.0','react-dom':'^19.0.0'},devDependencies:{'@vitejs/plugin-react':'^4.4.0',vite:'^6.0.0'}},null,2)+'\n'},
    {path:'frontend/index.html',content:`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Generated starter</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>`},
    {path:'frontend/vite.config.js',content:`import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({plugins:[react()],server:{host:'0.0.0.0',port:5173,proxy:{'/api':{target:process.env.API_TARGET||'http://127.0.0.1:3001',changeOrigin:true}}}});
`},
    {path:'frontend/src/main.jsx',content:`import React,{useEffect,useState} from 'react';
import{createRoot}from'react-dom/client';
import './style.css';
const title=${title};
function App(){const[items,setItems]=useState([]),[value,setValue]=useState(''),[error,setError]=useState('');
async function load(){try{const r=await fetch('/api/items');if(!r.ok)throw Error('API unavailable');setItems((await r.json()).items);setError('')}catch(e){setError(e.message)}}
useEffect(()=>{load()},[]);
async function submit(e){e.preventDefault();if(!value.trim())return;try{const r=await fetch('/api/items',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:value})});if(!r.ok)throw Error('Save failed');setValue('');await load()}catch(e){setError(e.message)}}
return <main><span className="eyebrow">GENERATED STARTER · DEMO TEMPLATE</span><h1>{title}</h1><p>اسکلت اولیه React و Node.js — فهرست نمونه برای آزمایش اتصال Frontend و Backend</p><form onSubmit={submit}><input value={value} onChange={e=>setValue(e.target.value)} placeholder="عنوان آیتم جدید"/><button>افزودن</button></form>{error&&<p className="error">{error}</p>}<section>{items.map(i=><article key={i.id}>{i.title}</article>)}{!items.length&&<div className="empty">هنوز آیتمی اضافه نشده است.</div>}</section></main>}
createRoot(document.getElementById('root')).render(<App/>);
`},
    {path:'frontend/src/style.css',content:`*{box-sizing:border-box}body{margin:0;background:#f3f6f9;color:#1c2c42;font-family:Tahoma,Arial,sans-serif}main{max-width:720px;margin:9vh auto;padding:40px;background:#fff;border:1px solid #e5eaf0;border-radius:20px;box-shadow:0 16px 40px #24334a0c}.eyebrow{font:11px Arial;letter-spacing:2px;color:#299c91}h1{font-size:32px;margin:18px 0}p{color:#66788b;line-height:1.9}form{display:flex;gap:10px;margin:28px 0}input{flex:1;min-width:0;border:1px solid #d9e2e8;padding:14px;border-radius:10px;font:inherit}button{background:#1a8279;color:#fff;border:none;border-radius:10px;padding:0 24px;font:inherit;cursor:pointer}section{display:grid;gap:10px}article,.empty{border:1px solid #edf0f3;border-radius:12px;padding:16px}.empty{color:#8d9aa8;text-align:center}.error{color:#c24949}@media(max-width:600px){main{margin:12px;padding:22px}form{flex-wrap:wrap}button{padding:14px}}`}
  ];
  if(role==='devops')return [
    {path:'infrastructure/backend.Dockerfile',content:`FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nEXPOSE 3001\nCMD ["node", "src/server.mjs"]\n`},
    {path:'infrastructure/frontend.Dockerfile',content:`FROM node:22-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm install\nCOPY . .\nEXPOSE 5173\nCMD ["npm", "run", "dev"]\n`},
    {path:'infrastructure/compose.yaml',content:`services:\n  backend:\n    build:\n      context: ../backend\n      dockerfile: ../infrastructure/backend.Dockerfile\n    ports:\n      - "127.0.0.1:3001:3001"\n  frontend:\n    build:\n      context: ../frontend\n      dockerfile: ../infrastructure/frontend.Dockerfile\n    environment:\n      API_TARGET: http://backend:3001\n    ports:\n      - "127.0.0.1:5174:5173"\n    depends_on:\n      - backend\n`},
    {path:'infrastructure/README.md',content:`# اجرای پروژه ساخته‌شده\n\nاز پوشه ریشه پروژه:\n\n\`\`\`bash\ndocker compose -f infrastructure/compose.yaml up --build\n\`\`\`\n\nFrontend: http://127.0.0.1:5174\nBackend health: http://127.0.0.1:3001/api/health\n\nاین سرویس نمونه برای توسعه محلی است، نه استقرار امن Production.\n`}
  ];
  if(role==='qa')return [
    {path:'tests/checklist.md',content:`# QA checklist\n- [ ] API health endpoint returns 200\n- [ ] POST /api/items validates title\n- [ ] GET /api/items returns created entries\n- [ ] React UI lists data from Backend\n- [ ] Docker Compose builds successfully\n\nدر حالت دمو بررسی‌های فایل و تست Backend با Runner انجام می‌شوند؛ موارد دیگر به تست واقعی در محیط اجرا نیاز دارند.\n`}
  ];
  throw new Error('Unknown agent');
}
