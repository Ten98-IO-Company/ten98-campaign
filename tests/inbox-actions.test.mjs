import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleIntegration } from '../server/integrations.mjs';

test('inbox replies, archive and reopen require scoped provider acknowledgements and keep uncertain sends closed', async () => {
  const db = new DatabaseSync(':memory:'), original = globalThis.fetch, writes = [];
  const project = { id: 'inbox-project', zernioProfileId: 'profile-a' };
  let acknowledgement = true, wrongAccount = false, wrongStatus = false, foreignConversation = false, sequence = 0;
  async function invoke(action, body = { accountId: 'account-a' }, key = `inbox-action-${++sequence}`, role = 'editor') {
    let response;
    await handleIntegration({ req: { method: 'POST', headers: { 'idempotency-key': key } }, url: new URL(`http://localhost/api/projects/${project.id}/integrations/inbox/shared-thread/${action}`), body, project, role, db, store: {}, config: { env: { ZERNIO_API_KEY: 'private-key' } }, send(status, data) { response = { status, data }; } });
    return response;
  }
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); let result;
    if (url.pathname === '/api/v1/accounts') result = { accounts: [{ _id: 'account-a', profileId: 'profile-a', platform: 'facebook' }] };
    else if (url.pathname === '/api/v1/inbox/conversations') result = { data: [{ id: 'shared-thread', accountId: foreignConversation ? 'foreign-account' : 'account-a' }], pagination: { hasMore: false } };
    else {
      const payload = JSON.parse(options.body); writes.push({ url, payload, method: options.method });
      result = { success: acknowledgement, data: { messageId: 'message-a', accountId: wrongAccount ? 'account-b' : payload.accountId, status: wrongStatus ? 'unknown' : payload.status } };
    }
    return new Response(JSON.stringify(result), { status: 200 });
  };
  try {
    assert.equal((await invoke('reopen', undefined, undefined, 'viewer')).status, 403); assert.equal(writes.length, 0);
    assert.equal((await invoke('resolve', { accountId: 'account-a', status: 'active' })).status, 400); assert.equal(writes.length, 0);
    foreignConversation = true; assert.equal((await invoke('reopen')).data.error.code, 'INVALID_PROVIDER_SCOPE'); assert.equal(writes.length, 0); foreignConversation = false;
    let result = await invoke('resolve', undefined, 'archive-once'); assert.equal(result.status, 200); assert.deepEqual(writes.at(-1).payload, { accountId: 'account-a', status: 'archived' }); assert.equal(writes.at(-1).method, 'PUT');
    await invoke('resolve', undefined, 'archive-once'); assert.equal(writes.length, 1);
    result = await invoke('reopen'); assert.equal(result.status, 200); assert.deepEqual(writes.at(-1).payload, { accountId: 'account-a', status: 'active' });
    wrongAccount = true; result = await invoke('resolve'); assert.equal(result.data.operation.status, 'uncertain'); wrongAccount = false;
    wrongStatus = true; result = await invoke('reopen'); assert.equal(result.data.operation.status, 'uncertain'); wrongStatus = false;
    acknowledgement = false; const reply = { accountId: 'account-a', message: 'A customer reply' };
    result = await invoke('reply', reply, 'unconfirmed-send'); assert.equal(result.data.operation.status, 'uncertain');
    const count = writes.length; result = await invoke('reply', reply, 'fresh-send-key'); assert.equal(result.data.error.code, 'OPERATION_UNCERTAIN'); assert.equal(writes.length, count);
    acknowledgement = true; result = await invoke('reply', { ...reply, message: 'A different confirmed reply' }); assert.equal(result.status, 200);
  } finally { globalThis.fetch = original; db.close(); }
});
