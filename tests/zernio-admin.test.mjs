import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import { handleZernioAdmin } from '../server/zernio-admin.mjs';
import { IntegrationError } from '../server/integrations.mjs';

const profileId = 'profile-a';
function setup() {
  const db = new DatabaseSync(':memory:'), calls = [], state = {
    accounts: [{ _id: 'account-a', platform: 'instagram', profileId, displayName: 'Campaign account', isActive: true }, { _id: 'account-b', platform: 'facebook', profileId }, { _id: 'outside', platform: 'instagram', profileId: 'other-profile' }],
    profile: { _id: profileId, name: 'Campaign profile', description: null, color: '#112233', timezone: null, secret: 'never-return' },
    groups: [{ _id: 'group-a', name: 'Campaign group', accountIds: ['account-a'] }, { _id: 'mixed', name: 'Private mixed group', accountIds: ['account-a', 'outside'] }, { _id: 'empty', name: 'Private empty group', accountIds: [] }, { _id: 'foreign', name: 'Private foreign group', accountIds: ['outside'] }],
    malformed: false, readFail: false, retainDeleted: false, hold: null, written: false,
  };
  const api = async (path, query = {}, body, key, method = body === undefined ? 'GET' : 'POST') => {
    calls.push({ path, query, body, key, method });
    if (method === 'GET') {
      if (state.readFail && state.written) throw new IntegrationError(502, 'PROVIDER_UNAVAILABLE', 'Readback unavailable');
      if (path === '/accounts') { assert.deepEqual(query, { profileId }); return { accounts: structuredClone(state.accounts) }; }
      if (path === '/account-groups') { assert.deepEqual(query, {}); return { groups: structuredClone(state.groups) }; }
      assert.equal(path, '/profiles/profile-a'); return { profile: structuredClone(state.profile) };
    }
    state.written = true; state.onWrite?.(); if (state.hold) await state.hold;
    if (path === '/profiles/profile-a') { assert.equal(method, 'PUT'); Object.assign(state.profile, body); return state.malformed ? {} : { profile: structuredClone(state.profile) }; }
    if (path === '/account-groups') { assert.equal(method, 'POST'); const row = { _id: 'created-' + state.groups.length, ...body }; state.groups.push(row); return state.malformed ? {} : { group: structuredClone(row) }; }
    const row = state.groups.find(row => path === `/account-groups/${row._id}`); assert.ok(row);
    if (method === 'PUT') { Object.assign(row, body); return state.malformed ? {} : { group: structuredClone(row) }; }
    assert.equal(method, 'DELETE'); if (!state.retainDeleted) state.groups.splice(state.groups.indexOf(row), 1); else row.accountIds = ['outside'];
    return state.malformed ? {} : { message: 'Group deleted' };
  };
  let count = 0;
  async function request(action, { body, role = 'owner', key = `admin-key-${++count}` } = {}) {
    let response;
    const context = { db, project: { id: 'project-a', zernioProfileId: profileId }, role, req: { method: body === undefined ? 'GET' : 'POST', headers: { 'idempotency-key': key } }, url: new URL(`http://localhost/api/projects/project-a/integrations/admin/${action}`), body: body || {}, send(status, data) { response = { status, data }; } };
    try { const handled = await handleZernioAdmin(context, api, profileId, action); return response || { handled }; }
    catch (error) { if (!(error instanceof IntegrationError)) throw error; return { status: error.status, data: { error: { code: error.code, message: error.message } } }; }
  }
  return { db, state, calls, request };
}
const snapshot = group => ({ name: group.name, accountIds: [...group.accountIds] });

test('administration reads only the mapped profile and complete project-owned groups, with no foreign names or secrets', async () => {
  const { db, state, calls, request } = setup();
  try {
    const result = await request('overview', { role: 'viewer' }); assert.equal(result.status, 200); assert.equal(result.data.profile._id, profileId); assert.deepEqual(result.data.groups.map(row => row._id), ['group-a']); assert.equal(result.data.accounts.length, 2);
    assert.equal(JSON.stringify(result).includes('Private'), false); assert.equal(JSON.stringify(result).includes('never-return'), false); assert.equal(calls.some(row => row.path === '/profiles'), false);
    state.profile._id = 'foreign-profile'; assert.equal((await request('overview')).status, 502); state.profile._id = profileId;
    state.groups[0].accountIds = ['account-a', 'account-a']; assert.equal((await request('overview')).status, 502);
  } finally { db.close(); }
});

test('group creation, rename, membership update and deletion are scoped, confirmed and idempotent', async () => {
  const { db, state, calls, request } = setup();
  try {
    const body = { name: ' Launch group ', accountIds: ['account-a', 'account-b'] }, key = 'create-launch-group';
    let result = await request('groups/create', { body, key }); assert.equal(result.status, 200); const created = result.data.group; assert.equal(created.name, 'Launch group'); assert.deepEqual(created.accountIds, body.accountIds);
    assert.deepEqual((await request('groups/create', { body, key })).data, result.data); assert.equal(calls.filter(row => row.method === 'POST').length, 1); assert.equal(calls.find(row => row.method === 'POST').body.profileId, undefined);
    result = await request(`groups/${created._id}/update`, { body: { name: 'Edited group', accountIds: ['account-b'], expectedGroup: snapshot(created) } }); assert.equal(result.status, 200); assert.equal(result.data.group.name, 'Edited group');
    result = await request(`groups/${created._id}/delete`, { body: { confirmGroupId: created._id, expectedGroup: snapshot(result.data.group) } }); assert.equal(result.status, 200); assert.equal(result.data.deleted, true); assert.equal(state.groups.some(row => row._id === created._id), false); assert.equal(state.accounts.length, 3);
  } finally { db.close(); }
});

test('roles, foreign or empty memberships, missing confirmations and stale group snapshots fail before a write', async () => {
  const { db, state, calls, request } = setup();
  try {
    for (const role of ['viewer', 'editor']) {
      assert.equal((await request('groups/create', { body: { name: 'Group', accountIds: ['account-a'] }, role })).status, 403);
      assert.equal((await request('profile/update', { body: { name: 'Changed', expectedProfile: state.profile }, role })).status, 403);
    }
    assert.equal(calls.length, 0);
    for (const accountIds of [[], ['outside'], ['account-a', 'outside'], ['account-a', 'account-a']]) assert.ok([400, 403].includes((await request('groups/create', { body: { name: 'Bad group', accountIds } })).status));
    for (const id of ['mixed', 'empty', 'foreign', 'missing']) assert.equal((await request(`groups/${id}/update`, { body: { name: 'Wrong', accountIds: ['account-a'], expectedGroup: { name: 'Private', accountIds: ['account-a'] } } })).status, 403);
    assert.equal((await request('groups/group-a/delete', { body: { expectedGroup: snapshot(state.groups[0]) } })).status, 400);
    assert.equal((await request('groups/group-a/update', { body: { name: 'New name', accountIds: ['account-b'], expectedGroup: { name: 'Stale', accountIds: ['account-a'] } } })).status, 409);
    assert.equal((await request('groups/%invalid/delete', { body: { confirmGroupId: '%invalid', expectedGroup: {} } })).status, 400);
    assert.equal(calls.some(row => row.method !== 'GET'), false);
  } finally { db.close(); }
});

test('mapped profile settings validate timezone, protect global fields and verify receipt plus readback', async () => {
  const { db, state, calls, request } = setup();
  try {
    const current = (await request('overview')).data.profile;
    const patch = { name: 'Brand profile', description: 'New description', color: '#aabbcc', timezone: 'Asia/Dubai', expectedProfile: current };
    let result = await request('profile/update', { body: patch }); assert.equal(result.status, 200); assert.equal(result.data.profile.timezone, 'Asia/Dubai'); assert.equal(result.data.profile.name, 'Brand profile');
    result = await request('profile/update', { body: { name: 'Overwritten', expectedProfile: current } }); assert.equal(result.status, 409); assert.equal(result.data.error.code, 'PROFILE_CHANGED');
    for (const fields of [{ isDefault: true }, { externalId: 'other-tenant' }, { profileId: 'foreign' }, { timezone: 'Invalid/Timezone' }, { color: {} }, { name: ' ' }]) assert.equal((await request('profile/update', { body: { ...fields, expectedProfile: result.data.profile } })).status, 400);
    const latest = (await request('overview')).data.profile; result = await request('profile/update', { body: { description: null, timezone: null, expectedProfile: latest } }); assert.equal(result.status, 200); assert.equal(result.data.profile.description, null); assert.equal(result.data.profile.timezone, null);
    assert.equal(calls.filter(row => row.method === 'PUT').length, 2); assert.equal(JSON.stringify(result).includes('never-return'), false);
  } finally { db.close(); }
});

test('malformed or unconfirmed group writes remain uncertain and cannot be resent using a different key', async () => {
  for (const failure of ['malformed', 'readFail', 'retainDeleted']) {
    const { db, state, calls, request } = setup();
    try {
      state[failure] = true;
      const action = failure === 'retainDeleted' ? 'groups/group-a/delete' : 'groups/create', body = failure === 'retainDeleted' ? { confirmGroupId: 'group-a', expectedGroup: snapshot(state.groups[0]) } : { name: 'Uncertain group', accountIds: ['account-a'] };
      let result = await request(action, { body, key: 'unknown-write-outcome' }); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain');
      const writes = calls.filter(row => row.method !== 'GET').length; result = await request(action, { body, key: 'another-outcome-key' }); assert.equal(result.status, 409); assert.equal(calls.filter(row => row.method !== 'GET').length, writes);
    } finally { db.close(); }
  }
  const { db, state, request } = setup();
  try { const expectedProfile = (await request('overview')).data.profile; state.malformed = true; const result = await request('profile/update', { body: { name: 'Unknown profile', expectedProfile } }); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain'); }
  finally { db.close(); }
});

test('group mutations share a resource lock while a provider write is pending', async () => {
  const { db, state, calls, request } = setup(); let release, entered;
  try {
    state.hold = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; }); state.onWrite = entered;
    const pending = request('groups/create', { body: { name: 'Held group', accountIds: ['account-a'] } }); await started;
    const result = await request('groups/group-a/delete', { body: { confirmGroupId: 'group-a', expectedGroup: snapshot(state.groups[0]) } }); assert.equal(result.status, 409); assert.equal(result.data.error.code, 'PROVIDER_RESOURCE_BUSY'); assert.equal(calls.some(row => row.method === 'DELETE'), false);
    release(); state.hold = null; assert.equal((await pending).status, 200);
  } finally { release?.(); db.close(); }
});

test('administration UI retains uncertain keys and ignores stale project or out-of-order reads', async () => {
  const source = await readFile(new URL('../src/ZernioAdmin.tsx', import.meta.url), 'utf8');
  const compile = (start, end, context) => new Function(...Object.keys(context), `return (${stripTypeScriptTypes(source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))))});`)(...Object.values(context));
  let active = true, finish, reject; const keys = { current: new Map() }, calls = [];
  const write = compile('async function write(', '  async function saveProfile(', { current: () => active, path: '/projects/a/integrations/admin', keys, crypto: { randomUUID: () => 'stable-admin-key' }, requester: { current: (...args) => { calls.push(args); return new Promise((resolve, fail) => { finish = resolve; reject = fail; }); } } });
  let pending = write('groups/create', { name: 'Group' }); reject(new Error('Unreadable response')); await assert.rejects(pending); assert.equal(keys.current.size, 1);
  pending = write('groups/create', { name: 'Group' }); reject(Object.assign(new Error('Uncertain'), { status: 409, code: 'OPERATION_UNCERTAIN' })); await assert.rejects(pending); assert.equal(calls[0][3], calls[1][3]);
  pending = write('groups/create', { name: 'Group' }); finish({ operation: { status: 'complete' }, group: {} }); await assert.rejects(pending, /receipt could not be read/); assert.equal(keys.current.size, 1);
  pending = write('groups/create', { name: 'Group' }); active = false; finish({ operation: { status: 'complete' }, group: { _id: 'created', name: 'Group', accountIds: ['a'] } }); await assert.rejects(pending, { name: 'AbortError' }); await assert.rejects(write('groups/create', {}), { name: 'AbortError' }); assert.equal(calls.length, 4);
  const reads = { current: 0 }, resolvers = [], accepted = [], profile = { _id: profileId, name: 'Profile', description: null, color: '#112233', timezone: null };
  const load = compile('async function load()', '  function choose(', { reads, requester: { current: () => new Promise(resolve => resolvers.push(resolve)) }, path: '/projects/a/integrations/admin', current: () => active, setProfile() {}, setAccounts() {}, setGroups: rows => accepted.push(rows), setLoaded() {}, setSelectedId() {}, setGroupDraft() {}, setProfileDraft() {} });
  active = true; const first = load(), second = load(); resolvers[1]({ profile, accounts: [], groups: [{ _id: 'new' }] }); await second; resolvers[0]({ profile, accounts: [], groups: [{ _id: 'old' }] }); await first; assert.deepEqual(accepted, [[{ _id: 'new' }]]);
  const third = load(); active = false; resolvers[2]({ profile, accounts: [], groups: [{ _id: 'departed' }] }); await third; assert.equal(accepted.length, 1);
  const identitySource = stripTypeScriptTypes(source.slice(source.indexOf('  const path ='), source.indexOf('  useEffect(')));
  const identity = new Function('projectId', 'canManage', 'scope', 'requester', 'request', 'active', 'groups', 'selectedId', `${identitySource}; return current;`), scope = { current: { path: '', canManage: true } }, mounted = { current: true };
  const firstA = identity('a', true, scope, {}, () => {}, mounted, [], ''); assert.equal(firstA(), true);
  const currentB = identity('b', true, scope, {}, () => {}, mounted, [], ''); assert.equal(firstA(), false); assert.equal(currentB(), true);
  const secondA = identity('a', true, scope, {}, () => {}, mounted, [], ''); assert.equal(firstA(), false); assert.equal(secondA(), true);
  const readerA = identity('a', false, scope, {}, () => {}, mounted, [], ''); assert.equal(secondA(), false); assert.equal(readerA(), true);
});

test('rendered administration UI offers normal forms and hides write controls from readers', async () => {
  const source = await readFile(new URL('../src/ZernioAdmin.tsx', import.meta.url), 'utf8'), start = source.indexOf('  return <section'), end = source.lastIndexOf('\n}');
  const { code } = await transformWithOxc(`const render = () => (${source.slice(start + '  return '.length, end).trim().replace(/;$/, '')});`, 'AdminView.tsx', { jsx: { runtime: 'classic' } });
  const render = canManage => {
    const context = { React, loaded: true, profile: { name: 'Campaign profile', description: 'Campaign details', timezone: null }, profileDraft: { name: 'Campaign profile', description: '', color: '#112233', timezone: '' }, groupDraft: { name: '', accountIds: [] }, selectedId: '', selected: undefined, accounts: [{ _id: 'account-a', platform: 'instagram', displayName: 'Campaign account' }], groups: [{ _id: 'group-a', name: 'Campaign group', accountIds: ['account-a'] }], error: '', notice: '', busy: false, canManage, accountName: row => row.displayName, action() {}, load() {}, saveProfile() {}, saveGroup() {}, choose() {}, removeGroup() {}, setProfileDraft() {}, setGroupDraft() {} };
    return renderToStaticMarkup(new Function(...Object.keys(context), `${code}; return render();`)(...Object.values(context)));
  };
  const reader = render(false), admin = render(true); assert.match(reader, /Campaign group/); assert.doesNotMatch(reader, /Save profile settings|Create account group|Edit Campaign group/); assert.match(admin, /Save profile settings/); assert.match(admin, /Create account group/); assert.match(admin, /type="checkbox"/); assert.doesNotMatch(admin, /JSON|API payload/);
});

test('administration write keys survive server failures and pending receipts until a definite client failure', async () => {
  const source = await readFile(new URL('../src/ZernioAdmin.tsx', import.meta.url), 'utf8'), handler = stripTypeScriptTypes(source.slice(source.indexOf('async function write('), source.indexOf('  async function saveProfile(')));
  const keys = { current: new Map() }, calls = []; let failure, sequence = 0;
  const context = { current: () => true, path: '/projects/a/integrations/admin', keys, crypto: { randomUUID: () => `admin-key-${++sequence}` }, requester: { current: async (...args) => { calls.push(args); if (failure) throw Object.assign(new Error('Request failed'), failure); return { operation: { status: 'complete' }, group: { _id: 'group-a', name: 'Group', accountIds: ['account-a'] } }; } } };
  const write = new Function(...Object.keys(context), `return (${handler});`)(...Object.values(context));
  for (const receipt of [{ status: 502 }, { status: 409, code: 'OPERATION_UNCERTAIN' }, { status: 409, code: 'OPERATION_IN_PROGRESS' }, { status: 409, code: 'OPERATION_PENDING' }, { status: 409, operation: { status: 'pending' } }, { status: 400, operation: { status: 'uncertain' } }]) {
    failure = receipt; await assert.rejects(write('groups/create', { name: 'Group' })); assert.equal(keys.current.size, 1, JSON.stringify(receipt)); const retained = calls.at(-1)[3];
    failure = null; await write('groups/create', { name: 'Group' }); assert.equal(calls.at(-1)[3], retained); assert.equal(keys.current.size, 0);
  }
  failure = { status: 400, code: 'INVALID_GROUP_UPDATE', operation: { status: 'failed' } }; await assert.rejects(write('groups/create', { name: 'Group' })); assert.equal(keys.current.size, 0); const rejected = calls.at(-1)[3];
  failure = null; await write('groups/create', { name: 'Group' }); assert.notEqual(calls.at(-1)[3], rejected);
});
