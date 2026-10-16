import fs from 'node:fs/promises';
import path from 'node:path';
import {listFiles,readSafeFile} from './policies.mjs';
const BLOCK=/(^|\/)(\.git|\.env(?:\..*)?|node_modules|\.next|dist|build|coverage|\.ssh|\.npm|\.aws|\.github\/workflows|secrets?|credentials?|\.terraform|vendor|\.DS_Store|id_rsa|\.p12|\.pem|\.key)(\/|$)/i;
const BINARY=/\.(png|jpg|jpeg|gif|webp|pdf|svgz|ico|zip|gz|sqlite|db|wasm|woff2?|ttf|eot|lockb)$/i;
export function safeRelative(p){
 if(typeof p!=='string'||!p||p.length>240||p.includes('\\')||p.includes('\0')||path.posix.isAbsolute(p)||/^[a-z]:/i.test(p)||p!==path.posix.normalize(p)||p.split('/').includes('..')||p.split('/').some(x=>x.startsWith('.'))||BLOCK.test(p)||BINARY.test(p))throw Error('مسیر فایل ممنوع یا نامعتبر است.');
 return p;
}
export function roleAllows(role,p,policy){
 if(policy){const prefixes=policy[role];return Array.isArray(prefixes)&&prefixes.some(prefix=>prefix.endsWith('/')?p.startsWith(prefix):p===prefix);}
 if(role==='analyst')return p.startsWith('docs/teamforge/');
 if(role==='qa')return p.startsWith('docs/teamforge/')||p.startsWith('tests/')||p.startsWith('__tests__/')||/\.(test|spec)\.[cm]?[jt]sx?$/.test(p);
 if(role==='backend')return /^(backend|server|api|services|prisma|database|db|apps\/api|apps\/server|src\/(server|api|backend|routes|models|db|services|app\/api|pages\/api)|app\/api|pages\/api|apps\/web\/(app\/api|pages\/api|src\/app\/api|src\/pages\/api)|tests\/backend)\//.test(p)||p==='package.json';
 if(role==='frontend')return /^(frontend|client|components|styles|public|apps\/web|apps\/client|src|app|pages|tests\/frontend)\//.test(p)&&!(/(^|\/)(app|pages)\/api\//.test(p)||/^src\/(server|api|backend|routes|models|db|services)\//.test(p))||p==='package.json';
 return false;
}
export async function statSafe(root,p){
 safeRelative(p);let cursor=root;
 const segments=p.split('/');
 for(const part of segments){cursor=path.join(cursor,part);const stat=await fs.lstat(cursor).catch(e=>e.code==='ENOENT'?null:Promise.reject(e));if(stat?.isSymbolicLink())throw Error('Symlink مجاز نیست.');if(!stat)return null;}
 const stat=await fs.stat(cursor);if(!stat.isFile())throw Error('مسیر فایل نیست.');return stat;
}
export async function safeRead(root,p){safeRelative(p);const s=await statSafe(root,p);if(!s)throw Error('فایل وجود ندارد.');if(s.size>180000)throw Error('فایل بزرگ‌تر از محدوده ایجنت است.');return readSafeFile(root,p);}
export async function applyExactPatch(root,role,{path:filepath,search,replace},policy){
 const p=safeRelative(filepath);
 if(!roleAllows(role,p,policy))throw Error(`نقش ${role} مجاز به تغییر ${p} نیست.`);
 if(typeof search!=='string'||typeof replace!=='string'||replace.length>120000||search.length>100000)throw Error('Patch نامعتبر است.');
 const target=path.join(root,...p.split('/'));
 const stat=await statSafe(root,p);let before=stat?await safeRead(root,p):null,after;
 if(before===null){if(search!=='')throw Error('برای ایجاد فایل جدید search باید خالی باشد.');if(!replace)throw Error('فایل جدید نمی‌تواند خالی باشد.');after=replace;}
 else if(before===''&&search===''){after=replace;}
 else {if(!search)throw Error('برای تغییر فایل موجود باید search دقیق و غیرخالی باشد.');let start=before.indexOf(search);if(start<0||before.indexOf(search,start+1)>=0)throw Error('متن جستجو دقیقاً یک بار پیدا نشد؛ فایل را دوباره بخوانید.');after=before.slice(0,start)+replace+before.slice(start+search.length);}
 if(after.length>180000)throw Error('فایل جدید بیش از حد بزرگ است.');
 const parts=p.split('/');let cursor=root;
 for(const piece of parts.slice(0,-1)){cursor=path.join(cursor,piece);const s=await fs.lstat(cursor).catch(e=>e.code==='ENOENT'?null:Promise.reject(e));if(s&&!s.isDirectory())throw Error('مسیر پوشه نیست.');if(!s)await fs.mkdir(cursor);}
 // Recheck to reject races and avoid following symlink on final file.
 const latest=await statSafe(root,p);if(Boolean(latest)!==Boolean(stat))throw Error('فایل همزمان تغییر کرده است.');
 if(latest&&(await safeRead(root,p))!==before)throw Error('فایل همزمان ویرایش شده است.');
 const temp=path.join(path.dirname(target),`.teamforge-tmp-${process.pid}-${Date.now()}`);
 try{await fs.writeFile(temp,after,{flag:'wx',mode:0o600});await fs.rename(temp,target);}finally{await fs.rm(temp,{force:true}).catch(()=>{});}
 return{path:p,before,after};
}
export async function searchWorkspace(root,query,{limit=24}={}){
 if(typeof query!=='string'||query.length<2||query.length>100)throw Error('عبارت جستجو باید ۲ تا ۱۰۰ نویسه باشد.');
 const results=[];
 for(const p of (await listFiles(root)).slice(0,2000)){
  try{safeRelative(p);const text=await safeRead(root,p);const lines=text.split('\n');for(let i=0;i<lines.length;i++){if(lines[i].toLowerCase().includes(query.toLowerCase())){results.push({path:p,line:i+1,text:lines[i].slice(0,180)});if(results.length>=limit)return results;}}}catch{}
 }
 return results;
}
export async function repoFiles(root){return (await listFiles(root)).filter(p=>{try{safeRelative(p);return true;}catch{return false;}}).slice(0,2000);}
export async function deleteSafeFile(root,role,filepath,policy){
 const p=safeRelative(filepath);if(!roleAllows(role,p,policy))throw Error(`Role ${role} cannot delete ${p}`);
 const before=await safeRead(root,p);await statSafe(root,p);await fs.unlink(path.join(root,p));return{path:p,before,after:null};
}

/** Full-content edit tied to content actually read by this invocation, never a blind overwrite. */
export async function writeObservedFile(root,role,{path:filepath,content},observed,policy){
 const p=safeRelative(filepath);
 if(!roleAllows(role,p,policy))throw Error(`Role ${role} cannot write ${p}`);
 if(typeof content!=='string'||!content.trim()||content.length>120000)throw Error('write_file requires nonempty complete content');
 const exists=await statSafe(root,p);
 if(!exists){if(observed.has(p))throw Error('File changed since read_file; read it again before write_file.');return applyExactPatch(root,role,{path:p,search:'',replace:content},policy);}
 if(!observed.has(p))throw Error('Read the existing file with read_file before write_file.');
 const before=await safeRead(root,p);
 if(before!==observed.get(p))throw Error('File changed since read_file; read it again before write_file.');
 return applyExactPatch(root,role,{path:p,search:before,replace:content},policy);
}
