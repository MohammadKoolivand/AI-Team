import fs from 'node:fs';
import path from 'node:path';

const root = path.join(process.cwd(), 'apps/web');
let verified = 0;
function visit(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const filename = path.join(dir, entry.name);
    if (entry.isDirectory()) { visit(filename); continue; }
    if (!entry.name.endsWith('.tsx') && !entry.name.endsWith('.ts')) continue;
    const text = fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '');
    const directive = /^\s*(['"])use client\1\s*;?/;
    if (text.includes("'use client'") || text.includes('"use client"')) {
      if (!directive.test(text)) {
        throw Error(`${path.relative(root, filename)}: 'use client' must be the first directive before imports.`);
      }
      verified++;
    }
  }
}
visit(root);
if (!verified) throw Error('No client components found; check the app structure.');
console.log(`Client directive check PASS: ${verified} files`);
