import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Store} from './store.mjs';
import {Engine} from './engine.mjs';
import {git} from './git.mjs';
import {prepareReviewedCommit,validatePublishRemote} from './publication.mjs';

test('QA approval publishes reviewed commit to develop, retries are idempotent and never force remote changes',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'teamforge-publish-')),old=process.env.TEAMFORGE_AUTO_PUBLISH;
 try{
  const remote=path.join(root,'remote.git');await git(['init','--bare',remote]);
  const store=new Store(path.join(root,'data'));await store.init();const engine=new Engine(store);
  const p=await store.create({title:'Reviewed feature',description:'Publish approved implementation',mode:'ollama'}),workspace=engine.workspace(p.id);
  await git(['init',workspace]);await git(['-C',workspace,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','base']);
  const base=await git(['-C',workspace,'rev-parse','HEAD']);
  await git(['-C',workspace,'config',`url.${remote}.insteadOf`,'https://fixture.invalid/repo.git']);
  await fs.mkdir(path.join(workspace,'backend'));await fs.writeFile(path.join(workspace,'backend/api.mjs'),'export const api=1;');
  await fs.mkdir(path.join(workspace,'frontend'));await fs.writeFile(path.join(workspace,'frontend/app.mjs'),'export const app=1;');
  const hash=await engine.revisionHash(p.id);
  await store.mutate(p.id,x=>{x.repository={kind:'git',publishRemote:'https://fixture.invalid/repo.git',head:base};x.status='awaiting_review';for(const t of x.tasks){t.status=t.id==='qa'?'awaiting_review':'approved';t.revisions=[{id:`r-${t.id}`,workspaceHash:hash,changes:['backend','frontend'].includes(t.id)?[{path:t.id==='backend'?'backend/api.mjs':'frontend/app.mjs',before:null,after:'code'}]:[]}];}});
  process.env.TEAMFORGE_AUTO_PUBLISH='1';
  await engine.review(p.id,'qa',{action:'approve',revisionId:'r-qa',reviewer:'Human QA'});
  const result=store.getProject(p.id);assert.equal(result.publication.status,'pushed',result.publication.error);
  const commit=result.publication.commit;assert.equal(await git(['--git-dir',remote,'rev-parse','refs/heads/develop']),commit);
  assert.equal(await git(['-C',workspace,'rev-parse','HEAD']),base);assert.equal(await git(['-C',workspace,'diff','--cached','--name-only']),'');
  assert.match(await engine.approvedPatch(p.id),/backend\/api.mjs/);
  await engine.publish(p.id);assert.equal(store.getProject(p.id).publication.commit,commit);
  // Concurrent remote development must survive a retry; no force and no duplicate commit.
  await git(['--git-dir',remote,'update-ref','refs/heads/develop',base]);
  await store.mutate(p.id,x=>{x.publication.status='failed';});
  await engine.publish(p.id);assert.equal(store.getProject(p.id).publication.status,'pushed');
  const other=await git(['-C',workspace,'commit-tree',`${base}^{tree}`,'-p',base,'-m','Concurrent change'],{env:{GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'f@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'f@example.invalid'}});
  await git(['-C',workspace,'push',remote,`${other}:refs/heads/concurrent`]);
  await git(['--git-dir',remote,'update-ref','refs/heads/develop',other]);
  await store.mutate(p.id,x=>{x.publication.status='failed';});await engine.publish(p.id);
  assert.equal(store.getProject(p.id).publication.status,'failed');assert.equal(await git(['--git-dir',remote,'rev-parse','develop']),other);
  await fs.writeFile(path.join(workspace,'backend/api.mjs'),'changed after approval');await engine.publish(p.id);assert.match(store.getProject(p.id).publication.error,/QA/);
  await assert.rejects(prepareReviewedCommit(workspace,{paths:['frontend/app.mjs'],branch:'develop',message:'no'}),/خارج/);
  await store.mutate(p.id,x=>{x.status='awaiting_review';});await engine.publish(p.id);assert.match(store.getProject(p.id).publication.error,/تأیید انسانی/);
  assert.throws(()=>validatePublishRemote('/local/source'));assert.throws(()=>validatePublishRemote('https://user:password@example.com/repo.git'));
 }finally{if(old===undefined)delete process.env.TEAMFORGE_AUTO_PUBLISH;else process.env.TEAMFORGE_AUTO_PUBLISH=old;await fs.rm(root,{recursive:true,force:true});}
});
