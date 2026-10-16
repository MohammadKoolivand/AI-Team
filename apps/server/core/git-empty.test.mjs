import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {git,importRepository} from './git.mjs';

test('empty imports explain the missing commit, clean up, and initialize only with explicit permission',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'teamforge-empty-')),previous=process.env.TEAMFORGE_IMPORT_ROOTS;
 try{
  const source=path.join(root,'source');await git(['init',source]);process.env.TEAMFORGE_IMPORT_ROOTS=root;
  const data=path.join(root,'data');await assert.rejects(importRepository(data,'rejected',{kind:'local',path:source}),/هیچ commit/);
  assert.equal(await fs.stat(path.join(data,'repositories/rejected')).catch(()=>null),null);
  const imported=await importRepository(data,'allowed',{kind:'local',path:source,initializeEmpty:true});
  assert.equal(imported.initializedEmpty,true);assert.match(imported.head,/^[0-9a-f]{40,64}$/);
  assert.equal(await git(['-C',imported.workspace,'rev-parse','HEAD']),imported.head);
  assert.equal(await git(['-C',source,'status','--porcelain']),'');
  await assert.rejects(git(['-C',source,'rev-parse','--verify','HEAD']));
 }finally{if(previous===undefined)delete process.env.TEAMFORGE_IMPORT_ROOTS;else process.env.TEAMFORGE_IMPORT_ROOTS=previous;await fs.rm(root,{recursive:true,force:true});}
});

test('import resolves an existing main branch when the source HEAD points to a nonexistent branch',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'teamforge-head-')),previous=process.env.TEAMFORGE_IMPORT_ROOTS;
 try{
  const source=path.join(root,'source');await git(['init','-b','main',source]);await git(['-C',source,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgSign=false','commit','--allow-empty','-m','fixture']);
  const head=await git(['-C',source,'rev-parse','HEAD']);await git(['-C',source,'symbolic-ref','HEAD','refs/heads/missing']);process.env.TEAMFORGE_IMPORT_ROOTS=root;
  const imported=await importRepository(path.join(root,'data'),'fallback',{kind:'local',path:source});assert.equal(imported.head,head);assert.equal(imported.initializedEmpty,false);
  assert.equal(await git(['-C',source,'symbolic-ref','HEAD']),'refs/heads/missing');
 }finally{if(previous===undefined)delete process.env.TEAMFORGE_IMPORT_ROOTS;else process.env.TEAMFORGE_IMPORT_ROOTS=previous;await fs.rm(root,{recursive:true,force:true});}
});
