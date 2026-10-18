import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.mjs';

test('removed inbox routes, sample records and agent access stay unavailable while legacy records are preserved privately', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ten98-inbox-removal-')), origin = 'http://127.0.0.1:3000';
  const app = createApp({ dataDir, appUrl: origin, env: { ZERNIO_API_KEY: 'never-used-inbox-key', OPENROUTER_API_KEY: 'mock-agent-key', OPENROUTER_MODEL: 'fixture/model' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`, originalFetch = globalThis.fetch, modelCalls = []; let cookie;
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.href, 'https://openrouter.ai/api/v1/chat/completions', 'Removed inbox routes must never request Zernio.');
    const payload = JSON.parse(options.body); modelCalls.push(payload);
    return new Response(JSON.stringify({ choices: [{ message: modelCalls.length === 1 ? { role: 'assistant', content: null, tool_calls: [{ id: 'forbidden-inbox', type: 'function', function: { name: 'read_inbox', arguments: '{}' } }] } : { role: 'assistant', content: 'Only campaign tools are available.' } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }));
  };
  async function request(path, method = 'GET', body) {
    const response = await fetch(base + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method === 'GET' ? {} : { Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': 'inbox-removal-check' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  try {
    const setup = await request('/api/auth/setup', 'POST', { name: 'Removal fixture', email: 'removal@example.test', password: 'a sufficiently long fixture password', sample: true });
    assert.equal(setup.status, 201); cookie = setup.cookie;
    const initial = (await request('/api/state')).data, projectId = initial.projectId, project = `/api/projects/${projectId}`;
    assert.equal(Object.hasOwn(initial, 'conversations'), false);
    assert.equal(app.db.prepare("SELECT count(*) AS count FROM records WHERE collection='conversations'").get().count, 0, 'New sample projects must not create inbox data.');
    assert.throws(() => app.store.create(projectId, 'conversations', {}), /Unknown collection/);
    const legacy = { id: 'legacy-private-thread', projectId, contact: 'PRIVATE_LEGACY_CONTACT', messages: [{ content: 'PRIVATE_LEGACY_MESSAGE' }], sample: true };
    app.db.prepare('INSERT INTO records VALUES(?,?,?,?)').run(legacy.id, projectId, 'conversations', JSON.stringify(legacy));
    for (const suffix of ['/inbox/cache', '/integrations/inbox', '/integrations/inbox/thread/messages?accountId=account-a', '/engagement/status', '/engagement/accounts', '/engagement/comments', '/engagement/reviews', '/engagement/updates?accountId=account-a&kind=comments', '/conversations', `/conversations/${legacy.id}`]) assert.equal((await request(project + suffix)).status, 404, suffix);
    for (const suffix of ['/integrations/inbox/thread/reply', '/integrations/inbox/thread/archive', '/integrations/inbox/thread/reopen', '/engagement/comments/reply', '/engagement/reviews/reply', '/conversations']) assert.equal((await request(project + suffix, 'POST', { accountId: 'account-a', message: 'Never sent', contact: 'Never created' })).status, 404, suffix);
    assert.equal((await request(`${project}/conversations/${legacy.id}`, 'PATCH', { status: 'resolved' })).status, 404);
    assert.equal((await request(`${project}/conversations/${legacy.id}`, 'DELETE')).status, 404);
    const state = (await request('/api/state')).data;
    assert.equal(Object.hasOwn(state, 'conversations'), false); assert.equal(JSON.stringify(state).includes('PRIVATE_LEGACY'), false);
    for (const includeInbox of [true, false]) assert.equal((await request(project + '/agent/run', 'POST', { message: 'Plan my campaign', includeInbox })).status, 400);
    assert.equal(modelCalls.length, 0, 'Old opt-in fields must fail before any paid inference.');
    assert.equal((await request(project + '/agent/run', 'POST', { message: 'Inspect current campaign tools.' })).status, 200);
    assert.equal(modelCalls.length, 2); assert.equal(modelCalls[0].tools.some(tool => tool.function.name === 'read_inbox'), false);
    const denied = modelCalls[1].messages.find(message => message.role === 'tool' && message.tool_call_id === 'forbidden-inbox');
    assert.ok(JSON.parse(denied.content).error); assert.equal(JSON.stringify(modelCalls).includes('PRIVATE_LEGACY'), false);
    assert.equal((await request(project + '/sample-data', 'DELETE')).status, 200);
    assert.deepEqual(JSON.parse(app.db.prepare('SELECT data FROM records WHERE id=?').get(legacy.id).data), legacy, 'Removing the feature must not silently delete pre-existing private data.');
  } finally { globalThis.fetch = originalFetch; await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
