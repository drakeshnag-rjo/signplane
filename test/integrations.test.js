const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

process.env.SIGNPLANE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-itg-'));
const db = require('../lib/db');
const itg = require('../lib/integrations');

// One mock server plays Slack, Jira, ServiceNow, and a SIEM sink.
const received = [];
let mock, base;

before(async () => {
  mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, auth: req.headers.authorization || null, body: body ? JSON.parse(body) : null });
      const send = obj => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/rest/api/3/issue' && req.method === 'POST') return send({ key: 'SP-42' });
      if (req.url.startsWith('/rest/api/3/issue/SP-42/comment')) return send({ id: '1' });
      if (req.url === '/rest/api/3/myself') return send({ displayName: 'Signplane Bot' });
      if (req.url === '/api/now/table/change_request' && req.method === 'POST') return send({ result: { sys_id: 'snow123' } });
      if (req.url.startsWith('/api/now/table/change_request')) return send({ result: [] });
      send({ ok: true });
    });
  });
  await new Promise(r => mock.listen(0, r));
  base = `http://localhost:${mock.address().port}`;
});

after(() => mock.close());

const sampleIntent = () => ({
  id: 'int_test1', status: 'pending', risk: 'HIGH', environment: 'prod',
  intent_text: 'Scale prod node pool 6 → 8', policy_name: 'Production writes need security approval',
  agent_summary: { name: 'infra-agent' },
  blast_radius: { resources_touched: ['nodepool-1'], cost_delta_usd_month: 620 },
  integration_state: {}
});

test('slack connector posts approval card and passes test()', async () => {
  received.length = 0;
  await itg.CONNECTORS.slack.send({ webhook_url: base + '/slack' }, 'intent.pending', sampleIntent(), { base_url: 'http://sp' });
  assert.strictEqual(received[0].url, '/slack');
  assert.match(received[0].body.text, /Approval needed/);
  assert.match(received[0].body.text, /infra-agent/);
  assert.match(await itg.CONNECTORS.slack.test({ webhook_url: base + '/slack' }), /Test message/);
});

test('jira connector creates issue on pending, comments on execution', async () => {
  received.length = 0;
  const config = { base_url: base, email: 'bot@corp.io', api_token: 'tok', project_key: 'SP' };
  const intent = sampleIntent();
  const state = {};
  await itg.CONNECTORS.jira.send(config, 'intent.pending', intent, { base_url: 'http://sp' }, state);
  assert.strictEqual(state.jira_issue, 'SP-42');
  assert.match(received[0].auth, /^Basic /);
  assert.strictEqual(received[0].body.fields.project.key, 'SP');
  assert.match(received[0].body.fields.summary, /\[Signplane\]\[HIGH\]/);

  intent.status = 'executed';
  intent.execution = { aws: 'launched i-123' };
  intent.evidence_id = 'evd_x';
  await itg.CONNECTORS.jira.send(config, 'intent.executed', intent, {}, state);
  assert.strictEqual(received[1].url, '/rest/api/3/issue/SP-42/comment');
  assert.match(await itg.CONNECTORS.jira.test(config), /Signplane Bot/);
});

test('servicenow connector opens change_request and closes it on execution', async () => {
  received.length = 0;
  const config = { instance_url: base, username: 'sn', password: 'pw' };
  const intent = sampleIntent();
  const state = {};
  await itg.CONNECTORS.servicenow.send(config, 'intent.pending', intent, { base_url: 'http://sp' }, state);
  assert.strictEqual(state.snow_sys_id, 'snow123');
  assert.strictEqual(received[0].body.correlation_id, 'int_test1');
  assert.strictEqual(received[0].body.risk, 2); // HIGH → 2

  intent.status = 'executed';
  intent.execution = { aws: 'done' };
  await itg.CONNECTORS.servicenow.send(config, 'intent.executed', intent, {}, state);
  assert.strictEqual(received[1].method, 'PATCH');
  assert.match(received[1].url, /snow123/);
});

test('webhook connector streams events with auth header', async () => {
  received.length = 0;
  await itg.CONNECTORS.webhook.send({ url: base + '/hec', auth_header: 'Authorization', auth_value: 'Splunk tok' }, 'intent.blocked', sampleIntent(), {});
  assert.strictEqual(received[0].auth, 'Splunk tok');
  assert.strictEqual(received[0].body.source, 'signplane');
  assert.strictEqual(received[0].body.event, 'intent.blocked');
});

test('dispatcher: failure isolation + audit trail + connector state persistence', async () => {
  received.length = 0;
  db.integrations.create({ kind: 'slack', name: 'good slack', config: { webhook_url: base + '/slack' } });
  db.integrations.create({ kind: 'slack', name: 'dead slack', config: { webhook_url: 'http://localhost:1/dead' } });
  db.integrations.create({ kind: 'jira', name: 'jira', config: { base_url: base, email: 'e', api_token: 't', project_key: 'SP' } });

  const intent = sampleIntent();
  const results = await itg.dispatch('intent.pending', intent, { base_url: 'http://sp' });
  assert.strictEqual(results.length, 3);
  assert.strictEqual(results.filter(r => r.ok).length, 2);
  assert.strictEqual(results.filter(r => !r.ok).length, 1);
  assert.strictEqual(intent.integration_state.jira_issue, 'SP-42');

  const audit = db.audit.recent(10);
  assert.ok(audit.some(a => a.event_type === 'integration_delivered'));
  assert.ok(audit.some(a => a.event_type === 'integration_failed'));
});
