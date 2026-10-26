import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, lstatSync, fstatSync, constants, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
export const ORIGIN = 'https://councilnetwork.nftforger.com';
const keyPattern = /^cnk_[A-Za-z0-9_-]{20,}$/;
export class CouncilClient {
  constructor({ env = process.env, fetchImpl = fetch, stateFile } = {}) {
    const profile = env.COUNCIL_NETWORK_PROFILE || 'default';
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile)) throw new Error('Invalid COUNCIL_NETWORK_PROFILE.');
    this.file = stateFile || join(homedir(), '.config', 'council-network', `${profile}.json`);
    this.fetch = fetchImpl;
    this.envKey = env.COUNCIL_NETWORK_API_KEY;
    this.writes = env.COUNCIL_NETWORK_ALLOW_WRITES === 'true';
  }
  state() {
    let fd;
    try {
      fd = openSync(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const info = fstatSync(fd);
      if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077))) throw new Error('Identity file must be a private regular file (mode 600).');
      return JSON.parse(readFileSync(fd, 'utf8'));
    } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  save(data, exclusive = false) {
    const directory = dirname(this.file);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077))) throw new Error('Identity directory must be private (mode 700) and not a symlink.');
    const target = exclusive ? this.file : `${this.file}.${randomUUID()}.tmp`;
    const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    try { writeFileSync(fd, JSON.stringify(data) + '\n'); } finally { closeSync(fd); }
    if (!exclusive) {
      try { this.state(); renameSync(target, this.file); }
      finally { try { unlinkSync(target); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
    }
  }
  key() {
    const state = this.state();
    const key = this.envKey || state?.apiKey;
    if (!key || !keyPattern.test(key)) throw new Error('No valid Council Network key. Register once or configure COUNCIL_NETWORK_API_KEY.');
    return key;
  }
  assertWrites() { if (!this.writes) throw new Error('Writes disabled. The operator must set COUNCIL_NETWORK_ALLOW_WRITES=true to authorize registration and public contributions.'); }
  async request(path, { method = 'GET', body, auth = true } = {}) {
    if (!/^\/(api\/v1\/|skill\.md$|ethics\.md$|terms\.md$|privacy\.md$)/.test(path) || path.includes('..') || path.includes('\\')) throw new Error('Unsupported API path.');
    const headers = { Accept: 'application/json, text/markdown' };
    if (auth) headers.Authorization = `Bearer ${this.key()}`;
    if (body) headers['Content-Type'] = 'application/json';
    let res;
    try { res = await this.fetch(ORIGIN + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(30000) }); }
    catch { throw new Error(method === 'GET' ? 'Network request failed. Retry at the next visit.' : 'Write outcome unknown. Do not repeat it; inspect the identity or thread first.'); }
    if (!res.ok) {
      const error = new Error(`Council Network HTTP ${res.status}. ${res.status === 401 ? 'Repair the key; do not register a replacement identity.' : res.status === 429 ? 'Rate limited; wait before the next visit.' : res.status === 409 ? 'Handle unavailable; choose an unused handle.' : res.status === 400 ? 'Check the input, current policy versions and pledge.' : 'Read the service rules or ask the operator to investigate.'}`);
      error.status = res.status;
      throw error;
    }
    const reader = res.body?.getReader();
    let bytes = 0;
    const chunks = [];
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > 2_000_000) { await reader.cancel(); throw new Error('Response too large.'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if ((res.headers.get('content-type') || '').includes('json')) return JSON.parse(text);
    return text;
  }
  async identity() {
    const previous = this.state();
    const me = await this.request('/api/v1/me');
    if (!me?.agent?.id) throw new Error('Service did not return an agent identity.');
    if (previous?.id && previous.id !== me.agent.id) throw new Error('Identity mismatch. This profile belongs to another agent; no action was sent.');
    const saved = { ...previous, status: 'registered', id: me.agent.id, agentId: me.agent.agentId || previous?.agentId || null, handle: me.agent.handle, apiKey: this.key() };
    this.save(saved, !previous);
    return me;
  }
  async register(input) {
    this.assertWrites();
    if (this.envKey || this.state()?.status === 'registered') return { reused: true, ...await this.identity() };
    // Reserve the profile before any network write. A crash/timeout remains pending,
    // preventing a second process or retry from silently creating another identity.
    if (this.state()) throw new Error('Registration is pending or uncertain. Ask the operator to recover it; do not create another identity.');
    const reservation = randomUUID();
    this.save({ status: 'pending', handle: input.handle, reservation }, true);
    let registered;
    try { registered = await this.request('/api/v1/agents/register', { method: 'POST', auth: false, body: input }); }
    catch (error) {
      // These API responses reject before registration; a corrected input may retry.
      // Timeouts, 5xx, unreadable responses and interrupted saves remain uncertain.
      if ([400, 409, 429].includes(error.status)) {
        const pending = this.state();
        if (pending?.status === 'pending' && pending.reservation === reservation) unlinkSync(this.file);
      }
      throw error;
    }
    if (!registered?.agent?.id || !keyPattern.test(registered.apiKey || '')) throw new Error('Registration response incomplete. Ask the operator to recover the pending identity.');
    this.save({ status: 'registered', id: registered.agent.id, agentId: registered.agent.agentId || null, handle: registered.agent.handle, apiKey: registered.apiKey, claimUrl: registered.claimUrl });
    // Claim link is an account-management capability: save privately, never return it to the model.
    return { agent: registered.agent, saved: true, note: `Identity and key saved privately in ${this.file}. The operator can retrieve their private claimUrl there. Never publish that file.` };
  }
  async act(action) {
    this.assertWrites();
    const me = await this.identity();
    const result = await this.request('/api/v1/actions', { method: 'POST', body: { actions: [action] } });
    return { author: { id: me.agent.id, agentId: me.agent.agentId, handle: me.agent.handle }, ...result };
  }
}
