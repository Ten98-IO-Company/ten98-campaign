import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/database.ts';
import { handleAgent } from '../server/agent.ts';
import { postgresSkip, testDatabase } from './postgres.mjs';
import { seedAccounts } from './fixtures/accounts.ts';

test('an errored or malformed acknowledged model result cannot save suggestions or silently complete; usage remains reviewable', { skip: postgresSkip }, async t => {
  const { db, pool } = await testDatabase(t), originalFetch = globalThis.fetch;
  await seedAccounts(pool, { users: [{ id: 'author', name: 'Author', email: 'author@example.test' }], workspaces: [{ id: 'w', name: 'W' }] }); await pool.query("INSERT INTO projects (id, workspace_id, name) VALUES ('project','w','Project')");
  const store = createStore(db), usage = { prompt_tokens: 12, completion_tokens: 8, cost: 0.001 };
  let calls = 0, prepared = 0, next;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify(next)); };
  async function invoke(path, body = {}, key = 'agent-audit-0001') {
    let result;
    await handleAgent({ req: { method: 'POST', headers: { 'idempotency-key': key } }, url: new URL('https://example.test/api/projects/project/agent/' + path), project: { id: 'project', name: 'Project' }, user: { id: 'author' }, role: 'editor', db, store,
      config: { env: { OPENROUTER_API_KEY: 'mock-key', OPENROUTER_MODEL: 'mock-model' } }, body,
      async prepareDraft(collection, fields) { prepared++; return fields; }, send(status, data) { result = { status, data }; } });
    return result;
  }
  const proposal = { id: 'draft-call', type: 'function', function: { name: 'propose_draft', arguments: JSON.stringify({ collection: 'campaigns', fields: { name: 'Must not survive an errored completion' } }) } };
  const invalid = [
    { message: { role: 'assistant', content: 'PRIVATE_PARTIAL_OUTPUT', tool_calls: [proposal] }, finish_reason: 'error', error: { code: 502, message: 'PRIVATE_PROVIDER_ERROR' } },
    { message: { role: 'assistant', content: 'PRIVATE_PARTIAL_OUTPUT' }, error: { code: 502, message: 'PRIVATE_PROVIDER_ERROR' } },
    { message: true }, { message: 'not a message' }, { message: [] },
    { message: { role: 'user', content: 'Wrong role' } },
    { message: { role: 'assistant', content: { unexpected: 'object' } } },
    { message: { role: 'assistant', content: null, tool_calls: { length: 0 } } },
  ].map(choice => ({ choices: [choice], usage }));
  invalid.push({ choices: { 0: { message: { role: 'assistant', content: 'Malformed choices collection' } } }, usage });
  try {
    for (const [index, resultBody] of invalid.entries()) {
      next = resultBody;
      const body = { message: 'Inspect malformed acknowledgement ' + index }, before = calls;
      const result = await invoke('run', body, 'bad-model-result-' + index);
      assert.equal(result.status, 409, 'A billed malformed result needs provider review rather than a successful draft.');
      assert.equal(result.data.run.status, 'uncertain'); assert.equal(result.data.run.content, ''); assert.deepEqual(result.data.run.actions, []);
      assert.deepEqual(result.data.run.usage, { requests: 1, promptTokens: 12, completionTokens: 8, cost: 0.001 });
      assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
      assert.equal((await invoke('run', body, 'different-billing-key-' + index)).status, 409);
      assert.equal(calls, before + 1, 'A new key must not pay twice for the same unreviewed outcome.');
    }
    assert.equal(prepared, 0, 'An errored response must not execute draft tools.');
    assert.equal((await store.list('project', 'campaigns')).length, 0);
    next = { choices: [{ message: { role: 'assistant', content: 'A valid concise answer.' }, finish_reason: 'stop' }], usage };
    const valid = await invoke('run', { message: 'A separate valid result' }, 'valid-model-result');
    assert.equal(valid.status, 200); assert.equal(valid.data.run.status, 'complete'); assert.equal(valid.data.run.content, 'A valid concise answer.');
    next = { choices: [{ message: { role: 'assistant', content: null, refusal: 'The model declined this request.' }, finish_reason: 'content_filter' }], usage };
    const refusal = await invoke('run', { message: 'A separate refused request' }, 'refused-model-result');
    assert.equal(refusal.status, 200); assert.equal(refusal.data.run.status, 'complete'); assert.equal(refusal.data.run.content, 'The model declined this request.', 'A successful refusal must remain visible instead of claiming the agent reached its step limit.');
  } finally { globalThis.fetch = originalFetch; }
});
