/**
 * Signplane client — drop this single file into your agent project (Node >= 18).
 *
 *   const { Signplane, Blocked } = require('./signplane');
 *   const sp = new Signplane({ agentId: 'agt_…', token: '…' });
 *
 *   const verdict = await sp.propose({
 *     intent: 'Scale batch workers; queue depth > 10k',
 *     environment: 'dev', verb: 'write', resource: 'ec2/run-instances',
 *     cloud: { provider: 'aws', service: 'ec2', operation: 'run_instances',
 *              params: { ImageId: 'ami-12c6146b', InstanceType: 't3.micro', MinCount: 1, MaxCount: 1 } }
 *   });
 *   if (verdict.pending) await sp.wait(verdict);          // blocks for human approval
 *
 * A Blocked error means policy said no — the cloud never saw the request and the
 * attempt is on the evidence record. Don't retry; surface the reason.
 */

class Blocked extends Error {
  constructor(reason, intentId, evidenceId) {
    super(reason);
    this.name = 'Blocked';
    this.intentId = intentId;
    this.evidenceId = evidenceId;
  }
}

class Verdict {
  constructor(data) { this.data = data; }
  get intentId() { return this.data.intent_id || this.data.id; }
  get status() { return this.data.status; }
  get executed() { return this.data.status === 'executed'; }
  get pending() { return this.data.status === 'pending'; }
  get scheduled() { return this.data.status === 'scheduled'; }
  get observed() { return 'would_have' in this.data || this.data.status === 'observed'; }
  get wouldHave() { return this.data.would_have; }
  get risk() { return this.data.risk; }
  get policy() { return this.data.policy || this.data.policy_name; }
  get evidenceId() { return this.data.evidence_id; }
  get summary() { return this.data.execution?.aws || this.data.status; }
}

class Signplane {
  constructor({ agentId, token, url } = {}) {
    this.url = (url || process.env.SIGNPLANE_URL || 'http://localhost:4820').replace(/\/$/, '');
    this.agentId = agentId || process.env.SIGNPLANE_AGENT_ID;
    this.token = token || process.env.SIGNPLANE_AGENT_TOKEN;
    if (!this.agentId || !this.token) throw new Error('agentId and token required (or SIGNPLANE_AGENT_ID / SIGNPLANE_AGENT_TOKEN env)');
  }

  async #request(method, path, body) {
    const res = await fetch(this.url + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  async propose({ intent, verb, resource, environment, cloud, resourcesTouched, costDeltaUsdMonth, notBefore }) {
    const action = { tool: cloud?.provider || 'generic', verb, resource };
    if (resourcesTouched) action.resources_touched = resourcesTouched;
    if (costDeltaUsdMonth !== undefined) action.cost_delta_usd_month = costDeltaUsdMonth;
    if (cloud) action.cloud = cloud;
    const { status, body } = await this.#request('POST', '/api/gateway/propose', {
      agent_id: this.agentId, agent_token: this.token,
      intent,
      environment: environment || process.env.SIGNPLANE_ENVIRONMENT || 'dev',
      action,
      schedule: notBefore ? { not_before: notBefore } : undefined
    });
    if (status === 403) throw new Blocked(body.reason || body.policy || 'blocked', body.intent_id, body.evidence_id);
    return new Verdict(body);
  }

  async status(intentId) {
    const { body } = await this.#request('GET', `/api/intents/${intentId}`);
    return new Verdict(body);
  }

  async wait(verdict, { timeout = 600_000, poll = 3_000 } = {}) {
    const deadline = Date.now() + timeout;
    let current = verdict;
    while (Date.now() < deadline) {
      current = await this.status(verdict.intentId);
      if (!['pending', 'scheduled', 'approved'].includes(current.status)) {
        if (current.status === 'blocked') throw new Blocked(current.policy, current.intentId, current.evidenceId);
        return current;
      }
      await new Promise(r => setTimeout(r, poll));
    }
    throw new Error(`intent ${verdict.intentId} still ${current.status} after ${timeout}ms`);
  }
}

module.exports = { Signplane, Verdict, Blocked };
