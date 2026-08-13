#!/usr/bin/env node
/**
 * Signplane MCP server — lets MCP-capable agents (Claude Desktop, Claude Code,
 * anything speaking Model Context Protocol) propose infrastructure changes
 * through the Signplane gateway as native tools.
 *
 * Zero dependencies. Stdio transport (newline-delimited JSON-RPC 2.0).
 *
 * Environment:
 *   SIGNPLANE_URL          gateway base URL   (default http://localhost:4820)
 *   SIGNPLANE_AGENT_ID     registered agent id
 *   SIGNPLANE_AGENT_TOKEN  the agent's token
 *   SIGNPLANE_ENVIRONMENT  default environment for proposals (default "dev")
 *
 * Claude Desktop / Claude Code config (also printed by `node dev.js`):
 *   { "mcpServers": { "signplane": {
 *       "command": "node", "args": ["<path>/mcp-server.js"],
 *       "env": { "SIGNPLANE_AGENT_ID": "agt_…", "SIGNPLANE_AGENT_TOKEN": "…" } } } }
 */

const BASE = process.env.SIGNPLANE_URL || 'http://localhost:4820';
const AGENT_ID = process.env.SIGNPLANE_AGENT_ID || '';
const AGENT_TOKEN = process.env.SIGNPLANE_AGENT_TOKEN || '';
const DEFAULT_ENV = process.env.SIGNPLANE_ENVIRONMENT || 'dev';

const TOOLS = [
  {
    name: 'propose_change',
    description:
      'Propose an infrastructure change through the Signplane governance gateway. The change is ' +
      'identity-checked and policy-evaluated BEFORE anything executes: low-risk changes run ' +
      'immediately, risky ones wait for human approval (poll with check_intent), forbidden ones are ' +
      'blocked. Always explain WHY in `intent` — a human approver and an auditor will read it.',
    inputSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: 'Plain-English reason for the change (read by approvers and auditors)' },
        environment: { type: 'string', description: `Target environment (default: ${DEFAULT_ENV})` },
        verb: { type: 'string', enum: ['read', 'write', 'delete'], description: 'What kind of change this is' },
        resource: { type: 'string', description: 'Resource identifier, e.g. "ec2/run-instances" or "k8s/deploy/api"' },
        resources_touched: { type: 'array', items: { type: 'string' }, description: 'Resources affected (blast radius)' },
        cost_delta_usd_month: { type: 'number', description: 'Estimated monthly cost change in USD' },
        provider: { type: 'string', enum: ['aws', 'azure', 'gcp'], description: 'Cloud provider for real execution (omit for simulated/observe)' },
        service: { type: 'string', description: 'Cloud service, e.g. "ec2", "compute", "storage"' },
        operation: { type: 'string', description: 'API operation, e.g. "run_instances", "instances.stop", "virtual_machines.begin_deallocate"' },
        params: { type: 'object', description: 'Operation parameters' },
        not_before: { type: 'string', description: 'Optional ISO timestamp — schedule the change for later (re-validated at release)' }
      },
      required: ['intent', 'verb', 'resource']
    }
  },
  {
    name: 'check_intent',
    description: 'Check the status of a previously proposed change (pending → approved/rejected, scheduled, executed, blocked, rolled_back). Use after propose_change returns "pending".',
    inputSchema: { type: 'object', properties: { intent_id: { type: 'string' } }, required: ['intent_id'] }
  },
  {
    name: 'list_policies',
    description: 'List the governance policies currently in force (first match wins), so you can anticipate whether a change will auto-approve, need approval, or be blocked.',
    inputSchema: { type: 'object', properties: {} }
  }
];

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function callTool(name, args) {
  if (name === 'propose_change') {
    const action = {
      tool: args.provider || 'generic',
      verb: args.verb,
      resource: args.resource,
      resources_touched: args.resources_touched,
      cost_delta_usd_month: args.cost_delta_usd_month
    };
    if (args.service && args.operation) {
      action.cloud = { provider: args.provider || 'aws', service: args.service, operation: args.operation, params: args.params || {} };
    }
    const r = await api('POST', '/api/gateway/propose', {
      agent_id: AGENT_ID, agent_token: AGENT_TOKEN,
      intent: args.intent,
      environment: args.environment || DEFAULT_ENV,
      action,
      schedule: args.not_before ? { not_before: args.not_before } : undefined
    });
    const b = r.body || {};
    if (r.status === 403) {
      return `BLOCKED — this change was denied before reaching the cloud (${b.reason || b.policy}). ` +
        `The attempt is on the evidence record (${b.evidence_id}). Do not retry or work around it; ` +
        `tell the user why it was blocked.`;
    }
    if (b.status === 'pending') {
      return `PENDING human approval (risk: ${b.risk}, policy: ${b.policy}). ` +
        `Intent id: ${b.intent_id}. Poll with check_intent; do not proceed as if approved.`;
    }
    if (b.status === 'scheduled') {
      return `SCHEDULED for ${b.not_before} (risk: ${b.risk}). It will re-validate approval, policy, ` +
        `and cloud-state drift at release. Intent id: ${b.intent_id}.`;
    }
    if (b.would_have) {
      return `OBSERVED (observe mode — not gated). Would have: ${b.would_have}. Risk: ${b.risk}. ` +
        `Evidence: ${b.evidence_id}. You may proceed with your own execution.`;
    }
    return `EXECUTED (risk: ${b.risk}, policy: ${b.policy}). Evidence: ${b.evidence_id}.`;
  }

  if (name === 'check_intent') {
    const r = await api('GET', `/api/intents/${args.intent_id}`);
    if (r.status !== 200) return `Intent not found (${args.intent_id}).`;
    const i = r.body;
    const bits = [`status: ${i.status}`, `risk: ${i.risk}`, `policy: ${i.policy_name}`];
    if (i.approval) bits.push(`decision: ${i.approval.decision} by ${i.approval.approver}${i.approval.comment ? ` — "${i.approval.comment}"` : ''}`);
    if (i.execution?.aws) bits.push(`result: ${i.execution.aws}`);
    if (i.revalidation) bits.push(`revalidation: ${i.revalidation.reason} — ${i.revalidation.detail}`);
    if (i.not_before) bits.push(`scheduled for: ${i.not_before}`);
    return bits.join(' · ');
  }

  if (name === 'list_policies') {
    const r = await api('GET', '/api/policies');
    if (r.status !== 200) return 'Could not fetch policies.';
    return r.body.map((p, idx) =>
      `${idx + 1}. [${p.risk}] ${p.name} — ${p.action}${p.required_role ? ` (${p.required_role})` : ''}` +
      `${p.match?.environment ? ` · env: ${p.match.environment}` : ''}${p.match?.verbs ? ` · verbs: ${p.match.verbs.join('/')}` : ''}` +
      `${p.match?.window ? ` · window: ${(p.match.window.days || []).join(',')} ${p.match.window.start}-${p.match.window.end}` : ''}`
    ).join('\n');
  }

  throw new Error(`unknown tool: ${name}`);
}

// ---- stdio JSON-RPC plumbing (newline-delimited) ----

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) handle(line);
  }
});

async function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'signplane', version: '1.1.0' }
    } });
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') {
    return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  }
  if (method === 'tools/call') {
    try {
      const text = await callTool(params.name, params.arguments || {});
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
    } catch (e) {
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Signplane error: ${e.message}` }], isError: true } });
    }
  }
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}
