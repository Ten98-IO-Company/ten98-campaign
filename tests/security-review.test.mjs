// Regression tests for the 2026-10-22 defensive security review. Each test fails on dev at b59ad42.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAuth, hashPassword } from '../server/auth.ts';
import { postgresSkip, testApp, testDatabase } from './postgres.mjs';

// ten98-campaign#33 step 2/3: callers encode or validate every ID today, but providerRequest should refuse a path that
// leaves its intended endpoint, so a future unencoded caller cannot reach another endpoint with Campaign's credentials.
test('provider requests refuse traversal, encoded separators and smuggled queries in the path', async t => {
  const { zernioClient } = await import('../server/provider-core.ts'), originalFetch = globalThis.fetch, reached = [];
  globalThis.fetch = async target => { reached.push(String(target)); return new Response('{}', { status: 200 }); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const api = zernioClient('fixture-key');
  for (const id of ['../x', '..%2Fx', '%2e%2e/x', 'a%2Fb', 'a%5Cb', 'a?b=1', 'a#b']) {
    await assert.rejects(api(`/posts/${id}`), error => error.code === 'INVALID_PROVIDER', id);
  }
  assert.deepEqual(reached, [], 'No unsafe path reaches the provider.');
  await api('/posts/507f1f77bcf86cd799439011'); assert.equal(reached.length, 1, 'An ordinary ID is still sent.');
});

function response() {
  return { headers: {}, status: null, setHeader(name, value) { this.headers[name] = value; }, getHeader(name) { return this.headers[name]; }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end() {} };
}

// Behind the documented reverse proxy every request arrives from the proxy's address. The per-address sign-in limit
// must then key on the client the trusted proxy reports, or one client's failures lock every user out.
// `trustedProxies` is the proposed option name; rename it with the fix.
test('failed sign-ins from one client behind a trusted proxy do not lock out other clients', { skip: postgresSkip }, async t => {
  const { db } = await testDatabase(t), password = 'proxy fixture password 2026';
  await db.$client.query('INSERT INTO users VALUES ($1, $2, $3, $4)', ['victim', 'Victim', 'victim@example.test', await hashPassword(password)]);
  const auth = createAuth(db, { sessionSecret: 'security-review-fixture-secret-32-characters', appUrl: 'https://campaign.example', trustedProxies: ['10.0.0.2'] });
  const viaProxy = client => ({ headers: { 'x-forwarded-for': client }, socket: { remoteAddress: '10.0.0.2' } });
  for (let attempt = 0; attempt < 30; attempt++) {
    await assert.rejects(auth.login(viaProxy('203.0.113.7'), response(), { email: `guess-${attempt}@example.test`, password: 'wrong password guess' }), error => error.status === 401);
  }
  const user = await auth.login(viaProxy('198.51.100.9'), response(), { email: 'victim@example.test', password });
  assert.equal(user?.id, 'victim', 'A different client behind the same proxy must still be able to sign in.');

  // Negative control: an untrusted peer cannot dodge the limit by rotating X-Forwarded-For.
  for (let attempt = 0; attempt < 30; attempt++) {
    await assert.rejects(auth.login({ headers: { 'x-forwarded-for': `192.0.2.${attempt}` }, socket: { remoteAddress: '198.51.100.50' } }, response(), { email: `spray-${attempt}@example.test`, password: 'wrong password guess' }), error => error.status === 401);
  }
  await assert.rejects(auth.login({ headers: { 'x-forwarded-for': '192.0.2.200' }, socket: { remoteAddress: '198.51.100.50' } }, response(), { email: 'spray-final@example.test', password: 'wrong password guess' }), error => error.status === 429);
});

// The approval policy says "Changes to a post ... require a new review" and council decision ten98-code-system#30
// stops an administrator approving their own change while another administrator exists. Editing a published copy's
// text through social/edit-published must pass the same approval gate instead of only the administrator-role check.
test('with approval required, an administrator cannot change a published post\'s text without an approved review', { skip: postgresSkip }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ten98-security-review-')), distDir = join(dataDir, 'dist');
  await mkdir(distDir); await writeFile(join(distDir, 'index.html'), '<!doctype html><title>Campaign</title>');
  const origin = 'http://127.0.0.1:3000', app = await testApp(t, { dataDir, distDir, appUrl: origin, env: { ZERNIO_API_KEY: 'private-review-key' } }), originalFetch = globalThis.fetch;
  const providerWrites = [], remotePosts = new Map(); let ownerCookie, created = 0;
  const profileId = 'review-profile', accountId = 'review-account', account = { _id: accountId, profileId, platform: 'facebook', isActive: true };
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.origin, 'https://zernio.com');
    if (url.pathname === '/api/v1/tools/validate/post') return new Response(JSON.stringify({ valid: true, warnings: [] }));
    const method = options.method || 'GET'; let result;
    if (url.pathname === '/api/v1/accounts') result = { accounts: [account] };
    else if (method === 'POST' && url.pathname === '/api/v1/posts') {
      const payload = JSON.parse(options.body); providerWrites.push({ url, payload });
      const remote = { _id: `remote-review-${++created}`, content: payload.content, mediaItems: payload.mediaItems || [], status: 'published', platforms: payload.platforms.map(copy => ({ ...copy, status: 'published' })) };
      remotePosts.set(remote._id, remote); result = { post: remote };
    } else if (url.pathname.startsWith('/api/v1/posts/')) {
      const pieces = url.pathname.split('/'), remote = remotePosts.get(pieces[4]); assert.ok(remote);
      if (method === 'GET') result = { post: remote };
      else if (method === 'POST' && pieces[5] === 'edit') { const payload = JSON.parse(options.body); providerWrites.push({ url, payload }); remote.content = payload.content; result = { success: true }; }
      else throw new Error('Unexpected provider mutation');
    } else throw new Error(`Unexpected provider endpoint ${url.pathname}`);
    return new Response(JSON.stringify(result), { status: 200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, { method = 'GET', body, cookie = ownerCookie, key } = {}) {
    const result = await fetch(base + path, { method, headers: { ...(method !== 'GET' ? { Origin: origin } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: result.status, data: await result.json(), cookie: result.headers.get('set-cookie')?.split(';')[0] };
  }
  const post = (path, body, options = {}) => request(path, { ...options, method: 'POST', body });
  const password = 'a sufficiently long review fixture password';
  const setup = await post('/api/auth/setup', { token: app.config.bootstrapToken, name: 'Review owner', email: 'review-owner@example.test', password, sample: false }); assert.equal(setup.status, 201); ownerCookie = setup.cookie;
  const state = (await request('/api/state')).data, project = `/api/projects/${state.projectId}`, workspaceId = state.workspaces[0].id;
  assert.equal((await request(project, { method: 'PATCH', body: { zernioProfileId: profileId } })).status, 200);
  const passwordHash = (await app.sql.get('SELECT password FROM users WHERE id=?', state.user.id)).password;
  async function member(name, role) {
    const userId = randomUUID(), email = `${name}@example.test`;
    await app.sql.run('INSERT INTO users(id,name,email,password) VALUES(?,?,?,?)', userId, name, email, passwordHash);
    await app.sql.run('INSERT INTO memberships VALUES(?,?,?)', workspaceId, userId, role);
    const login = await post('/api/auth/login', { email, password }); assert.equal(login.status, 200);
    return login.cookie;
  }
  const editor = await member('review-editor', 'editor'), admin = await member('review-admin', 'admin');
  assert.equal((await post(project + '/approvals/policy', { requireApproval: true })).status, 200);
  const draft = await post(project + '/posts', { content: 'Reviewed launch text', platforms: ['facebook'], accounts: [accountId] }, { cookie: editor }); assert.equal(draft.status, 201);
  const requested = await post(`${project}/approvals/posts/${draft.data.record.id}/request`, {}, { cookie: editor }); assert.equal(requested.status, 200);
  assert.equal((await post(`${project}/approvals/posts/${draft.data.record.id}/review`, { decision: 'approved', reviewId: requested.data.item.review.id, note: 'Reviewed.' }, { cookie: admin })).status, 200);
  const published = await post(project + '/integrations/social/publish', { postId: draft.data.record.id }, { cookie: editor, key: 'review-publish' }); assert.equal(published.status, 200);
  const writes = providerWrites.length;

  for (const cookie of [admin, ownerCookie]) {
    const result = await post(project + '/integrations/social/edit-published', { postId: draft.data.record.id, accountId, content: 'Unreviewed live replacement text', confirmEdit: true }, { cookie, key: `review-edit-${randomUUID()}` });
    assert.ok([403, 409].includes(result.status), `An unreviewed live text change must be refused (got ${result.status}).`);
    assert.ok(['PUBLISHING_APPROVAL_REQUIRED', 'PUBLISHING_APPROVAL_STALE'].includes(result.data.error?.code), JSON.stringify(result.data));
  }
  assert.equal(providerWrites.length, writes, 'No unreviewed edit reaches the provider.');
  assert.equal(remotePosts.get(published.data.post.externalId)?.content, 'Reviewed launch text');
});
