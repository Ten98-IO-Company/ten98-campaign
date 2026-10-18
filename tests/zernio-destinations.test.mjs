import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { transformWithOxc } from 'vite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createApp } from '../server/index.mjs';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'campaign-destinations-')), origin = 'https://destinations.example.test', originalFetch = globalThis.fetch, calls = [];
  const app = createApp({ dataDir: directory, appUrl: origin, env: { ZERNIO_API_KEY: 'synthetic-destinations-key' }, directScheduler: false });
  const accounts = ['pinterest', 'youtube'].map(platform => ({ _id: 'account-' + platform, platform, profileId: 'destination-profile', isActive: true, displayName: platform + ' publishing', platformUserId: 'native-' + platform }));
  const state = { hook: null, sequence: 1, boards: [{ id: 'board-1', name: 'Existing board', description: 'Reviewed description', privacy: 'PUBLIC' }], playlists: [{ id: 'PL-1', title: 'Existing playlist', description: 'Reviewed description', privacy: 'unlisted', itemCount: 3, thumbnailUrl: '' }], defaultPlaylistId: 'PL-1' };
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.hostname, 'zernio.com'); assert.equal(options.headers.Authorization, 'Bearer synthetic-destinations-key'); const method = options.method || 'GET', body = options.body ? JSON.parse(options.body) : undefined; calls.push({ url, method, body, key: options.headers['Idempotency-Key'] });
    if (state.hook) { const response = await state.hook(url, options, body); if (response !== undefined) return response; }
    if (url.pathname.endsWith('/accounts')) return Response.json({ accounts: [...accounts, { _id: 'account-foreign', platform: 'youtube', profileId: 'other-profile', isActive: true, platformUserId: 'native-youtube' }] });
    const youtube = url.pathname.endsWith('/youtube-playlists'), pinterest = url.pathname.endsWith('/pinterest-boards'); assert.ok(youtube || pinterest, url.pathname);
    const field = youtube ? 'playlists' : 'boards';
    if (method === 'GET') return Response.json({ accountId: url.pathname.split('/').at(-2), [field]: state[field], ...(youtube ? { defaultPlaylistId: state.defaultPlaylistId } : {}) });
    assert.ok(options.headers['Idempotency-Key']);
    if (method === 'POST') { const row = { id: youtube ? 'PL-' + (++state.sequence) : 'board-' + (++state.sequence), ...body, ...(youtube ? { itemCount: 0, thumbnailUrl: '' } : {}) }; state[field].push(row); return Response.json({ [youtube ? 'playlist' : 'board']: row }, { status: 201 }); }
    assert.equal(method, 'PUT'); if (youtube) { assert.deepEqual(Object.keys(body).sort(), ['defaultPlaylistId', 'defaultPlaylistName']); const row = state.playlists.find(row => row.id === body.defaultPlaylistId); assert.equal(body.defaultPlaylistName, row.title); state.defaultPlaylistId = row.id; return Response.json({ success: true }); }
    assert.deepEqual(Object.keys(body).sort(), ['defaultBoardId', 'defaultBoardName']); const row = state.boards.find(row => row.id === body.defaultBoardId); assert.equal(body.defaultBoardName, row.name); return Response.json({ message: 'Default Pinterest board updated successfully', account: { ...accounts[0], accessToken: 'never-return' } });
  };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${app.server.address().port}/api`; let cookie;
  async function request(path, body, key = randomUUID(), authenticated = true) { const response = await originalFetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, ...(cookie && authenticated ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': key }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }; }
  const setup = await request('/auth/setup', { name: 'Destination owner', email: 'destinations@example.test', password: 'Synthetic destination fixture passphrase!', sample: false }); cookie = setup.cookie; const project = '/projects/' + setup.data.projectId;
  app.db.prepare('UPDATE projects SET zernio_profile_id=? WHERE id=?').run('destination-profile', setup.data.projectId);
  const route = platform => `${project}/integrations/publishing/accounts/account-${platform}/${platform === 'youtube' ? 'youtube-playlists' : 'pinterest-boards'}`, get = platform => request(route(platform) + '/manage'), write = async (platform, task, settings, extra = {}, key) => request(route(platform) + '/' + task, { expectedVersion: (await get(platform)).data.version, confirmed: true, ...(task === 'create' ? { settings } : { destinationId: settings }), ...extra }, key);
  return { app, accounts, state, calls, project, route, request, get, write, writes: () => calls.filter(row => row.method !== 'GET'), async close() { await app.close(); globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); } };
}

test('all four destination mutations use authenticated native contracts, fresh census/readback and unchanged lookup projections', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request(f.route('youtube') + '/manage', undefined, undefined, false)).status, 401);
    const original = await f.request(f.route('youtube')); assert.equal(original.data.playlists[0].description, undefined); assert.equal(original.data.version, undefined);
    const snapshot = await f.get('youtube'); assert.equal(snapshot.data.playlists[0].description, 'Reviewed description'); assert.equal(snapshot.data.defaultReported, true); assert.match(snapshot.data.version, /^[a-f0-9]{64}$/);
    const pin = await f.write('pinterest', 'create', { name: 'New board', description: 'New board description', privacy: 'SECRET' }); assert.equal(pin.status, 200, JSON.stringify(pin.data)); assert.equal(pin.data.destination.privacy, 'SECRET'); assert.equal(pin.data.created, true);
    const pinDefault = await f.write('pinterest', 'default', pin.data.destination.id); assert.equal(pinDefault.status, 200); assert.equal(pinDefault.data.accepted, true); assert.equal(pinDefault.data.readback, false); assert.equal(pinDefault.data.snapshot.defaultReported, false); assert.equal(JSON.stringify(pinDefault.data).includes('accessToken'), false);
    const before = (await f.get('youtube')).data, settings = { title: 'New empty playlist', description: 'Explicit description', privacy: 'private' }, body = { expectedVersion: before.version, confirmed: true, settings }, key = randomUUID();
    const yt = await f.request(f.route('youtube') + '/create', body, key); assert.equal(yt.status, 200, JSON.stringify(yt.data)); assert.equal(yt.data.destination.itemCount, 0); assert.equal(yt.data.destination.privacy, 'private'); assert.equal(yt.data.snapshot.defaultPlaylistId, 'PL-1');
    await f.request(f.route('youtube') + '/create', body, key); assert.equal(f.writes().length, 3, 'Exact retries replay even after the census changed because creation succeeded.');
    const ytDefault = await f.write('youtube', 'default', yt.data.destination.id); assert.equal(ytDefault.status, 200, JSON.stringify(ytDefault.data)); assert.equal(ytDefault.data.readback, true); assert.equal(ytDefault.data.snapshot.defaultPlaylistId, yt.data.destination.id);
    assert.deepEqual(f.writes().map(row => row.method), ['POST', 'PUT', 'POST', 'PUT']); assert.ok(f.writes().every(row => row.body.expectedVersion === undefined && row.body.confirmed === undefined));
  } finally { await f.close(); }
});

test('destination management rejects foreign, stale, malformed, unsupported clear and nonadministrator changes without dispatch', async () => {
  const f = await fixture();
  try {
    const snapshot = (await f.get('youtube')).data, body = { expectedVersion: snapshot.version, confirmed: true, settings: { title: 'Reviewed playlist', description: '', privacy: 'private' } };
    assert.equal((await f.request(f.route('youtube').replace('account-youtube', 'account-foreign') + '/manage')).status, 403);
    assert.equal((await f.request(f.route('youtube') + '/manage?fields=raw')).status, 400);
    for (const invalid of [{ ...body, confirmed: false }, { ...body, settings: { ...body.settings, privacy: undefined } }, { ...body, settings: { ...body.settings, raw: {} } }]) assert.equal((await f.request(f.route('youtube') + '/create', invalid)).status, 400);
    assert.equal((await f.write('youtube', 'default', '')).status, 400); assert.equal((await f.write('youtube', 'default', 'PL-foreign')).status, 403);
    f.state.playlists[0].title = 'Changed after review'; assert.equal((await f.request(f.route('youtube') + '/create', body)).status, 409);
    f.app.db.prepare("UPDATE memberships SET role='editor'").run(); assert.equal((await f.write('youtube', 'create', body.settings)).status, 403); assert.equal((await f.get('youtube')).status, 200);
    assert.equal(f.writes().length, 0);
  } finally { await f.close(); }
});

test('destination writes refresh connection scope after the census and retain unknown creation/default receipts until reviewed recovery', async () => {
  for (const scenario of ['moved-profile', 'changed-native', 'existing-id', 'privacy-drift', 'foreign-ack', 'default-not-saved', 'default-changed-on-create', 'default-reporting-lost']) {
    const f = await fixture();
    try {
      if (scenario === 'default-reporting-lost') f.state.defaultPlaylistId = null;
      const before = (await f.get('youtube')).data, body = { expectedVersion: before.version, confirmed: true, settings: { title: 'Reviewed playlist', description: '', privacy: 'private' } }; let reads = 0;
      f.state.hook = (url, options, payload) => {
        if (url.pathname.endsWith('/youtube-playlists') && options.method === 'GET' && ++reads === 2) { if (scenario === 'moved-profile') f.accounts[1].profileId = 'other-profile'; if (scenario === 'changed-native') f.accounts[1].platformUserId = 'different-native-channel'; }
        if (url.pathname.endsWith('/youtube-playlists') && options.method === 'POST') {
          if (scenario === 'existing-id') return Response.json({ playlist: { ...f.state.playlists[0], ...payload } }, { status: 201 });
          if (scenario === 'privacy-drift') { const playlist = { id: 'PL-unreviewed', ...payload, privacy: 'public', itemCount: 0, thumbnailUrl: '' }; f.state.playlists.push(playlist); return Response.json({ playlist }, { status: 201 }); }
          if (scenario === 'foreign-ack') return Response.json({ accountId: 'foreign-account', playlist: { id: 'PL-foreign', ...payload, itemCount: 0, thumbnailUrl: '' } }, { status: 201 });
          if (['default-changed-on-create', 'default-reporting-lost'].includes(scenario)) { const playlist = { id: 'PL-created', ...payload, itemCount: 0, thumbnailUrl: '' }; f.state.playlists.push(playlist); if (scenario === 'default-changed-on-create') f.state.defaultPlaylistId = playlist.id; return Response.json({ playlist }, { status: 201 }); }
        }
        if (scenario === 'default-reporting-lost' && options.method === 'GET' && url.pathname.endsWith('/youtube-playlists') && f.state.playlists.some(row => row.id === 'PL-created')) return Response.json({ playlists: f.state.playlists });
        if (scenario === 'default-not-saved' && options.method === 'PUT') return Response.json({ success: true });
      };
      if (scenario === 'default-not-saved') f.state.playlists.push({ ...f.state.playlists[0], id: 'PL-new' });
      const result = scenario === 'default-not-saved' ? await f.write('youtube', 'default', 'PL-new') : await f.request(f.route('youtube') + '/create', body);
      assert.equal(result.status, scenario === 'moved-profile' ? 403 : 409, scenario + ':' + JSON.stringify(result.data)); assert.equal(f.writes().length, ['moved-profile', 'changed-native'].includes(scenario) ? 0 : 1);
      if (!['moved-profile', 'changed-native'].includes(scenario)) { assert.equal(result.data.operation.status, 'uncertain'); f.state.hook = null; const blocked = await f.write('youtube', 'create', { title: 'Different new request', description: '', privacy: 'private' }); assert.equal(blocked.status, 409); assert.equal(blocked.data.error.code, 'DESTINATION_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(blocked.data.operation.status, 'failed'); assert.equal(f.writes().length, 1); }
      if (scenario === 'existing-id') {
        const other = await f.request('/workspaces', { name: 'Other publishing project' }); assert.equal(other.status, 201); f.app.db.prepare('UPDATE projects SET zernio_profile_id=? WHERE id=?').run('destination-profile-2', other.data.projectId); f.accounts.push({ _id: 'account-youtube-shared', platform: 'youtube', profileId: 'destination-profile-2', isActive: true, platformUserId: 'native-youtube' });
        const otherRoute = `/projects/${other.data.projectId}/integrations/publishing/accounts/account-youtube-shared/youtube-playlists`, snapshot = (await f.request(otherRoute + '/manage')).data;
        const sharedBlocked = await f.request(otherRoute + '/create', { expectedVersion: snapshot.version, confirmed: true, settings: body.settings }); assert.equal(sharedBlocked.status, 409); assert.equal(sharedBlocked.data.error.code, 'DESTINATION_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(f.writes().length, 1);
        const reviewed = await f.request(`${f.project}/operations/${result.data.operation.id}/review`, { resolution: 'not_applied', confirmChecked: true, note: 'Synthetic existing-ID acknowledgement created no new playlist.', reference: 'synthetic-existing-playlist-only' }); assert.equal(reviewed.status, 200);
        assert.equal((await f.write('youtube', 'create', { title: 'After reviewed recovery', description: '', privacy: 'private' })).status, 200); assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM zernio_destination_mutations').get().n, 0);
      }
    } finally { await f.close(); }
  }
});

test('provider-wide destination fencing blocks missing-native-ID aliases in the same and other projects until reviewed recovery', async () => {
  const f = await fixture();
  try {
    delete f.accounts[1].platformUserId;
    f.accounts.push({ _id: 'account-youtube-alias', platform: 'youtube', profileId: 'destination-profile', isActive: true });
    const settings = { title: 'Unknown playlist creation', description: '', privacy: 'private' }, before = (await f.get('youtube')).data, key = randomUUID();
    assert.equal(before.nativeAccountId, null);
    f.state.hook = (url, options) => { if (url.pathname.endsWith('/youtube-playlists') && options.method === 'POST') throw new Error('Synthetic transport loss before the fixture persisted a playlist.'); };
    const unknown = await f.request(f.route('youtube') + '/create', { expectedVersion: before.version, confirmed: true, settings }, key); assert.equal(unknown.status, 409); assert.equal(unknown.data.operation.status, 'uncertain');
    const sameProject = f.route('youtube').replace('account-youtube/', 'account-youtube-alias/'), alias = (await f.request(sameProject + '/manage')).data;
    const blockedAlias = await f.request(sameProject + '/create', { expectedVersion: alias.version, confirmed: true, settings }); assert.equal(blockedAlias.status, 409); assert.equal(blockedAlias.data.error.code, 'DESTINATION_PREVIOUS_OUTCOME_UNRESOLVED');
    const other = await f.request('/workspaces', { name: 'Unknown native identity project' }); assert.equal(other.status, 201); f.app.db.prepare('UPDATE projects SET zernio_profile_id=? WHERE id=?').run('missing-native-profile', other.data.projectId); f.accounts.push({ _id: 'account-youtube-other-alias', platform: 'youtube', profileId: 'missing-native-profile', isActive: true });
    const otherRoute = `/projects/${other.data.projectId}/integrations/publishing/accounts/account-youtube-other-alias/youtube-playlists`, otherSnapshot = (await f.request(otherRoute + '/manage')).data;
    const blockedOther = await f.request(otherRoute + '/create', { expectedVersion: otherSnapshot.version, confirmed: true, settings }, key); assert.equal(blockedOther.status, 409); assert.equal(blockedOther.data.error.code, 'DESTINATION_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(blockedOther.data.operation.status, 'failed'); assert.equal(f.writes().length, 1);
    assert.equal(f.app.db.prepare('SELECT resource FROM zernio_destination_mutations').get().resource, 'youtube');
    assert.equal((await f.write('pinterest', 'create', { name: 'Independent provider board', description: '', privacy: 'PUBLIC' })).status, 200, 'YouTube reconciliation does not block Pinterest writes.');
    const reviewed = await f.request(`${f.project}/operations/${unknown.data.operation.id}/review`, { resolution: 'not_applied', confirmChecked: true, note: 'The synthetic fixture failed before persisting any playlist.', reference: 'synthetic-no-playlist' }); assert.equal(reviewed.status, 200);
    f.state.hook = null; assert.equal((await f.request(otherRoute + '/create', { expectedVersion: otherSnapshot.version, confirmed: true, settings })).status, 200); assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM zernio_destination_mutations').get().n, 0);
  } finally { await f.close(); }
});

const source = await readFile(new URL('../src/ZernioDestinations.tsx', import.meta.url), 'utf8');
const compile = (code, context) => new Function(...Object.keys(context), `return (${stripTypeScriptTypes(code)});`)(...Object.values(context));
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

test('destination UI freezes reviewed settings, rejects stale scope/version and preserves exact uncertain retry keys', async () => {
  const prepareSource = section('function prepare(', '  async function write('), saveSource = section('async function save(', '  return <section'), writeSource = section('async function write(', '  async function save('), calls = [], view = {};
  let intent, reviewed; const snapshot = { version: 'old-reviewed' };
  const prepare = compile(prepareSource, { canManage: true, snapshot, busy: false, uncertain: false, current: () => true, youtube: true, name: 'Reviewed title', description: '', privacy: 'private', rows: [], defaultId: '', setIntent: value => { intent = value; }, setReviewed: value => { reviewed = value; }, setError() {}, setNotice() {} });
  prepare({ preventDefault() {} }, 'create'); const first = intent; reviewed = first;
  const makeSave = extra => compile(saveSource, { canManage: true, intent, reviewed, snapshot, current: () => true, action: run => run(), write: async value => { calls.push(value); return { snapshot: {}, destination: { id: 'PL' } }; }, setUncertain() {}, setSnapshot() {}, setIntent() {}, setReviewed() {}, setDefaultId() {}, setNotice() {}, youtube: true, ...extra });
  prepare({ preventDefault() {} }, 'create'); await makeSave({ reviewed: first })(); assert.equal(calls.length, 0);
  reviewed = intent; await makeSave({ snapshot: { version: 'changed-unseen' } })(); await makeSave({ current: () => false })(); assert.equal(calls.length, 0); await makeSave({})(); assert.equal(calls.length, 1); assert.equal(calls[0].body.settings.title, 'Reviewed title');
  const keys = { current: new Map() }, requests = []; let unknown = true;
  const write = compile(writeSource, { target: '/publishing/accounts/yt/youtube-playlists', keys, crypto, requester: { current: async (...args) => { requests.push(args); if (unknown) throw Object.assign(new Error('Unknown receipt'), { status: 409, code: 'OPERATION_UNCERTAIN' }); return { operation: { status: 'complete' }, created: true, destination: { id: 'PL' }, snapshot: { accountId: 'yt', version: 'new' } }; } }, accountId: 'yt' });
  await assert.rejects(write(intent), /Unknown/); assert.equal(keys.current.size, 1); unknown = false; await write(intent); assert.deepEqual(requests[0], requests[1]); assert.equal(keys.current.size, 0);
});

test('destination reads ignore late responses and rendered controls expose explicit privacy, quota and unsupported-clear behavior without native dialogs', async () => {
  const loadSource = section('async function load(', '  function clearReview('); let finish, live = true; const accepted = [], reads = { current: 0 };
  const context = { current: () => live, accountId: 'yt', account: { platform: 'youtube' }, reads, setSnapshot: value => { if (value) accepted.push(value); }, setIntent() {}, setReviewed() {}, setUncertain() {}, setDefaultId() {}, requester: { current: () => new Promise(resolve => { finish = resolve; }) }, target: '/publishing/yt', youtube: true };
  const pending = compile(loadSource, context)(); live = false; finish({ accountId: 'yt', platform: 'youtube', version: 'late', playlists: [] }); await pending; assert.deepEqual(accepted, []);
  const start = source.indexOf('  return <section className="panel settings-panel">'), end = source.lastIndexOf('\n}'), { code } = await transformWithOxc(`const render = () => (${source.slice(start + '  return '.length, end).trim().replace(/;$/, '')});`, 'Destinations.tsx', { jsx: { runtime: 'classic' } });
  const intent = { summary: ['Create empty playlist with private visibility.'] }, renderContext = { React, accountId: 'yt', busy: false, action() {}, load() {}, error: '', notice: '', accounts: [{ _id: 'yt', platform: 'youtube' }], setAccountId() {}, snapshot: { accountName: 'Synthetic YouTube', defaultReported: true, defaultPlaylistId: 'PL' }, youtube: true, rows: [{ id: 'PL', title: 'Reviewed list', privacy: 'private', description: '', itemCount: 0 }], canManage: true, uncertain: false, prepare() {}, clearReview() {}, defaultId: '', setDefaultId() {}, name: 'New playlist', setName() {}, description: '', setDescription() {}, privacy: 'private', setPrivacy() {}, intent, reviewed: null, setReviewed() {}, save() {} };
  const html = renderToStaticMarkup(new Function(...Object.keys(renderContext), code + '; return render;')(...Object.values(renderContext))()); assert.match(html, /50 YouTube quota units/); assert.match(html, /not idempotent/); assert.match(html, /clearing the saved default is unavailable/); assert.match(html, /<option value="private" selected="">private/); assert.doesNotMatch(source, /window\.confirm/);
});
