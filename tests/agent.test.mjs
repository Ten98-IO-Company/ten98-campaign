import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../server/database.ts';
import { handleAgent } from '../server/agent.ts';

test('the OpenRouter agent keeps tools scoped, drafts reviewable, paid retries durable, and user history private', async () => {
  const db = new DatabaseSync(':memory:'), originalFetch = globalThis.fetch, calls = [];
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY);
    CREATE TABLE projects(id TEXT PRIMARY KEY);
    CREATE TABLE records(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,collection TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE activity(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,message TEXT NOT NULL,created_at TEXT NOT NULL,sample INTEGER NOT NULL DEFAULT 0);
    INSERT INTO users VALUES('user-a'),('user-b'); INSERT INTO projects VALUES('project-a'),('project-b');`);
  const store = createStore(db), project = { id: 'project-a', name: 'Current brand' };
  const campaign = store.create(project.id, 'campaigns', { name: 'Current project campaign', channel: 'paid', status: 'draft', budget: 100, accessToken: 'SECRET_CAMPAIGN_TOKEN' });
  const foreignCampaign = store.create('project-b', 'campaigns', { name: 'OTHER_PROJECT_PRIVATE_CAMPAIGN', budget: 999 });
  store.create(project.id, 'assets', { name: 'Approved creative', kind: 'image', approval: 'approved', url: 'https://example.com/SECRET_SIGNED_ASSET_URL', credentials: 'SECRET_ASSET_CREDENTIAL' });
  const config = { env: { OPENROUTER_API_KEY: 'SECRET_OPENROUTER_KEY', OPENROUTER_MODEL: 'operator/model', OPENROUTER_MAX_STEPS: '4', OPENROUTER_MAX_TOKENS: '500' } };
  let responses = [];
  globalThis.fetch = async (target, options) => {
    assert.equal(String(target), 'https://openrouter.ai/api/v1/chat/completions'); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error'); assert.ok(options.signal);
    assert.equal(options.headers.Authorization, 'Bearer SECRET_OPENROUTER_KEY');
    const payload = JSON.parse(options.body); calls.push(payload);
    assert.equal(payload.model, 'operator/model'); assert.equal(payload.max_tokens, 500); assert.equal(payload.parallel_tool_calls, false); assert.equal(payload.stream, false);
    const next = responses.shift(); assert.ok(next, 'No unexpected paid model calls are allowed.');
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next), { status: 200 });
  };
  const tool = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const completion = (message, usage = { prompt_tokens: 12, completion_tokens: 8, cost: 0.001 }) => ({ choices: [{ message }], usage });
  function prepareDraft(selectedProject, collection, fields) {
    assert.equal(fields.status, 'draft');
    if (!['campaigns', 'posts', 'placements'].includes(collection)) throw new Error('Unsupported collection');
    if (collection === 'campaigns' && (typeof fields.name !== 'string' || fields.budget < 0)) throw new Error('Invalid draft');
    for (const [field, target] of [['campaignId', 'campaigns'], ['assetId', 'assets'], ['providerId', 'providers']]) if (fields[field] && !store.get(selectedProject.id, target, fields[field])) throw new Error('Reference outside current project');
    return { ...fields, status: 'draft', ...(collection === 'campaigns' ? { spent: 0 } : {}) };
  }
  async function invoke(path, options = {}) {
    const { method = 'GET', body = {}, key = 'agent-key-001', userId = 'user-a', role = 'editor', selectedProject = project, selectedConfig = config } = options;
    let response;
    const handled = await handleAgent({ req: { method, headers: { 'idempotency-key': key } }, url: new URL(`http://localhost/api/projects/${selectedProject.id}/agent/${path}`), body, project: selectedProject, user: { id: userId }, role, db, store, config: selectedConfig, assertIntegrationSettings: options.assertIntegrationSettings, prepareDraft: (collection, fields) => prepareDraft(selectedProject, collection, fields), send(status, data) { response = { status, data }; } });
    assert.equal(handled, true); return response;
  }
  try {
    let result = await invoke('status'); assert.equal(result.data.configured, true); assert.equal(result.data.model, 'operator/model'); assert.equal(JSON.stringify(result).includes('SECRET_OPENROUTER_KEY'), false);
    result = await invoke('run', { method: 'POST', role: 'viewer', body: { message: 'Plan a campaign' } }); assert.equal(result.status, 403); assert.equal(calls.length, 0);
    result = await invoke('run', { method: 'POST', selectedConfig: { env: {} }, body: { message: 'Plan a campaign' } }); assert.equal(result.status, 503); assert.equal(calls.length, 0);
    result = await invoke('run', { method: 'POST', body: { message: 'Plan a campaign', apiKey: 'user-supplied-key' } }); assert.equal(result.status, 400); assert.equal(calls.length, 0);
    responses = [completion({ role: 'assistant', content: null, tool_calls: [
      tool('read-campaigns', 'read_campaigns', {}), tool('read-assets', 'read_assets', {}), tool('inbox-without-permission', 'read_inbox', {}),
      tool('shell-attempt', 'exec_command', { cmd: 'write-file-or-publish' }),
      tool('active-proposal', 'propose_draft', { collection: 'campaigns', fields: { name: 'Activate without review', budget: 10, status: 'active' } }),
      tool('safe-proposal', 'propose_draft', { collection: 'campaigns', fields: { name: 'Reviewed launch', channel: 'mixed', budget: 50, currency: 'AED' } }),
      tool('foreign-reference', 'propose_draft', { collection: 'posts', fields: { content: 'A proposed post', platforms: ['facebook'], campaignId: foreignCampaign.id } }),
      tool('foreign-project-read', 'read_campaigns', { projectId: 'project-b' }),
    ] }, { prompt_tokens: 20, completion_tokens: 10, cost: 0.002 }), completion({ role: 'assistant', content: 'Review this draft campaign before saving it.' })];
    const body = { message: 'Inspect this project and prepare a campaign draft.' };
    result = await invoke('run', { method: 'POST', body }); assert.equal(result.status, 200, JSON.stringify(result));
    const run = result.data.run, action = run.actions[0];
    assert.equal(run.status, 'complete'); assert.equal(run.actions.length, 1); assert.equal(action.status, 'proposed'); assert.equal(action.data.status, 'draft'); assert.equal(action.data.spent, 0);
    assert.deepEqual(run.usage, { requests: 2, promptTokens: 32, completionTokens: 18, cost: 0.003 });
    assert.equal(store.list(project.id, 'campaigns').length, 1, 'Model proposals must not create any records before explicit user review.');
    assert.equal(calls.length, 2); assert.equal(calls[0].tools.some(entry => entry.function.name === 'read_inbox'), false);
    const sent = JSON.stringify(calls);
    for (const forbidden of ['SECRET_OPENROUTER_KEY', 'SECRET_CAMPAIGN_TOKEN', 'SECRET_SIGNED_ASSET_URL', 'SECRET_ASSET_CREDENTIAL', 'OTHER_PROJECT_PRIVATE_CAMPAIGN', 'PRIVATE_INBOX_OPT_IN_TEXT', 'OTHER_PROJECT_INBOX']) assert.equal(sent.includes(forbidden), false, `${forbidden} must not enter the model context.`);
    const toolResults = calls[1].messages.filter(entry => entry.role === 'tool').map(entry => ({ id: entry.tool_call_id, result: JSON.parse(entry.content) }));
    assert.deepEqual(toolResults.find(entry => entry.id === 'read-campaigns').result.records.map(row => row.id), [campaign.id]);
    for (const id of ['inbox-without-permission', 'shell-attempt', 'active-proposal', 'foreign-reference', 'foreign-project-read']) assert.ok(toolResults.find(entry => entry.id === id).result.error);
    assert.equal(toolResults.find(entry => entry.id === 'safe-proposal').result.saved, false);
    assert.deepEqual(await invoke('run', { method: 'POST', body }), result); assert.equal(calls.length, 2, 'Replaying a paid request must not bill another model call.');
    result = await invoke('run', { method: 'POST', body: { message: 'A different request' } }); assert.equal(result.status, 409); assert.equal(calls.length, 2);
    result = await invoke('history', { userId: 'user-b' }); assert.deepEqual(result.data.runs, []);
    result = await invoke('history', { selectedProject: { id: 'project-b', name: 'Other brand' } }); assert.deepEqual(result.data.runs, []);
    result = await invoke(`actions/${action.id}/apply`, { method: 'POST', userId: 'user-b' }); assert.equal(result.status, 404);
    result = await invoke(`actions/${action.id}/apply`, { method: 'POST', selectedProject: { id: 'project-b', name: 'Other brand' } }); assert.equal(result.status, 404);
    result = await invoke(`actions/${action.id}/apply`, { method: 'POST', role: 'viewer' }); assert.equal(result.status, 403);
    result = await invoke(`actions/${action.id}/apply`, { method: 'POST' }); assert.equal(result.status, 201); assert.equal(result.data.record.status, 'draft'); assert.equal(result.data.record.projectId, project.id);
    result = await invoke(`actions/${action.id}/apply`, { method: 'POST' }); assert.equal(result.status, 200); assert.equal(result.data.alreadyApplied, true); assert.equal(store.list(project.id, 'campaigns').length, 2); assert.equal(calls.length, 2);

    const beforeInbox = calls.length;
    result = await invoke('run', { method: 'POST', key: 'removed-inbox-opt-in-001', body: { message: 'Review my recent messages.', includeInbox: true } }); assert.equal(result.status, 400);
    assert.equal(calls.length, beforeInbox, 'Removed inbox opt-in cannot send private messages to the model.');

    responses = [new Error('SECRET_FROM_PROVIDER_OR_NETWORK')];
    const uncertainBody = { message: ' \tPrepare a separate uncertain run.\n' }, beforeUncertain = calls.length;
    result = await invoke('run', { method: 'POST', key: 'uncertain-0001', body: uncertainBody }); assert.equal(result.status, 409); assert.equal(result.data.run.status, 'uncertain'); assert.equal(JSON.stringify(result).includes('SECRET_FROM_PROVIDER_OR_NETWORK'), false);
    const uncertainId = result.data.run.id;
    result = await invoke('run', { method: 'POST', key: 'uncertain-0001', body: uncertainBody }); assert.equal(result.status, 409);
    result = await invoke('run', { method: 'POST', key: 'uncertain-0002', body: uncertainBody }); assert.equal(result.status, 409); assert.equal(calls.length, beforeUncertain + 1, 'Fresh request keys cannot bypass an ambiguous billing outcome.');
    for (const [index, message] of [uncertainBody.message.trim(), ' ' + uncertainBody.message, uncertainBody.message + '\n', '\t' + uncertainBody.message + ' \n'].entries()) {
      result = await invoke('run', { method: 'POST', key: 'uncertain-whitespace-' + index, body: { message } });
      assert.equal(result.status, 409); assert.equal(calls.length, beforeUncertain + 1, 'Changing surrounding whitespace cannot bill again for the same normalized unresolved model message.');
    }
    for (let index = 0; index < 20; index++) db.prepare('INSERT INTO agent_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(`later-run-${index}`, project.id, 'user-a', `later-key-${index}`, `later-hash-${index}`, 'complete', 'A later request', config.env.OPENROUTER_MODEL, 'Completed', JSON.stringify({ requests: 1, promptTokens: 1, completionTokens: 1, cost: 0.001 }), null, new Date().toISOString());
    const history = await invoke('history'); assert.equal(history.data.runs.length, 20); assert.equal(history.data.runs[0].id, uncertainId, 'Unresolved billed requests must remain reachable for review after newer runs fill the history.');
    result = await invoke(`runs/${uncertainId}/resolve`, { method: 'POST', body: {} }); assert.equal(result.status, 400);
    result = await invoke(`runs/${uncertainId}/resolve`, { method: 'POST', userId: 'user-b', body: { confirmedReviewed: true } }); assert.equal(result.status, 404);
    result = await invoke(`runs/${uncertainId}/resolve`, { method: 'POST', body: { confirmedReviewed: true } }); assert.equal(result.status, 200);
    responses = [completion({ role: 'assistant', content: 'The explicitly retried result.' }, { prompt_tokens: 5, completion_tokens: 3 })];
    result = await invoke('run', { method: 'POST', key: 'uncertain-0003', body: uncertainBody }); assert.equal(result.status, 200); assert.equal(result.data.run.usage.cost, null, 'An absent provider cost must remain unknown rather than zero.');
    assert.equal(responses.length, 0);
    let checks = 0;
    responses = [completion({ role: 'assistant', content: 'PRIVATE_MODEL_RESPONSE', tool_calls: [tool('read-after-revocation', 'read_campaigns', {})] })];
    const denied = await invoke('run', { method: 'POST', key: 'access-revoked-0001', body: { message: 'Inspect a campaign with pending access.' }, assertIntegrationSettings() { if (++checks > 1) throw Object.assign(new Error('Access revoked'), { status: 403 }); } });
    assert.equal(denied.status, 403); assert.equal(denied.data.run, undefined); assert.equal(JSON.stringify(denied).includes('PRIVATE_MODEL_RESPONSE'), false);
    const stopped = db.prepare("SELECT * FROM agent_runs WHERE request_key='access-revoked-0001'").get();
    assert.equal(stopped.status, 'failed'); assert.equal(JSON.parse(stopped.usage).requests, 1, 'An acknowledged model completion retains its actual usage even when access changes.');
    assert.equal(db.prepare('SELECT count(*) AS count FROM agent_actions WHERE run_id=?').get(stopped.id).count, 0);
  } finally { globalThis.fetch = originalFetch; db.close(); }
});

test('unreadable paid model responses stay uncertain, release streams and cannot be silently retried', async () => {
  const db = new DatabaseSync(':memory:'), originalFetch = globalThis.fetch;
  db.exec("CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE projects(id TEXT PRIMARY KEY); INSERT INTO users VALUES('user'); INSERT INTO projects VALUES('project');");
  let response, calls = 0;
  globalThis.fetch = async (_target, options) => { calls++; assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); return response; };
  const invoke = async (key, message) => {
    let result;
    await handleAgent({ req: { method: 'POST', headers: { 'idempotency-key': key } }, url: new URL('http://localhost/api/projects/project/agent/run'), project: { id: 'project', name: 'Fixture' }, user: { id: 'user' }, role: 'editor', body: { message }, db, store: {}, config: { env: { OPENROUTER_API_KEY: 'fixture', OPENROUTER_MODEL: 'fixture/model' } }, send(status, data) { result = { status, data }; } });
    return result;
  };
  try {
    const prefix = Buffer.from('{"choices":[{"message":{"role":"assistant","content":"'), suffix = Buffer.from('"}}]}');
    const malformed = new Response(Buffer.concat([prefix, Buffer.from([0xc3, 0x28]), suffix]));
    let cancelled = false;
    const oversized = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); }, cancel() { cancelled = true; } }));
    for (const [index, invalid] of [malformed, oversized, new Response('\ufeff{"choices":[{"message":{"role":"assistant","content":"Valid JSON after BOM"}}]}'), Response.json({ choices: [{ message: { role: 'assistant', content: 'Private text' } }], error: { message: 'PRIVATE_PROVIDER_ERROR' } })].entries()) {
      response = invalid; const key = 'invalid-paid-response-' + index, message = 'Request ' + index;
      const result = await invoke(key, message);
      assert.equal(result.status, 409); assert.equal(result.data.run.status, 'uncertain'); assert.equal(result.data.run.usage.cost, null); assert.equal(JSON.stringify(result).includes('PRIVATE_PROVIDER_ERROR'), false); assert.equal(invalid.body.locked, false);
      const beforeRetry = calls; assert.equal((await invoke(key, message)).status, 409); assert.equal(calls, beforeRetry);
    }
    assert.equal(cancelled, true, 'Oversized unfinished provider bodies must be cancelled.');
    let rejectedCancelled = false;
    response = new Response(new ReadableStream({ cancel() { rejectedCancelled = true; } }), { status: 503 });
    const rejected = await invoke('invalid-paid-response-503', 'Failed provider');
    assert.equal(rejected.status, 409); assert.equal(rejected.data.run.status, 'uncertain'); assert.equal(rejectedCancelled, true);
  } finally { globalThis.fetch = originalFetch; db.close(); }
});
