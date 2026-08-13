const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.SIGNPLANE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-core-'));
const core = require('../lib/core');

test('stableStringify is key-order independent', () => {
  assert.strictEqual(core.stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] }), core.stableStringify({ a: [2, { c: 4, d: 3 }], b: 1 }));
});

test('policy: first match wins, windows respected', () => {
  const policies = core.DEFAULT_POLICIES;
  // Saturday 03:00 — inside the maintenance window → MEDIUM/team
  const satNight = new Date('2026-08-15T03:00:00');
  const inWin = core.evaluatePolicy(policies, { verb: 'write', resource: 'x' }, 'prod', satNight);
  assert.strictEqual(inWin.risk, 'MEDIUM');
  assert.strictEqual(inWin.required_role, 'team');
  // Tuesday noon — outside → HIGH/security
  const tueNoon = new Date('2026-08-11T12:00:00');
  const outWin = core.evaluatePolicy(policies, { verb: 'write', resource: 'x' }, 'prod', tueNoon);
  assert.strictEqual(outWin.risk, 'HIGH');
  assert.strictEqual(outWin.required_role, 'security');
  // prod delete → CRITICAL block regardless of time
  assert.strictEqual(core.evaluatePolicy(policies, { verb: 'delete' }, 'prod', satNight).decision, 'block');
  // read → allow
  assert.strictEqual(core.evaluatePolicy(policies, { verb: 'read' }, 'prod', tueNoon).decision, 'allow');
  // unmatched verb → default approval
  assert.strictEqual(core.evaluatePolicy(policies, { verb: 'exec' }, 'prod', tueNoon).policy.id, 'pol-default');
});

test('inWindow handles overnight ranges', () => {
  const w = { start: '22:00', end: '04:00' };
  assert.ok(core.inWindow(w, new Date('2026-08-11T23:30:00')));
  assert.ok(core.inWindow(w, new Date('2026-08-11T02:00:00')));
  assert.ok(!core.inWindow(w, new Date('2026-08-11T12:00:00')));
});

test('evidence chain: append, verify, detect tamper', () => {
  const a = core.appendEvidence({ type: 'test', n: 1 });
  const b = core.appendEvidence({ type: 'test', n: 2 });
  core.appendEvidence({ type: 'test', n: 3 });
  assert.strictEqual(b.prev_hash, a.hash);
  assert.deepStrictEqual(core.verifyChain(), { valid: true, records: 3 });

  // tamper with record #2
  const lines = fs.readFileSync(core.EVIDENCE_FILE, 'utf8').trim().split('\n');
  const rec = JSON.parse(lines[1]);
  rec.payload.n = 999;
  lines[1] = JSON.stringify(rec);
  fs.writeFileSync(core.EVIDENCE_FILE, lines.join('\n') + '\n');
  const v = core.verifyChain();
  assert.strictEqual(v.valid, false);
  assert.strictEqual(v.broken_at_index, 1);
});

test('cloudSpec normalizes action.cloud and legacy action.aws', () => {
  assert.strictEqual(core.cloudSpec(null), null);
  assert.strictEqual(core.cloudSpec({ verb: 'write' }), null);
  const legacy = core.cloudSpec({ aws: { service: 'ec2', operation: 'run_instances', params: { MinCount: 1 } } });
  assert.strictEqual(legacy.provider, 'aws');
  assert.strictEqual(legacy.service, 'ec2');
  const azure = core.cloudSpec({ cloud: { provider: 'Azure', service: 'compute', operation: 'virtual_machines.begin_deallocate', params: {} } });
  assert.strictEqual(azure.provider, 'azure');
  const gcp = core.cloudSpec({ cloud: { provider: 'gcp', service: 'compute', operation: 'instances.stop' } });
  assert.strictEqual(gcp.provider, 'gcp');
  assert.strictEqual(gcp.operation, 'instances.stop');
});

test('blastRadius flags destruction and counts resources', () => {
  const br = core.blastRadius({ verb: 'delete', resources_touched: ['a', 'b'], cost_delta_usd_month: -10 });
  assert.strictEqual(br.resource_count, 2);
  assert.strictEqual(br.destructive, true);
  assert.strictEqual(br.cost_delta_usd_month, -10);
});
