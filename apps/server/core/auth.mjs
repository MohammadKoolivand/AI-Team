import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { durableJSON } from './durable.mjs';
const roles = ['manager', 'analysis', 'backend', 'frontend', 'qa', 'viewer'];
const fail = (message, status = 403) => Object.assign(Error(message), { status });
const hash = (password, salt) => crypto.scryptSync(password, salt, 64).toString('hex');
export class Auth {
    constructor(dataDir) { this.file = path.join(dataDir, 'users.json'); this.users = []; this.queue = Promise.resolve(); this.attempts = new Map(); }
    async init() {
        try { this.users = JSON.parse(await fs.readFile(this.file, 'utf8')); if (!Array.isArray(this.users) || !this.users.length) throw Error('Invalid users database'); }
        catch (e) {
            if (e.code !== 'ENOENT') throw e;
            const password = process.env.TEAMFORGE_ADMIN_PASSWORD || crypto.randomBytes(24).toString('base64url');
            await this.create({ username: process.env.TEAMFORGE_ADMIN_USER || 'admin', password, admin: true });
            if (!process.env.TEAMFORGE_ADMIN_PASSWORD) console.log(`TeamForge first-run administrator: ${process.env.TEAMFORGE_ADMIN_USER || 'admin'}\nTemporary bootstrap password: ${password}\nSave this password; only its hash is stored.`);
        }
    }
    public(user) { const { salt, passwordHash, ...safe } = user; return structuredClone(safe); }
    async create({ username, password, admin = false }) {
        if (typeof username !== 'string' || ! /^[a-zA-Z0-9_.-]{2,60}$/.test(username) || typeof password !== 'string' || password.length < 12 || password.length > 200) throw fail('Username or password invalid (minimum 12 password characters)', 400);
        const op = this.queue.then(async () => {
            if (this.users.some(x => x.username === username)) throw fail('User already exists', 409);
            const salt = crypto.randomBytes(16).toString('hex'), user = { id: crypto.randomUUID(), username, salt, passwordHash: hash(password, salt), admin: admin === true, memberships: [], createdAt: new Date().toISOString() };
            await durableJSON(this.file, [...this.users, user]); this.users.push(user); return this.public(user);
        }); this.queue = op.catch(() => { }); return op;
    }
    authenticate(req) {
        const value = req.headers.authorization;
        if (!value?.startsWith('Basic ')) throw fail('Authentication required', 401);
        const raw = Buffer.from(value.slice(6), 'base64').toString('utf8'), split = raw.indexOf(':'), username = raw.slice(0, split), password = raw.slice(split + 1);
        const key = req.socket.remoteAddress || 'local', now = Date.now(), entry = this.attempts.get(key);
        if (entry && entry.until > now && entry.count >= 20) throw fail('Too many login attempts; retry in one minute', 429);
        const user = this.users.find(x => x.username === username), salt = user?.salt || 'invalid-user-salt';
        const computed = hash(password.slice(0, 201), salt), expected = user?.passwordHash || '0'.repeat(128);
        if (split < 0 || !user || !crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(expected, 'hex'))) {
            const next = entry && entry.until > now ? entry : { count: 0, until: now + 60000 }; next.count++; this.attempts.set(key, next); throw fail('Invalid credentials', 401);
        }
        this.attempts.delete(key); return this.public(user);
    }
    can(user, projectId, allowed = roles) { return user.admin || user.memberships.some(m => m.projectId === projectId && allowed.includes(m.role)); }
    require(user, projectId, allowed = roles) { if (!this.can(user, projectId, allowed)) throw fail('Project permission denied'); }
    async assign(userId, projectId, role) {
        if (!roles.includes(role)) throw fail('Invalid project role', 400);
        const op = this.queue.then(async () => {
            const next = structuredClone(this.users), user = next.find(x => x.id === userId); if (!user) throw fail('User not found', 404);
            user.memberships = user.memberships.filter(m => !(m.projectId === projectId && m.role === role)); user.memberships.push({ projectId, role });
            await durableJSON(this.file, next); this.users = next; return this.public(user);
        }); this.queue = op.catch(() => { }); return op;
    }
}
export function validateOrigin(req) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    if (req.headers['sec-fetch-site'] === 'cross-site') throw fail('Cross-site writes denied');
    if (req.headers.origin) {
        let url; try { url = new URL(req.headers.origin); } catch { throw fail('Invalid origin'); }
        const allowed = (process.env.TEAMFORGE_WEB_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000').split(',');
        if (!allowed.includes(url.origin)) throw fail('Origin not allowed');
    }
}
