import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../server/database.ts';
import { createApp } from '../server/index.ts';

const cli = fileURLToPath(new URL('../server/cli.ts', import.meta.url));
function runCli(dataDir, command, input) {
  // Honor explicit source-control preloads in the CLI child as well as the test process.
  const preloads = process.execArgv.flatMap((value, index, values) => value === '--import' ? [value, values[index + 1]] : []);
  return spawnSync(process.execPath, [...preloads, cli, command], { input: JSON.stringify(input), env: { DATA_DIR: dataDir }, encoding: 'utf8', timeout: 120000 });
}
function seed(db) {
  db.exec("INSERT INTO users VALUES('owner','Owner','owner@example.test','preserved-owner-hash'),('member','Member','member@example.test','preserved-member-hash'); INSERT INTO instance_operators VALUES('owner'); INSERT INTO workspaces VALUES('workspace','Workspace'); INSERT INTO memberships VALUES('workspace','owner','owner'),('workspace','member','editor');");
}
const history = db => db.prepare('SELECT * FROM instance_operator_audit ORDER BY rowid').all().map(row => ({ ...row }));

test('native host CLI persists command audits including idempotent repeats while preserving upgrade identities without invented history', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'campaign-operator-upgrade-')); let db;
  try {
    db = openDatabase(dataDir); seed(db); db.exec('DROP TABLE IF EXISTS instance_operator_audit'); db.close(); db = openDatabase(dataDir);
    assert.equal(db.prepare('SELECT user_id FROM instance_operators').get().user_id, 'owner');
    let result = runCli(dataDir, 'grant-operator', { email: 'member@example.test' }); assert.equal(result.status, 0, result.stderr);
    assert.equal(db.prepare("SELECT user_id FROM instance_operators WHERE user_id='member'").get()?.user_id, 'member', 'The native host grant must actually persist operator authority.');
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='instance_operator_audit'").get()?.name, 'instance_operator_audit', 'An actual host grant must leave persisted audit history.');
    let rows = history(db); assert.equal(rows.length, 1, 'Pre-upgrade grants must not acquire invented audit events.');
    assert.equal(rows[0].user_id, 'member'); assert.equal(rows[0].action, 'grant'); assert.equal(rows[0].source, 'host'); assert(Number.isSafeInteger(rows[0].created_at));
    const first = rows[0];
    for (const email of ['member@example.test', 'owner@example.test']) assert.equal(runCli(dataDir, 'grant-operator', { email }).status, 0);
    assert.equal(history(db).length, 3, 'Every successful host invocation records its command, including an already granted role.');
    assert.equal(runCli(dataDir, 'revoke-operator', { email: 'member@example.test' }).status, 0);
    assert.equal(runCli(dataDir, 'revoke-operator', { email: 'member@example.test' }).status, 0);
    assert.deepEqual(history(db).map(row => row.action), ['grant', 'grant', 'grant', 'revoke', 'revoke']); assert.deepEqual(history(db)[0], first);
    assert.equal(runCli(dataDir, 'revoke-operator', { email: 'owner@example.test' }).status, 0, 'Host recovery permits revoking the final operator.');
    assert.equal(db.prepare('SELECT count(*) AS count FROM instance_operators').get().count, 0);
    assert.equal(runCli(dataDir, 'grant-operator', { email: 'owner@example.test' }).status, 0);
    db.close(); db = openDatabase(dataDir); rows = history(db);
    assert.deepEqual(rows.map(row => row.action), ['grant', 'grant', 'grant', 'revoke', 'revoke', 'revoke', 'grant']); assert.deepEqual(rows[0], first);
    assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
    assert.deepEqual(db.prepare('SELECT id,password FROM users ORDER BY id').all().map(row => ({ ...row })), [{ id: 'member', password: 'preserved-member-hash' }, { id: 'owner', password: 'preserved-owner-hash' }]);
    assert.deepEqual(db.prepare('SELECT user_id,role FROM memberships ORDER BY user_id').all().map(row => ({ ...row })), [{ user_id: 'member', role: 'editor' }, { user_id: 'owner', role: 'owner' }]);
  } finally { db?.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('native CLI audit insertion failure rolls back grants and revocations and fails no-op commands atomically', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'campaign-operator-rollback-')); const db = openDatabase(dataDir);
  try {
    seed(db); db.exec("CREATE TRIGGER audit_failure BEFORE INSERT ON instance_operator_audit BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;");
    assert.equal(runCli(dataDir, 'grant-operator', { email: 'member@example.test' }).status, 1);
    assert.equal(db.prepare("SELECT user_id FROM instance_operators WHERE user_id='member'").get(), undefined);
    assert.equal(runCli(dataDir, 'revoke-operator', { email: 'owner@example.test' }).status, 1);
    assert.equal(db.prepare("SELECT user_id FROM instance_operators WHERE user_id='owner'").get().user_id, 'owner');
    assert.equal(runCli(dataDir, 'grant-operator', { email: 'owner@example.test' }).status, 1);
    assert.equal(runCli(dataDir, 'revoke-operator', { email: 'member@example.test' }).status, 1);
    assert.equal(history(db).length, 0);
    db.exec('DROP TRIGGER audit_failure');
    assert.equal(runCli(dataDir, 'grant-operator', { email: 'member@example.test' }).status, 0); assert.equal(history(db).length, 1);
  } finally { db.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('native HTTP sessions observe host revocation immediately, retain workspace boundaries and preserve stdin account recovery', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'campaign-operator-http-')), origin = 'http://127.0.0.1:3018';
  const app = createApp({ dataDir, appUrl: origin, env: {}, directScheduler: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  async function request(path, { body, cookie } = {}) {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`, { method: body ? 'POST' : 'GET', headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
  }
  try {
    const password = 'owner fixture original password', nextPassword = 'owner fixture replacement password';
    const setup = await request('/auth/setup', { body: { token: app.config.bootstrapToken, name: 'Owner', email: 'owner@example.test', password, sample: false } }); assert.equal(setup.status, 201);
    const cookie = setup.cookie, state = (await request('/state', { cookie })).data;
    assert.equal(runCli(dataDir, 'revoke-operator', { email: 'owner@example.test' }).status, 0);
    assert.equal((await request('/session', { cookie })).data.user.isOperator, false); assert.equal((await request('/settings/integrations', { cookie })).status, 403);
    assert.equal(app.db.prepare('SELECT role FROM memberships WHERE workspace_id=? AND user_id=?').get(state.workspaces[0].id, setup.data.user.id).role, 'owner');
    assert.equal(runCli(dataDir, 'grant-operator', { email: 'owner@example.test' }).status, 0);
    assert.equal((await request('/session', { cookie })).data.user.isOperator, true); assert.equal((await request('/settings/integrations', { cookie })).status, 200);
    const memberPassword = 'member stdin fixture password';
    const created = runCli(dataDir, 'create-user', { name: 'Member', email: 'member@example.test', password: memberPassword }); assert.equal(created.status, 0, created.stderr); assert.equal((created.stdout + created.stderr).includes(memberPassword), false);
    assert.equal(runCli(dataDir, 'grant-operator', { email: 'member@example.test' }).status, 0);
    const member = await request('/auth/login', { body: { email: 'member@example.test', password: memberPassword } }); assert.equal(member.status, 200);
    assert.equal((await request('/state?projectId=' + state.projectId, { cookie: member.cookie })).status, 404, 'Operator authority must not grant workspace membership.');
    const count = history(app.db).length, reset = runCli(dataDir, 'reset-password', { email: 'owner@example.test', password: nextPassword }); assert.equal(reset.status, 0, reset.stderr); assert.equal((reset.stdout + reset.stderr).includes(nextPassword), false);
    assert.equal((await request('/session', { cookie })).data.user, null);
    assert.equal((await request('/auth/login', { body: { email: 'owner@example.test', password } })).status, 401);
    assert.equal((await request('/auth/login', { body: { email: 'owner@example.test', password: nextPassword } })).status, 200);
    assert.equal(history(app.db).length, count, 'Password recovery must not invent an operator change.');
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
