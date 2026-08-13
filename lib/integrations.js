// Signplane integrations — event dispatcher + connectors.
//
// Events emitted by the gateway:
//   intent.pending | intent.executed | intent.blocked | intent.rejected |
//   intent.rolled_back | intent.drift | intent.scheduled | mode.changed
//
// Each enabled integration receives every event it subscribes to. Dispatch is
// async and failure-isolated: a dead Jira instance never blocks the gateway.
// Every delivery (success or failure) lands in audit_events.

const { integrations, audit } = require('./db');

const TIMEOUT_MS = 6000;

async function post(url, { headers = {}, body, method = 'POST' } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
}

const basicAuth = (user, secret) => 'Basic ' + Buffer.from(`${user}:${secret}`).toString('base64');

function intentSummary(intent) {
  return {
    intent_id: intent.id,
    agent: intent.agent_summary?.name,
    environment: intent.environment,
    intent: intent.intent_text,
    risk: intent.risk,
    policy: intent.policy_name,
    status: intent.status,
    resources: intent.blast_radius?.resources_touched,
    cost_delta_usd_month: intent.blast_radius?.cost_delta_usd_month
  };
}

// ---------------- connectors ----------------

const CONNECTORS = {

  // config: { webhook_url }
  slack: {
    label: 'Slack',
    configFields: ['webhook_url'],
    events: ['intent.pending', 'intent.executed', 'intent.blocked', 'intent.rolled_back', 'intent.drift', 'mode.changed'],
    async send(config, event, intent, extra) {
      const icon = { 'intent.pending': '⏳', 'intent.executed': '✅', 'intent.blocked': '⛔', 'intent.rolled_back': '↩️', 'intent.drift': '⚠️', 'mode.changed': '🔁' }[event] || 'ℹ️';
      let text;
      if (event === 'mode.changed') {
        text = `${icon} Signplane mode changed to *${extra.mode.toUpperCase()}* by ${extra.changed_by}`;
      } else {
        const head = { 'intent.pending': `Approval needed (*${intent.risk}*)`, 'intent.executed': 'Change executed', 'intent.blocked': `Change *BLOCKED* (${intent.risk})`, 'intent.rolled_back': 'Change rolled back', 'intent.drift': 'Drift guard fired — re-approval required' }[event];
        text = [
          `${icon} ${head}`,
          `*Agent:* ${intent.agent_summary?.name} · *Env:* ${intent.environment}`,
          `*Intent:* ${intent.intent_text}`,
          `*Policy:* ${intent.policy_name}` + (intent.blast_radius?.cost_delta_usd_month ? ` · $${intent.blast_radius.cost_delta_usd_month}/mo` : ''),
          event === 'intent.pending' ? `→ Approve in the dashboard: ${extra.base_url}` : null
        ].filter(Boolean).join('\n');
      }
      await post(config.webhook_url, { body: { text } });
    },
    async test(config) {
      await post(config.webhook_url, { body: { text: '✓ Signplane connection test — this channel will receive approval and evidence notifications.' } });
      return 'Test message posted to Slack.';
    }
  },

  // config: { base_url, email, api_token, project_key, issue_type? }
  jira: {
    label: 'Jira',
    configFields: ['base_url', 'email', 'api_token', 'project_key', 'issue_type'],
    events: ['intent.pending', 'intent.executed', 'intent.blocked', 'intent.rolled_back', 'intent.drift'],
    async send(config, event, intent, extra, state) {
      const auth = { Authorization: basicAuth(config.email, config.api_token) };
      const api = config.base_url.replace(/\/$/, '') + '/rest/api/3';
      const adf = text => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

      if (event === 'intent.pending') {
        const res = await post(`${api}/issue`, { headers: auth, body: {
          fields: {
            project: { key: config.project_key },
            issuetype: { name: config.issue_type || 'Task' },
            summary: `[Signplane][${intent.risk}] ${intent.intent_text}`.slice(0, 250),
            description: adf(
              `Agent ${intent.agent_summary?.name} proposes a ${intent.risk}-risk change in ${intent.environment}. ` +
              `Policy: ${intent.policy_name}. Resources: ${(intent.blast_radius?.resources_touched || []).join(', ')}. ` +
              `Approve or reject in Signplane: ${extra.base_url} (intent ${intent.id})`)
          }
        } });
        state.jira_issue = res.key;              // remembered on the intent for follow-up comments
      } else if (state.jira_issue) {
        const note = {
          'intent.executed': `Executed. Result: ${intent.execution?.aws || 'success'}. Evidence: ${intent.evidence_id}.`,
          'intent.blocked': `Blocked by policy at release: ${intent.policy_name}.`,
          'intent.rejected': `Rejected by ${intent.approval?.approver}: ${intent.approval?.comment || 'no comment'}.`,
          'intent.rolled_back': `Rolled back: ${intent.rollback_execution?.aws || 'compensating action executed'}.`,
          'intent.drift': `Drift guard: ${intent.revalidation?.detail}`
        }[event];
        if (note) await post(`${api}/issue/${state.jira_issue}/comment`, { headers: auth, body: { body: adf(note) } });
      }
    },
    async test(config) {
      const me = await post(config.base_url.replace(/\/$/, '') + '/rest/api/3/myself',
        { method: 'GET', headers: { Authorization: basicAuth(config.email, config.api_token) } });
      return `Authenticated to Jira as ${me.displayName || me.emailAddress || 'unknown user'}.`;
    }
  },

  // config: { instance_url, username, password }
  servicenow: {
    label: 'ServiceNow',
    configFields: ['instance_url', 'username', 'password'],
    events: ['intent.pending', 'intent.executed', 'intent.blocked', 'intent.rolled_back', 'intent.drift'],
    async send(config, event, intent, extra, state) {
      const auth = { Authorization: basicAuth(config.username, config.password) };
      const api = config.instance_url.replace(/\/$/, '') + '/api/now/table';

      if (event === 'intent.pending') {
        const riskMap = { LOW: 4, MEDIUM: 3, HIGH: 2, CRITICAL: 1 };
        const res = await post(`${api}/change_request`, { headers: auth, body: {
          short_description: `[Signplane][${intent.risk}] ${intent.intent_text}`.slice(0, 160),
          description: `AI agent ${intent.agent_summary?.name} proposes a change in ${intent.environment}.\n` +
            `Policy: ${intent.policy_name}\nResources: ${(intent.blast_radius?.resources_touched || []).join(', ')}\n` +
            `Signplane intent: ${intent.id} — approve at ${extra.base_url}`,
          type: 'normal', risk: riskMap[intent.risk] || 3, category: 'Software',
          correlation_id: intent.id
        } });
        state.snow_sys_id = res.result?.sys_id;
      } else if (state.snow_sys_id) {
        const stateMap = { 'intent.executed': { state: 3, close_notes: `Executed: ${intent.execution?.aws || 'success'}` },
          'intent.blocked': { state: 4, close_notes: 'Blocked by Signplane policy' },
          'intent.rejected': { state: 4, close_notes: `Rejected: ${intent.approval?.comment || ''}` },
          'intent.rolled_back': { state: 3, close_notes: `Rolled back: ${intent.rollback_execution?.aws || ''}` },
          'intent.drift': { work_notes: `Drift guard: ${intent.revalidation?.detail}` } }[event];
        if (stateMap) await post(`${api}/change_request/${state.snow_sys_id}`, { method: 'PATCH', headers: auth, body: stateMap });
      }
    },
    async test(config) {
      const res = await post(config.instance_url.replace(/\/$/, '') + '/api/now/table/change_request?sysparm_limit=1',
        { method: 'GET', headers: { Authorization: basicAuth(config.username, config.password) } });
      return `Connected to ServiceNow (${Array.isArray(res.result) ? 'change_request table readable' : 'response received'}).`;
    }
  },

  // config: { url, auth_header?, auth_value? } — Splunk HEC, Datadog, or any JSON sink
  webhook: {
    label: 'SIEM / Webhook',
    configFields: ['url', 'auth_header', 'auth_value'],
    events: ['intent.pending', 'intent.executed', 'intent.blocked', 'intent.rejected', 'intent.rolled_back', 'intent.drift', 'intent.scheduled', 'mode.changed'],
    async send(config, event, intent, extra) {
      const headers = config.auth_header ? { [config.auth_header]: config.auth_value } : {};
      await post(config.url, { headers, body: {
        source: 'signplane', event, time: new Date().toISOString(),
        detail: intent ? intentSummary(intent) : extra
      } });
    },
    async test(config) {
      const headers = config.auth_header ? { [config.auth_header]: config.auth_value } : {};
      await post(config.url, { headers, body: { source: 'signplane', event: 'connection.test', time: new Date().toISOString() } });
      return 'Test event delivered.';
    }
  }
};

// ---------------- dispatcher ----------------

// Per-intent connector state (e.g. the Jira issue key) is stored back on the
// intent object by the caller via the returned state mutations.
async function dispatch(event, intent, extra = {}) {
  const enabled = integrations.list().filter(i => i.enabled);
  const results = [];
  await Promise.all(enabled.map(async itg => {
    const connector = CONNECTORS[itg.kind];
    if (!connector || !connector.events.includes(event)) return;
    const state = (intent && intent.integration_state) || {};
    try {
      await connector.send(itg.config, event, intent, extra, state);
      if (intent) intent.integration_state = state;
      audit.log('system', itg.id, 'integration_delivered', { kind: itg.kind, event, intent_id: intent?.id });
      results.push({ integration: itg.id, ok: true });
    } catch (e) {
      audit.log('system', itg.id, 'integration_failed', { kind: itg.kind, event, intent_id: intent?.id, error: e.message.slice(0, 300) });
      results.push({ integration: itg.id, ok: false, error: e.message });
    }
  }));
  return results;
}

async function testIntegration(kind, config) {
  const connector = CONNECTORS[kind];
  if (!connector) throw new Error(`unknown integration kind: ${kind}`);
  return connector.test(config);
}

module.exports = { CONNECTORS, dispatch, testIntegration };
