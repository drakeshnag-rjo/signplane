#!/usr/bin/env node
/**
 * Demo agent traffic for Signplane MVP.
 * Registers an agent, then submits proposals spanning every routing outcome:
 * auto-allow, team approval, security approval, policy block, identity denial.
 *
 * Run while server.js is up:  node demo-agent.js
 */

const BASE = process.env.SIGNPLANE_URL || 'http://localhost:4820';

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json() };
}

function show(label, r) {
  const b = r.body;
  const outcome = b.status || (b.allowed === false ? 'denied' : 'ok');
  const extra = b.would_have ? ` (would have: ${b.would_have})` : b.reason ? ` (${b.reason})` : '';
  console.log(`  [${String(r.status).padEnd(3)}] ${label} → ${outcome}${extra}`);
}

(async () => {
  console.log(`Signplane demo agent → ${BASE}\n`);

  // Flow D: agent onboarding
  const reg = await api('POST', '/api/agents/register', {
    name: 'cost-optimizer-agent',
    owner: 'priya@example.com',
    model: 'claude-sonnet-5',
    environments: ['staging', 'prod']
  });
  const agent = reg.body;
  console.log(`Registered agent ${agent.name} (${agent.id})\n`);

  const propose = (intent, environment, action) =>
    api('POST', '/api/gateway/propose', {
      agent_id: agent.id, agent_token: agent.token, intent, environment, action
    });

  console.log('Submitting proposals:');

  show('LOW  · read prod metrics', await propose(
    'Check CPU utilization on prod AKS node pool before deciding whether to scale.',
    'prod',
    { tool: 'kubernetes', verb: 'read', resource: 'aks/prod/nodepool-1/metrics', resources_touched: ['nodepool-1'] }
  ));

  show('MED  · scale staging deployment', await propose(
    'Scale staging API deployment 3 → 5 replicas; sustained CPU > 80%.',
    'staging',
    { tool: 'kubernetes', verb: 'write', resource: 'k8s/staging/deploy/api', resources_touched: ['deploy/api'], cost_delta_usd_month: 140 }
  ));

  show('HIGH · scale prod node pool', await propose(
    'Increase prod AKS node pool 6 → 8 nodes; CPU > 85% for 30 minutes.',
    'prod',
    { tool: 'terraform', verb: 'write', resource: 'aks/prod/nodepool-1', resources_touched: ['nodepool-1', 'vmss-agentpool'], cost_delta_usd_month: 620 }
  ));

  show('CRIT · delete prod database', await propose(
    'Remove unused-looking prod database to save cost.',
    'prod',
    { tool: 'terraform', verb: 'delete', resource: 'azurerm_postgresql/prod-main-db', resources_touched: ['prod-main-db'], cost_delta_usd_month: -900 }
  ));

  show('ROGUE · unregistered agent', await api('POST', '/api/gateway/propose', {
    agent_id: 'agt_deadbeef0000', agent_token: 'stolen-token',
    intent: 'Modify prod security group.', environment: 'prod',
    action: { tool: 'aws', verb: 'write', resource: 'sg/prod-web', resources_touched: ['sg-prod-web'] }
  }));

  const summary = await api('GET', '/api/summary');
  const s = summary.body;
  console.log(`\nSummary: mode=${s.mode} · governed=${s.intents_total} · pending=${s.pending} · blocked=${s.blocked} · executed=${s.executed} · observed=${s.observed}`);
  console.log(`Evidence chain: ${s.chain.valid ? `VALID (${s.chain.records} records)` : 'BROKEN'}`);
  console.log(`\nOpen the dashboard → ${BASE}`);
  if (s.pending > 0) console.log('Pending approvals are waiting for you there.');
})().catch(e => { console.error('Demo failed:', e.message); process.exit(1); });
