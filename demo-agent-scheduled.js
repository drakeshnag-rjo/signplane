#!/usr/bin/env node
/**
 * Change-management demo: scheduled changes with release-time re-validation.
 *
 * Submits two proposals scheduled ~40 seconds out. After you approve them
 * in the dashboard, Signplane holds them in the Scheduled panel, then at
 * release time re-validates: approval TTL, policy, and STATE DRIFT.
 *
 * To see the drift guard fire, make an out-of-band change after approving
 * (the playbook has the command) — the S3 change bounces back to pending.
 *
 * Prereqs: moto on :5000, Signplane on :4820, ENFORCE mode.
 */

const BASE = process.env.SIGNPLANE_URL || 'http://localhost:4820';
const DELAY_SECONDS = Number(process.env.SCHEDULE_DELAY || 40);

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json() };
}

(async () => {
  console.log(`Signplane scheduled-change demo → ${BASE}\n`);

  const reg = await api('POST', '/api/agents/register', {
    name: 'nightly-maintenance-agent',
    owner: 'priya@example.com',
    model: 'claude-sonnet-5',
    environments: ['staging', 'prod']
  });
  const agent = reg.body;
  const not_before = new Date(Date.now() + DELAY_SECONDS * 1000).toISOString();
  console.log(`Registered ${agent.name} (${agent.id})`);
  console.log(`Changes scheduled for: ${new Date(not_before).toLocaleTimeString()} (${DELAY_SECONDS}s from now)\n`);

  const propose = (intent, environment, action) =>
    api('POST', '/api/gateway/propose', {
      agent_id: agent.id, agent_token: agent.token, intent, environment,
      action, schedule: { not_before }
    });

  const r1 = await propose(
    'Nightly maintenance: add 1 batch worker before the 02:00 job run.',
    'prod',
    {
      tool: 'aws', verb: 'write', resource: 'ec2/run-instances',
      resources_touched: ['ec2:nightly-batch-worker'], cost_delta_usd_month: 8,
      aws: {
        service: 'ec2', operation: 'run_instances',
        params: {
          ImageId: 'ami-12c6146b', InstanceType: 't3.micro', MinCount: 1, MaxCount: 1,
          TagSpecifications: [{ ResourceType: 'instance', Tags: [
            { Key: 'Name', Value: 'nightly-batch-worker' },
            { Key: 'provisioned_by', Value: 'signplane' }
          ] }]
        }
      }
    }
  );
  console.log(`  [${r1.status}] HIGH · scheduled EC2 worker → ${r1.body.status}${r1.body.message ? ' (' + r1.body.message.split(' — ')[0] + ')' : ''}`);

  const r2 = await propose(
    'Nightly maintenance: create archive bucket before log rotation.',
    'staging',
    {
      tool: 'aws', verb: 'write', resource: 's3/signplane-nightly-archive',
      resources_touched: ['s3:signplane-nightly-archive'], cost_delta_usd_month: 3,
      aws: { service: 's3', operation: 'create_bucket', params: { Bucket: 'signplane-nightly-archive' } }
    }
  );
  console.log(`  [${r2.status}] MED  · scheduled S3 archive bucket → ${r2.body.status}${r2.body.message ? ' (' + r2.body.message.split(' — ')[0] + ')' : ''}`);

  console.log(`\nNow (within ${DELAY_SECONDS}s):`);
  console.log(`  1. Approve BOTH in the dashboard → they move to the Scheduled panel.`);
  console.log(`  2. To trigger the drift guard, make an out-of-band S3 change:`);
  console.log(`     node -e "const{spawnSync}=require('child_process');console.log(spawnSync('python',['executor.py'],{input:JSON.stringify({op:'execute',service:'s3',operation:'create_bucket',params:{Bucket:'manual-out-of-band-bucket'}}),encoding:'utf8'}).stdout)"`);
  console.log(`  3. At release time: EC2 executes on schedule; S3 bounces back to pending with ⚠ state_drift.`);
  console.log(`\nDashboard → ${BASE}`);
})().catch(e => { console.error('Demo failed:', e.message); process.exit(1); });
