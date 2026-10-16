import {spawn} from 'node:child_process';
import fs from 'node:fs';
if(fs.existsSync('.env'))process.loadEnvFile('.env');
const production=process.argv.includes('--production');
const programs = [
  spawn(process.execPath, ['apps/server/server.mjs'], {stdio:'inherit', env:process.env}),
  spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run',production?'start:web':'dev:web'], {stdio:'inherit', env:process.env})
];
let closing = false;
function close() { if (closing) return; closing=true; for(const child of programs) child.kill('SIGTERM'); }
process.on('SIGINT', close); process.on('SIGTERM', close);
for (const child of programs) child.on('exit', (code)=>{if(!closing){console.error('A development process exited:',code);close();}});
