#!/usr/bin/env node
/**
 * Real-execution demo: agent proposals that hit an actual AWS API
 * (moto / Floci / LocalStack / real AWS — whatever AWS_ENDPOINT_URL points at).
 *
 * Prereqs:  AWS emulator running (python -m moto.server -p 5000)
 *           Signplane running     (node server.js)
 * Run:      node demo-agent-aws.js
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
  return b;
}

(async () => {
  console.log(`Signplane real-execution demo → ${BASE}\n`);

  const reg = await api('POST', '/api/agents/register', {
    name: 'infra-provisioner-agent',
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

  console.log('Submitting proposals (real AWS API execution):');

  show('LOW  · list prod EC2 instances', await propose(
    'Inventory current prod EC2 fleet before capacity planning.',
    'prod',
    {
      tool: 'aws', verb: 'read', resource: 'ec2/instances',
      resources_touched: ['ec2:prod'],
      aws: { service: 'ec2', operation: 'describe_instances' }
    }
  ));

  show('MED  · create staging log bucket', await propose(
    'Create S3 bucket for staging application logs.',
    'staging',
    {
      tool: 'aws', verb: 'write', resource: 's3/signplane-staging-logs',
      resources_touched: ['s3:signplane-staging-logs'], cost_delta_usd_month: 5,
      aws: { service: 's3', operation: 'create_bucket', params: { Bucket: 'signplane-staging-logs' } }
    }
  ));

  show('HIGH · launch 2 prod EC2 workers', await propose(
    'Provision 2 t3.micro instances for prod batch workers; queue depth > 10k.',
    'prod',
    {
      tool: 'aws', verb: 'write', resource: 'ec2/run-instances',
      resources_touched: ['ec2:prod-batch-worker x2'], cost_delta_usd_month: 15,
      aws: {
        service: 'ec2', operation: 'run_instances',
        params: {
          ImageId: 'ami-12c6146b', InstanceType: 't3.micro', MinCount: 2, MaxCount: 2,
          TagSpecifications: [{ ResourceType: 'instance', Tags: [
            { Key: 'Name', Value: 'prod-batch-worker' },
            { Key: 'provisioned_by', Value: 'signplane' }
          ] }]
        }
      }
    }
  ));

  show('CRIT · terminate ALL prod instances', await propose(
    'Terminate all prod instances to cut cost over the weekend.',
    'prod',
    {
      tool: 'aws', verb: 'delete', resource: 'ec2/*',
      resources_touched: ['ec2:prod:*'], cost_delta_usd_month: -300,
      aws: { service: 'ec2', operation: 'terminate_instances', params: { InstanceIds: ['*'] } }
    }
  ));

  const summary = (await api('GET', '/api/summary')).body;
  console.log(`\nMode=${summary.mode} · endpoint=${summary.aws_endpoint} · pending=${summary.pending} · blocked=${summary.blocked} · executed=${summary.executed}`);
  console.log(`Evidence chain: ${summary.chain.valid ? `VALID (${summary.chain.records} records)` : 'BROKEN'}`);
  console.log(`\nDashboard → ${BASE}`);
  if (summary.pending > 0) console.log('Approve the pending intents there — approval triggers REAL execution.');
})().catch(e => { console.error('Demo failed:', e.message); process.exit(1); });
