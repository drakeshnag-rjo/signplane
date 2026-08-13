// Signplane authentication & authorization.
// - Local users: scrypt password hashing, cookie sessions, roles admin|approver|viewer
// - SSO: generic OIDC authorization-code flow with JWKS RS256 id_token verification
//   (works with Okta, Azure AD / Entra, Google, Auth0 — anything spec-compliant)
// Auth enforcement is a mode: settings key auth_mode = 'off' (demo) | 'on' (production).

const crypto = require('crypto');
const { users, sessions, settings, audit } = require('./db');

const ROLE_RANK = { viewer: 1, approver: 2, admin: 3 };

// ---- passwords ----

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

// ---- sessions / request identity ----

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function currentUser(req) {
  const sid = parseCookies(req).signplane_session;
  if (!sid) return null;
  const s = sessions.get(sid);
  return s ? users.byId(s.user_id) : null;
}

function sessionCookie(sid, maxAgeSec = 7 * 24 * 3600) {
  return `signplane_session=${sid}; HttpOnly; Path=/; Max-Age=${maxAgeSec}; SameSite=Lax`;
}

const clearCookie = () => 'signplane_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax';

function authMode() { return settings.get('auth_mode', 'off'); }

// Returns the effective user for a request. In auth_mode 'off' (demo), an
// implicit admin is used so the MVP demos keep working unchanged.
function effectiveUser(req) {
  const real = currentUser(req);
  if (real) return real;
  if (authMode() === 'off') return { id: 'demo', email: 'demo@signplane.local', name: 'Demo mode', role: 'admin', demo: true };
  return null;
}

function requireRole(req, role) {
  const user = effectiveUser(req);
  if (!user) return { ok: false, code: 401, error: 'authentication required' };
  if (ROLE_RANK[user.role] < ROLE_RANK[role]) return { ok: false, code: 403, error: `requires ${role} role` };
  return { ok: true, user };
}

function login(email, password) {
  const u = users.byEmail(email);
  if (!u || !verifyPassword(password, u.password_hash)) {
    audit.log('user', email, 'login_failed');
    return null;
  }
  const s = sessions.create(u.id);
  audit.log('user', u.id, 'login', { method: 'password' });
  return { user: u, session: s };
}

// ---- OIDC SSO ----
// Config lives in settings key 'oidc': { issuer, client_id, client_secret, enabled }.
// State/nonce are held in-memory with a 10-minute TTL (single-node v1).

const pendingOidc = new Map();

function oidcConfig() { return settings.get('oidc', null); }

async function discover(issuer) {
  const res = await fetch(issuer.replace(/\/$/, '') + '/.well-known/openid-configuration');
  if (!res.ok) throw new Error(`OIDC discovery failed: HTTP ${res.status}`);
  return res.json();
}

async function oidcStart(redirectUri) {
  const cfg = oidcConfig();
  if (!cfg || !cfg.enabled) throw new Error('SSO is not configured');
  const disc = await discover(cfg.issuer);
  const state = crypto.randomBytes(16).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');
  pendingOidc.set(state, { nonce, redirectUri, created: Date.now() });
  for (const [k, v] of pendingOidc) if (Date.now() - v.created > 600e3) pendingOidc.delete(k);
  const url = new URL(disc.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', cfg.client_id);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  return url.toString();
}

function b64urlJson(part) {
  return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
}

async function verifyIdToken(idToken, disc, cfg, nonce) {
  const [h, p, sig] = idToken.split('.');
  if (!h || !p || !sig) throw new Error('malformed id_token');
  const header = b64urlJson(h);
  const payload = b64urlJson(p);
  if (header.alg !== 'RS256') throw new Error(`unsupported alg ${header.alg}`);

  const jwksRes = await fetch(disc.jwks_uri);
  if (!jwksRes.ok) throw new Error('JWKS fetch failed');
  const jwks = await jwksRes.json();
  const jwk = (jwks.keys || []).find(k => k.kid === header.kid) || (jwks.keys || [])[0];
  if (!jwk) throw new Error('no matching JWK');

  const pub = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), pub,
    Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  if (!ok) throw new Error('id_token signature invalid');

  const issuerNorm = s => String(s).replace(/\/$/, '');
  if (issuerNorm(payload.iss) !== issuerNorm(cfg.issuer)) throw new Error('issuer mismatch');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(cfg.client_id)) throw new Error('audience mismatch');
  if (payload.exp && payload.exp * 1000 < Date.now()) throw new Error('id_token expired');
  if (nonce && payload.nonce !== nonce) throw new Error('nonce mismatch');
  return payload;
}

async function oidcCallback(code, state) {
  const pending = pendingOidc.get(state);
  if (!pending) throw new Error('unknown or expired state');
  pendingOidc.delete(state);

  const cfg = oidcConfig();
  const disc = await discover(cfg.issuer);
  const tokenRes = await fetch(disc.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code,
      redirect_uri: pending.redirectUri,
      client_id: cfg.client_id, client_secret: cfg.client_secret
    })
  });
  if (!tokenRes.ok) throw new Error(`token exchange failed: HTTP ${tokenRes.status}`);
  const tokens = await tokenRes.json();
  const claims = await verifyIdToken(tokens.id_token, disc, cfg, pending.nonce);

  const email = (claims.email || '').toLowerCase();
  if (!email) throw new Error('id_token carries no email claim');

  let user = users.byEmail(email);
  if (!user) {
    // First-ever user becomes admin; later SSO users join as viewer until promoted.
    const role = users.count() === 0 ? 'admin' : 'viewer';
    user = users.create({ email, name: claims.name || email, role, sso_subject: claims.sub });
    audit.log('system', null, 'sso_user_provisioned', { email, role });
  }
  const session = sessions.create(user.id);
  audit.log('user', user.id, 'login', { method: 'sso' });
  return { user, session };
}

module.exports = {
  hashPassword, verifyPassword, login, currentUser, effectiveUser, requireRole,
  sessionCookie, clearCookie, authMode, oidcStart, oidcCallback, verifyIdToken, discover,
  ROLE_RANK
};
