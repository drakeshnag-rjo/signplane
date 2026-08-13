#!/usr/bin/env node
/**
 * Signplane — the control plane for autonomous infrastructure.
 *
 * v1.0 product server: SQLite persistence, local + OIDC SSO auth, RBAC,
 * integrations (Slack / Jira / ServiceNow / SIEM webhook), plus the full
 * governance engine from the MVP: gateway interception, policy with change
 * windows, approvals with TTL, scheduled release with drift guard, real AWS
 * execution, verified rollback, and the hash-chained evidence ledger.
 *
 * Run: node server.js  →  http://localhost:4820
 * Auth is OFF by default (demo mode). Enable: set auth_mode 'on' in Settings.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const db = require('./lib/db');
const auth = require('./lib/auth');
const core = require('./lib/core');
const itg = require('./lib/integrations');

const PORT = process.env.PORT || 4820;
const baseUrl = () => db.settings.get('base_url', `http://localhost:${PORT}`);

let policies = core.loadPolicies();

// ---------- helpers ----------

function json(res, code, obj, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(obj, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  });
}

function guard(req, res, role) {
  const r = auth.requireRole(req, role);
  if (!r.ok) { json(res, r.code, { error: r.error }); return null; }
  return r.user;
}

const STATUS_EVENT = {
  pending: 'intent.pending', executed: 'intent.executed', blocked: 'intent.blocked',
  rejected: 'intent.rejected', rolled_back: 'intent.rolled_back', scheduled: 'intent.scheduled'
};

function finalizeIntent(intent, extra = {}) {
  const evidence = core.appendEvidence({
    type: 'agent_action',
    intent_id: intent.id,
    agent: intent.agent_summary,
    environment: intent.environment,
    intent_text: intent.intent_text,
    action: intent.action,
    policy: { id: intent.policy_id, name: intent.policy_name },
    risk: intent.risk,
    mode: intent.mode,
    routing: intent.routing,
    status: intent.status,
    not_before: intent.not_before || null,
    released_at: intent.released_at || null,
    approval: intent.approval || null,
    blast_radius: intent.blast_radius,
    snapshot: intent.snapshot || null,
    execution: intent.execution || null,
    ...extra
  });
  intent.evidence_id = evidence.id;
  intent.evidence_hash = evidence.hash;
  db.intents.save(intent);

  const event = extra.revalidation ? 'intent.drift' : STATUS_EVENT[intent.status];
  if (event) {
    itg.dispatch(event, intent, { base_url: baseUrl() })
      .then(() => db.intents.save(intent))   // persist connector state (Jira key, SN sys_id)
      .catch(() => {});
  }
}

// ---------- scheduled release (approval TTL → policy → drift) ----------

const DEFAULT_APPROVAL_TTL_MIN = 240;

function captureApprovalState(intent) {
  const aws = intent.action && intent.action.aws;
  if (!aws || !aws.service) return;
  const cur = core.runExecutor({ op: 'describe', service: aws.service });
  intent.approval_state_hash = core.sha256(core.stableStringify(cur.ok ? cur.result : cur.error));
}

function releaseScheduled(intent) {
  const nowIso = new Date().toISOString();

  if (intent.approval && intent.approval.valid_until && intent.approval.valid_until < nowIso) {
    intent.status = 'pending';
    intent.revalidation = { failed_at: nowIso, reason: 'approval_expired',
      detail: `approval by ${intent.approval.approver} expired at ${intent.approval.valid_until} — re-approval required` };
    finalizeIntent(intent, { revalidation: intent.revalidation });
    return;
  }

  const ev = core.evaluatePolicy(policies, intent.action, intent.environment);
  if (ev.decision === 'block') {
    intent.status = 'blocked';
    intent.routing = 'policy_block_at_release';
    intent.policy_id = ev.policy.id;
    intent.policy_name = ev.policy.name;
    finalizeIntent(intent);
    return;
  }

  const aws = intent.action && intent.action.aws;
  if (aws && intent.approval_state_hash) {
    const cur = core.runExecutor({ op: 'describe', service: aws.service });
    const hash = core.sha256(core.stableStringify(cur.ok ? cur.result : cur.error));
    if (hash !== intent.approval_state_hash) {
      intent.status = 'pending';
      intent.revalidation = { failed_at: nowIso, reason: 'state_drift',
        detail: `${aws.service} state changed between approval and scheduled release — re-approval required` };
      finalizeIntent(intent, { revalidation: intent.revalidation });
      return;
    }
  }

  intent.released_at = nowIso;
  core.executeIntent(intent);
  finalizeIntent(intent, { released: 'on_schedule' });
}

const schedulerTimer = setInterval(() => {
  const nowIso = new Date().toISOString();
  for (const intent of db.intents.list('scheduled')) {
    if (intent.not_before && intent.not_before <= nowIso) {
      try { releaseScheduled(intent); } catch (e) { console.error('release failed:', intent.id, e.message); }
    }
  }
}, 3000);
schedulerTimer.unref();

// ---------- HTTP ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    }

    // ---- auth ----
    if (req.method === 'GET' && p === '/api/auth/me') {
      const user = auth.currentUser(req);
      const oidc = db.settings.get('oidc', null);
      return json(res, 200, {
        auth_mode: auth.authMode(),
        needs_setup: auth.authMode() === 'on' && db.users.count() === 0,
        sso_enabled: !!(oidc && oidc.enabled),
        user: user ? { id: user.id, email: user.email, name: user.name, role: user.role } :
          (auth.authMode() === 'off' ? { id: 'demo', email: 'demo@signplane.local', name: 'Demo mode', role: 'admin', demo: true } : null)
      });
    }
    if (req.method === 'POST' && p === '/api/auth/setup') {
      if (db.users.count() > 0) return json(res, 409, { error: 'setup already completed' });
      const b = await readBody(req);
      if (!b.email || !b.password || !b.name) return json(res, 400, { error: 'name, email, password required' });
      const u = db.users.create({ email: b.email, name: b.name, role: 'admin', password_hash: auth.hashPassword(b.password) });
      const s = db.sessions.create(u.id);
      db.audit.log('system', null, 'first_admin_created', { email: u.email });
      return json(res, 201, { user: { email: u.email, role: u.role } }, { 'Set-Cookie': auth.sessionCookie(s.id) });
    }
    if (req.method === 'POST' && p === '/api/auth/login') {
      const b = await readBody(req);
      const r = auth.login(b.email || '', b.password || '');
      if (!r) return json(res, 401, { error: 'invalid credentials' });
      return json(res, 200, { user: { email: r.user.email, name: r.user.name, role: r.user.role } },
        { 'Set-Cookie': auth.sessionCookie(r.session.id) });
    }
    if (req.method === 'POST' && p === '/api/auth/logout') {
      const sid = (req.headers.cookie || '').match(/signplane_session=([^;]+)/)?.[1];
      if (sid) db.sessions.remove(sid);
      return json(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
    }
    if (req.method === 'GET' && p === '/api/auth/oidc/login') {
      const redirectUri = baseUrl() + '/api/auth/oidc/callback';
      const location = await auth.oidcStart(redirectUri);
      res.writeHead(302, { Location: location });
      return res.end();
    }
    if (req.method === 'GET' && p === '/api/auth/oidc/callback') {
      try {
        const r = await auth.oidcCallback(url.searchParams.get('code'), url.searchParams.get('state'));
        res.writeHead(302, { Location: '/', 'Set-Cookie': auth.sessionCookie(r.session.id) });
        return res.end();
      } catch (e) {
        res.writeHead(302, { Location: '/?sso_error=' + encodeURIComponent(e.message) });
        return res.end();
      }
    }

    // ---- users (admin) ----
    if (p === '/api/users') {
      if (req.method === 'GET') { if (!guard(req, res, 'admin')) return; return json(res, 200, db.users.list()); }
      if (req.method === 'POST') {
        const actor = guard(req, res, 'admin'); if (!actor) return;
        const b = await readBody(req);
        if (!b.email || !b.name || !['admin', 'approver', 'viewer'].includes(b.role)) return json(res, 400, { error: 'name, email, valid role required' });
        if (db.users.byEmail(b.email)) return json(res, 409, { error: 'email already exists' });
        const u = db.users.create({ email: b.email, name: b.name, role: b.role, password_hash: b.password ? auth.hashPassword(b.password) : null });
        db.audit.log('user', actor.id, 'user_created', { email: u.email, role: u.role });
        return json(res, 201, { id: u.id, email: u.email, role: u.role });
      }
    }
    const userMatch = p.match(/^\/api\/users\/(usr_[a-f0-9]+)$/);
    if (userMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
      const actor = guard(req, res, 'admin'); if (!actor) return;
      const target = db.users.byId(userMatch[1]);
      if (!target) return json(res, 404, { error: 'user not found' });
      if (req.method === 'DELETE') {
        if (target.id === actor.id) return json(res, 400, { error: 'cannot delete yourself' });
        db.users.remove(target.id);
        db.audit.log('user', actor.id, 'user_deleted', { email: target.email });
        return json(res, 200, { ok: true });
      }
      const b = await readBody(req);
      if (b.role) {
        if (!['admin', 'approver', 'viewer'].includes(b.role)) return json(res, 400, { error: 'invalid role' });
        db.users.setRole(target.id, b.role);
        db.audit.log('user', actor.id, 'role_changed', { email: target.email, role: b.role });
      }
      return json(res, 200, db.users.byId(target.id));
    }

    // ---- integrations (admin) ----
    if (p === '/api/integrations') {
      if (req.method === 'GET') {
        if (!guard(req, res, 'admin')) return;
        return json(res, 200, { kinds: Object.fromEntries(Object.entries(itg.CONNECTORS).map(([k, c]) => [k, { label: c.label, configFields: c.configFields }])), configured: db.integrations.list() });
      }
      if (req.method === 'POST') {
        const actor = guard(req, res, 'admin'); if (!actor) return;
        const b = await readBody(req);
        if (!itg.CONNECTORS[b.kind]) return json(res, 400, { error: 'unknown kind' });
        const created = db.integrations.create({ kind: b.kind, name: b.name || itg.CONNECTORS[b.kind].label, config: b.config || {}, enabled: b.enabled !== false });
        db.audit.log('user', actor.id, 'integration_added', { kind: b.kind, id: created.id });
        return json(res, 201, created);
      }
    }
    const itgMatch = p.match(/^\/api\/integrations\/(itg_[a-f0-9]+)(\/test)?$/);
    if (itgMatch) {
      const actor = guard(req, res, 'admin'); if (!actor) return;
      const record = db.integrations.byId(itgMatch[1]);
      if (!record) return json(res, 404, { error: 'integration not found' });
      if (req.method === 'POST' && itgMatch[2] === '/test') {
        try { return json(res, 200, { ok: true, message: await itg.testIntegration(record.kind, record.config) }); }
        catch (e) { return json(res, 502, { ok: false, error: e.message }); }
      }
      if (req.method === 'PATCH') {
        const b = await readBody(req);
        return json(res, 200, db.integrations.update(record.id, b));
      }
      if (req.method === 'DELETE') {
        db.integrations.remove(record.id);
        db.audit.log('user', actor.id, 'integration_removed', { kind: record.kind });
        return json(res, 200, { ok: true });
      }
    }

    // ---- settings (admin) ----
    if (p === '/api/settings' && req.method === 'PATCH') {
      const actor = guard(req, res, 'admin'); if (!actor) return;
      const b = await readBody(req);
      if (b.auth_mode) {
        if (!['on', 'off'].includes(b.auth_mode)) return json(res, 400, { error: "auth_mode must be 'on' or 'off'" });
        if (b.auth_mode === 'on' && db.users.count() === 0 && !b.first_admin) {
          return json(res, 400, { error: 'create the first admin before enabling auth (pass first_admin: {name, email, password})' });
        }
        if (b.first_admin && db.users.count() === 0) {
          db.users.create({ email: b.first_admin.email, name: b.first_admin.name, role: 'admin', password_hash: auth.hashPassword(b.first_admin.password) });
        }
        db.settings.set('auth_mode', b.auth_mode);
        db.audit.log('user', actor.id, 'auth_mode_changed', { auth_mode: b.auth_mode });
      }
      if (b.oidc) { db.settings.set('oidc', b.oidc); db.audit.log('user', actor.id, 'oidc_configured', { issuer: b.oidc.issuer, enabled: b.oidc.enabled }); }
      if (b.base_url) db.settings.set('base_url', b.base_url);
      return json(res, 200, { auth_mode: auth.authMode(), oidc: db.settings.get('oidc'), base_url: baseUrl() });
    }

    // ---- agents ----
    if (req.method === 'POST' && p === '/api/agents/register') {
      if (!guard(req, res, 'admin')) return;
      const b = await readBody(req);
      if (!b.name || !b.owner) return json(res, 400, { error: 'name and owner are required' });
      const agent = db.agents.create({
        id: db.id('agt'), token: crypto.randomBytes(12).toString('hex'),
        name: b.name, owner: b.owner, model: b.model || 'unknown',
        environments: b.environments || ['staging'], status: 'active',
        expires_at: b.expires_at || null, created_at: db.now()
      });
      core.appendEvidence({ type: 'agent_registered', agent_id: agent.id, name: agent.name, owner: agent.owner, model: agent.model, environments: agent.environments });
      return json(res, 201, agent);
    }
    if (req.method === 'GET' && p === '/api/agents') {
      if (!guard(req, res, 'viewer')) return;
      return json(res, 200, db.agents.list().map(({ token, ...a }) => a));
    }
    const agentMatch = p.match(/^\/api\/agents\/(agt_[a-f0-9]+)$/);
    if (agentMatch && req.method === 'PATCH') {
      const actor = guard(req, res, 'admin'); if (!actor) return;
      const b = await readBody(req);
      if (!['active', 'suspended'].includes(b.status)) return json(res, 400, { error: "status must be 'active' or 'suspended'" });
      db.agents.setStatus(agentMatch[1], b.status);
      db.audit.log('user', actor.id, 'agent_status_changed', { agent_id: agentMatch[1], status: b.status });
      return json(res, 200, { ok: true });
    }

    // ---- the gateway ----
    if (req.method === 'POST' && p === '/api/gateway/propose') {
      const b = await readBody(req);
      const action = b.action || {};
      const environment = b.environment || 'unknown';
      const mode = db.settings.get('mode', 'observe');

      const agent = db.agents.byId(b.agent_id);
      const identityOk = agent && agent.token === b.agent_token && agent.status === 'active' &&
        (!agent.expires_at || new Date(agent.expires_at) > new Date());
      const scopeOk = identityOk && agent.environments.includes(environment);

      if (!identityOk || !scopeOk) {
        const denial = {
          id: db.id('int'), created_at: db.now(),
          agent_summary: agent ? { id: agent.id, name: agent.name, model: agent.model } : { id: b.agent_id || 'unknown', name: 'UNKNOWN AGENT' },
          environment, intent_text: b.intent || '', action,
          policy_id: 'identity-gate',
          policy_name: !identityOk ? 'Unknown, suspended or expired agent identity' : 'Agent not scoped to this environment',
          risk: 'CRITICAL', mode, routing: 'identity_denied', status: 'blocked',
          blast_radius: core.blastRadius(action)
        };
        finalizeIntent(denial);
        return json(res, 403, { intent_id: denial.id, allowed: false, status: 'blocked', reason: denial.policy_name, evidence_id: denial.evidence_id });
      }

      const evalResult = core.evaluatePolicy(policies, action, environment);
      let not_before = null;
      if (b.schedule && b.schedule.not_before) {
        const t = new Date(b.schedule.not_before);
        if (isNaN(t)) return json(res, 400, { error: 'schedule.not_before must be an ISO timestamp' });
        not_before = t.toISOString();
      }
      const intent = {
        id: db.id('int'), created_at: db.now(),
        agent_summary: { id: agent.id, name: agent.name, owner: agent.owner, model: agent.model },
        environment, intent_text: b.intent || '', action, not_before,
        approval_ttl_min: evalResult.policy.approval_ttl_minutes || DEFAULT_APPROVAL_TTL_MIN,
        policy_id: evalResult.policy.id, policy_name: evalResult.policy.name,
        risk: evalResult.risk, mode, blast_radius: core.blastRadius(action)
      };

      if (mode === 'observe') {
        intent.routing = 'observed';
        intent.status = 'observed';
        intent.would_have = evalResult.decision === 'allow' ? 'auto-approved'
          : evalResult.decision === 'block' ? 'blocked' : `waited for ${evalResult.required_role} approval`;
        finalizeIntent(intent, { would_have: intent.would_have });
        return json(res, 200, { intent_id: intent.id, allowed: true, enforced: false, mode: 'observe', risk: intent.risk, policy: intent.policy_name, would_have: intent.would_have, evidence_id: intent.evidence_id });
      }

      if (evalResult.decision === 'block') {
        intent.routing = 'policy_block';
        intent.status = 'blocked';
        finalizeIntent(intent);
        return json(res, 403, { intent_id: intent.id, allowed: false, status: 'blocked', risk: intent.risk, policy: intent.policy_name, evidence_id: intent.evidence_id });
      }

      if (evalResult.decision === 'allow') {
        if (intent.not_before && intent.not_before > db.now()) {
          intent.routing = 'auto_approved_scheduled';
          intent.status = 'scheduled';
          captureApprovalState(intent);
          finalizeIntent(intent);
          return json(res, 202, { intent_id: intent.id, allowed: true, status: 'scheduled', not_before: intent.not_before, risk: intent.risk, policy: intent.policy_name });
        }
        intent.routing = 'auto_approved';
        intent.status = 'approved';
        core.executeIntent(intent);
        finalizeIntent(intent);
        return json(res, 200, { intent_id: intent.id, allowed: true, status: 'executed', risk: intent.risk, policy: intent.policy_name, evidence_id: intent.evidence_id });
      }

      intent.routing = `pending_${evalResult.required_role || 'team'}_approval`;
      intent.status = 'pending';
      intent.required_role = evalResult.required_role || 'team';
      db.intents.save(intent);
      itg.dispatch('intent.pending', intent, { base_url: baseUrl() }).then(() => db.intents.save(intent)).catch(() => {});
      return json(res, 202, { intent_id: intent.id, allowed: false, status: 'pending', risk: intent.risk, policy: intent.policy_name, message: `Awaiting ${intent.required_role} approval — poll GET /api/intents/${intent.id}` });
    }

    // ---- decisions (approver+) ----
    const decisionMatch = p.match(/^\/api\/intents\/(int_[a-f0-9]+)\/decision$/);
    if (req.method === 'POST' && decisionMatch) {
      const actor = guard(req, res, 'approver'); if (!actor) return;
      const intent = db.intents.byId(decisionMatch[1]);
      if (!intent) return json(res, 404, { error: 'intent not found' });
      if (intent.status !== 'pending') return json(res, 409, { error: `intent is ${intent.status}, not pending` });
      const b = await readBody(req);
      if (!['approved', 'rejected'].includes(b.decision)) return json(res, 400, { error: "decision must be 'approved' or 'rejected'" });
      const decided_at = new Date();
      intent.approval = {
        decision: b.decision,
        approver: actor.demo ? (b.approver || 'demo-user') : actor.email,
        comment: b.comment || '', decided_at: decided_at.toISOString(),
        valid_until: new Date(decided_at.getTime() + (intent.approval_ttl_min || DEFAULT_APPROVAL_TTL_MIN) * 60000).toISOString(),
        channel: 'dashboard'
      };
      if (b.decision === 'approved') {
        intent.revalidation = null;
        if (intent.not_before && intent.not_before > decided_at.toISOString()) {
          intent.status = 'scheduled';
          captureApprovalState(intent);
          finalizeIntent(intent);
          return json(res, 202, { intent_id: intent.id, status: 'scheduled', not_before: intent.not_before, approval_valid_until: intent.approval.valid_until, evidence_id: intent.evidence_id });
        }
        intent.status = 'approved';
        core.executeIntent(intent);
      } else {
        intent.status = 'rejected';
      }
      finalizeIntent(intent);
      return json(res, 200, { intent_id: intent.id, status: intent.status, evidence_id: intent.evidence_id });
    }

    // ---- rollback (approver+) ----
    const rollbackMatch = p.match(/^\/api\/intents\/(int_[a-f0-9]+)\/rollback$/);
    if (req.method === 'POST' && rollbackMatch) {
      const actor = guard(req, res, 'approver'); if (!actor) return;
      const intent = db.intents.byId(rollbackMatch[1]);
      if (!intent) return json(res, 404, { error: 'intent not found' });
      if (intent.status !== 'executed' || intent.rollback !== 'AVAILABLE') {
        return json(res, 409, { error: `rollback not available (status=${intent.status}, rollback=${intent.rollback})` });
      }
      const b = await readBody(req);
      let rb;
      if (intent.rollback_plan) {
        const r = core.runExecutor({ op: 'execute', ...intent.rollback_plan });
        rb = { executed_at: db.now(), requested_by: actor.demo ? (b.requested_by || 'demo-user') : actor.email,
          plan: intent.rollback_plan, result: r.ok ? 'success' : 'failed',
          aws: r.ok ? r.summary : null, error: r.ok ? null : r.error };
        if (r.ok) { intent.status = 'rolled_back'; intent.rollback = 'COMPLETED'; } else intent.rollback = 'FAILED';
      } else {
        rb = { executed_at: db.now(), requested_by: actor.demo ? (b.requested_by || 'demo-user') : actor.email, simulated: true, result: 'success' };
        intent.status = 'rolled_back';
        intent.rollback = 'COMPLETED';
      }
      intent.rollback_execution = rb;
      finalizeIntent(intent, { rollback_execution: rb });
      return json(res, rb.result === 'success' ? 200 : 502, { intent_id: intent.id, status: intent.status, rollback: rb, evidence_id: intent.evidence_id });
    }

    // ---- reads ----
    const intentMatch = p.match(/^\/api\/intents\/(int_[a-f0-9]+)$/);
    if (req.method === 'GET' && intentMatch) {
      if (!guard(req, res, 'viewer')) return;
      const intent = db.intents.byId(intentMatch[1]);
      return intent ? json(res, 200, intent) : json(res, 404, { error: 'not found' });
    }
    if (req.method === 'GET' && p === '/api/intents') {
      if (!guard(req, res, 'viewer')) return;
      return json(res, 200, db.intents.list(url.searchParams.get('status')));
    }
    if (req.method === 'GET' && p === '/api/evidence') {
      if (!guard(req, res, 'viewer')) return;
      return json(res, 200, core.readEvidence().reverse());
    }
    if (req.method === 'GET' && p === '/api/evidence/verify') {
      return json(res, 200, core.verifyChain());
    }
    if (req.method === 'GET' && p === '/api/evidence/export') {
      if (!guard(req, res, 'viewer')) return;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="signplane-evidence-pack.json"' });
      return res.end(JSON.stringify({
        exported_at: db.now(),
        control_mapping: ['SOC2 CC8.1 change management', 'SOX change authorization'],
        chain_verification: core.verifyChain(),
        records: core.readEvidence()
      }, null, 2));
    }
    if (req.method === 'GET' && p === '/api/audit') {
      if (!guard(req, res, 'admin')) return;
      return json(res, 200, db.audit.recent(100));
    }

    // ---- mode + policies + summary ----
    if (p === '/api/mode') {
      if (req.method === 'POST') {
        const actor = guard(req, res, 'admin'); if (!actor) return;
        const b = await readBody(req);
        if (!['observe', 'enforce'].includes(b.mode)) return json(res, 400, { error: "mode must be 'observe' or 'enforce'" });
        db.settings.set('mode', b.mode);
        core.appendEvidence({ type: 'mode_changed', mode: b.mode, changed_by: actor.demo ? (b.changed_by || 'demo-user') : actor.email });
        itg.dispatch('mode.changed', null, { mode: b.mode, changed_by: actor.demo ? (b.changed_by || 'demo-user') : actor.email }).catch(() => {});
      }
      return json(res, 200, { mode: db.settings.get('mode', 'observe') });
    }
    if (p === '/api/policies') {
      if (req.method === 'GET') { if (!guard(req, res, 'viewer')) return; return json(res, 200, policies); }
      if (req.method === 'PUT') {
        const actor = guard(req, res, 'admin'); if (!actor) return;
        const b = await readBody(req);
        if (!Array.isArray(b) || !b.every(x => x.id && x.match && x.risk && x.action)) return json(res, 400, { error: 'body must be an array of policy rules {id, match, risk, action}' });
        policies = b;
        fs.writeFileSync(path.join(__dirname, 'policies.json'), JSON.stringify(b, null, 2));
        core.appendEvidence({ type: 'policies_updated', count: b.length, updated_by: actor.email || 'demo' });
        db.audit.log('user', actor.id, 'policies_updated', { count: b.length });
        return json(res, 200, policies);
      }
    }
    if (req.method === 'GET' && p === '/api/summary') {
      if (!guard(req, res, 'viewer')) return;
      const counts = db.intents.counts();
      const total = Object.values(counts).reduce((a, b2) => a + b2, 0);
      return json(res, 200, {
        mode: db.settings.get('mode', 'observe'),
        auth_mode: auth.authMode(),
        aws_endpoint: core.AWS_ENDPOINT_LABEL,
        agents: db.agents.count(),
        users: db.users.count(),
        integrations: db.integrations.list().map(i => ({ kind: i.kind, name: i.name, enabled: i.enabled })),
        intents_total: total,
        pending: counts.pending || 0,
        scheduled: counts.scheduled || 0,
        blocked: counts.blocked || 0,
        executed: counts.executed || 0,
        observed: counts.observed || 0,
        rolled_back: counts.rolled_back || 0,
        failed: counts.failed || 0,
        chain: core.verifyChain()
      });
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Signplane v1.0 running → http://localhost:${PORT}`);
    console.log(`Mode: ${db.settings.get('mode', 'observe').toUpperCase()} · Auth: ${auth.authMode().toUpperCase()} · Agents: ${db.agents.count()} · Users: ${db.users.count()}`);
    console.log(`Demo traffic:  node demo-agent-aws.js`);
  });
}

module.exports = { server, PORT };
