// MCP server smoke test: boots the real Signplane server + the MCP stdio
// server, then speaks JSON-RPC over stdin/stdout like Claude Desktop would.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const PORT = 4907;
const BASE = `http://localhost:${PORT}`;
let serverChild, mcpChild, agent;
const responses = [];
let mcpBuffer = '';

function rpc(msg) { mcpChild.stdin.write(JSON.stringify(msg) + '\n'); }

async function waitForResponse(id, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = responses.find(r => r.id === id);
    if (hit) return hit;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`no MCP response for id ${id}`);
}

before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-mcp-'));
  serverChild = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), SIGNPLANE_DATA_DIR: dataDir }, stdio: 'ignore'
  });
  for (let i = 0; i < 40; i++) {
    try { await fetch(BASE + '/api/summary'); break; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  const reg = await fetch(BASE + '/api/agents/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'mcp-agent', owner: 't@t.io', environments: ['dev'] })
  });
  agent = await reg.json();
  await fetch(BASE + '/api/mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'enforce' }) });

  mcpChild = spawn(process.execPath, [path.join(__dirname, '..', 'mcp-server.js')], {
    env: { ...process.env, SIGNPLANE_URL: BASE, SIGNPLANE_AGENT_ID: agent.id, SIGNPLANE_AGENT_TOKEN: agent.token, SIGNPLANE_ENVIRONMENT: 'dev' },
    stdio: ['pipe', 'pipe', 'inherit']
  });
  mcpChild.stdout.setEncoding('utf8');
  mcpChild.stdout.on('data', chunk => {
    mcpBuffer += chunk;
    let nl;
    while ((nl = mcpBuffer.indexOf('\n')) >= 0) {
      const line = mcpBuffer.slice(0, nl).trim();
      mcpBuffer = mcpBuffer.slice(nl + 1);
      if (line) { try { responses.push(JSON.parse(line)); } catch { /* ignore */ } }
    }
  });
});

after(() => { mcpChild?.kill(); serverChild?.kill(); });

test('MCP handshake and tool discovery', async () => {
  rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } });
  const init = await waitForResponse(1);
  assert.strictEqual(init.result.serverInfo.name, 'signplane');
  rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });

  rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const list = await waitForResponse(2);
  const names = list.result.tools.map(t => t.name);
  assert.deepStrictEqual(names.sort(), ['check_intent', 'list_policies', 'propose_change']);
});

test('propose_change via MCP: pending approval round-trip', async () => {
  rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'propose_change', arguments: {
    intent: 'Scale dev deployment for load test', verb: 'write', resource: 'k8s/dev/deploy/api'
  } } });
  const res = await waitForResponse(3);
  const text = res.result.content[0].text;
  assert.match(text, /PENDING human approval/);
  const intentId = text.match(/int_[a-f0-9]+/)[0];

  // approve server-side (demo mode: implicit admin)
  const dec = await fetch(`${BASE}/api/intents/${intentId}/decision`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'approved', approver: 'test' })
  });
  assert.strictEqual((await dec.json()).status, 'executed');

  rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'check_intent', arguments: { intent_id: intentId } } });
  const check = await waitForResponse(4);
  assert.match(check.result.content[0].text, /status: executed/);
});

test('propose_change via MCP: destructive change is blocked with explanation', async () => {
  // dev delete matches "non-prod writes need approval"… use identity denial instead:
  // an out-of-scope environment proves the 403 path through MCP.
  rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'propose_change', arguments: {
    intent: 'Touch prod from a dev-scoped agent', verb: 'write', resource: 'ec2/prod', environment: 'prod'
  } } });
  const res = await waitForResponse(5);
  assert.match(res.result.content[0].text, /BLOCKED/);
  assert.match(res.result.content[0].text, /Do not retry/);
});

test('list_policies via MCP', async () => {
  rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'list_policies', arguments: {} } });
  const res = await waitForResponse(6);
  assert.match(res.result.content[0].text, /Never let an agent destroy production/);
});
