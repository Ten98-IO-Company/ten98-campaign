import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { operation, IntegrationError } from '../server/integrations.mjs';
import { handleOperationRecovery } from '../server/operation-recovery.mjs';

test('provider recovery is scoped, audited, read-only and final; only a checked not-applied review permits a fresh manual action', async () => {
  const db = new DatabaseSync(':memory:'), originalFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail('Recovery must never contact a provider.');
  const project = { id: 'project-a' }, user = { id: 'operator-a', isOperator: true }, body = { name: 'Example ad', apiKey: 'SECRET_REQUEST_BODY' };
  let actionCount = 0;
  const context = (key, overrides = {}) => ({ db, project, req: { method: 'POST', headers: { 'idempotency-key': key } }, url: new URL('https://campaign.example/api/projects/project-a/integrations/ads/create?api_key=SECRET_QUERY'), body, ...overrides });
  const uncertain = () => { actionCount++; throw new IntegrationError(502, 'PRIVATE_PROVIDER_CODE', 'SECRET_PROVIDER_ERROR', true); };
  const applied = () => { actionCount++; return { result: 'provider receipt' }; };
  async function reviewRequest(suffix = '', { method = 'GET', body = {}, project: selectedProject = project, role = 'owner', selectedUser = user } = {}) {
    let response;
    try {
      const handled = await handleOperationRecovery({ db, project: selectedProject, role, user: selectedUser, req: { method }, url: new URL(`https://campaign.example/api/projects/${selectedProject.id}/operations${suffix}`), body, send(status, data) { response = { status, data }; } });
      assert.equal(handled, true); return response;
    } catch (error) { if (error instanceof IntegrationError) return { status: error.status, data: { error: { code: error.code, message: error.message } } }; throw error; }
  }
  const resolution = (value = 'not_applied') => ({ resolution: value, confirmChecked: true, note: 'Checked the provider dashboard and receipt history.', reference: 'provider-reference-123' });
  try {
    for (const options of [{ role: 'viewer' }, { role: 'editor' }, { selectedUser: { id: 'admin-only', isOperator: false }, role: 'admin' }, { selectedUser: null }]) assert.equal((await reviewRequest('', options)).status, 403);
    const first = await operation(context('uncertain-key-01'), uncertain), id = first.data.operation.id;
    assert.equal(first.data.operation.status, 'uncertain'); assert.equal(actionCount, 1);
    const receipt = db.prepare('SELECT response,http_status FROM integration_operations WHERE id=?').get(id);
    let result = await reviewRequest(); assert.equal(result.status, 200); assert.equal(result.data.operations[0].canReview, true); assert.equal(result.data.operations[0].action, 'POST /integrations/ads/create');
    const publicList = JSON.stringify(result.data);
    for (const secret of ['SECRET_REQUEST_BODY', 'SECRET_QUERY', 'SECRET_PROVIDER_ERROR', 'PRIVATE_PROVIDER_CODE', 'uncertain-key-01', 'request_hash', 'request_key', 'response']) assert.equal(publicList.includes(secret), false);
    assert.deepEqual((await reviewRequest('', { project: { id: 'project-b' } })).data.operations, []);
    assert.equal((await reviewRequest('/' + id + '/review', { method: 'POST', project: { id: 'project-b' }, body: resolution() })).status, 404);
    await assert.rejects(operation(context('uncertain-key-02'), applied), error => error.code === 'OPERATION_UNCERTAIN'); assert.equal(actionCount, 1);
    for (const invalid of [{ ...resolution(), confirmChecked: false }, { ...resolution(), note: 'short' }, { ...resolution(), resolution: 'retry' }, { ...resolution(), automaticRetry: true }]) assert.equal((await reviewRequest('/' + id + '/review', { method: 'POST', body: invalid })).status, 400);
    result = await reviewRequest('/' + id + '/review', { method: 'POST', body: resolution() }); assert.equal(result.status, 200); assert.equal(result.data.operation.status, 'reviewed-not-applied');
    assert.equal(result.data.operation.review.reviewerId, user.id); assert.equal(result.data.operation.review.resolution, 'not_applied'); assert.equal(result.data.operation.review.reference, 'provider-reference-123');
    assert.deepEqual(db.prepare('SELECT response,http_status FROM integration_operations WHERE id=?').get(id), receipt, 'Operator review must preserve the original provider receipt.');
    assert.equal((await reviewRequest('/' + id + '/review', { method: 'POST', body: resolution() })).status, 200); assert.equal(db.prepare('SELECT count(*) AS count FROM integration_operation_reviews').get().count, 1);
    assert.equal((await reviewRequest('/' + id + '/review', { method: 'POST', body: resolution('applied') })).status, 409);
    const oldKey = await operation(context('uncertain-key-01'), applied); assert.equal(oldKey.status, 409); assert.equal(oldKey.data.error.code, 'OPERATION_REVIEWED'); assert.equal(actionCount, 1);
    const fresh = await operation(context('fresh-manual-key'), applied); assert.equal(fresh.status, 200); assert.equal(actionCount, 2);
    assert.deepEqual(await operation(context('fresh-manual-key'), applied), fresh); assert.equal(actionCount, 2);
    assert.equal((await reviewRequest('/' + fresh.data.operation.id + '/review', { method: 'POST', body: resolution() })).status, 409);
    const different = context('applied-outcome-1', { body: { name: 'Another ad' } }), externallyApplied = await operation(different, uncertain), appliedId = externallyApplied.data.operation.id;
    assert.equal((await reviewRequest('/' + appliedId + '/review', { method: 'POST', body: resolution('applied') })).status, 200);
    const countBeforeBlocked = actionCount;
    await assert.rejects(operation({ ...different, req: { method: 'POST', headers: { 'idempotency-key': 'applied-new-key-2' } } }, applied), error => error.code === 'OPERATION_UNCERTAIN'); assert.equal(actionCount, countBeforeBlocked);
    assert.equal((await operation(different, applied)).status, 409); assert.equal(actionCount, countBeforeBlocked);
    // Current-process orphaned requests wait ten minutes; old-process requests are explicitly distinguishable after restart.
    const pendingRow = (id, runId, createdAt = new Date().toISOString()) => db.prepare('INSERT INTO integration_operations(id,project_id,request_key,request_hash,status,created_at,action_path,run_id) VALUES(?,?,?,?,?,?,?,?)').run(id, project.id, id + '-key', id + '-hash', 'pending', createdAt, 'POST /calendar/events', runId);
    pendingRow('recent-orphan', operation.runId);
    assert.equal((await reviewRequest('/recent-orphan/review', { method: 'POST', body: resolution() })).status, 409);
    db.prepare('UPDATE integration_operations SET created_at=? WHERE id=?').run(new Date(Date.now() - 11 * 60000).toISOString(), 'recent-orphan');
    assert.equal((await reviewRequest('/recent-orphan/review', { method: 'POST', body: resolution() })).status, 200);
    pendingRow('previous-process', 'previous-process-run-id');
    assert.equal((await reviewRequest('/previous-process/review', { method: 'POST', body: resolution('applied') })).status, 200);
    let release;
    const running = operation(context('running-key-001', { body: { name: 'In flight' } }), async () => { actionCount++; await new Promise(resolve => { release = resolve; }); return { result: 'confirmed later' }; });
    const inFlight = db.prepare('SELECT * FROM integration_operations WHERE request_key=?').get('running-key-001');
    db.prepare('UPDATE integration_operations SET created_at=?,run_id=? WHERE id=?').run(new Date(Date.now() - 30 * 60000).toISOString(), 'older-process-id', inFlight.id);
    result = await reviewRequest(); assert.equal(result.data.operations.find(row => row.id === inFlight.id).canReview, false);
    assert.equal((await reviewRequest('/' + inFlight.id + '/review', { method: 'POST', body: resolution() })).status, 409);
    release(); assert.equal((await running).status, 200);
    // Even an out-of-band close must not be overwritten when a delayed action completes.
    let finish;
    const delayed = operation(context('late-finish-key', { body: { name: 'Delayed finish' } }), async () => { await new Promise(resolve => { finish = resolve; }); return { result: 'late receipt' }; });
    const delayedId = db.prepare('SELECT id FROM integration_operations WHERE request_key=?').get('late-finish-key').id;
    db.prepare("UPDATE integration_operations SET status='reviewed-applied' WHERE id=?").run(delayedId);
    finish(); await assert.rejects(delayed, error => error.code === 'OPERATION_REVIEWED');
    assert.equal(db.prepare('SELECT status,response FROM integration_operations WHERE id=?').get(delayedId).status, 'reviewed-applied'); assert.equal(db.prepare('SELECT response FROM integration_operations WHERE id=?').get(delayedId).response, null);
  } finally { globalThis.fetch = originalFetch; db.close(); }
});

test('recovery migrates older receipts without exposing their stored payloads', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE integration_operations(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_key TEXT NOT NULL,request_hash TEXT NOT NULL,status TEXT NOT NULL,response TEXT,http_status INTEGER,created_at TEXT NOT NULL,UNIQUE(project_id,request_key));
    INSERT INTO integration_operations VALUES('legacy','project-legacy','SECRET_OLD_KEY','SECRET_HASH','pending','SECRET_ORIGINAL_RESPONSE',409,'2020-01-01T00:00:00Z');`);
  try {
    let result;
    await handleOperationRecovery({ req: { method: 'GET' }, url: new URL('https://example.test/api/projects/project-legacy/operations'), project: { id: 'project-legacy' }, role: 'admin', user: { id: 'operator', isOperator: true }, db, send: (status, data) => { result = { status, data }; } });
    assert.equal(result.status, 200); assert.equal(result.data.operations[0].action, 'Earlier provider action'); assert.equal(result.data.operations[0].canReview, true); assert.equal(JSON.stringify(result).includes('SECRET'), false);
    assert.ok(db.prepare('PRAGMA table_info(integration_operations)').all().some(column => column.name === 'action_path'));
    for (let index = 0; index < 105; index++) db.prepare("INSERT INTO integration_operations(id,project_id,request_key,request_hash,status,created_at) VALUES(?,?,?,?,?,?)").run('done-' + index, 'project-legacy', 'done-key-' + index, 'done-hash-' + index, 'complete', new Date().toISOString());
    await handleOperationRecovery({ req: { method: 'GET' }, url: new URL('https://example.test/api/projects/project-legacy/operations'), project: { id: 'project-legacy' }, role: 'admin', user: { id: 'operator', isOperator: true }, db, send: (status, data) => { result = { status, data }; } });
    assert.equal(result.data.operations.length, 100); assert.equal(result.data.operations[0].id, 'legacy', 'New completed receipts must never hide an older unresolved outcome.');
  } finally { db.close(); }
});
