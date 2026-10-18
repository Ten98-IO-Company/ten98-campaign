import { randomBytes, scrypt, timingSafeEqual, createHmac, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { transaction } from './database.mjs';

const derive = promisify(scrypt);
const maxAge = 7 * 86400;
export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
export const publicUser = user => user ? { id: user.id, name: user.name, email: user.email, isOperator: Boolean(user.isOperator) } : null;
export function sessionSecret(dataDir, provided) {
  if (provided) { if (provided.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters.'); return provided; }
  const path = join(dataDir, 'session-secret');
  try { const value = readFileSync(path, 'utf8').trim(); if (value.length < 32) throw new Error('The saved session secret is invalid.'); return value; }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const value = randomBytes(48).toString('base64url');
    try { writeFileSync(path, value, { flag: 'wx', mode: 0o600 }); return value; }
    catch (race) { if (race.code === 'EEXIST') return sessionSecret(dataDir); throw race; }
  }
}
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${(await derive(password, salt, 64, { N: 65536, maxmem: 128 * 1024 * 1024 })).toString('hex')}`;
}
async function verify(password, encoded) {
  const [, salt = 'absent-account', expected = '0'.repeat(128)] = (encoded || '').split('$');
  const actual = await derive(password, salt, 64, { N: 65536, maxmem: 128 * 1024 * 1024 });
  const saved = Buffer.from(expected, 'hex');
  return Boolean(encoded) && saved.length === actual.length && timingSafeEqual(saved, actual);
}
export function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(part => part.trim().split(/=(.*)/s)).filter(part => part[0]).map(([key, value]) => [key, value || '']));
}
export function createAuth(db, config) {
  const digest = value => createHmac('sha256', config.sessionSecret).update(value).digest('hex');
  function cookie(name, value, age = maxAge) {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${config.appUrl.startsWith('https:') ? '; Secure' : ''}`;
  }
  function establish(res, userId) {
    const token = randomBytes(32).toString('base64url');
    db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token), userId, Date.now() + maxAge * 1000);
    res.setHeader('Set-Cookie', cookie('ten98_session', token));
  }
  function user(req) {
    const token = cookies(req).ten98_session;
    if (!token || !/^[\w-]{43}$/.test(token)) return null;
    return publicUser(db.prepare('SELECT u.id,u.name,u.email,EXISTS(SELECT 1 FROM instance_operators o WHERE o.user_id=u.id) AS isOperator FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?').get(digest(token), Date.now()));
  }
  function limit(key, maximum = 10) {
    const now = Date.now();
    db.prepare('DELETE FROM login_limits WHERE expires_at<=?').run(now);
    const row = db.prepare('SELECT count FROM login_limits WHERE key=?').get(key);
    if (row?.count >= maximum) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    db.prepare('INSERT INTO login_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(key, now + 900000);
  }
  let oidcConfig;
  async function oidc() {
    const client = await import('openid-client');
    if (!oidcConfig) oidcConfig = await client.discovery(new URL(config.oidcIssuer), config.oidcClientId, config.oidcClientSecret || undefined);
    return { client, provider: oidcConfig };
  }
  return {
    user, establish, limit,
    account(userId) { return { localPassword: Boolean(db.prepare('SELECT password FROM users WHERE id=?').get(userId)?.password), activeSessions: db.prepare('SELECT count(*) AS count FROM sessions WHERE user_id=? AND expires_at>?').get(userId, Date.now()).count }; },
    revokeOtherSessions(req, userId) { return db.prepare('DELETE FROM sessions WHERE user_id=? AND token<>?').run(userId, digest(cookies(req).ten98_session || '')).changes; },
    async changePassword(req, res, userId, currentPassword, newPassword) {
      limit('password:' + userId);
      const previous = db.prepare('SELECT password FROM users WHERE id=?').get(userId)?.password;
      if (!previous || !await verify(currentPassword, previous)) throw new HttpError(400, 'The current password is incorrect.');
      const next = await hashPassword(newPassword);
      transaction(db, () => {
        if (db.prepare('SELECT password FROM users WHERE id=?').get(userId)?.password !== previous) throw new HttpError(409, 'Your password changed during this request. Sign in again.');
        db.prepare('UPDATE users SET password=? WHERE id=?').run(next, userId);
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
      });
      establish(res, userId);
    },
    async login(req, res, body) {
      limit('ip:' + req.socket.remoteAddress, 30); limit('email:' + digest(body.email));
      const found = db.prepare('SELECT u.*,EXISTS(SELECT 1 FROM instance_operators o WHERE o.user_id=u.id) AS isOperator FROM users u WHERE email=?').get(body.email);
      if (!await verify(body.password, found?.password)) throw new HttpError(401, 'Email or password is incorrect.');
      if (db.prepare('SELECT password FROM users WHERE id=?').get(found.id)?.password !== found.password) throw new HttpError(401, 'Your password changed. Sign in again.');
      db.prepare('DELETE FROM login_limits WHERE key=?').run('email:' + digest(body.email));
      establish(res, found.id); return publicUser(found);
    },
    logout(req, res) {
      if (cookies(req).ten98_session) db.prepare('DELETE FROM sessions WHERE token=?').run(digest(cookies(req).ten98_session));
      res.setHeader('Set-Cookie', cookie('ten98_session', '', 0));
    },
    async oidcStart(req, res) {
      if (!config.oidcEnabled || !db.prepare('SELECT id FROM users LIMIT 1').get()) throw new HttpError(400, 'Identity sign-in is unavailable.');
      limit('oidc:' + req.socket.remoteAddress, 30);
      const { client, provider } = await oidc();
      const invite = new URL(req.url || '/api/auth/oidc/start', config.appUrl).searchParams.get('invite');
      if (invite && !/^[A-Za-z0-9_-]{43}$/.test(invite)) throw new HttpError(400, 'Use a valid invitation link before signing in.');
      const state = client.randomState(), nonce = client.randomNonce(), verifier = client.randomPKCECodeVerifier(), browser = randomBytes(32).toString('base64url');
      db.prepare('DELETE FROM oidc_flows WHERE expires_at<=?').run(Date.now());
      db.prepare('INSERT INTO oidc_flows VALUES(?,?,?,?,?)').run(digest(state), digest(browser), verifier, nonce, Date.now() + 600000);
      if (invite) db.prepare('INSERT INTO oidc_return_targets VALUES(?,?)').run(digest(state), invite);
      const location = client.buildAuthorizationUrl(provider, { redirect_uri: config.appUrl + '/api/auth/oidc/callback', scope: 'openid email profile', state, nonce, code_challenge: await client.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256' });
      res.setHeader('Set-Cookie', cookie('ten98_oidc', browser, 600)); res.writeHead(302, { Location: location.href }); res.end();
    },
    async oidcCallback(req, res, url) {
      const state = url.searchParams.get('state'), browser = cookies(req).ten98_oidc;
      if (!state || !browser || url.searchParams.getAll('state').length !== 1) throw new HttpError(400, 'Identity sign-in expired. Start again.');
      const flow = transaction(db, () => {
          const found = db.prepare('SELECT f.*,r.invite_token FROM oidc_flows f LEFT JOIN oidc_return_targets r ON r.state=f.state WHERE f.state=? AND f.browser=? AND f.expires_at>?').get(digest(state), digest(browser), Date.now());
        if (found) db.prepare('DELETE FROM oidc_flows WHERE state=?').run(found.state);
        return found;
      });
      if (!flow) throw new HttpError(400, 'Identity sign-in expired or was already used.');
      try {
        const { client, provider } = await oidc();
        const tokens = await client.authorizationCodeGrant(provider, url, { pkceCodeVerifier: flow.verifier, expectedState: state, expectedNonce: flow.nonce, idTokenExpected: true });
        const claims = tokens.claims();
        if (!claims?.sub || typeof claims.sub !== 'string' || claims.sub.length > 1024) throw new Error('Missing subject.');
        const userId = transaction(db, () => {
          const existing = db.prepare('SELECT user_id FROM oidc_identities WHERE issuer=? AND subject=?').get(claims.iss, claims.sub);
          if (existing) return existing.user_id;
          const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
          if (claims.email_verified !== true || !config.oidcAllowedEmails.includes(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new HttpError(403, 'This identity is not provisioned. Ask the operator for access.');
          if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) throw new HttpError(403, 'This email already has an account. Automatic identity linking is disabled.');
          const id = randomUUID(), workspace = randomUUID();
          db.prepare('INSERT INTO users VALUES(?,?,?,NULL)').run(id, typeof claims.name === 'string' ? claims.name.slice(0, 120) : email, email);
          db.prepare('INSERT INTO oidc_identities VALUES(?,?,?)').run(claims.iss, claims.sub, id);
          db.prepare('INSERT INTO workspaces VALUES(?,?)').run(workspace, 'My workspace');
          db.prepare("INSERT INTO memberships VALUES(?,?,'owner')").run(workspace, id);
          db.prepare('INSERT INTO projects(id,workspace_id,name) VALUES(?,?,?)').run(randomUUID(), workspace, 'My project');
          return id;
        });
        establish(res, userId); res.setHeader('Set-Cookie', [res.getHeader('Set-Cookie'), cookie('ten98_oidc', '', 0)]);
        res.writeHead(302, { Location: config.appUrl + '/' + (flow.invite_token ? '?invite=' + encodeURIComponent(flow.invite_token) : '') }); res.end();
      } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'Identity sign-in could not be verified. Start again.'); }
    },
  };
}
