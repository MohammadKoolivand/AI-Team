/** Offline-only fixture for testing TeamForge on a throwaway Git repository. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const root=path.resolve(process.argv[2]||'./sample-repo');
if(await fs.stat(root).catch(()=>null)){
 console.error(`Sample repository already exists: ${root}\nNot overwriting your work.`);
 process.exit(1);
}
const files={
 'README.md':`# Employee Requests — isolated TeamForge test project\n\nA tiny offline Node.js + browser JavaScript project.\n\nFeature idea: Add an endpoint to create a request with title and status, and a form that calls the API.\nAcceptance criteria: title required; GET /api/requests returns records; POST /api/requests validates input; tests cover both.\n\nThis repository is intentionally small for qwen2.5-coder:7b.\n`,
 'package.json':JSON.stringify({name:'teamforge-sample-employee-requests',private:true,type:'module',scripts:{test:'node --test',build:'node --check backend/server.mjs && node --check frontend/app.js'}},null,2)+'\n',
 'backend/server.mjs':`import http from 'node:http';\n\nexport function createServer(){\n  const requests=[];\n  return http.createServer(async(req,res)=>{\n    res.setHeader('Content-Type','application/json; charset=utf-8');\n    if(req.method==='GET'&&req.url==='/api/requests'){res.end(JSON.stringify({requests}));return;}\n    res.statusCode=404;res.end(JSON.stringify({error:'not found'}));\n  });\n}\nif(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){\n  createServer().listen(3099,'127.0.0.1',()=>console.log('Sample API: http://127.0.0.1:3099'));\n}\n`,
 'backend/server.test.mjs':`import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {createServer} from './server.mjs';\ntest('empty requests GET endpoint',async()=>{\n const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));\n try{const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/requests');assert.equal(r.status,200);assert.deepEqual(await r.json(),{requests:[]});}\n finally{await new Promise(resolve=>server.close(resolve));}\n});\n`,
 'frontend/app.js':`// Existing browser UI: AI frontend agent may extend this file to add a form.\nexport function renderRequests(requests){\n return '<ul>'+requests.map(item=>'<li>'+escapeHtml(item.title)+'</li>').join('')+'</ul>';\n}\nfunction escapeHtml(value){return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');}\n`,
};
for(const [rel,content] of Object.entries(files)){
 const dest=path.join(root,...rel.split('/'));await fs.mkdir(path.dirname(dest),{recursive:true});await fs.writeFile(dest,content);
}
execFileSync('git',['init',root],{stdio:'ignore'});
execFileSync('git',['-C',root,'add','.'],{stdio:'ignore'});
execFileSync('git',['-C',root,'-c','user.name=TeamForge Fixture','-c','user.email=teamforge@example.invalid','commit','-m','test fixture'],{stdio:'ignore'});
console.log(`\nSample repository ready: ${root}\nFor TeamForge, set:\nexport TEAMFORGE_IMPORT_ROOTS="${path.dirname(root)}"\nThen paste this path in the portfolio Git connection field:\n${root}\n`);
