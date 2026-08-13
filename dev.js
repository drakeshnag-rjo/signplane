#!/usr/bin/env node
/**
 * Signplane developer mode — one command from zero to a governed local agent.
 *
 *   node dev.js
 *
 * Starts the server (if not already running), registers (or reuses) a dev
 * agent scoped to dev/tst, and prints everything a developer needs to wire
 * a local agent: env exports, Python/JS snippets, and the MCP config for
 * Claude Desktop / Claude Code. Credentials are cached in .signplane-dev.json
 * so repeated runs are idempotent.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 4820;
const BASE = `http://localhost:${PORT}`;
const CACHE = path.join(__dirname, '.signplane-dev.json');

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function serverUp() {
  try { return (await fetch(BASE + '/api/summary')).ok; } catch { return false; }
}

(async () => {
  // 1. server
  if (await serverUp()) {
    console.log(`✓ Signplane already running at ${BASE}`);
  } else {
    console.log('starting Signplane server…');
    const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      detached: true, stdio: 'ignore', env: process.env
    });
    child.unref();
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise(r => setTimeout(r, 250));
    if (!(await serverUp())) { console.error('server failed to start'); process.exit(1); }
    console.log(`✓ Signplane running at ${BASE}`);
  }

  // 2. dev agent (reuse if cached and still valid)
  let agent = null;
  if (fs.existsSync(CACHE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
      const check = await api('POST', '/api/gateway/propose', {
        agent_id: cached.id, agent_token: cached.token, environment: 'dev',
        intent: 'dev.js liveness check', action: { verb: 'read', resource: 'signplane/dev-check' }
      });
      if (check.status !== 403) { agent = cached; console.log(`✓ reusing dev agent ${agent.id}`); }
    } catch { /* re-register below */ }
  }
  if (!agent) {
    const reg = await api('POST', '/api/agents/register', {
      name: 'local-dev-agent',
      owner: process.env.USERNAME || process.env.USER || 'developer',
      model: 'local', environments: ['dev', 'tst']
    });
    if (reg.status !== 201) {
      console.error('could not register a dev agent automatically —',
        reg.body?.error || `HTTP ${reg.status}`,
        '\n(auth is ON: register via the dashboard as an admin, then set SIGNPLANE_AGENT_ID/TOKEN)');
      process.exit(1);
    }
    agent = { id: reg.body.id, token: reg.body.token };
    fs.writeFileSync(CACHE, JSON.stringify(agent, null, 2));
    console.log(`✓ registered dev agent ${agent.id} (scoped to dev/tst — prod is out of reach)`);
  }

  const mcpPath = path.join(__dirname, 'mcp-server.js');

  console.log(`
──────────────────────────────────────────────────────────────────────
 Signplane dev environment ready
──────────────────────────────────────────────────────────────────────
 Dashboard      ${BASE}
 Agent id       ${agent.id}
 Environments   dev, tst   ·   Mode: check the dashboard header

 ENV (shell)
   export SIGNPLANE_URL=${BASE}
   export SIGNPLANE_AGENT_ID=${agent.id}
   export SIGNPLANE_AGENT_TOKEN=${agent.token}

 PYTHON (copy clients/signplane.py into your project)
   from signplane import Signplane
   sp = Signplane()                       # reads the env vars above
   v = sp.propose(intent="why I am doing this", verb="write",
                  resource="k8s/deploy/api", environment="dev")
   if v.pending: v = sp.wait(v)           # blocks until a human decides

 NODE (copy clients/signplane.js into your project)
   const { Signplane } = require('./signplane');
   const sp = new Signplane();
   const v = await sp.propose({ intent: 'why', verb: 'write', resource: 'x' });

 CLAUDE DESKTOP / CLAUDE CODE (MCP) — add to your MCP config:
   {
     "mcpServers": {
       "signplane": {
         "command": "node",
         "args": ["${mcpPath.replace(/\\/g, '\\\\')}"],
         "env": {
           "SIGNPLANE_URL": "${BASE}",
           "SIGNPLANE_AGENT_ID": "${agent.id}",
           "SIGNPLANE_AGENT_TOKEN": "${agent.token}"
         }
       }
     }
   }
   → your agent gets tools: propose_change · check_intent · list_policies

 Try it now:   node demo-agent-aws.js        (needs the moto emulator)
 Docs:         docs/connecting-agents.md · docs/API.md
──────────────────────────────────────────────────────────────────────`);
})();
