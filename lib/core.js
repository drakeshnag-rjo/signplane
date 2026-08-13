// Signplane core engine: policy evaluation (with change windows), blast radius,
// the hash-chained evidence ledger, and the AWS execution broker bridge.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { DATA_DIR } = require('./db');

const EVIDENCE_FILE = path.join(DATA_DIR, 'evidence.jsonl');
const POLICIES_FILE = path.join(__dirname, '..', 'policies.json');
// AWS_ENDPOINT_URL: an emulator URL (moto/Floci/LocalStack), or the sentinel
// 'aws' to use real AWS default endpoints. Unset = local moto (dev default).
const rawEndpoint = process.env.AWS_ENDPOINT_URL || 'http://localhost:5000';
const AWS_ENDPOINT = ['aws', 'real', 'default'].includes(rawEndpoint.toLowerCase()) ? null : rawEndpoint;
const AWS_ENDPOINT_LABEL = AWS_ENDPOINT || 'aws (default endpoints)';

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const id = prefix => prefix + '_' + crypto.randomBytes(6).toString('hex');

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

// ---------- policies ----------

const DEFAULT_POLICIES = [
  { id: 'pol-critical-prod-destroy', name: 'Never let an agent destroy production resources',
    match: { environment: 'prod', verbs: ['delete'] }, risk: 'CRITICAL', action: 'block' },
  { id: 'pol-maintenance-window', name: 'Prod writes inside the maintenance window need only team approval',
    match: { environment: 'prod', verbs: ['write'], window: { days: ['sat', 'sun'], start: '02:00', end: '06:00' } },
    risk: 'MEDIUM', action: 'approve', required_role: 'team', approval_ttl_minutes: 240 },
  { id: 'pol-high-prod-write', name: 'Production writes need security approval',
    match: { environment: 'prod', verbs: ['write'] }, risk: 'HIGH', action: 'approve', required_role: 'security', approval_ttl_minutes: 240 },
  { id: 'pol-medium-nonprod-write', name: 'Non-prod writes need team approval',
    match: { verbs: ['write', 'delete'] }, risk: 'MEDIUM', action: 'approve', required_role: 'team', approval_ttl_minutes: 240 },
  { id: 'pol-low-read', name: 'Reads flow freely', match: { verbs: ['read'] }, risk: 'LOW', action: 'allow' }
];

function loadPolicies() {
  try { return JSON.parse(fs.readFileSync(POLICIES_FILE, 'utf8')); }
  catch { fs.writeFileSync(POLICIES_FILE, JSON.stringify(DEFAULT_POLICIES, null, 2)); return DEFAULT_POLICIES; }
}

function inWindow(w, d = new Date()) {
  if (!w) return true;
  const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  if (w.days && w.days.length && !w.days.map(x => String(x).slice(0, 3).toLowerCase()).includes(dayNames[d.getDay()])) return false;
  if (w.start && w.end) {
    const parse = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
    const mins = d.getHours() * 60 + d.getMinutes();
    const s = parse(w.start), e = parse(w.end);
    return s <= e ? (mins >= s && mins < e) : (mins >= s || mins < e);
  }
  return true;
}

function evaluatePolicy(policies, action, environment, at = new Date()) {
  for (const pol of policies) {
    const m = pol.match || {};
    if (m.environment && m.environment !== environment) continue;
    if (m.verbs && !m.verbs.includes(action.verb)) continue;
    if (m.resource_pattern && !new RegExp(m.resource_pattern).test(action.resource || '')) continue;
    if (m.window && !inWindow(m.window, at)) continue;
    return { policy: pol, risk: pol.risk, decision: pol.action, required_role: pol.required_role || null };
  }
  return { policy: { id: 'pol-default', name: 'Unmatched actions require approval' }, risk: 'MEDIUM', decision: 'approve', required_role: 'team' };
}

function blastRadius(action) {
  const resources = action.resources_touched || (action.resource ? [action.resource] : []);
  return {
    resources_touched: resources,
    resource_count: resources.length,
    cost_delta_usd_month: action.cost_delta_usd_month ?? 0,
    destructive: action.verb === 'delete'
  };
}

// ---------- evidence ledger (append-only, hash-chained JSONL) ----------

function lastEvidenceHash() {
  try {
    const lines = fs.readFileSync(EVIDENCE_FILE, 'utf8').trim().split('\n').filter(Boolean);
    return lines.length ? JSON.parse(lines[lines.length - 1]).hash : 'GENESIS';
  } catch { return 'GENESIS'; }
}

function appendEvidence(payload) {
  const prev_hash = lastEvidenceHash();
  const record = { id: id('evd'), recorded_at: new Date().toISOString(), payload, prev_hash };
  record.hash = sha256(record.prev_hash + stableStringify({ id: record.id, recorded_at: record.recorded_at, payload }));
  fs.appendFileSync(EVIDENCE_FILE, JSON.stringify(record) + '\n');
  return record;
}

function readEvidence() {
  try { return fs.readFileSync(EVIDENCE_FILE, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); }
  catch { return []; }
}

function verifyChain() {
  const records = readEvidence();
  let prev = 'GENESIS';
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const expected = sha256(prev + stableStringify({ id: r.id, recorded_at: r.recorded_at, payload: r.payload }));
    if (r.prev_hash !== prev || r.hash !== expected) {
      return { valid: false, records: records.length, broken_at_index: i, broken_record_id: r.id };
    }
    prev = r.hash;
  }
  return { valid: true, records: records.length };
}

// ---------- execution broker (boto3 bridge; endpoint-agnostic) ----------

function runExecutor(cmd) {
  const r = spawnSync('python', [path.join(__dirname, '..', 'executor.py')], {
    input: JSON.stringify({ ...cmd, endpoint: AWS_ENDPOINT }),
    encoding: 'utf8', timeout: 30000
  });
  if (r.error) return { ok: false, error: r.error.message };
  try { return JSON.parse(r.stdout); } catch { return { ok: false, error: (r.stderr || r.stdout || 'executor produced no output').slice(0, 500) }; }
}

function executeIntent(intent) {
  const aws = intent.action && intent.action.aws;
  const started_at = new Date().toISOString();

  if (aws && aws.service && aws.operation) {
    const pre = runExecutor({ op: 'describe', service: aws.service });
    intent.snapshot = {
      id: id('snap'), kind: `aws_${aws.service}_state`, endpoint: AWS_ENDPOINT_LABEL,
      state: pre.ok ? pre.result : { unavailable: pre.error },
      hash: sha256(stableStringify(pre.ok ? pre.result : pre.error)), captured_at: started_at
    };
    const exec = runExecutor({ op: 'execute', service: aws.service, operation: aws.operation, params: aws.params || {} });
    const post = runExecutor({ op: 'describe', service: aws.service });
    intent.execution = {
      started_at, finished_at: new Date().toISOString(), simulated: false, endpoint: AWS_ENDPOINT_LABEL,
      result: exec.ok ? 'success' : 'failed',
      aws: exec.ok ? exec.summary : null, error: exec.ok ? null : exec.error,
      pre_state_hash: intent.snapshot.hash,
      post_state_hash: sha256(stableStringify(post.ok ? post.result : post.error))
    };
    intent.status = exec.ok ? 'executed' : 'failed';
    intent.rollback = exec.ok && exec.rollback_available ? 'AVAILABLE' : 'NONE';
    intent.rollback_plan = exec.ok ? exec.rollback_plan : null;
    return;
  }

  intent.snapshot = { id: id('snap'), kind: 'simulated_state', hash: sha256('pre:' + intent.id), captured_at: started_at };
  intent.execution = {
    started_at, finished_at: new Date().toISOString(), result: 'success', simulated: true,
    expected_state_hash: sha256('post:' + intent.id), actual_state_hash: sha256('post:' + intent.id),
    validation: 'expected == actual'
  };
  intent.status = 'executed';
  intent.rollback = 'AVAILABLE';
}

module.exports = {
  sha256, id, stableStringify,
  DEFAULT_POLICIES, loadPolicies, inWindow, evaluatePolicy, blastRadius,
  appendEvidence, readEvidence, verifyChain, EVIDENCE_FILE,
  runExecutor, executeIntent, AWS_ENDPOINT, AWS_ENDPOINT_LABEL
};
