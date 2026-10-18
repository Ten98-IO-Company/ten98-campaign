import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { handleIntegration } from '../server/integrations.mjs';

test('late social refreshes cannot overwrite newer edits or cancellation receipts, even with identical update timestamps', async () => {
  for (const action of ['update', 'cancel']) {
    const db = new DatabaseSync(':memory:'), originalFetch = globalThis.fetch, project = { id: 'refresh-race-project', zernioProfileId: 'refresh-race-profile' };
    const account = { _id: 'refresh-race-account', platform: 'facebook', profileId: project.zernioProfileId };
    let post = { id: 'refresh-race-local', externalId: 'refresh-race-remote', zernioProfileId: project.zernioProfileId, content: 'Original caption', status: 'scheduled', updatedAt: 'same-timestamp' };
    let remote = { _id: post.externalId, status: 'scheduled', content: post.content, scheduledFor: '2070-01-01T10:00:00Z', platforms: [{ platform: account.platform, accountId: account._id, status: 'pending' }] };
    let release, entered, holdNextRead = true, refresh;
    const reached = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const store = { get(_project, collection) { return collection === 'posts' ? structuredClone(post) : undefined; }, update(_project, _collection, _id, patch) { post = { ...post, ...patch }; return post; }, activity() {} };
    globalThis.fetch = async (target, options = {}) => {
      const url = new URL(target);
      if (url.pathname === '/api/v1/accounts') return Response.json({ accounts: [account] });
      if (options.method === 'DELETE') return new Response(null, { status: 204 });
      if (options.method === 'PUT') { const payload = JSON.parse(options.body); remote = { ...remote, ...payload, status: payload.isDraft ? 'draft' : 'scheduled' }; }
      const snapshot = structuredClone(remote);
      if (holdNextRead) { holdNextRead = false; entered(); await gate; }
      return Response.json({ post: snapshot });
    };
    async function invoke(path, body) {
      let response;
      await handleIntegration({ req: { method: body ? 'POST' : 'GET', headers: { 'idempotency-key': 'refresh-race-' + path } }, url: new URL(`http://localhost/api/projects/${project.id}/integrations/social/${path}${body ? '' : '?postId=' + post.id}`), body: { postId: post.id, ...body }, project, db, store, role: 'editor', config: { env: { ZERNIO_API_KEY: 'fixture-key' } }, send(status, data) { response = { status, data }; } });
      return response;
    }
    try {
      refresh = invoke('status'); await reached;
      const changed = await invoke(action, action === 'cancel' ? { confirmCancellation: true } : { content: 'New caption', mode: 'draft' });
      assert.equal(changed.status, 200, JSON.stringify(changed.data));
      assert.equal(post.status, action === 'cancel' ? 'cancelled' : 'draft');
      if (action === 'update') assert.equal(post.content, 'New caption'); else assert.ok(post.providerDeletedAt);
      const latest = structuredClone(post); release(); const stale = await refresh;
      assert.equal(stale.status, 409); assert.equal(stale.data.error.code, 'POST_CHANGED');
      assert.deepEqual(post, latest, 'An older provider response cannot replace the newer local receipt.');
      assert.equal((await invoke('status')).status, 200, 'A fresh status read remains available.');
    } finally { release(); await refresh?.catch(() => {}); globalThis.fetch = originalFetch; db.close(); }
  }
});

test('a social write accepted during a newer local status update remains uncertain and cannot be repeated', async () => {
  const db = new DatabaseSync(':memory:'), originalFetch = globalThis.fetch, project = { id: 'write-race-project', zernioProfileId: 'write-race-profile' };
  const account = { _id: 'write-race-account', platform: 'facebook', profileId: project.zernioProfileId };
  let post = { id: 'write-race-local', externalId: 'write-race-remote', zernioProfileId: project.zernioProfileId, content: 'Original caption', status: 'draft' }, writes = 0;
  let remote = { _id: post.externalId, status: 'draft', content: post.content, platforms: [{ platform: account.platform, accountId: account._id }] };
  const store = { get(_project, collection) { return collection === 'posts' ? structuredClone(post) : undefined; }, update(_project, _collection, _id, patch) { post = { ...post, ...patch }; return post; }, activity() {} };
  globalThis.fetch = async (target, options = {}) => {
    if (new URL(target).pathname === '/api/v1/accounts') return Response.json({ accounts: [account] });
    if (options.method === 'PUT') { writes++; remote = { ...remote, ...JSON.parse(options.body) }; post = { ...post, status: 'published', providerStatus: 'published', providerEventAt: '2070-01-01T10:00:00Z' }; }
    return Response.json({ post: remote });
  };
  async function invoke(key) {
    let response;
    await handleIntegration({ req: { method: 'POST', headers: { 'idempotency-key': key } }, url: new URL(`http://localhost/api/projects/${project.id}/integrations/social/update`), body: { postId: post.id, content: 'New caption', mode: 'draft' }, project, db, store, role: 'editor', config: { env: { ZERNIO_API_KEY: 'fixture-key' } }, send(status, data) { response = { status, data }; } });
    return response;
  }
  try {
    const result = await invoke('write-race-original');
    assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain');
    assert.equal(post.status, 'published'); assert.equal(post.content, 'Original caption');
    assert.equal((await invoke('write-race-new-key')).status, 409); assert.equal(writes, 1);
  } finally { globalThis.fetch = originalFetch; db.close(); }
});

test('an empty Drive collection is readable and syncable without erasing existing assets', async () => {
  const db = new DatabaseSync(':memory:'), originalFetch = globalThis.fetch, { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const project = { id: 'empty-drive-project', driveFolderId: 'empty-drive-folder' }, assets = [{ id: 'existing-asset', name: 'Retained creative' }];
  let page = { kind: 'drive#fileList' }, fields;
  globalThis.fetch = async target => {
    const url = new URL(target);
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'fixture-google-token' });
    assert.equal(url.pathname, '/drive/v3/files');
    fields = url.searchParams.get('fields');
    return Response.json(page);
  };
  async function invoke(method) {
    let response;
    await handleIntegration({ req: { method }, url: new URL(`http://localhost/api/projects/${project.id}/integrations/drive/${method === 'GET' ? 'files' : 'sync'}`), project, db, store: { list() { return assets; }, activity() {}, create() { assert.fail('An empty folder must not create assets.'); } }, role: 'editor', config: { env: { GOOGLE_SERVICE_ACCOUNT_EMAIL: 'fixture@example.test', GOOGLE_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }) } }, send(status, data) { response = { status, data }; } });
    return response;
  }
  try {
    // Google's Node quickstart treats an omitted files field as an empty search result.
    // https://developers.google.com/workspace/drive/api/quickstart/nodejs
    for (const method of ['GET', 'POST']) {
      const result = await invoke(method); assert.equal(result.status, 200, JSON.stringify(result.data));
      assert.ok(fields.split(',').includes('kind'), 'Request the collection identity so omission cannot turn an arbitrary object into an empty folder.');
      assert.equal(result.data.complete, true); assert.deepEqual(method === 'GET' ? result.data.files : result.data.assets, []);
    }
    for (const malformed of [{}, { kind: 'drive#fileList', files: null }, { kind: 'drive#fileList', files: {} }, { kind: 'another-resource' }]) {
      page = malformed; assert.equal((await invoke('POST')).status, 502);
    }
    assert.deepEqual(assets, [{ id: 'existing-asset', name: 'Retained creative' }]);
  } finally { globalThis.fetch = originalFetch; db.close(); }
});

test('editing the visible post schedule moves existing per-account overrides to that time', async () => {
  const db = new DatabaseSync(':memory:'), originalFetch = globalThis.fetch, project = { id: 'schedule-project', zernioProfileId: 'schedule-profile' }, writes = [];
  const copies = [{ platform: 'facebook', accountId: 'facebook-copy', status: 'pending', scheduledFor: '2070-01-01T10:00:00Z', customContent: 'Facebook caption' }, { platform: 'linkedin', accountId: 'linkedin-copy', status: 'pending', scheduledFor: '2070-01-01T11:00:00Z', customContent: 'LinkedIn caption' }];
  let remote = { _id: 'schedule-remote', status: 'scheduled', content: 'Shared caption', scheduledFor: '2070-01-01T09:00:00Z', platforms: copies }, post = { id: 'schedule-local', externalId: remote._id, zernioProfileId: project.zernioProfileId, content: remote.content, status: 'scheduled' };
  const store = { get(projectId, collection) { return collection === 'posts' ? structuredClone(post) : undefined; }, update(projectId, collection, id, patch) { post = { ...post, ...patch }; return post; }, activity() {} };
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target);
    if (url.pathname === '/api/v1/accounts') return Response.json({ accounts: copies.map(copy => ({ _id: copy.accountId, platform: copy.platform, profileId: project.zernioProfileId })) });
    if (url.pathname === '/api/v1/tools/validate/post') return Response.json({ valid: true, warnings: [] });
    if (options.method === 'PUT') { const payload = JSON.parse(options.body); writes.push(payload); remote = { ...remote, ...payload, status: payload.isDraft ? 'draft' : 'scheduled' }; }
    return Response.json({ post: remote });
  };
  async function invoke(body, key) {
    let response;
    await handleIntegration({ req: { method: 'POST', headers: { 'idempotency-key': key } }, url: new URL(`http://localhost/api/projects/${project.id}/integrations/social/update`), body: { postId: post.id, mode: 'scheduled', scheduledAt: '2070-02-01T12:00:00Z', ...body }, project, db, store, role: 'editor', config: { env: { ZERNIO_API_KEY: 'fixture-zernio-key' } }, send(status, data) { response = { status, data }; } });
    return response;
  }
  try {
    // Zernio defines each target scheduledFor as an override of the shared schedule.
    // https://docs.zernio.com/guides/platform-settings
    for (const [index, body] of [{}, { platformOverrides: { facebook: { content: 'New Facebook caption' }, linkedin: { content: 'New LinkedIn caption' } } }].entries()) {
      const result = await invoke(body, 'copy-schedule-' + index); assert.equal(result.status, 200, JSON.stringify(result.data));
      const payload = writes.at(-1); assert.equal(payload.scheduledFor, '2070-02-01T12:00:00.000Z');
      assert.equal(payload.platforms?.length, copies.length, 'Existing account overrides must be replaced even when the caption variants were not edited.');
      for (const target of payload.platforms) assert.equal(target.scheduledFor || payload.scheduledFor, payload.scheduledFor);
      assert.deepEqual(payload.platforms.map(copy => copy.customContent), index === 0 ? copies.map(copy => copy.customContent) : ['New Facebook caption', 'New LinkedIn caption']);
    }
  } finally { globalThis.fetch = originalFetch; db.close(); }
});

test('a documented minimal update receipt retains the newly saved platform draft locally', async () => {
  const db = new DatabaseSync(':memory:'), originalFetch = globalThis.fetch, project = { id: 'minimal-edit-project', zernioProfileId: 'minimal-edit-profile' }, account = { _id: 'minimal-edit-account', platform: 'facebook', profileId: 'minimal-edit-profile' };
  let post = { id: 'minimal-edit-local', externalId: 'minimal-edit-remote', zernioProfileId: project.zernioProfileId, content: 'Shared caption', status: 'draft', mediaItems: [], platformOverrides: { facebook: { content: 'Old Facebook caption' } } };
  let remote = { _id: post.externalId, status: 'draft', content: post.content, mediaItems: [], platforms: [{ platform: account.platform, accountId: account._id, customContent: 'Old Facebook caption' }] }, failReadback = false, unreadable = false, writes = 0;
  const overrides = { facebook: { content: 'New Facebook caption', mediaItems: [{ type: 'image', url: 'https://cdn.example.test/new.png' }], options: { firstComment: 'New first comment' } } };
  const store = { get(projectId, collection) { return collection === 'posts' ? structuredClone(post) : undefined; }, update(projectId, collection, id, patch) { post = { ...post, ...patch }; return post; }, activity() {} };
  globalThis.fetch = async (target, options = {}) => {
    if (new URL(target).pathname === '/api/v1/accounts') return Response.json({ accounts: [account] });
    if (options.method === 'PUT') {
      const payload = JSON.parse(options.body); writes++; assert.equal(payload.platforms[0].customContent, overrides.facebook.content);
      remote = { ...remote, ...payload }; unreadable = failReadback;
      // https://docs.zernio.com/posts/update-post documents a receipt without target copies.
      return Response.json({ post: { _id: post.externalId, status: 'draft', content: post.content, ...(writes === 2 ? { platforms: [{ platform: account.platform, accountId: account._id }] } : {}) } });
    }
    if (unreadable) throw new Error('Provider readback unavailable.');
    return Response.json({ post: remote });
  };
  try {
    let response;
    async function repeat(key) {
      await handleIntegration({ req: { method: 'POST', headers: { 'idempotency-key': key } }, url: new URL(`http://localhost/api/projects/${project.id}/integrations/social/update`), body: { postId: post.id, mode: 'draft', platformOverrides: overrides }, project, db, store, role: 'editor', config: { env: { ZERNIO_API_KEY: 'fixture-zernio-key' } }, send(status, data) { response = { status, data }; } });
      return response;
    }
    for (const key of ['minimal-edit-round4', 'minimal-edit-identities-only']) {
      assert.equal((await repeat(key)).status, 200, JSON.stringify(response.data));
      assert.deepEqual(post.platformOverrides, overrides, 'A successful save must reopen with the variants accepted in that save, even if the receipt omits them.');
      assert.deepEqual(response.data.post.platformOverrides, overrides);
    }
    const saved = structuredClone(post); failReadback = true;
    assert.equal((await repeat('minimal-edit-unconfirmed')).status, 409);
    assert.equal(response.data.operation.status, 'uncertain'); assert.deepEqual(post, saved);
    assert.equal((await repeat('minimal-edit-fresh-key')).status, 409); assert.equal(writes, 3, 'A fresh key cannot repeat an accepted update with unreadable state.');
  } finally { globalThis.fetch = originalFetch; db.close(); }
});
