// Signplane persistence layer — Node built-in SQLite (node:sqlite).
// Single-file database at data/signplane.db. The evidence ledger stays in
// data/evidence.jsonl on purpose: an append-only file is the honest,
// independently-verifiable artifact auditors (and the tamper demo) want.

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.SIGNPLANE_DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'signplane.db'));
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','approver','viewer')),
  password_hash TEXT, sso_subject TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, token TEXT NOT NULL, name TEXT NOT NULL, owner TEXT NOT NULL,
  model TEXT, environments TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
  expires_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS intents (
  id TEXT PRIMARY KEY, json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
  config TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY, actor_type TEXT NOT NULL, actor_id TEXT,
  event_type TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intents_status ON intents(status);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_events(created_at);
`);

const id = prefix => prefix + '_' + crypto.randomBytes(6).toString('hex');
const now = () => new Date().toISOString();

// ---- one-time migration from the MVP's JSON files ----
function migrateJson() {
  const agentsFile = path.join(DATA_DIR, 'agents.json');
  if (fs.existsSync(agentsFile) && db.prepare('SELECT COUNT(*) AS n FROM agents').get().n === 0) {
    try {
      const old = JSON.parse(fs.readFileSync(agentsFile, 'utf8'));
      const ins = db.prepare('INSERT OR IGNORE INTO agents (id, token, name, owner, model, environments, status, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)');
      for (const a of Object.values(old)) {
        ins.run(a.id, a.token, a.name, a.owner, a.model || null, JSON.stringify(a.environments || []), a.status || 'active', a.expires_at || null, a.created_at || now());
      }
      fs.renameSync(agentsFile, agentsFile + '.migrated');
    } catch { /* leave the file for manual inspection */ }
  }
  const intentsFile = path.join(DATA_DIR, 'intents.json');
  if (fs.existsSync(intentsFile) && db.prepare('SELECT COUNT(*) AS n FROM intents').get().n === 0) {
    try {
      const old = JSON.parse(fs.readFileSync(intentsFile, 'utf8'));
      const ins = db.prepare('INSERT OR IGNORE INTO intents (id, json, status, created_at) VALUES (?,?,?,?)');
      for (const i of Object.values(old)) ins.run(i.id, JSON.stringify(i), i.status, i.created_at);
      fs.renameSync(intentsFile, intentsFile + '.migrated');
    } catch { /* ignore */ }
  }
  const settingsFile = path.join(DATA_DIR, 'settings.json');
  if (fs.existsSync(settingsFile)) {
    try {
      const old = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      if (old.mode) settings.set('mode', old.mode);
      fs.renameSync(settingsFile, settingsFile + '.migrated');
    } catch { /* ignore */ }
  }
}

// ---- typed accessors ----

const users = {
  create({ email, name, role, password_hash = null, sso_subject = null }) {
    const u = { id: id('usr'), email: email.toLowerCase(), name, role, password_hash, sso_subject, created_at: now() };
    db.prepare('INSERT INTO users (id, email, name, role, password_hash, sso_subject, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(u.id, u.email, u.name, u.role, u.password_hash, u.sso_subject, u.created_at);
    return u;
  },
  byEmail: email => db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase()) || null,
  byId: uid => db.prepare('SELECT * FROM users WHERE id = ?').get(uid) || null,
  list: () => db.prepare('SELECT id, email, name, role, sso_subject, created_at FROM users ORDER BY created_at').all(),
  count: () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
  setRole: (uid, role) => db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, uid),
  remove: uid => { db.prepare('DELETE FROM sessions WHERE user_id = ?').run(uid); db.prepare('DELETE FROM users WHERE id = ?').run(uid); }
};

const sessions = {
  create(user_id, ttlHours = 24 * 7) {
    const s = { id: crypto.randomBytes(24).toString('hex'), user_id, created_at: now(), expires_at: new Date(Date.now() + ttlHours * 3600e3).toISOString() };
    db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?,?,?,?)').run(s.id, s.user_id, s.created_at, s.expires_at);
    return s;
  },
  get(sid) {
    const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
    if (!s) return null;
    if (s.expires_at < now()) { sessions.remove(sid); return null; }
    return s;
  },
  remove: sid => db.prepare('DELETE FROM sessions WHERE id = ?').run(sid)
};

const agents = {
  create(a) {
    db.prepare('INSERT INTO agents (id, token, name, owner, model, environments, status, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(a.id, a.token, a.name, a.owner, a.model || null, JSON.stringify(a.environments || []), a.status, a.expires_at || null, a.created_at);
    return a;
  },
  byId(aid) {
    const r = db.prepare('SELECT * FROM agents WHERE id = ?').get(aid);
    return r ? { ...r, environments: JSON.parse(r.environments) } : null;
  },
  list: () => db.prepare('SELECT * FROM agents ORDER BY created_at').all().map(r => ({ ...r, environments: JSON.parse(r.environments) })),
  setStatus: (aid, status) => db.prepare('UPDATE agents SET status = ? WHERE id = ?').run(status, aid),
  count: () => db.prepare('SELECT COUNT(*) AS n FROM agents').get().n
};

const intents = {
  save(intent) {
    db.prepare(`INSERT INTO intents (id, json, status, created_at) VALUES (?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET json = excluded.json, status = excluded.status`)
      .run(intent.id, JSON.stringify(intent), intent.status, intent.created_at);
  },
  byId(iid) {
    const r = db.prepare('SELECT json FROM intents WHERE id = ?').get(iid);
    return r ? JSON.parse(r.json) : null;
  },
  list(status = null) {
    const rows = status
      ? db.prepare('SELECT json FROM intents WHERE status = ? ORDER BY created_at DESC').all(status)
      : db.prepare('SELECT json FROM intents ORDER BY created_at DESC').all();
    return rows.map(r => JSON.parse(r.json));
  },
  counts() {
    const out = {};
    for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM intents GROUP BY status').all()) out[r.status] = r.n;
    return out;
  }
};

const integrations = {
  create({ kind, name, config, enabled = true }) {
    const i = { id: id('itg'), kind, name, config, enabled, created_at: now() };
    db.prepare('INSERT INTO integrations (id, kind, name, config, enabled, created_at) VALUES (?,?,?,?,?,?)')
      .run(i.id, i.kind, i.name, JSON.stringify(config), enabled ? 1 : 0, i.created_at);
    return i;
  },
  byId(iid) {
    const r = db.prepare('SELECT * FROM integrations WHERE id = ?').get(iid);
    return r ? { ...r, config: JSON.parse(r.config), enabled: !!r.enabled } : null;
  },
  list: () => db.prepare('SELECT * FROM integrations ORDER BY created_at').all().map(r => ({ ...r, config: JSON.parse(r.config), enabled: !!r.enabled })),
  update(iid, { config, enabled, name }) {
    const cur = integrations.byId(iid);
    if (!cur) return null;
    db.prepare('UPDATE integrations SET config = ?, enabled = ?, name = ? WHERE id = ?')
      .run(JSON.stringify(config ?? cur.config), (enabled ?? cur.enabled) ? 1 : 0, name ?? cur.name, iid);
    return integrations.byId(iid);
  },
  remove: iid => db.prepare('DELETE FROM integrations WHERE id = ?').run(iid)
};

const settings = {
  get: (key, fallback = null) => {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return r ? JSON.parse(r.value) : fallback;
  },
  set: (key, value) =>
    db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value))
};

const audit = {
  log(actor_type, actor_id, event_type, payload = null) {
    db.prepare('INSERT INTO audit_events (id, actor_type, actor_id, event_type, payload, created_at) VALUES (?,?,?,?,?,?)')
      .run(id('aud'), actor_type, actor_id, event_type, payload ? JSON.stringify(payload) : null, now());
  },
  recent: (limit = 50) => db.prepare('SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?').all(limit)
    .map(r => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : null }))
};

migrateJson();

module.exports = { db, id, now, users, sessions, agents, intents, integrations, settings, audit, DATA_DIR };
