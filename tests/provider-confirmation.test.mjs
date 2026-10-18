import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleIntegration, providerRequest } from '../server/integrations.mjs';

test('social write receipts reject malformed or cross-account acknowledgements before changing local posts', async () => {
  const db = new DatabaseSync(':memory:'), originalFetch = globalThis.fetch, records = new Map(), writes = [];
  const project = { id: 'confirmation-project', zernioProfileId: 'confirmation-profile' };
  const account = { _id: 'confirmation-account', profileId: project.zernioProfileId, platform: 'facebook' };
  const store = {
    get(projectId, collection, id) { return collection === 'posts' && projectId === project.id ? structuredClone(records.get(id)) : undefined; },
    update(projectId, collection, id, patch) { const post = this.get(projectId, collection, id); if (!post) return; const saved = { ...post, ...patch }; records.set(id, saved); return saved; },
    activity() {},
  };
  let acknowledgement, remote, sequence = 0;
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target), method = options.method || 'GET';
    if (url.pathname === '/api/v1/accounts') return Response.json({ accounts: [account] });
    if (url.pathname === '/api/v1/tools/validate/post') return Response.json({ valid: true, warnings: [] });
    if (method === 'GET') return Response.json({ post: remote });
    writes.push({ method, payload: JSON.parse(options.body) });
    return Response.json({ post: acknowledgement });
  };
  async function invoke(action, post, key) {
    let response;
    const body = { postId: post.id, ...(action === 'update' ? { mode: 'draft', content: 'Requested update' } : action === 'retry' ? { confirmPublish: true } : {}) };
    await handleIntegration({ req: { method: 'POST', headers: { 'idempotency-key': key } }, url: new URL(`http://localhost/api/projects/${project.id}/integrations/social/${action}`), project, db, store, body, role: 'editor', config: { env: { ZERNIO_API_KEY: 'fixture-key' } }, send(status, data) { response = { status, data }; } });
    return response;
  }
  const valid = { _id: 'confirmed-post', status: 'published', platforms: [{ platform: 'facebook', accountId: account._id, status: 'published' }] };
  try {
    const failures = [
      { _id: { unexpected: 'object' } }, { status: {} }, { content: {} }, { profileId: 'foreign-profile' },
      { platforms: [{ platform: 'facebook', accountId: 'foreign-account', customContent: 'PRIVATE_FOREIGN_CAPTION' }] },
      { platforms: [{ platform: 'instagram', accountId: account._id }] }, { platforms: [{ platform: 'facebook', accountId: account._id, customContent: {} }] }, { platforms: [null] }, { platforms: 'invalid' },
    ];
    for (const action of ['publish', 'update', 'retry']) for (const failure of failures) {
      const post = { id: `local-${++sequence}`, content: 'Local original', platforms: ['facebook'], accounts: [account._id], status: action === 'retry' ? 'failed' : 'draft', ...(action === 'publish' ? {} : { externalId: valid._id, zernioProfileId: project.zernioProfileId }) };
      records.set(post.id, post);
      remote = { ...valid, status: post.status, content: post.content, platforms: valid.platforms.map(copy => ({ ...copy, status: 'failed' })) };
      acknowledgement = { ...valid, ...failure };
      const result = await invoke(action, post, `confirmation-${sequence}`);
      assert.equal(result.status, 409, `${action}: ${JSON.stringify(failure)}`);
      assert.equal(result.data.operation.status, 'uncertain');
      assert.deepEqual(records.get(post.id), post, 'Untrusted acknowledgement fields must not replace the local draft or account copies.');
      assert.equal(JSON.stringify(result).includes('PRIVATE_FOREIGN_CAPTION'), false);
      const beforeRetry = writes.length;
      assert.equal((await invoke(action, post, `confirmation-retry-${sequence}`)).status, 409);
      assert.equal(writes.length, beforeRetry, 'Fresh action keys cannot repeat an unconfirmed provider write.');
      // This fixture never applies its acknowledgement; reconcile before the next independent malformed-receipt case.
      db.prepare("UPDATE integration_operations SET status='reviewed-not-applied' WHERE id=?").run(result.data.operation.id);
    }
    for (const platforms of [[{ platform: 'facebook', status: 'published' }], [{ accountId: account._id, status: 'pending' }], [{ platform: 'facebook', accountId: { _id: account._id }, status: 'published' }]]) {
      const post = { id: `minimal-${++sequence}`, content: 'Documented minimal acknowledgement', platforms: ['facebook'], accounts: [account._id], status: 'draft' };
      records.set(post.id, post); acknowledgement = { ...valid, profileId: { _id: project.zernioProfileId }, platforms };
      assert.equal((await invoke('publish', post, `confirmation-minimal-${sequence}`)).status, 200, 'Minimal acknowledgements need not repeat both platform and account ID.');
    }
  } finally { globalThis.fetch = originalFetch; db.close(); }
});

test('the shared provider boundary rejects JSON primitives with write uncertainty intact', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const value of [null, [], true, 42, 'not an object']) {
      globalThis.fetch = async () => Response.json(value);
      for (const method of ['GET', 'POST']) await assert.rejects(providerRequest('https://www.googleapis.com/drive/v3/files', { method }, 'Google Drive'), error => error.code === 'INVALID_PROVIDER_RESPONSE' && error.status === 502 && Boolean(error.uncertain) === (method === 'POST'));
    }
  } finally { globalThis.fetch = originalFetch; }
});
