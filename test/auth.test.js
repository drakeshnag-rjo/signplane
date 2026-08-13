const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');

process.env.SIGNPLANE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-auth-'));
const db = require('../lib/db');
const auth = require('../lib/auth');

test('password hashing round-trips and rejects wrong password', () => {
  const h = auth.hashPassword('correct horse battery staple');
  assert.ok(auth.verifyPassword('correct horse battery staple', h));
  assert.ok(!auth.verifyPassword('wrong', h));
  assert.ok(!auth.verifyPassword('anything', null));
});

test('login + session + role ranks', () => {
  db.users.create({ email: 'elena@corp.io', name: 'Elena', role: 'admin', password_hash: auth.hashPassword('s3cret!') });
  assert.strictEqual(auth.login('elena@corp.io', 'nope'), null);
  const r = auth.login('ELENA@corp.io', 's3cret!');
  assert.ok(r && r.session.id);
  const fakeReq = { headers: { cookie: `signplane_session=${r.session.id}` } };
  assert.strictEqual(auth.currentUser(fakeReq).email, 'elena@corp.io');
  assert.ok(auth.ROLE_RANK.admin > auth.ROLE_RANK.approver && auth.ROLE_RANK.approver > auth.ROLE_RANK.viewer);
});

test('requireRole: demo mode grants implicit admin; auth-on demands session', () => {
  db.settings.set('auth_mode', 'off');
  assert.ok(auth.requireRole({ headers: {} }, 'admin').ok);
  db.settings.set('auth_mode', 'on');
  const denied = auth.requireRole({ headers: {} }, 'viewer');
  assert.strictEqual(denied.code, 401);
  db.settings.set('auth_mode', 'off');
});

// ---- full OIDC flow against a local mock IdP ----

test('OIDC SSO: discovery → auth URL → code exchange → verified id_token → session', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };

  let issuedNonce = null;
  const idp = http.createServer((req, res) => {
    const send = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/.well-known/openid-configuration') {
      send({
        issuer: issuer,
        authorization_endpoint: issuer + '/authorize',
        token_endpoint: issuer + '/token',
        jwks_uri: issuer + '/jwks'
      });
    } else if (req.url === '/jwks') {
      send({ keys: [jwk] });
    } else if (req.url === '/token' && req.method === 'POST') {
      const b64u = buf => Buffer.from(JSON.stringify(buf)).toString('base64url');
      const header = b64u({ alg: 'RS256', typ: 'JWT', kid: 'k1' });
      const payload = b64u({
        iss: issuer, aud: 'signplane-client', sub: 'okta|priya',
        email: 'priya@corp.io', name: 'Priya Patel',
        nonce: issuedNonce, exp: Math.floor(Date.now() / 1000) + 300
      });
      const sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
      send({ id_token: `${header}.${payload}.${sig}`, access_token: 'at', token_type: 'Bearer' });
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise(r => idp.listen(0, r));
  const issuer = `http://localhost:${idp.address().port}`;

  db.settings.set('oidc', { issuer, client_id: 'signplane-client', client_secret: 'shh', enabled: true });

  const authUrl = new URL(await auth.oidcStart('http://localhost:4820/api/auth/oidc/callback'));
  assert.strictEqual(authUrl.origin + authUrl.pathname, issuer + '/authorize');
  assert.strictEqual(authUrl.searchParams.get('client_id'), 'signplane-client');
  const state = authUrl.searchParams.get('state');
  issuedNonce = authUrl.searchParams.get('nonce');
  assert.ok(state && issuedNonce);

  const result = await auth.oidcCallback('fake-code', state);
  assert.strictEqual(result.user.email, 'priya@corp.io');
  assert.ok(result.session.id);
  assert.ok(db.users.byEmail('priya@corp.io'));

  // replayed state must fail
  await assert.rejects(() => auth.oidcCallback('fake-code', state), /unknown or expired state/);

  // tampered token must fail: reconfigure client_id so audience check trips
  db.settings.set('oidc', { issuer, client_id: 'different-client', client_secret: 'shh', enabled: true });
  const url2 = new URL(await auth.oidcStart('http://localhost:4820/cb'));
  issuedNonce = url2.searchParams.get('nonce');
  await assert.rejects(() => auth.oidcCallback('code', url2.searchParams.get('state')), /audience mismatch/);

  idp.close();
});
