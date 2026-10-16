import fs from 'node:fs/promises';
import path from 'node:path';
const RESTRICTED = /(^|\/)(\.git|\.env(?:\..*)?|id_rsa|\.ssh|secrets?|credentials?|node_modules|\.npm)(\/|$)/i;
const permitted = {
  'analyst':['docs/'],
  'tech-lead':['docs/'],
  'frontend':['frontend/'],
  'backend':['backend/'],
  'devops':['infrastructure/'],
  'qa':['tests/','docs/qa-report.md']
};
export function validateRelativeFile(input,role){
  if(typeof input!=='string'||input.length>220||!input||input.includes('\\')||input.includes('\0')||path.posix.isAbsolute(input)||/^[A-Za-z]:/.test(input))throw Error('مسیر فایل نامعتبر است.');
  const normalized=path.posix.normalize(input);
  if(normalized==='.'||normalized.startsWith('../')||normalized.includes('/../')||normalized!==input||RESTRICTED.test(normalized))throw Error('مسیر فایل خارج از محدوده مجاز است.');
  if(!permitted[role]?.some(prefix=>prefix.endsWith('/')?normalized.startsWith(prefix):normalized===prefix))throw Error(`ایجنت ${role} اجازه تغییر ${normalized} را ندارد.`);
  return normalized;
}
export async function writeAgentFiles(root,role,files,onFile=()=>{}){
  if(!Array.isArray(files)||files.length<1||files.length>12)throw Error('خروجی ایجنت باید ۱ تا ۱۲ فایل داشته باشد.');
  const written=[];
  for(const file of files){
    const relative=validateRelativeFile(file.path,role);
    if(typeof file.content!=='string'||file.content.length>110000)throw Error(`محتوای فایل ${relative} نامعتبر یا بیش از حد بزرگ است.`);
    const dest=path.join(root,...relative.split('/'));
    // Prevent writes through pre-existing symlinks, including parent directories.
    let cursor=root;
    for(const segment of relative.split('/').slice(0,-1)){
      cursor=path.join(cursor,segment);
      const stat=await fs.lstat(cursor).catch(e=>e.code==='ENOENT'?null:Promise.reject(e));
      if(stat?.isSymbolicLink())throw Error('نوشتن در مسیر لینک نمادین ممنوع است.');
      if(stat&&!stat.isDirectory())throw Error('مسیر مقصد پوشه نیست.');
      if(!stat)await fs.mkdir(cursor);
    }
    const stat=await fs.lstat(dest).catch(e=>e.code==='ENOENT'?null:Promise.reject(e));
    if(stat?.isSymbolicLink())throw Error('جایگزینی لینک نمادین ممنوع است.');
    await fs.writeFile(dest,file.content,{encoding:'utf8',flag:'w'});
    written.push(relative);
    await onFile(relative,written.length,files.length);
  }
  return written;
}
export async function listFiles(root){
  const files=[];
  async function visit(dir,prefix='',depth=0){if(depth>9)return;let entries;try{entries=await fs.readdir(dir,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return;throw e;}for(const e of entries){if(e.name.startsWith('.')||e.name==='node_modules')continue;const relative=prefix?`${prefix}/${e.name}`:e.name;if(e.isFile())files.push(relative);else if(e.isDirectory())await visit(path.join(dir,e.name),relative,depth+1);}}
  await visit(root);return files.sort();
}
export async function readSafeFile(root,relative){
  if(typeof relative!=='string'||!relative||relative.includes('\\')||relative.includes('\0')||relative.startsWith('/')||relative.split('/').includes('..')||relative.startsWith('.')||RESTRICTED.test(relative))throw Error('مسیر فایل نامعتبر است.');
  let current=root;
  for(const seg of relative.split('/')){current=path.join(current,seg);if((await fs.lstat(current)).isSymbolicLink())throw Error('خواندن Symlink مجاز نیست.');}
  const stat=await fs.stat(current);if(!stat.isFile()||stat.size>300000)throw Error('فایل قابل نمایش نیست.');
  return fs.readFile(current,'utf8');
}
