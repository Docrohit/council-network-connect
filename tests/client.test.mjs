import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CouncilClient, ORIGIN } from '../src/client.mjs';
const key = 'cnk_' + 'a'.repeat(32);
const agent = { id: 'b64df662-7716-412e-9455-9825dd414eb7', agentId: 'CN-000012', handle: 'tester' };
const response = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
function fixture(t, handler, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'council-connect-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, client: new CouncilClient({ stateFile: join(dir, 'identity.json'), env, fetchImpl: handler }) };
}
test('registration persists identity and secrets privately; restart reuses it', async t => {
  let registrations = 0;
  const fetchImpl = async (url, init) => {
    assert(url.startsWith(ORIGIN)); assert.equal(init.redirect, 'error');
    if (url.endsWith('/register')) { registrations++; return response({ agent, apiKey: key, claimUrl: ORIGIN + '/claim/cnc_' + 'c'.repeat(32) }); }
    assert.equal(init.headers.Authorization, `Bearer ${key}`);
    return response({ agent });
  };
  const { client } = fixture(t, fetchImpl, { COUNCIL_NETWORK_ALLOW_WRITES: 'true' });
  const first = await client.register({ handle: 'tester' });
  assert(!JSON.stringify(first).includes(key)); assert(!JSON.stringify(first).includes('/claim/'));
  assert.equal(statSync(client.file).mode & 0o777, 0o600);
  const restarted = new CouncilClient({ stateFile: client.file, env: { COUNCIL_NETWORK_ALLOW_WRITES: 'true' }, fetchImpl });
  assert.equal((await restarted.register({ handle: 'different' })).agent.id, agent.id);
  assert.equal(registrations, 1);
  assert.equal(JSON.parse(readFileSync(client.file)).agentId, agent.agentId);
});
test('identity mismatch prevents actions; a rotated key retains identity', async t => {
  let writes = 0, current = agent;
  const { client } = fixture(t, async (_url, init) => { if (init.method === 'POST') writes++; return response({ agent: current }); }, { COUNCIL_NETWORK_API_KEY: key, COUNCIL_NETWORK_ALLOW_WRITES: 'true' });
  await client.identity();
  client.envKey = 'cnk_' + 'b'.repeat(32);
  assert.equal((await client.identity()).agent.id, agent.id);
  current = { ...agent, id: 'other-agent' };
  await assert.rejects(client.act({ type: 'post' }), /Identity mismatch/);
  assert.equal(writes, 0);
});
test('uncertain registration never retries or creates another identity', async t => {
  let calls = 0;
  const { client } = fixture(t, async () => { calls++; throw Error('timeout'); }, { COUNCIL_NETWORK_ALLOW_WRITES: 'true' });
  await assert.rejects(client.register({ handle: 'tester' }), /outcome unknown/);
  await assert.rejects(client.register({ handle: 'tester' }), /pending or uncertain/);
  assert.equal(calls, 1);
});
test('writes disabled; paths fixed; 401 does not re-register; unsafe identity files rejected', async t => {
  const { client, dir } = fixture(t, async () => response({}), { COUNCIL_NETWORK_API_KEY: key });
  await assert.rejects(client.register({}), /Writes disabled/);
  await assert.rejects(client.act({}), /Writes disabled/);
  await assert.rejects(client.request('//evil.example'), /Unsupported API path/);
  await assert.rejects(client.request('/api/v1/../../evil'), /Unsupported API path/);
  client.fetch = async () => new Response('{}', { status: 401 });
  await assert.rejects(client.identity(), /Repair the key/);
  assert.equal(client.state(), null);
  client.save({ apiKey: key }, true);
  chmodSync(client.file, 0o644);
  assert.throws(() => client.state(), /private regular file/);
  const link = join(dir, 'link.json'); symlinkSync(client.file, link);
  const linked = new CouncilClient({ stateFile: link, env: {} });
  assert.throws(() => linked.state());
});
test('response size is bounded while streaming', async t => {
  const { client } = fixture(t, async () => new Response('x'.repeat(2_000_001)));
  await assert.rejects(client.request('/skill.md', { auth: false }), /too large/);
});
test('confirmed registration rejection can be corrected, but server failure stays pending', async t => {
  let status = 409;
  const { client } = fixture(t, async () => status === 201 ? response({ agent, apiKey: key }) : new Response('{}', { status }), { COUNCIL_NETWORK_ALLOW_WRITES: 'true' });
  for (const rejected of [400,409,429]) {
    status = rejected;
    await assert.rejects(client.register({ handle: 'tester' }), new RegExp(`HTTP ${rejected}`));
    assert.equal(client.state(), null);
  }
  status = 201; assert.equal((await client.register({ handle: 'tester' })).agent.id, agent.id);
  const other = fixture(t, async () => new Response('{}', { status: 500 }), { COUNCIL_NETWORK_ALLOW_WRITES: 'true' }).client;
  await assert.rejects(other.register({ handle: 'tester' }), /HTTP 500/);
  assert.equal(other.state().status, 'pending');
});
