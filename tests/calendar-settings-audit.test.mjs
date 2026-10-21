import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { openDatabase, createStore } from '../server/database.ts';
import { handleCalendar } from '../server/calendar.ts';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });

test('Calendar listing accepts a genuine empty collection and honors browser-local instant boundaries', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ten98-calendar-window-')), db = openDatabase(directory), store = createStore(db), originalFetch = globalThis.fetch;
  db.prepare('INSERT INTO workspaces VALUES(?,?)').run('workspace', 'Calendar audit');
  db.prepare('INSERT INTO projects(id,workspace_id,name) VALUES(?,?,?)').run('project', 'workspace', 'Calendar audit');
  const calls = [], events = [{ id: 'lateoctober', summary: 'October 31 late in New York', start: { dateTime: '2026-11-01T03:30:00Z' }, end: { dateTime: '2026-11-01T03:45:00Z' } }, { id: 'septemberlate', summary: 'September 30 late in New York', start: { dateTime: '2026-10-01T03:30:00Z' }, end: { dateTime: '2026-10-01T03:45:00Z' } }];
  let empty = false;
  globalThis.fetch = async (target, options) => {
    const url = new URL(target);
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'calendar-window-token' });
    assert.equal(url.hostname, 'www.googleapis.com'); assert.equal(options.method, 'GET'); calls.push(url);
    return Response.json(empty ? { kind: 'calendar#events', etag: 'empty-calendar' } : { kind: 'calendar#events', items: events.filter(event => Date.parse(event.end.dateTime) > Date.parse(url.searchParams.get('timeMin')) && Date.parse(event.start.dateTime) < Date.parse(url.searchParams.get('timeMax'))) });
  };
  async function invoke(suffix, method = 'GET', body = {}) {
    let response;
    await handleCalendar({ req: { method, headers: {} }, url: new URL(`http://localhost/api/projects/project/calendar/${suffix}`), project: { id: 'project' }, user: { isOperator: true }, role: 'owner', db, store, body, config: { env: { GOOGLE_SERVICE_ACCOUNT_EMAIL: 'calendar@example.test', GOOGLE_PRIVATE_KEY: privateKey } }, send(status, data) { response = { status, data }; } });
    return response;
  }
  try {
    assert.equal((await invoke('connection', 'POST', { calendarId: 'shared@example.test' })).status, 200);
    const query = new URLSearchParams({ fromDate: '2026-10-01', toDate: '2026-10-31', timeMin: '2026-10-01T04:00:00.000Z', timeMax: '2026-11-01T04:00:00.000Z' });
    const local = await invoke('events?' + query);
    assert.equal(local.status, 200); assert.deepEqual(local.data.events.map(event => event.id), ['lateoctober'], 'The October view must include October 31 at 23:30 in the browser timezone.');
    const utc = await invoke('events?fromDate=2026-10-01&toDate=2026-10-31');
    assert.equal(utc.status, 200); assert.deepEqual(utc.data.events.map(event => event.id), ['septemberlate'], 'Existing date-only API clients retain UTC date bounds.');
    for (const bounds of [{ timeMin: 'bad', timeMax: '2026-11-01T04:00:00Z' }, { timeMin: '2026-10-01T04:00:00Z' }, { timeMin: '2026-10-01T04:00:00Z', timeMax: '2026-10-01T04:00:00Z' }, { timeMin: '2026-10-01T04:00:00Z', timeMax: '2028-11-01T04:00:00Z' }, { timeMin: '2026-10-01T24:00:00Z', timeMax: '2026-10-03T04:00:00Z' }, { fromDate: '1900-01-01' }, { toDate: '9998-01-01' }]) {
      const before = calls.length, invalid = await invoke('events?' + new URLSearchParams(bounds));
      assert.equal(invalid.status, 400); assert.equal(calls.length, before, 'Invalid bounds must not reach Google event reads.');
    }
    empty = true;
    const cleared = await invoke('events?fromDate=2026-10-01&toDate=2026-10-31');
    assert.equal(cleared.status, 200); assert.deepEqual(cleared.data.events, []); assert.equal(cleared.data.complete, true);
  } finally { globalThis.fetch = originalFetch; db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Calendar UI sends local month boundaries across daylight saving', async () => {
  const source = await readFile(new URL('../src/GoogleCalendar.tsx', import.meta.url), 'utf8');
  const loadSource = stripTypeScriptTypes(source.slice(source.indexOf('async function load()'), source.indexOf('  async function save(')));
  const previousTZ = process.env.TZ; process.env.TZ = 'America/New_York';
  try {
    const requests = [], load = new Function('request', 'path', 'from', 'to', 'active', 'scope', 'view', 'updateEvents', 'setLoaded', `return (${loadSource});`)(async path => { requests.push(path); return { events: [] }; }, '/calendar', '2026-11-01', '2026-11-30', { current: true }, { current: 'november' }, 'november', () => {}, () => {});
    await load(); const query = new URL('http://localhost' + requests[0]).searchParams;
    assert.equal(query.get('timeMin'), '2026-11-01T04:00:00.000Z'); assert.equal(query.get('timeMax'), '2026-12-01T05:00:00.000Z', 'Month endpoints use their own UTC offsets across DST.');
  } finally { if (previousTZ === undefined) delete process.env.TZ; else process.env.TZ = previousTZ; }
});

test('Calendar sync uses current server plan identity, retains uncertain keys and ignores closed views', async () => {
  const source = await readFile(new URL('../src/GoogleCalendar.tsx', import.meta.url), 'utf8');
  const writeHandler = stripTypeScriptTypes(source.slice(source.indexOf('async function write('), source.indexOf('  async function load('))), reviewHandler = stripTypeScriptTypes(source.slice(source.indexOf('async function reviewPlan('), source.indexOf('  async function syncPlan('))), syncHandler = stripTypeScriptTypes(source.slice(source.indexOf('async function syncPlan('), source.indexOf('  async function removeEvent(')));
  function setup(request, active = { current: true }, scope = { current: 'view' }) {
    const keys = { current: new Map() }, notices = [], loads = [], context = { request, path: '/calendar', active, scope, view: 'view', keys };
    const write = new Function(...Object.keys(context), `return (${writeHandler});`)(...Object.values(context));
    let review = null;
    const dependencies = { ...context, write, action: run => run(), projectId: 'project', status: { calendarId: 'shared@example.test' }, canWrite: true, setReview: value => { review = value; }, setNotice: value => notices.push(value), load: async () => { loads.push(true); } };
    return { keys, notices, loads, preview: new Function(...Object.keys(dependencies), `return (${reviewHandler});`)(...Object.values(dependencies)), sync: () => { const current = { ...dependencies, review }; return new Function(...Object.keys(current), `return (${syncHandler});`)(...Object.values(current))(); } };
  }
  let fingerprint = 'a'.repeat(64), uncertain = true; const writes = [];
  const ui = setup(async (path, method, body, key) => {
    if (path.endsWith('/plan')) return { fingerprint, projectId: 'project', calendarId: 'shared@example.test', upserts: [], deletions: [] };
    assert.equal(method, 'POST'); writes.push({ body, key });
    if (uncertain) throw Object.assign(new Error('Needs provider review'), { status: 409, code: 'OPERATION_UNCERTAIN' });
    return { created: 0, updated: 1 };
  });
  await ui.preview(); assert.equal(writes.length, 0, 'Reviewing a plan must not publish it.'); await assert.rejects(ui.sync(), /Needs provider review/); await assert.rejects(ui.sync(), /Needs provider review/);
  assert.equal(writes[0].key, writes[1].key); assert.equal(ui.keys.current.size, 1);
  fingerprint = 'b'.repeat(64); uncertain = false; await ui.preview(); await ui.sync();
  assert.notEqual(writes[2].key, writes[0].key); assert.deepEqual(writes[2].body, { planFingerprint: fingerprint }); assert.equal(ui.notices.length, 1); assert.equal(ui.loads.length, 1);
  for (const plan of [{}, { fingerprint: null }, { fingerprint: 7 }, { fingerprint: 'a'.repeat(63) }, { fingerprint: 'z'.repeat(64) }]) {
    const malformedWrites = [], malformed = setup(async path => { if (path.endsWith('/plan')) return plan; malformedWrites.push(path); return { created: 0, updated: 0 }; });
    await assert.rejects(malformed.preview(), /plan preview could not be read/); await malformed.sync();
    assert.deepEqual(malformedWrites, []); assert.equal(malformed.keys.current.size, 0); assert.deepEqual(malformed.notices, []); assert.deepEqual(malformed.loads, []);
  }
  for (const during of ['plan', 'write']) {
    const active = { current: true }, closedWrites = [], closed = setup(async (path) => {
      if (path.endsWith('/plan')) { if (during === 'plan') active.current = false; return { fingerprint, projectId: 'project', calendarId: 'shared@example.test', upserts: [], deletions: [] }; }
      closedWrites.push(path); active.current = false; return { created: 1, updated: 0 };
    }, active);
    await closed.preview(); await closed.sync().catch(error => { assert.equal(error.name, 'AbortError'); });
    assert.equal(closedWrites.length, during === 'plan' ? 0 : 1); assert.equal(closed.notices.length, 0); assert.equal(closed.loads.length, 0);
  }
});

test('the shared Google credential editor preserves Google and unrelated provider drafts', async () => {
  const source = await readFile(new URL('../src/IntegrationSettings.tsx', import.meta.url), 'utf8');
  const changeSource = stripTypeScriptTypes(source.slice(source.indexOf('function change('), source.indexOf('  function dirty(')));
  const saveSource = stripTypeScriptTypes(source.slice(source.indexOf('async function save('), source.indexOf('  async function reset(')));
  let drafts = {}; const requests = [];
  const setDrafts = update => { drafts = update(drafts); }, change = new Function('setDrafts', `return (${changeSource});`)(setDrafts);
  change('openrouter', 'model', 'other/unsaved-model');
  change('googleDrive', 'privateKey', 'new-unsaved-private-key');
  change('googleDrive', 'serviceAccountEmail', 'replacement-service@example.test');
  assert.deepEqual(drafts.googleDrive, { privateKey: 'new-unsaved-private-key', serviceAccountEmail: 'replacement-service@example.test' });
  assert.deepEqual(drafts.googleCalendar, drafts.googleDrive, 'Both connection tests must reflect pending edits to the shared service account.');
  const dependencies = { action: (_provider, run) => run(), drafts, request: async (...args) => { requests.push(args); }, refresh: async () => {}, active: { current: true }, setDrafts, setResults() {}, mapsTested: { current: false }, cancelMapProbe: { current: null }, setMapsReload() {}, setNotice() {}, onChanged: undefined };
  const save = new Function(...Object.keys(dependencies), `return (${saveSource});`)(...Object.values(dependencies));
  await save({ id: 'googleDrive', label: 'Google Drive', secretFields: { privateKey: {} } }, { preventDefault() {} });
  assert.deepEqual(requests, [['/settings/integrations/googleDrive', 'PUT', { fields: { privateKey: 'new-unsaved-private-key', serviceAccountEmail: 'replacement-service@example.test' } }]]);
  assert.deepEqual(drafts.googleDrive, {}); assert.deepEqual(drafts.googleCalendar, {});
  assert.deepEqual(drafts.openrouter, { model: 'other/unsaved-model' }, 'Saving shared Google credentials must preserve unrelated drafts.');
});
