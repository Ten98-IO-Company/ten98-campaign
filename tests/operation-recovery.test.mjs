import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { operation, IntegrationError } from '../server/provider-core.ts';
import { handleOperationRecovery } from '../server/operation-recovery.ts';

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
    assert.equal((await operation(context('uncertain-key-02'), applied)).data.error.code, 'OPERATION_NOT_SENT'); assert.equal(actionCount, 1);
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
    assert.equal((await operation({ ...different, req: { method: 'POST', headers: { 'idempotency-key': 'applied-new-key-2' } } }, applied)).data.error.code, 'OPERATION_NOT_SENT'); assert.equal(actionCount, countBeforeBlocked);
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
    const legacyBlocked = await operation({ db, project: { id: 'project-legacy' }, req: { method: 'POST', headers: { 'idempotency-key': 'legacy-edited-key' } }, url: new URL('https://example.test/api/projects/project-legacy/integrations/ads/edit'), body: { name: 'Changed legacy request' } }, () => assert.fail('An unidentified legacy pending action must be reviewed first.'), 'legacy-campaign');
    assert.equal(legacyBlocked.status, 409); assert.equal(legacyBlocked.data.error.code, 'OPERATION_NOT_SENT'); assert.equal(legacyBlocked.data.operation.status, 'failed'); assert.notEqual(legacyBlocked.data.operation.id, 'legacy');
    db.prepare("UPDATE integration_operations SET action_path='POST /integrations/ads/status' WHERE id='legacy'").run();
    const siblingBlocked = await operation({ db, project: { id: 'project-legacy' }, req: { method: 'POST', headers: { 'idempotency-key': 'legacy-sibling-key' } }, url: new URL('https://example.test/api/projects/project-legacy/integrations/ads/campaign'), body: { name: 'Another action on the legacy campaign' } }, () => assert.fail('A legacy receipt without a resource binding must also fence sibling actions.'), 'legacy-campaign');
    assert.equal(siblingBlocked.status, 409); assert.notEqual(siblingBlocked.data.operation.id, 'legacy'); assert.equal(siblingBlocked.data.error.code, 'OPERATION_NOT_SENT');
    for (let index = 0; index < 105; index++) db.prepare("INSERT INTO integration_operations(id,project_id,request_key,request_hash,status,created_at) VALUES(?,?,?,?,?,?)").run('done-' + index, 'project-legacy', 'done-key-' + index, 'done-hash-' + index, 'complete', new Date().toISOString());
    await handleOperationRecovery({ req: { method: 'GET' }, url: new URL('https://example.test/api/projects/project-legacy/operations'), project: { id: 'project-legacy' }, role: 'admin', user: { id: 'operator', isOperator: true }, db, send: (status, data) => { result = { status, data }; } });
    assert.equal(result.data.operations.length, 100); assert.equal(result.data.operations[0].id, 'legacy', 'New completed receipts must never hide an older unresolved outcome.');
  } finally { db.close(); }
});

test('product creation recovery exposes only durable operation-scoped native references, including an unknown ID', async () => {
  const db = new DatabaseSync(':memory:'), project = { id: 'product-recovery' };
  const context = (key, title) => ({ db, project, req: { method: 'POST', headers: { 'idempotency-key': key } }, url: new URL('https://example.test/api/projects/product-recovery/integrations/products/store-a/create'), body: { title, secret: 'SECRET_BODY' } });
  try {
    const first = await operation(context('create-known-key', 'Known reference'), () => { throw new IntegrationError(502, 'LOST_READBACK', 'SECRET_ERROR', true); }, 'create-one');
    const second = await operation(context('create-unknown-key', 'Unknown reference'), () => { throw new IntegrationError(502, 'LOST_ACK', 'SECRET_ERROR', true); }, 'create-two');
    db.exec('CREATE TABLE zernio_product_create_receipts(project_id TEXT NOT NULL,request_key TEXT NOT NULL,account_id TEXT NOT NULL,native_product_id TEXT,PRIMARY KEY(project_id,request_key))');
    const record = db.prepare('INSERT INTO zernio_product_create_receipts VALUES(?,?,?,?)');
    record.run(project.id, 'create-known-key', 'store-a', '9002'); record.run(project.id, 'create-unknown-key', 'store-a', null);
    record.run('foreign-project', 'create-known-key', 'SECRET_FOREIGN_ACCOUNT', 'SECRET_FOREIGN_ID');
    let result;
    const read = async () => { await handleOperationRecovery({ db, project, role: 'owner', user: { id: 'operator', isOperator: true }, req: { method: 'GET' }, url: new URL('https://example.test/api/projects/product-recovery/operations'), send: (status, data) => { result = { status, data }; } }); return result.data.operations; };
    const rows = await read();
    assert.deepEqual(rows.find(row => row.id === first.data.operation.id).productCreation, { accountId: 'store-a', productId: '9002' });
    assert.deepEqual(rows.find(row => row.id === second.data.operation.id).productCreation, { accountId: 'store-a', productId: null });
    assert.equal(JSON.stringify(result).includes('SECRET'), false); assert.equal(JSON.stringify(result).includes('create-known-key'), false);
    db.prepare("UPDATE integration_operations SET status='reviewed-applied' WHERE id=?").run(first.data.operation.id);
    record.run(project.id, 'later-manual-key', 'store-a', '9003');
    assert.equal((await read()).find(row => row.id === first.data.operation.id).productCreation.productId, '9002', 'A later creation cannot erase the original review evidence.');
    db.prepare('UPDATE zernio_product_create_receipts SET native_product_id=? WHERE project_id=? AND request_key=?').run('bad/id', project.id, 'create-known-key');
    assert.equal((await read()).find(row => row.id === first.data.operation.id).productCreation.productId, null);
  } finally { db.close(); }
});

test('campaign copy recovery preserves only its own bounded reported reference across reopening and renders it as unverified text', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ten98-copy-recovery-')), filename = join(directory, 'operations.sqlite'), project = { id: 'copy-recovery' };
  let db = new DatabaseSync(filename), response;
  const context = key => ({ db, project, req: { method: 'POST', headers: { 'idempotency-key': key } }, url: new URL('https://example.test/api/projects/copy-recovery/integrations/ads/copy'), body: { name: key, secret: 'PRIVATE_BODY' } });
  const read = async () => { await handleOperationRecovery({ db, project, role: 'owner', user: { id: 'operator', isOperator: true }, req: { method: 'GET' }, url: new URL('https://example.test/api/projects/copy-recovery/operations'), send(status, data) { response = { status, data }; } }); assert.equal(response.status, 200); return response.data.operations; };
  try {
    const uncertain = await operation(context('private-copy-key'), () => { throw new IntegrationError(502, 'PRIVATE_CODE', 'PRIVATE_ERROR', true); }, 'copy-source');
    const complete = await operation(context('private-complete-key'), () => ({}), 'copy-complete');
    db.exec('CREATE TABLE zernio_campaign_copy_receipts(project_id TEXT NOT NULL,request_key TEXT NOT NULL,profile_id TEXT NOT NULL,source_campaign_id TEXT NOT NULL,platform TEXT NOT NULL,account_id TEXT NOT NULL,native_advertiser_id TEXT NOT NULL,resource TEXT NOT NULL,copied_campaign_id TEXT,discovery TEXT,verification TEXT NOT NULL DEFAULT \'pending\',status_read_at TEXT,PRIMARY KEY(project_id,request_key))');
    const insert = db.prepare('INSERT INTO zernio_campaign_copy_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
    insert.run(project.id, 'private-copy-key', 'PRIVATE_PROFILE', 'source-campaign', 'facebook', 'PRIVATE_ACCOUNT', 'PRIVATE_ADVERTISER', 'PRIVATE_RESOURCE', 'copy-<img=bad>', 'triggered', 'paused', '2026-10-19T12:00:00Z');
    insert.run(project.id, 'private-complete-key', 'PRIVATE_PROFILE', 'complete-source', 'tiktok', 'PRIVATE_ACCOUNT', 'PRIVATE_ADVERTISER', 'PRIVATE_RESOURCE', 'complete-copy', 'skipped', 'paused', '2026-10-19T12:00:00Z');
    insert.run('foreign-project', 'private-copy-key', 'PRIVATE_PROFILE', 'PRIVATE_FOREIGN_SOURCE', 'facebook', 'PRIVATE_ACCOUNT', 'PRIVATE_ADVERTISER', 'PRIVATE_RESOURCE', 'PRIVATE_FOREIGN_COPY', 'triggered', 'paused', '2026-10-19T12:00:00Z');
    db.prepare('UPDATE integration_operations SET response=? WHERE id=?').run('{"private":"PRIVATE_ORIGINAL_RESPONSE"}', uncertain.data.operation.id);
    db.close(); db = new DatabaseSync(filename);
    const rows = await read(), receipt = rows.find(row => row.id === uncertain.data.operation.id), confirmed = rows.find(row => row.id === complete.data.operation.id);
    assert.deepEqual(receipt.campaignCopy, { sourceCampaignId: 'source-campaign', platform: 'facebook', copiedCampaignId: 'copy-<img=bad>', discovery: 'triggered', requestedStatus: 'PAUSED', verification: 'pending', statusReadAt: null });
    assert.equal(confirmed.campaignCopy.verification, 'paused'); assert.equal(confirmed.campaignCopy.statusReadAt, '2026-10-19T12:00:00Z');
    for (const secret of ['PRIVATE_', 'private-copy-key', 'private-complete-key', 'request_key', 'response']) assert.equal(JSON.stringify(response).includes(secret), false, secret);
    let foreign;
    await handleOperationRecovery({ db, project: { id: 'other-project' }, role: 'admin', user: { id: 'operator', isOperator: true }, req: { method: 'GET' }, url: new URL('https://example.test/api/projects/other-project/operations'), send(_status, data) { foreign = data; } }); assert.deepEqual(foreign.operations, []);
    const [{ default: React }, { renderToStaticMarkup }, { transformWithOxc }] = await Promise.all([import('react'), import('react-dom/server'), import('vite')]);
    const source = readFileSync(new URL('../src/OperationRecovery.tsx', import.meta.url), 'utf8').replace(/^import .+;\r?\n/gm, '').replace('export default function ', 'function ');
    const { code } = await transformWithOxc(source, 'OperationRecoveryCheck.tsx', { jsx: { runtime: 'classic' } }); let stateIndex = 0;
    const { AppField } = await import('@ten98/ui/app');
    const Component = new Function('React', 'useState', 'useRef', 'useEffect', 'AppField', code + ';return OperationRecovery;')(React, initial => [stateIndex++ === 0 ? [receipt] : initial, () => assert.fail('Rendering does not update state')], value => ({ current: value }), () => {}, AppField);
    const html = renderToStaticMarkup(React.createElement(Component, { projectId: project.id, role: 'owner', isOperator: true, request: () => assert.fail('Rendering does not contact a provider') }));
    assert.match(html, /Provider-reported copied campaign ID: copy-&lt;img=bad&gt;/); assert.match(html, /Recorded verification: Not verified/); assert.match(html, /Check the provider directly before recording the final review/); assert.doesNotMatch(html, /<img|<a\s|PRIVATE_/);
    for (const [field, value, expected] of [['copied_campaign_id', 'bad/id', 'null'], ['copied_campaign_id', 'source-campaign', 'null'], ['discovery', 'PRIVATE_INVALID_DISCOVERY', 'discovery'], ['source_campaign_id', 'bad/source', 'absent'], ['platform', 'PRIVATE_INVALID_PLATFORM', 'absent'], ['platform', 'google', 'absent'], ['platform', 'twitter', 'absent']]) {
      db.prepare('UPDATE zernio_campaign_copy_receipts SET copied_campaign_id=?,discovery=?,source_campaign_id=?,platform=? WHERE project_id=? AND request_key=?').run('copy-<img=bad>', 'triggered', 'source-campaign', 'facebook', project.id, 'private-copy-key');
      db.prepare(`UPDATE zernio_campaign_copy_receipts SET ${field}=? WHERE project_id=? AND request_key=?`).run(value, project.id, 'private-copy-key');
      const copy = (await read()).find(row => row.id === receipt.id).campaignCopy;
      if (expected === 'absent') assert.equal(copy, undefined); else if (expected === 'discovery') assert.equal(copy.discovery, null); else assert.equal(copy.copiedCampaignId, null);
      assert.equal(JSON.stringify(response).includes('PRIVATE_'), false);
    }
    db.prepare("UPDATE zernio_campaign_copy_receipts SET platform='linkedin' WHERE project_id=? AND request_key=?").run(project.id, 'private-complete-key');
    const linkedIn = (await read()).find(row => row.id === confirmed.id).campaignCopy;
    assert.equal(linkedIn.verification, 'pending'); assert.equal(linkedIn.statusReadAt, null, 'LinkedIn has no supported live paused readback in this flow.');
    db.prepare("UPDATE zernio_campaign_copy_receipts SET platform='tiktok',status_read_at=? WHERE project_id=? AND request_key=?").run('2026-02-30T12:00:00Z', project.id, 'private-complete-key');
    assert.equal((await read()).find(row => row.id === confirmed.id).campaignCopy.verification, 'pending');
    db.prepare('UPDATE zernio_campaign_copy_receipts SET status_read_at=? WHERE project_id=? AND request_key=?').run('2026-10-19T12:00:00Z', project.id, 'private-complete-key');
    db.prepare("UPDATE integration_operations SET status='reviewed-applied' WHERE id=?").run(confirmed.id);
    assert.equal((await read()).find(row => row.id === confirmed.id).campaignCopy.verification, 'pending', 'An operator assessment cannot become native paused proof.');
  } finally { db?.close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); rmSync(directory, { recursive: true, force: true }); }
});

test('uncertain provider outcomes survive SQLite reopening and require review before a new action', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ten98-operation-reopen-')), filename = join(directory, 'operations.sqlite');
  const project = { id: 'project-reopen' }, body = { name: 'Reopen fixture ad' }, resource = 'fixture-campaign:one';
  let db = new DatabaseSync(filename), writes = 0;
  const context = key => ({ db, project, req: { method: 'POST', headers: { 'idempotency-key': key } }, url: new URL('https://campaign.example/api/projects/project-reopen/integrations/ads/create'), body });
  const applied = () => { writes++; return { result: 'confirmed fixture receipt' }; };
  try {
    const first = await operation(context('reopen-original-key'), () => { writes++; throw new IntegrationError(502, 'LOST_ACKNOWLEDGEMENT', 'The fixture lost the write acknowledgement.', true); }, resource);
    assert.equal(first.status, 409); assert.equal(first.data.operation.status, 'uncertain'); assert.equal(writes, 1);
    db.close(); db = null; db = new DatabaseSync(filename);
    assert.equal(db.prepare('SELECT status FROM integration_operations WHERE id=?').get(first.data.operation.id).status, 'uncertain');
    await assert.rejects(operation(context('reopen-original-key'), applied, resource), error => error.code === 'OPERATION_UNCERTAIN');
    const blocked = await operation(context('reopen-fresh-key'), applied, resource);
    assert.equal(blocked.data.error.code, 'OPERATION_NOT_SENT'); assert.equal(blocked.data.operation.status, 'failed');
    const changed = await operation({ ...context('reopen-edited-key'), body: { name: 'Changed draft for the same campaign' } }, applied, resource);
    assert.equal(changed.status, 409); assert.equal(changed.data.error.code, 'OPERATION_NOT_SENT'); assert.notEqual(changed.data.operation.id, first.data.operation.id);
    assert.equal(writes, 1, 'Reopening SQLite must not lose the original-key or fresh-key write fence.');
    let review;
    await handleOperationRecovery({ db, project, role: 'owner', user: { id: 'operator-reopen', isOperator: true }, req: { method: 'POST' }, url: new URL(`https://campaign.example/api/projects/project-reopen/operations/${first.data.operation.id}/review`), body: { resolution: 'not_applied', confirmChecked: true, note: 'Checked the synthetic provider receipt history.' }, send(status, data) { review = { status, data }; } });
    assert.equal(review.status, 200); assert.equal(review.data.operation.status, 'reviewed-not-applied'); assert.equal(writes, 1, 'Review must never replay the provider action.');
    const closed = await operation(context('reopen-original-key'), applied, resource); assert.equal(closed.status, 409); assert.equal(closed.data.error.code, 'OPERATION_REVIEWED');
    db.close(); db = new DatabaseSync(filename);
    assert.deepEqual(await operation(context('reopen-fresh-key'), applied, resource), blocked);
    assert.deepEqual(await operation({ ...context('reopen-edited-key'), body: { name: 'Changed draft for the same campaign' } }, applied, resource), changed);
    assert.equal(writes, 1, 'Neither blocked key may dispatch after operator closure or reopening SQLite.');
    const fresh = await operation(context('reopen-deliberate-key'), applied, resource); assert.equal(fresh.status, 200); assert.equal(writes, 2);
    assert.deepEqual(await operation(context('reopen-deliberate-key'), applied, resource), fresh); assert.equal(writes, 2, 'Replaying the deliberate action returns its receipt without another write.');
  } finally { db?.close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); rmSync(directory, { recursive: true, force: true }); }
});


test('a key blocked by an active sibling remains terminal after that sibling completes', async () => {
  const db = new DatabaseSync(':memory:'), project = { id: 'active-sibling' };
  const context = (key, action) => ({ db, project, req: { method: 'POST', headers: { 'idempotency-key': key } }, url: new URL('https://campaign.example/api/projects/active-sibling/integrations/products/store/9001/' + action), body: { version: 'reviewed-' + action } });
  let finish, writes = 0;
  try {
    const first = operation(context('active-price-key', 'price'), async () => { writes++; await new Promise(resolve => { finish = resolve; }); return { readback: true }; }, 'same-native-product');
    const blocked = await operation(context('blocked-state-key', 'deactivate'), () => { writes++; }, 'same-native-product');
    assert.equal(blocked.data.error.code, 'OPERATION_NOT_SENT'); assert.equal(blocked.data.operation.status, 'failed'); assert.equal(writes, 1);
    finish(); await first;
    assert.deepEqual(await operation(context('blocked-state-key', 'deactivate'), () => { writes++; }, 'same-native-product'), blocked);
    assert.equal(writes, 1, 'Checking the blocked key must not become a first state mutation.');
    assert.equal((await operation(context('fresh-state-review', 'deactivate'), () => { writes++; return { readback: true }; }, 'same-native-product')).status, 200);
    assert.equal(writes, 2);
  } finally { finish?.(); db.close(); }
});
