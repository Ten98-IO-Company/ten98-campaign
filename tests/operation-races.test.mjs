import test from 'node:test';
import assert from 'node:assert/strict';
import { IntegrationError, claimFence, operation, releaseFence } from '../server/provider-core.ts';
import { handleOperationRecovery } from '../server/operation-recovery.ts';
import { blockWrites, postgresSkip, testDatabase } from './postgres.mjs';

const pg = { skip: postgresSkip };
async function fixture(t) {
  const database = await testDatabase(t);
  await database.pool.query("INSERT INTO workspaces (id, name) VALUES ('w', 'W'); INSERT INTO projects (id, workspace_id, name) VALUES ('p', 'w', 'P'); INSERT INTO users VALUES ('operator', 'Operator', 'operator@example.test', NULL)");
  const context = (key, body = { name: 'fixture' }) => ({ db: database.db, project: { id: 'p' }, req: { method: 'POST', headers: { 'idempotency-key': key } }, url: new URL('https://campaign.example/api/projects/p/integrations/social/update'), body });
  // A provider call that waits until the test lets it finish, counting how many requests actually reached the provider.
  const provider = { calls: 0, release: () => {} };
  const gate = new Promise(resolve => { provider.release = resolve; });
  provider.call = async () => { provider.calls++; await gate; return { sent: true }; };
  return { ...database, context, provider };
}
// Waits until one request has settled or a second one reached the provider, so a duplicate send fails instead of hanging.
async function settleOrDuplicate(requests, provider) {
  let settled = false; for (const request of requests) request.then(() => { settled = true; });
  for (const deadline = Date.now() + 10000; !settled && provider.calls < 2 && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 10));
  provider.release();
}
const outcome = promise => promise.then(result => ({ status: result.status, code: result.data.error?.code ?? 'sent' }), error => ({ status: error.status, code: error instanceof IntegrationError ? error.code : 'unexpected:' + (error.cause?.code || error.message) }));

test('a parallel retry of one idempotency key reaches the provider once', pg, async t => {
  const { pool, context, provider } = await fixture(t);
  // Without the key lock both requests find no receipt and the second insert fails instead of reporting the first as pending.
  const gate = await blockWrites(pool, 'integration_operations');
  const requests = [outcome(operation(context('same-key-123'), provider.call)), outcome(operation(context('same-key-123'), provider.call))];
  await gate.waiting(2); await gate.release();
  await settleOrDuplicate(requests, provider);
  const results = await Promise.all(requests), second = results.find(result => result.code !== 'sent');
  assert.equal(provider.calls, 1);
  assert.deepEqual(results.map(result => result.code).sort(), ['OPERATION_UNCERTAIN', 'sent']);
  assert.equal(second.code, 'OPERATION_UNCERTAIN');
  assert.equal((await pool.query('SELECT count(*) AS count FROM integration_operations')).rows[0].count, 1);
});

test('parallel actions on one provider resource send once and record the other as not sent', pg, async t => {
  const { pool, context, provider } = await fixture(t);
  const resource = { post: 'post-1' };
  // Without the resource lock both claims see no pending action for the resource and both reach the provider.
  const gate = await blockWrites(pool, 'integration_operations');
  const requests = [outcome(operation(context('resource-key-a'), provider.call, resource)), outcome(operation(context('resource-key-b', { name: 'other' }), provider.call, resource))];
  await gate.waiting(2); await gate.release();
  await settleOrDuplicate(requests, provider);
  const results = await Promise.all(requests);
  assert.equal(provider.calls, 1);
  assert.deepEqual(results.map(result => result.code).sort(), ['OPERATION_NOT_SENT', 'sent']);
  assert.deepEqual((await pool.query('SELECT status FROM integration_operations ORDER BY status')).rows.map(row => row.status), ['complete', 'failed']);
});

test('an uncertain receipt blocks automatic retries and new actions on its resource until reviewed once', pg, async t => {
  const { pool, db, context } = await fixture(t);
  const resource = { post: 'post-2' };
  // The provider accepted the request, then the connection died before its reply: a crash between send and receipt.
  let sent = 0; const send = async () => { sent++; return { accepted: true }; };
  const lost = await operation(context('uncertain-key-1'), async () => { await send(); throw new Error('connection reset after send'); }, resource);
  assert.equal(sent, 1); assert.equal(lost.status, 409); assert.equal(lost.data.operation.status, 'uncertain'); assert.notEqual(lost.data.operation.status, 'failed');
  assert.equal((await pool.query('SELECT status FROM integration_operations WHERE id = $1', [lost.data.operation.id])).rows[0].status, 'uncertain');
  await assert.rejects(operation(context('uncertain-key-1'), send, resource), { code: 'OPERATION_UNCERTAIN' });
  assert.equal((await operation(context('uncertain-key-2', { name: 'new' }), send, resource)).data.error.code, 'OPERATION_NOT_SENT');
  assert.equal((await operation(context('uncertain-key-4'), send, resource)).data.error.code, 'OPERATION_NOT_SENT', 'The same request under a new key is blocked too.');
  assert.equal(sent, 1, 'No retry may reach the provider before the uncertain receipt is reviewed.');
  const review = (note) => {
    let sent; const send = (status, data) => { sent = { status, data }; };
    return handleOperationRecovery({ db, project: { id: 'p' }, role: 'owner', user: { id: 'operator', isOperator: true }, send, req: { method: 'POST' }, url: new URL(`https://campaign.example/api/projects/p/operations/${lost.data.operation.id}/review`), body: { resolution: 'not_applied', confirmChecked: true, note } }).then(() => sent, error => ({ status: error.status, data: { error: { code: error.code } } }));
  };
  // Two different reviews arrive together; the receipt row lock records exactly one and refuses the other.
  const gate = await blockWrites(pool, 'integration_operation_reviews');
  const reviews = [review('Checked the provider dashboard: not applied.'), review('A different reviewer note for the same receipt.')];
  await gate.waiting(2); await gate.release();
  assert.deepEqual((await Promise.all(reviews)).map(result => result.status).sort(), [200, 409]);
  assert.equal((await pool.query('SELECT count(*) AS count FROM integration_operation_reviews')).rows[0].count, 1);
  assert.equal((await pool.query('SELECT status FROM integration_operations WHERE id = $1', [lost.data.operation.id])).rows[0].status, 'reviewed-not-applied');
  assert.equal((await operation(context('uncertain-key-3', { name: 'after review' }), async () => ({ ok: true }), resource)).status, 200);
});

test('a provider resource fence admits one holder at a time and stays held while its outcome is unresolved', pg, async t => {
  const { pool, db } = await fixture(t);
  const receipt = (key, status) => pool.query("INSERT INTO integration_operations (id, project_id, request_key, request_hash, status, created_at) VALUES ($1, 'p', $1, 'hash', $2, 'now')", [key, status]);
  for (const key of ['fence-a', 'fence-b', 'fence-c']) await receipt(key, 'pending');
  // Both claims find the resource free before either commits; only the single conditional upsert keeps one holder.
  const gate = await blockWrites(pool, 'zernio_webhook_mutations');
  const claims = [claimFence(db, 'zernio_webhook_mutations', 'webhook-1', 'p', 'fence-a'), claimFence(db, 'zernio_webhook_mutations', 'webhook-1', 'p', 'fence-b')];
  await gate.waiting(2); await gate.release();
  assert.deepEqual((await Promise.all(claims)).sort(), [false, true]);
  const holder = (await pool.query("SELECT request_key FROM zernio_webhook_mutations WHERE resource = 'webhook-1'")).rows[0].request_key;
  await pool.query("UPDATE integration_operations SET status = 'uncertain' WHERE request_key = $1", [holder]);
  assert.equal(await claimFence(db, 'zernio_webhook_mutations', 'webhook-1', 'p', 'fence-c'), false, 'An uncertain holder keeps the fence.');
  await pool.query("UPDATE integration_operations SET status = 'reviewed-not-applied' WHERE request_key = $1", [holder]);
  assert.equal(await claimFence(db, 'zernio_webhook_mutations', 'webhook-1', 'p', 'fence-c'), true, 'A reviewed holder releases the fence to the next action.');
  await releaseFence(db, 'zernio_webhook_mutations', 'webhook-1', 'p', 'fence-c');
  assert.equal((await pool.query('SELECT count(*) AS count FROM zernio_webhook_mutations')).rows[0].count, 0);
  await receipt('lead-a', 'pending'); await receipt('lead-b', 'pending');
  assert.equal(await claimFence(db, 'zernio_lead_mutations', 'p', 'p', 'lead-a', 'project_id'), true);
  assert.equal(await claimFence(db, 'zernio_lead_mutations', 'p', 'p', 'lead-b', 'project_id'), false, 'Project-keyed fences behave the same way.');
});

test('an identical request under a different key, without a resource key, reaches the provider once', pg, async t => {
  const { pool, context, provider } = await fixture(t);
  // Both claims find no receipt for this request before either commits; only the request-hash lock lets the second see the first.
  const gate = await blockWrites(pool, 'integration_operations');
  const requests = [outcome(operation(context('identical-key-a'), provider.call)), outcome(operation(context('identical-key-b'), provider.call))];
  await gate.waiting(2); await gate.release();
  await settleOrDuplicate(requests, provider);
  const results = await Promise.all(requests);
  assert.equal(provider.calls, 1);
  assert.deepEqual(results.map(result => result.code).sort(), ['OPERATION_NOT_SENT', 'sent']);
});
