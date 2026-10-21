import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { handleIntegration } from '../server/integrations.ts';
import { IntegrationError } from '../server/provider-core.ts';
import { normalizePostTags } from '../shared/social-posts.ts';

function fixture(t) {
  const previous = globalThis.fetch, db = new DatabaseSync(':memory:'), project = { id: 'metadata-project', zernioProfileId: 'metadata-profile' };
  const accounts = ['channel-a', 'channel-b'].map(_id => ({ _id, platform: 'youtube', profileId: project.zernioProfileId, isActive: true }));
  const remote = { _id: 'remote-metadata', status: 'published', content: 'Stored description', tags: ['shared upload'], platforms: accounts.map((account, index) => ({ platform: 'youtube', accountId: account._id, status: 'published', platformPostId: index ? 'bbbbbbbbbbb' : 'aaaaaaaaaaa', platformPostUrl: `https://www.youtube.com/watch?v=${index ? 'bbbbbbbbbbb' : 'aaaaaaaaaaa'}`, platformSpecificData: { title: 'Stored upload title' } })) };
  let saved = { id: 'local-metadata', projectId: project.id, externalId: remote._id, zernioProfileId: project.zernioProfileId, status: 'published', providerStatus: 'published', content: remote.content, tags: [...remote.tags], providerResults: structuredClone(remote.platforms) }, sequence = 0;
  const state = { db, project, accounts, remote, writes: [], reads: 0, guards: 0, failReadback: false, mapping: project.zernioProfileId, get saved() { return saved; }, receipt: payload => ({ success: true, updatedFields: ['title', 'tags'].filter(field => Object.hasOwn(payload, field)) }) };
  const store = { get() { return structuredClone(saved); }, list() { return []; }, update(_, collection, id, changes) { assert.equal(collection, 'posts'); assert.equal(id, saved.id); saved = { ...saved, ...changes }; return structuredClone(saved); }, activity() {} };
  state.invoke = async (body = {}, key = `youtube-metadata-${++sequence}`, role = 'editor') => {
    let response;
    await handleIntegration({ req: { method: 'POST', headers: { 'idempotency-key': key } }, url: new URL(`http://localhost/api/projects/${project.id}/integrations/social/update-metadata`), body: { postId: saved.id, accountId: 'channel-a', videoId: 'aaaaaaaaaaa', confirmEdit: true, ...body }, project, role, db, store, config: { env: {}, ZERNIO_API_KEY: 'fake-test-key' }, assertProviderPostEdit() { state.guards++; if (state.denied) throw new IntegrationError(403, 'APPROVED_PROVIDER_EDIT_RESTRICTED', 'Administrator required.'); }, assertProjectMapping(expected) { if (expected !== state.mapping) throw new Error('Mapping changed'); }, send(status, data) { response = { status, data }; } });
    return response;
  };
  globalThis.fetch = async (target, options = {}) => {
    const path = new URL(target).pathname;
    if (path === '/api/v1/accounts') return Response.json({ accounts });
    if (path === '/api/v1/posts/remote-metadata' && (!options.method || options.method === 'GET')) {
      if (state.failReadback && state.writes.length) throw new Error('Read unavailable');
      state.reads++; state.onRead?.(state.reads); return Response.json({ post: remote });
    }
    assert.equal(path, '/api/v1/posts/remote-metadata/update-metadata'); assert.equal(options.method, 'POST');
    const payload = JSON.parse(options.body); state.writes.push(payload); state.onWrite?.();
    if (state.loseReceipt) throw new Error('Receipt lost');
    return Response.json(state.receipt(payload));
  };
  t.after(() => { globalThis.fetch = previous; db.close(); }); return state;
}

test('YouTube metadata acceptance preserves stored root and sibling values, supports omission and replays its receipt without another write', async t => {
  const f = fixture(t), before = structuredClone(f.saved), body = { title: 'Replacement title', tags: ['one, literal tag', '#literal'] };
  const result = await f.invoke(body, 'metadata-accepted-001');
  assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.data.operation.status, 'complete');
  assert.deepEqual(f.writes, [{ platform: 'youtube', accountId: 'channel-a', ...body }]); assert.deepEqual(f.saved, before);
  assert.deepEqual(result.data.metadataAcceptance, { postId: before.id, accountId: 'channel-a', videoId: 'aaaaaaaaaaa', requested: body, updatedFields: ['title', 'tags'], message: 'Accepted by Zernio; live values unverified.' });
  assert.equal(f.reads, 3); assert.equal(f.guards, 2);
  assert.deepEqual((await f.invoke(body, 'metadata-accepted-001')).data, result.data); assert.equal(f.writes.length, 1);
  assert.deepEqual(JSON.parse(f.db.prepare('SELECT response FROM integration_operations WHERE id=?').get(result.data.operation.id).response).metadataAcceptance, result.data.metadataAcceptance);
  await f.invoke({ tags: [] }); assert.deepEqual(f.writes.at(-1), { platform: 'youtube', accountId: 'channel-a', tags: [] });
  await f.invoke({ title: 'Title only' }); assert.deepEqual(f.writes.at(-1), { platform: 'youtube', accountId: 'channel-a', title: 'Title only' }); assert.deepEqual(f.saved, before);
});

test('YouTube metadata rejects unreviewed, invalid, unauthorized and changed account/video scope before writing', async t => {
  const f = fixture(t);
  for (const body of [{}, { title: '' }, { title: 'x'.repeat(101) }, { title: 'line\nbreak' }, { tags: ['x'.repeat(101)] }, { tags: Array(6).fill('x'.repeat(100)) }, { tags: ['bad\u0000tag'] }, { tags: 'tag' }, { title: 'A', description: 'Unsupported' }, { title: 'A', confirmEdit: false }, { title: 'A', videoId: 'wrong' }]) assert.equal((await f.invoke(body)).status, 400, JSON.stringify(body));
  assert.equal((await f.invoke({ title: 'A' }, undefined, 'viewer')).status, 403);
  assert.equal((await f.invoke({ title: 'A', accountId: 'outside' })).status, 403);
  f.denied = true; assert.equal((await f.invoke({ title: 'A' })).status, 403); f.denied = false;
  f.accounts[0].isActive = false; assert.equal((await f.invoke({ title: 'A' })).status, 409); f.accounts[0].isActive = true;
  f.remote.platforms.push({ ...f.remote.platforms[0] }); assert.equal((await f.invoke({ title: 'A' })).status, 409); f.remote.platforms.pop();
  f.remote.platforms[0].status = 'failed'; assert.equal((await f.invoke({ title: 'A' })).status, 403); f.remote.platforms[0].status = 'published';
  f.remote.platforms[0].removedFromPlatformAt = '2026-10-19T00:00:00Z'; assert.equal((await f.invoke({ title: 'A' })).status, 409); delete f.remote.platforms[0].removedFromPlatformAt;
  f.remote.recycling = { enabled: true, gap: 1, gapFreq: 'week', startDate: '2070-01-01T00:00:00Z' }; assert.equal((await f.invoke({ title: 'A' })).status, 409); delete f.remote.recycling;
  const prewriteRead = f.reads + 2; f.onRead = count => { if (count === prewriteRead) f.remote.platforms[0].platformPostId = 'ccccccccccc'; };
  assert.equal((await f.invoke({ title: 'A' })).status, 409); assert.deepEqual(f.writes, []);
});

test('YouTube metadata requires only the selected channel to stay active and still checks every copy scope', async t => {
  for (const index of [0, 1]) for (const read of [1, 2, 3]) await t.test(`${index ? 'sibling' : 'selected'} inactive at read ${read}`, async t => {
    const f = fixture(t), before = structuredClone(f.saved);
    f.onRead = count => { if (count === read) f.accounts[index].isActive = false; };
    const result = await f.invoke({ title: 'Replacement title' });
    assert.equal(result.status, index ? 200 : 409, JSON.stringify(result));
    assert.equal(result.data.operation.status, index ? 'complete' : read === 3 ? 'uncertain' : 'failed');
    assert.equal(f.writes.length, index || read === 3 ? 1 : 0); assert.deepEqual(f.saved, before);
  });
  for (const mismatch of ['profile', 'platform']) await t.test(`inactive sibling with wrong ${mismatch}`, async t => {
    const f = fixture(t); f.accounts[1].isActive = false;
    if (mismatch === 'profile') f.accounts[1].profileId = 'outside-profile'; else f.accounts[1].platform = 'facebook';
    const result = await f.invoke({ title: 'Replacement title' });
    assert.equal(result.status, mismatch === 'profile' ? 403 : 502); assert.equal(f.writes.length, 0);
  });
});

test('YouTube metadata malformed, scoped-away and lost receipts stay uncertain and cannot resend with old or new keys', async t => {
  for (const receipt of [{ success: false, updatedFields: ['title'] }, { success: true }, { success: true, updatedFields: [] }, { success: true, updatedFields: ['title', 'tags'] }, { success: true, updatedFields: ['title', 'title'] }, { success: true, updatedFields: ['title'], accountId: 'channel-b' }, { success: true, updatedFields: ['title'], videoId: 'bbbbbbbbbbb' }, { success: true, updatedFields: ['title'], postId: 'foreign' }]) {
    await t.test(JSON.stringify(receipt), async t => {
      const f = fixture(t), before = structuredClone(f.saved); f.receipt = () => receipt;
      const first = await f.invoke({ title: 'A' }, 'metadata-bad-receipt'); assert.equal(first.data.operation.status, 'uncertain', JSON.stringify(first));
      assert.equal((await f.invoke({ title: 'A' }, 'metadata-bad-receipt')).status, 409); assert.equal((await f.invoke({ title: 'B' })).status, 409); assert.equal(f.writes.length, 1); assert.deepEqual(f.saved, before);
    });
  }
  for (const mode of ['loseReceipt', 'failReadback', 'remap', 'changed-video']) await t.test(mode, async t => {
    const f = fixture(t), before = structuredClone(f.saved); f[mode] = true;
    if (mode === 'remap') f.onWrite = () => { f.mapping = 'new-profile'; };
    if (mode === 'changed-video') f.onWrite = () => { f.remote.platforms[0].platformPostId = 'ccccccccccc'; };
    const result = await f.invoke({ tags: ['replace'] }); assert.equal(result.data.operation.status, 'uncertain', JSON.stringify(result));
    assert.equal((await f.invoke({ title: 'Another attempt' })).status, 409); assert.equal(f.writes.length, 1); assert.deepEqual(f.saved, before);
  });
});

const management = await readFile(new URL('../src/PostManagement.tsx', import.meta.url), 'utf8');
const submitSource = stripTypeScriptTypes(management.slice(management.indexOf('async function submit('), management.indexOf("  if (typeof videoId !== 'string'")));
function metadataUi() {
  const state = { review: null, busy: false, uncertain: false, error: '', disabled: false, calls: [], accepted: [], pending: { current: false }, mounted: { current: true }, scope: { current: 'metadata-view' }, identity: 'metadata-view', postId: 'local', id: 'channel', videoId: 'aaaaaaaaaaa' };
  state.request = async (path, body) => { state.calls.push({ path, body }); return { operation: { status: 'complete' }, post: { id: state.postId }, metadataAcceptance: { postId: state.postId, accountId: state.id, videoId: state.videoId, requested: Object.fromEntries(['title', 'tags'].filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]])), updatedFields: ['title', 'tags'].filter(key => Object.hasOwn(body, key)) } }; };
  state.submit = async fields => {
    const context = { ...state, normalizePostTags, FormData: class { constructor(form) { this.form = form; } has(key) { return Object.hasOwn(this.form, key); } get(key) { return this.form[key] ?? null; } }, setReview: value => { state.review = value; }, setBusy: value => { state.busy = value; }, setUncertain: value => { state.uncertain = value; }, setError: value => { state.error = value; }, setAcceptance: value => { state.acceptance = value; }, onAccepted: value => state.accepted.push(value) };
    return new Function(...Object.keys(context), `return (${submitSource});`)(...Object.values(context))({ preventDefault() {}, currentTarget: fields });
  };
  return state;
}

test('YouTube UI requires fresh field and video review, preserves omission, and blocks duplicate or uncertain dispatch', async () => {
  const f = metadataUi(), title = { changeTitle: 'on', title: 'Reviewed title', tags: 'ignored' };
  await f.submit({ title: 'Not selected' }); assert.match(f.error, /Select/); assert.equal(f.calls.length, 0);
  await f.submit(title); assert.equal(f.calls.length, 0); assert.equal(f.review.body.title, 'Reviewed title'); assert.equal(Object.hasOwn(f.review.body, 'tags'), false);
  await f.submit({ ...title, title: 'Changed after review' }); assert.equal(f.calls.length, 0); assert.equal(f.review.body.title, 'Changed after review');
  f.identity = 'different-video'; f.videoId = 'bbbbbbbbbbb'; f.scope.current = f.identity;
  await f.submit(title); assert.equal(f.calls.length, 0); assert.equal(f.review.body.videoId, f.videoId);
  f.disabled = true; await f.submit(title); assert.equal(f.calls.length, 0); f.disabled = false;
  await f.submit(title); assert.deepEqual(f.calls[0], { path: 'social/update-metadata', body: { postId: 'local', accountId: 'channel', videoId: 'bbbbbbbbbbb', confirmEdit: true, title: 'Reviewed title' } }); assert.equal(f.accepted.length, 1); assert.deepEqual(f.acceptance.updatedFields, ['title']);
  const unknown = metadataUi(); unknown.request = async () => { unknown.calls.push('write'); throw Object.assign(new Error('Lost receipt'), { status: 409, code: 'OPERATION_UNCERTAIN', operation: { status: 'uncertain' } }); };
  await unknown.submit(title); await unknown.submit(title); assert.equal(unknown.uncertain, true); await unknown.submit(title); assert.equal(unknown.calls.length, 1);
  const pending = metadataUi(); let finish;
  const acceptedRequest = pending.request; pending.request = (...args) => new Promise(resolve => { finish = async () => resolve(await acceptedRequest(...args)); });
  await pending.submit(title); const first = pending.submit(title); await pending.submit(title); assert.equal(pending.pending.current, true); pending.scope.current = 'closed'; await finish(); await first; assert.equal(pending.calls.length, 1); assert.equal(pending.accepted.length, 0);
  assert.match(management, /onInput=\{\(\) => setReview\(null\)\}/); assert.match(management, /Accepted by Zernio; live values unverified/);
});

test('YouTube UI malformed acceptance scope does not clear the draft and requires recovery', async () => {
  for (const mutate of [result => { delete result.metadataAcceptance; }, result => { result.metadataAcceptance.accountId = 'foreign'; }, result => { result.metadataAcceptance.requested.title = 'Other value'; }, result => { result.metadataAcceptance.updatedFields = ['tags']; }, result => { result.operation.status = 'pending'; }]) {
    const f = metadataUi(), normal = f.request, fields = { changeTitle: 'on', title: 'Reviewed' };
    f.request = async (...args) => { const result = await normal(...args); mutate(result); return result; };
    await f.submit(fields); await f.submit(fields); assert.equal(f.uncertain, true); assert.equal(f.accepted.length, 0); assert.equal(f.acceptance, undefined); await f.submit(fields); assert.equal(f.calls.length, 1);
  }
});
