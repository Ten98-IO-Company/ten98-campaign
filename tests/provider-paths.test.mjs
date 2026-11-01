import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createStore } from '../server/database.ts';
import { handleCalendar } from '../server/calendar.ts';
import { getSmsStatus } from '../server/direct-providers.ts';
import { assertProviderPath, pathSegment, providerRequest, zernioClient } from '../server/provider-core.ts';
import { postgresSkip, testDatabase } from './postgres.mjs';
import { addWorkspaces } from './fixtures/accounts.ts';

// ten98-campaign#33: an ID placed in a provider path must reach the intended endpoint as one segment, or be refused
// before anything is sent. The allowed provider hosts carry Campaign's credentials, so a traversal ID that reaches a
// different endpoint is a request forgery even though the host never changes.
const traversals = ['../x', '..%2Fx', 'a%2Fb', 'a?b', '..', '.', '%2e%2e', 'a#b', 'a\\b'];
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });

// Records provider requests; `respond` answers the ones a test expects.
function stubFetch(t, respond) {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (target, options = {}) => { const url = new URL(target); calls.push(url); return respond(url, options); };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}
// The request either never left, or it went to `prefix` + one segment that decodes back to `id` + `suffix`.
function assertContained(calls, before, prefix, id, suffix = '') {
  const sent = calls.slice(before);
  if (!sent.length) return;
  for (const url of sent) {
    assert.ok(url.pathname.startsWith(prefix) && url.pathname.endsWith(suffix), `${JSON.stringify(id)} reached ${url.pathname}`);
    const segment = url.pathname.slice(prefix.length, url.pathname.length - suffix.length);
    assert.ok(!segment.includes('/') && decodeURIComponent(segment) === id, `${JSON.stringify(id)} was sent as ${segment}`);
  }
}

test('the provider path guard refuses dot segments, backslashes and fragments, and keeps encoded IDs in one segment', () => {
  for (const path of ['/posts/../accounts', '/posts/%2e%2e/accounts', '/posts/..%2Faccounts', '/posts/.', '/posts/a\\b', '/posts/a%5Cb', '/posts/a#b', '/posts/a?b', '/posts/a?b=1']) assert.throws(() => assertProviderPath(path, false), error => error.code === 'INVALID_PROVIDER_PATH', path);
  for (const url of ['https://www.googleapis.com/calendar/v3/calendars/../events', 'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/%2e%2e/x.json', 'https://www.googleapis.com/drive/v3/files/a#b']) assert.throws(() => assertProviderPath(url), error => error.code === 'INVALID_PROVIDER_PATH', url);
  // An encoded slash stays allowed inside one segment: Shopify collection GIDs and opaque Zernio IDs are sent that way.
  for (const path of ['/posts/abc123', `/commerce/collections/${encodeURIComponent('gid://shopify/Collection/7001')}`, '/posts/a%20b', '/posts/a%41%FF']) assert.doesNotThrow(() => assertProviderPath(path, false), path);
  assert.doesNotThrow(() => assertProviderPath('https://www.googleapis.com/calendar/v3/calendars/a%40b.test/events?maxResults=1&q=../x'));
  assert.doesNotThrow(() => assertProviderPath('https://www.googleapis.com/drive/v3/files?q=name contains a b'), 'Inner spaces in a query stay allowed.');
  // The path is checked as the URL parser and the provider read it: whitespace or control characters, any escape
  // elsewhere in a segment, a backslash after the host, ';' parameters and doubly encoded escapes cannot hide a dot segment.
  for (const path of ['/posts/.\t./accounts', '/posts/.\n./accounts', '/posts/%2\re%2\re/accounts', '/posts/.. ', ' /posts/x', '/posts/x\u0000', '/posts/..%2F..%2Faccounts%FF', '/posts/..%2Faccounts%', '/posts/..%5Caccounts%FF', '/posts/..;/accounts', '/posts/%252e%252e/accounts', `/inbox/conversations/${encodeURIComponent('a%2Fb')}`]) assert.throws(() => assertProviderPath(path, false), error => error.code === 'INVALID_PROVIDER_PATH', JSON.stringify(path));
  for (const url of ['https://api.twilio.com\\2010-04-01\\Accounts\\..\\x', 'https://api.twilio.com\\..\\x', 'https://www.googleapis.com/calendar/v3/calendars/.\t./events ']) assert.throws(() => assertProviderPath(url), error => error.code === 'INVALID_PROVIDER_PATH', JSON.stringify(url));
  for (const value of ['', '.', '..']) assert.throws(() => pathSegment(value), error => error.code === 'INVALID_PROVIDER_PATH', value);
  assert.equal(pathSegment('a/b?c'), 'a%2Fb%3Fc');
});

test('Zernio routes send a traversal ID as one encoded segment or not at all', async t => {
  const calls = stubFetch(t, () => Response.json({ conversation: { id: 'ok' } })), api = zernioClient('sk_test_stub');
  for (const id of traversals) {
    const before = calls.length;
    // The inbox conversation route encodes its route segment; an unencoded template is refused by the client's guard.
    await api(`/inbox/conversations/${encodeURIComponent(id)}`, { accountId: 'acc' }).catch(error => assert.equal(error.code, 'INVALID_PROVIDER_PATH', id));
    assertContained(calls, before, '/api/v1/inbox/conversations/', id);
    // A caller that forgot to encode is refused for anything that would leave the segment, or sends that one segment.
    const raw = calls.length;
    await api(`/inbox/conversations/${id}`).catch(error => assert.equal(error.code, 'INVALID_PROVIDER_PATH', id));
    for (const url of calls.slice(raw)) assert.equal(url.pathname, `/api/v1/inbox/conversations/${id}`, `unencoded ${JSON.stringify(id)} left its segment`);
  }
  assert.ok(calls.length > 0, 'Safe IDs still reach Zernio, so the refusals above are not vacuous.');
});

test('Google Calendar reads keep a traversal calendar ID inside the calendar path, including a legacy mapping', { skip: postgresSkip }, async t => {
  const { db, sql } = await testDatabase(t), store = createStore(db);
  await addWorkspaces(sql, [{ id: 'workspace', name: 'Paths' }]);
  await sql.run('INSERT INTO projects (id,workspace_id,name) VALUES (?,?,?)', 'project', 'workspace', 'Paths');
  const calls = stubFetch(t, url => url.hostname === 'oauth2.googleapis.com' ? Response.json({ access_token: 'path-token' }) : Response.json({ kind: 'calendar#events', items: [] }));
  const invoke = async (suffix, method = 'GET', body = {}) => {
    let response;
    await handleCalendar({ req: { method, headers: {} }, url: new URL(`http://localhost/api/projects/project/calendar/${suffix}`), project: { id: 'project' }, user: { isOperator: true }, role: 'owner', db, store, body, config: { env: { GOOGLE_SERVICE_ACCOUNT_EMAIL: 'calendar@example.test', GOOGLE_PRIVATE_KEY: privateKey } }, send(status, data) { response = { status, data }; } });
    return response;
  };
  const events = (url) => url.hostname === 'www.googleapis.com';
  for (const id of traversals) {
    const before = calls.filter(events).length, mapped = await invoke('connection', 'POST', { calendarId: id });
    if (mapped.status === 200) await invoke('events?fromDate=2026-10-01&toDate=2026-10-31');
    assertContained(calls.filter(events), before, '/calendar/v3/calendars/', id, '/events');
  }
  // A calendar ID mapped before the mapping rule refused '..'; only the request guard stands between it and /calendar/v3/events.
  await sql.run('DELETE FROM calendar_connections WHERE project_id = ?', 'project');
  await sql.run('INSERT INTO calendar_connections (project_id, calendar_id) VALUES (?, ?)', 'project', '..');
  const before = calls.filter(events).length, read = await invoke('events?fromDate=2026-10-01&toDate=2026-10-31');
  assert.equal(calls.filter(events).length, before, 'A ".." calendar ID must not reach Google.');
  assert.ok(read.status >= 400, JSON.stringify(read));
});

test('Twilio status reads refuse a traversal message ID before sending', async t => {
  const calls = stubFetch(t, () => Response.json({}));
  const env = { TWILIO_ACCOUNT_SID: 'AC' + '1'.repeat(32), TWILIO_AUTH_TOKEN: 'test-twilio-secret' };
  for (const id of [...traversals, 'SM' + '1'.repeat(30) + '/..', 'SM' + '1'.repeat(32) + '%2F..']) {
    await assert.rejects(getSmsStatus({ env, providerId: id }), error => error.status === 400, id);
  }
  assert.equal(calls.length, 0);
});

test('provider requests are sent to a fixed origin for an allowed host, and nothing else is sent', async t => {
  const origins = ['https://zernio.com', 'https://www.googleapis.com', 'https://oauth2.googleapis.com', 'https://googleads.googleapis.com', 'https://login.microsoftonline.com', 'https://clientcenter.api.bingads.microsoft.com', 'https://campaign.api.bingads.microsoft.com', 'https://reporting.api.bingads.microsoft.com', 'https://api.twilio.com', 'https://api.cloudflare.com'];
  const sent = [], original = globalThis.fetch;
  globalThis.fetch = async (target, options) => { sent.push({ target, options }); return Response.json({ ok: true }); };
  t.after(() => { globalThis.fetch = original; });
  for (const origin of origins) {
    await providerRequest(`${origin}/v1/resource?x=1`);
    const { target, options } = sent.at(-1);
    assert.equal(typeof target, 'string'); assert.equal(new URL(target).origin, origin); assert.equal(new URL(target).pathname + new URL(target).search, '/v1/resource?x=1'); assert.equal(options.redirect, 'error');
  }
  const count = sent.length;
  for (const url of ['https://zernio.com.attacker.example/x', 'https://attacker.example/x', 'http://zernio.com/x', 'https://zernio.com:8443/x', 'https://user:pass@zernio.com/x', 'https://ZERNIO.com.evil/x']) {
    await assert.rejects(providerRequest(url), error => error.code === 'INVALID_PROVIDER', url);
  }
  assert.equal(sent.length, count, 'A refused endpoint sends nothing.');
});
