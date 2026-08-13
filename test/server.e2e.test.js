// End-to-end smoke: boots the real server on an ephemeral port with an
// isolated data dir, exercises the governance loop (simulated executor path,
// no AWS emulator needed), then flips auth ON and proves RBAC bites.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const PORT = 4899;
const BASE = `http://localhost:${PORT}`;
let child;

async function api(method, p, body, cookie) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
}

before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-e2e-'));
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), SIGNPLANE_DATA_DIR: dataDir },
    stdio: 'ignore'
  });
  for (let i = 0; i < 40; i++) {
    try { await fetch(BASE + '/api/summary'); return; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  throw new Error('server did not start');
});

after(() => child.kill());

let agent;

test('demo mode: register agent, observe, enforce, approve, rollback', async () => {
  const reg = await api('POST', '/api/agents/register', { name: 'e2e-agent', owner: 'test@corp.io', environments: ['staging', 'prod'] });
  assert.strictEqual(reg.status, 201);
  agent = reg.body;

  // observe mode: logged, not gated
  const obs = await api('POST', '/api/gateway/propose', {
    agent_id: agent.id, agent_token: agent.token, environment: 'prod',
    intent: 'obs test', action: { verb: 'write', resource: 'thing' }
  });
  assert.strictEqual(obs.body.enforced, false);
  assert.match(obs.body.would_have, /approval/);

  // rogue agent denied
  const rogue = await api('POST', '/api/gateway/propose', { agent_id: 'agt_000000000000', agent_token: 'x', environment: 'prod', action: { verb: 'write' } });
  assert.strictEqual(rogue.status, 403);

  // enforce
  await api('POST', '/api/mode', { mode: 'enforce' });
  const blocked = await api('POST', '/api/gateway/propose', {
    agent_id: agent.id, agent_token: agent.token, environment: 'prod',
    intent: 'destroy', action: { verb: 'delete', resource: 'db' }
  });
  assert.strictEqual(blocked.status, 403);

  const pend = await api('POST', '/api/gateway/propose', {
    agent_id: agent.id, agent_token: agent.token, environment: 'staging',
    intent: 'scale up', action: { verb: 'write', resource: 'deploy/api' }
  });
  assert.strictEqual(pend.status, 202);

  const dec = await api('POST', `/api/intents/${pend.body.intent_id}/decision`, { decision: 'approved', approver: 'marcus' });
  assert.strictEqual(dec.body.status, 'executed');

  const rb = await api('POST', `/api/intents/${pend.body.intent_id}/rollback`, {});
  assert.strictEqual(rb.body.status, 'rolled_back');

  const verify = await api('GET', '/api/evidence/verify');
  assert.strictEqual(verify.body.valid, true);
  assert.ok(verify.body.records >= 5);
});

test('auth on: RBAC enforced end-to-end', async () => {
  const on = await api('PATCH', '/api/settings', {
    auth_mode: 'on',
    first_admin: { name: 'Elena', email: 'elena@corp.io', password: 'hunter2!' }
  });
  assert.strictEqual(on.status, 200);

  // anonymous is now locked out of reads and decisions
  assert.strictEqual((await api('GET', '/api/intents')).status, 401);
  assert.strictEqual((await api('POST', '/api/mode', { mode: 'observe' })).status, 401);

  // gateway still works — agents authenticate with their own tokens
  const ok = await api('POST', '/api/gateway/propose', {
    agent_id: agent.id, agent_token: agent.token, environment: 'staging',
    intent: 'agent path unaffected', action: { verb: 'write', resource: 'x' }
  });
  assert.strictEqual(ok.status, 202);

  // login as admin
  const login = await api('POST', '/api/auth/login', { email: 'elena@corp.io', password: 'hunter2!' });
  assert.strictEqual(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.strictEqual((await api('GET', '/api/intents', null, cookie)).status, 200);

  // viewer cannot approve
  await api('POST', '/api/users', { name: 'Val', email: 'val@corp.io', password: 'pw123456', role: 'viewer' }, cookie);
  const vlogin = await api('POST', '/api/auth/login', { email: 'val@corp.io', password: 'pw123456' });
  const vcookie = vlogin.headers.get('set-cookie').split(';')[0];
  const pending = (await api('GET', '/api/intents?status=pending', null, vcookie)).body;
  assert.ok(pending.length >= 1);
  const deny = await api('POST', `/api/intents/${pending[0].id}/decision`, { decision: 'approved' }, vcookie);
  assert.strictEqual(deny.status, 403);

  // ...but an approver can
  await api('POST', '/api/users', { name: 'App', email: 'app@corp.io', password: 'pw123456', role: 'approver' }, cookie);
  const alogin = await api('POST', '/api/auth/login', { email: 'app@corp.io', password: 'pw123456' });
  const acookie = alogin.headers.get('set-cookie').split(';')[0];
  const approve = await api('POST', `/api/intents/${pending[0].id}/decision`, { decision: 'approved' }, acookie);
  assert.strictEqual(approve.status, 200);
  assert.strictEqual(approve.body.status, 'executed');

  // approval identity comes from the session, not the request body
  const intent = (await api('GET', `/api/intents/${pending[0].id}`, null, cookie)).body;
  assert.strictEqual(intent.approval.approver, 'app@corp.io');

  // viewer cannot touch settings/users/integrations
  assert.strictEqual((await api('GET', '/api/users', null, vcookie)).status, 403);
  assert.strictEqual((await api('GET', '/api/integrations', null, vcookie)).status, 403);
});
