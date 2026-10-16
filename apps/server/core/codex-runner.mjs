/**
 * Optional OSS Codex CLI coding runtime for trusted local development only.
 * The source workspace is NEVER the CLI process cwd. We export a sanitized
 * text-only snapshot, then independently validate staged changes before sync.
 * Codex uses Ollama via --oss; no OpenAI account/API key is required.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { safeRelative, roleAllows, safeRead, repoFiles, applyExactPatch } from './coding-files.mjs';
import { git } from './git.mjs';
import { buildChanges } from './revisions.mjs';
import { runAutomaticChecks } from './sandbox.mjs';

const MAX_FILES = 1700, MAX_BYTES = 16_000_000, MAX_FILE_BYTES = 180_000;
const STAGES = {
    analyst: 'Write a specific implementation plan, acceptance criteria, API contract and risks under docs/teamforge/analysis.md. Do not edit application files.',
    backend: 'Implement the approved backend/API scope. Preserve the existing architecture, add appropriate backend tests; do not edit frontend.',
    frontend: 'Implement the frontend using the approved backend API and the existing UI framework. Do not edit backend.',
    qa: 'Validate the approved feature, run appropriate tests, write an evidence-based report at docs/teamforge/qa-report.md. Report SKIPPED versus PASSED correctly. Do not modify product code.'
};
export function codexCommand(model = process.env.TEAMFORGE_CODEX_MODEL || process.env.OLLAMA_MODEL || 'gpt-oss:20b') {
    if (typeof model !== 'string' || !(/^[a-zA-Z0-9_./:-]{1,100}$/.test(model))) throw Error('Invalid local Ollama model name.');
    return ['exec', '--oss', '--local-provider', 'ollama', '--model', model, '--sandbox', 'workspace-write', '--ignore-user-config', '--ephemeral', '--json', '-'];
}
export function localhostOllama() {
    const raw = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
    const u = new URL(raw);
    if (u.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) || u.username || u.password || u.pathname !== '/' && u.pathname !== '') throw Error('Codex OSS adapter only permits a local HTTP Ollama endpoint.');
    return `${u.origin}/v1`;
}
export function decodeCodexEvent(e) {
    if (!e || typeof e !== 'object') return null;
    if (e.type === 'thread.started') return { phase: 'codex', detail: 'Codex session started' };
    if (e.type === 'turn.failed' || e.type === 'error') return { phase: 'error', detail: 'Codex reported an error' };
    if (e.type === 'turn.completed') return { phase: 'complete', detail: 'Codex turn completed', usage: e.usage };
    if (!['item.started', 'item.updated', 'item.completed'].includes(e.type)) return null;
    const item = e.item || {};
    if (item.type === 'command_execution') return { phase: 'tool', detail: `Command execution: ${String(item.command || '').slice(0, 140)}`, tool: item.type };
    if (item.type === 'file_change') return { phase: 'tool', detail: 'Applying code changes', tool: item.type };
    if (item.type === 'agent_message' && e.type === 'item.completed') return { phase: 'message', detail: String(item.text || '').slice(0, 250), finalMessage: String(item.text || '').slice(0, 1000) };
    if (item.type === 'todo_list') return { phase: 'planning', detail: 'Updating implementation plan' };
    return null; // Private reasoning is deliberately not surfaced.
}

async function snapshot(root) {
    const files = await repoFiles(root), content = new Map(); let size = 0;
    if (files.length > MAX_FILES) throw Error(`Repository exceeds safe snapshot size (${MAX_FILES} files).`);
    for (const name of files) {
        safeRelative(name);
        const text = await safeRead(root, name);
        const bytes = Buffer.byteLength(text);
        if (bytes > MAX_FILE_BYTES || size + bytes > MAX_BYTES) throw Error('Repository snapshot is too large; reduce the imported repo.');
        if (text.includes('\0')) throw Error('Binary content detected in a text file.');
        size += bytes; content.set(name, text);
    }
    return content;
}
async function stagingDirectory(tmp, before) {
    const stage = path.join(tmp, 'stage'); await fs.mkdir(stage);
    for (const [name, text] of before) { const dest = path.join(stage, ...name.split('/')); await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.writeFile(dest, text, { mode: 0o600 }); }
    // A fresh Git repository gives Codex meaningful Git context without granting
    // access to the real repo's metadata, remotes or hooks.
    await git(['init', '-q', stage]);
    await git(['-C', stage, 'add', '-A']);
    if (before.size) await git(['-C', stage, '-c', 'user.name=TeamForge', '-c', 'user.email=teamforge@localhost', 'commit', '-q', '-m', 'sanitized starting point']);
    return stage;
}
/** Rejects any hidden file, symbolic link, suspicious path or unexpected binary
 * created by a tool. Does not follow symlinks. */
async function scanStage(root) {
    const paths = []; let count = 0;
    async function walk(dir, prefix = '', depth = 0) {
        if (depth > 13) throw Error('Codex created a directory tree beyond the depth limit.');
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
            if (!prefix && entry.name === '.git') continue;
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isSymbolicLink()) throw Error(`Codex created an unsafe symlink: ${rel}`);
            safeRelative(rel);
            if (entry.isDirectory()) { await walk(path.join(dir, entry.name), rel, depth + 1); continue; }
            if (!entry.isFile()) throw Error(`Unsupported file type in staged output: ${rel}`);
            if (++count > MAX_FILES) throw Error('Codex generated too many files.');
            paths.push(rel);
        }
    }
    await walk(root); return paths;
}
async function stageDiff(before, stage, role) {
    const afterNames = await scanStage(stage), after = new Map(); let total = 0;
    for (const name of afterNames) {
        const text = await safeRead(stage, name), bytes = Buffer.byteLength(text);
        if (bytes > MAX_FILE_BYTES || (total += bytes) > MAX_BYTES || text.includes('\0')) throw Error('Staged file size or content violates policy.');
        after.set(name, text);
    }
    const modified = [];
    for (const name of new Set([...before.keys(), ...after.keys()])) {
        const oldText = before.get(name) ?? null, newText = after.get(name) ?? null;
        if (oldText === newText) continue;
        if (!roleAllows(role, name)) throw Error(`Codex tried to edit a file outside ${role} scope: ${name}`);
        if (newText === null) throw Error(`File deletion is not supported yet: ${name}`);
        if (oldText === '') throw Error(`Cannot patch a previously empty file: ${name}`);
        modified.push({ path: name, before: oldText, after: newText });
    }
    return modified;
}
function promptFor(project, role, feedback, repair) {
    return `You are a ${role} implementation agent within TeamForge's sequential HUMAN-GATED workflow.\n\nTASK: ${project.title}\nFEATURE: ${project.description}\nCURRENT STAGE: ${role}\nSTAGE RULES: ${STAGES[role]}\nHUMAN REVIEW FEEDBACK: ${feedback || 'None'}\nACTUAL TEST FAILURE (if any): ${repair || 'None'}\n\nRules:\n- Only edit files allowed for your role. Analyze the repository before changing code.\n- Use the existing project patterns. Make minimal precise edits.\n- Do not access or create secrets, hidden files, CI workflows or credentials.\n- No external network calls, package installation, deployment or destructive operations.\n- Do not commit or push. The platform owns all review decisions.\n- Never state that tests passed unless they actually executed and passed.\n- Stop when the stage's deliverable is ready for human review.\n`;
}
function cliEnv(codexHome) {
    return {
        PATH: process.env.PATH || '/usr/bin:/bin', HOME: os.homedir(), LANG: 'C.UTF-8', TERM: 'dumb', NO_COLOR: '1',
        CODEX_HOME: codexHome, CODEX_OSS_BASE_URL: localhostOllama(), CODEX_DISABLE_TELEMETRY: '1'
    };
}
export async function runCodexProcess({ cwd, home, prompt, onEvent = async () => { }, onProgress = () => { }, timeoutMs = 480000, bin = process.env.TEAMFORGE_CODEX_BIN || 'codex' }) {
    const args = codexCommand(); const output = []; let stderr = '', buffer = '', completed = false, failed = false, finalMessage = '', activity = 0;
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    const result = await new Promise((resolve, reject) => {
        const child = spawn(bin, args, { cwd, env: cliEnv(home), stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32' });
        let settled = false;
        const stop = () => { if (child.pid && process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } } else child.kill('SIGKILL'); };
        const timer = setTimeout(() => { stop(); settle(Error('Codex execution timed out.')) }, timeoutMs);
        const settle = (err, value) => { if (settled) return; settled = true; clearTimeout(timer); err ? reject(err) : resolve(value); };
        const accept = raw => {
            if (!raw.trim()) return;
            let event; try { event = JSON.parse(raw); } catch { return; }
            if (event.type === 'turn.completed') completed = true;
            if (event.type === 'turn.failed' || event.type === 'error') failed = true;
            const evt = decodeCodexEvent(event); if (!evt) return;
            activity++; if (evt.finalMessage) finalMessage = evt.finalMessage;
            onProgress({ phase: evt.phase, detail: evt.detail, toolCalls: activity });
            if (event.type === 'item.completed' || event.type === 'turn.completed' || event.type === 'error') void Promise.resolve(onEvent(evt.phase === 'error' ? 'warning' : 'info', evt.detail)).catch(() => { });
            if (output.length < 160) output.push({ type: event.type, phase: evt.phase, detail: evt.detail });
        };
        child.stdout.on('data', chunk => {
            buffer += String(chunk); if (buffer.length > 300000) buffer = buffer.slice(-300000);
            const parts = buffer.split('\n'); buffer = parts.pop() || ''; for (const line of parts) accept(line);
        });
        child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4500); });
        child.on('error', err => settle(Error(`Unable to start Codex CLI: ${err.message}. Install with npm install -g @openai/codex`)));
        child.on('close', code => { if (buffer) accept(buffer); settle(null, { code, completed, failed, finalMessage, events: output, stderr }); });
        child.stdin.on('error', () => { }); child.stdin.end(prompt);
    });
    if (result.code !== 0 || failed || !completed) throw Error(`Codex CLI did not complete successfully. Exit=${result.code}. ${result.stderr.slice(-1000)}`);
    return result;
}
export async function runCodexAgent({ project, role, root, feedback = '', onEvent = async () => { }, onProgress = () => { }, runner = runCodexProcess }) {
    if (!STAGES[role]) throw Error('Invalid Codex role.');
    // All operation on a separate sanitized stage, preserving prior human-approved
    // edits without letting Codex read original .git metadata or ignored secrets.
    const original = await snapshot(root);
    const allChecks = []; let summary = '', repair = '', repairRuns = 0, totalActivities = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'teamforge-codex-'));
        try {
            const current = await snapshot(root);
            const stage = await stagingDirectory(tmp, current);
            await onEvent('info', `Codex OSS / Ollama executing ${role}: attempt ${attempt + 1}`);
            const response = await runner({ cwd: stage, home: path.join(tmp, 'codex-home'), prompt: promptFor(project, role, feedback, repair), onEvent, onProgress });
            summary = response.finalMessage || summary || 'Codex CLI completed a stage'; totalActivities += response.events?.length || 0;
            const modified = await stageDiff(current, stage, role); // validates ALL changes before ANY apply
            for (const item of modified) {
                const present = await safeRead(root, item.path).catch(e => { if (e.code === 'ENOENT' || /وجود ندارد/.test(e.message)) return null; throw e; });
                if (present !== (item.before ?? null)) throw Error('Original workspace changed concurrently; refusing to apply generated edits.');
            }
            for (const item of modified) {
                await applyExactPatch(root, role, { path: item.path, search: item.before ?? '', replace: item.after });
                await onEvent('file', `Codex changed: ${item.path}`);
            }
            if (role === 'analyst') break;
            onProgress({ phase: 'testing', detail: 'Running supported automatic checks in isolated Docker' });
            const checks = await runAutomaticChecks(root, role, r => onEvent('test', `${r.command}: ${r.status}`)); allChecks.push(...checks);
            const failed = checks.find(x => x.status === 'failed');
            if (!failed || attempt === 2) break;
            repairRuns++; repair = `${failed.command} failed: ${String(failed.output || failed.detail).slice(-3500)}`;
            await onEvent('warning', `Codex repair attempt ${repairRuns}/2 after failed test.`);
        } finally { await fs.rm(tmp, { recursive: true, force: true }).catch(() => { }); }
    }
    if (role === 'qa') {
        const qaPath = 'docs/teamforge/qa-report.md';
        const existing = await safeRead(root, qaPath).catch(() => null);
        const checkLog = allChecks.map(x => `- ${x.command}: **${x.status.toUpperCase()}** — ${x.detail}\n  \n  ${String(x.output || '').slice(-700).replaceAll('```', '')}`).join('\n');
        const report = `# TeamForge independent QA evidence\n\n${checkLog || 'No checks executed — UNVERIFIED.'}\n\nHuman approval is still required. A SKIPPED check is never a passing check.\n`;
        if (existing !== report) await applyExactPatch(root, 'qa', { path: qaPath, search: existing ?? '', replace: report });
    }
    const final = await snapshot(root);
    const before = Object.fromEntries(original), after = Object.fromEntries(final);
    const changes = buildChanges(before, after);
    return { files: changes.map(c => c.path), changes, checks: allChecks, repairRuns, actions: [`codex-cli (${totalActivities} events)`], finished: true, message: summary.slice(0, 500) };
}
