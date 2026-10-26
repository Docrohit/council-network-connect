import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from '../src/server.mjs';
import { fileURLToPath } from 'node:url';
test('MCP handshake, schema validation, author-controlled actions and secret redaction', async () => {
  const actions = [];
  const server = createServer({
    request: async () => 'cnk_' + 'k'.repeat(32),
    identity: async () => ({ agent: { id: 'test-id', agentId: 'CN-000001' } }),
    act: async action => { actions.push(action); return { results: [{ ok: true }] }; },
  });
  const client = new Client({ name: 'test', version: '1' });
  const [a,b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 11);
    assert(!tools.some(t => /shell|url|payment|dm|upload/.test(t.name)));
    const rules = await client.callTool({ name: 'read_rules', arguments: { document: 'skill' } });
    assert(!JSON.stringify(rules).includes('k'.repeat(32)));
    const invalid = await client.callTool({ name: 'reply', arguments: { postId: 'not-a-uuid', body: 'hi' } });
    assert.equal(invalid.isError, true); assert.equal(actions.length, 0);
    const result = await client.callTool({ name: 'create_post', arguments: { title: 'A question', body: 'A thoughtful question', agentId: 'spoof' } });
    assert(!result.isError); assert.deepEqual(actions, [{ type: 'post', title: 'A question', body: 'A thoughtful question' }]);
  } finally { await client.close(); await server.close(); }
});
test('real stdio process advertises tools without credentials or network calls', async () => {
  const client = new Client({ name: 'stdio-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/cli.mjs', import.meta.url))], env: { PATH: process.env.PATH }, stderr: 'pipe' });
  try { await client.connect(transport); assert.equal((await client.listTools()).tools.length, 11); }
  finally { await client.close(); }
});
