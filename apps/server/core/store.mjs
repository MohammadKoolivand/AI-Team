import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {durableJSON,restoreInPlace} from './durable.mjs';

export const ROLES = [
  {id:'analyst',name:'Business Analyst / Tech Lead',fa:'تحلیل و معماری',area:'تحلیل نیازمندی و قرارداد API'},
  {id:'backend',name:'Backend Developer',fa:'بک‌اند',area:'کدنویسی API و دیتابیس'},
  {id:'frontend',name:'Frontend Developer',fa:'فرانت‌اند',area:'کدنویسی رابط کاربری'},
  {id:'qa',name:'QA Engineer',fa:'تست و تضمین کیفیت',area:'اجرای بررسی‌ها و گزارش تست'}
];
export const STAGES = [
  {id:'analysis',title:'تحلیل نیازمندی و طراحی فنی',agent:'analyst',dependencies:[]},
  {id:'backend',title:'پیاده‌سازی بک‌اند',agent:'backend',dependencies:['analysis']},
  {id:'frontend',title:'پیاده‌سازی فرانت‌اند',agent:'frontend',dependencies:['backend']},
  {id:'qa',title:'تست و کنترل کیفیت',agent:'qa',dependencies:['frontend']}
];
const clone=x=>structuredClone(x);
export class Store {
  constructor(dataDir){this.dataDir=dataDir;this.file=path.join(dataDir,'state.json');this.state={projects:[]};this.serial=Promise.resolve();this.listeners=new Map();this.live=new Map();}
  async init(){
    await fs.mkdir(this.dataDir,{recursive:true});
    try{const state=JSON.parse(await fs.readFile(this.file,'utf8'));if(Array.isArray(state.projects))this.state=state;}catch(e){if(e.code!=='ENOENT')throw e;}
    for(const p of this.state.projects){
      if(p.status==='running'){
        p.status='interrupted';
        for(const t of p.tasks)if(t.status==='running')t.status='pending';
        p.events.push({id:crypto.randomUUID(),at:new Date().toISOString(),agent:'system',kind:'warning',text:'اجرای قبلی قطع شده است؛ می‌توانید ادامه دهید.'});
      }
    }
    await this.save();
  }
  getProjects(){return clone(this.state.projects.map(({id,title,description,mode,runner,status,createdAt,tasks,repository})=>({id,title,description,mode,runner,status,createdAt,repository,tasks:tasks.map(({id,title,status,agent,attempts})=>({id,title,status,agent,attempts}))})).reverse());}
  getProject(id){const p=this.state.projects.find(x=>x.id===id);return p?clone(p):null;}
  async save(){await durableJSON(this.file,this.state);}
  async mutate(id,fn){
    const commit=async()=>{const p=this.state.projects.find(x=>x.id===id);if(!p)throw Error('پروژه پیدا نشد.');const backup=clone(this.state);let result;try{result=await fn(p);p.updatedAt=new Date().toISOString();await this.save();}catch(e){restoreInPlace(this.state,backup);throw e;}this.publish(id,{type:'update',at:p.updatedAt});return result;};
    const next=this.serial.then(commit,commit);this.serial=next.catch(()=>{});return next;
  }
  async create({title,description,mode,runner='builtin'}){
    const id=crypto.randomUUID(),now=new Date().toISOString();
    const p={id,title,description,mode,runner,status:'draft',createdAt:now,updatedAt:now,
      tasks:STAGES.map(t=>({...t,status:'pending',attempts:0,output:[],error:null,feedback:'',reviews:[],revisions:[],checks:[],startedAt:null,finishedAt:null,approvedAt:null})),
      repository:null,events:[{id:crypto.randomUUID(),at:now,agent:'system',kind:'created',text:'پروژه ثبت شد؛ مراحل تنها پس از تأیید انسانی پیش می‌روند.'}],quality:null,approvedAt:null};
    const next=this.serial.then(async()=>{this.state.projects.push(p);try{await this.save();}catch(e){this.state.projects=this.state.projects.filter(x=>x.id!==id);throw e;}this.publish(id,{type:'update',at:now});});this.serial=next.catch(()=>{});await next;return clone(p);
  }
  async deleteDraft(id){
    const next=this.serial.then(async()=>{
      const p=this.state.projects.find(x=>x.id===id);
      if(!p||p.status!=='draft')throw Error('فقط اجرای ثبت‌نشده قابل حذف است.');
      this.state.projects=this.state.projects.filter(x=>x.id!==id);
      await this.save();
    });
    this.serial=next.catch(()=>{});await next;
  }
  async event(id,agent,kind,text){return this.mutate(id,p=>{p.events.push({id:crypto.randomUUID(),at:new Date().toISOString(),agent,kind,text});if(p.events.length>700)p.events.splice(0,p.events.length-700);});}
  getProgress(id){return clone(Object.fromEntries(this.live.get(id)||[]));}
  setProgress(id,agent,patch){const progress=this.live.get(id)||new Map();progress.set(agent,{...(progress.get(agent)||{}),...patch,agent,updatedAt:new Date().toISOString()});this.live.set(id,progress);this.publish(id,{type:'progress',progress:this.getProgress(id)});}
  clearProgress(id,agent){const progress=this.live.get(id);if(!progress)return;progress.delete(agent);if(!progress.size)this.live.delete(id);this.publish(id,{type:'progress',progress:this.getProgress(id)});}
  subscribe(id,listener){const set=this.listeners.get(id)||new Set();set.add(listener);this.listeners.set(id,set);return()=>{set.delete(listener);if(!set.size)this.listeners.delete(id);};}
  publish(id,data){for(const listener of this.listeners.get(id)||[])try{listener(data);}catch{}}
}
