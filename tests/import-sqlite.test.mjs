import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { connect } from '../server/database.ts';
import { fingerprintDatabase } from '../server/import-sqlite.ts';
import { postgresSkip, testDatabase } from './postgres.mjs';

const pgOnly = { skip: postgresSkip };
const cli = fileURLToPath(new URL('../server/cli.ts', import.meta.url));
const fixture = new URL('./fixtures/sqlite-0.8.12-schema.sql', import.meta.url);
const ephemeral = ['sessions', 'oidc_flows', 'oidc_return_targets', 'login_limits'];
const passwordHash = 'scrypt$16384$8$1$c2FsdC1mb3ItdGVzdHM$ZXhhY3QtZGVyaXZlZC1rZXktYnl0ZXMtZm9yLXRoZS1yb3VuZC10cmlw';
const oddJson = '{"z":1,"id":"r1","a":{"y":[3,{"d":4,"c":5}],"b":null},"title":"Ünïcode ✓", "spaced" : true }';

function runCli(url, ...args) {
  // Honor explicit source-control preloads in the CLI child as well as the test process.
  const preloads = process.execArgv.flatMap((value, index, values) => value === '--import' ? [value, values[index + 1]] : []);
  return spawnSync(process.execPath, [...preloads, cli, ...args], { env: url ? { DATABASE_URL: url } : {}, encoding: 'utf8', timeout: 120000 });
}

const seed = `
INSERT INTO installation VALUES (1, 0);
INSERT INTO users VALUES ('owner','Owner','owner@example.test','${passwordHash}'),('member','Member','member@example.test',NULL);
INSERT INTO oidc_identities VALUES ('https://idp.example.test/realms/campaign','subject-0001','member');
INSERT INTO instance_operators VALUES ('owner');
INSERT INTO instance_operator_audit VALUES ('audit-1','owner','bootstrap','bootstrap',1760000000000),('audit-2','member','grant','host',1760000001000),('audit-3','member','revoke','host',1760000002000);
INSERT INTO workspaces VALUES ('ws','Workspace');
INSERT INTO memberships VALUES ('ws','owner','owner'),('ws','member','editor');
INSERT INTO workspace_invitations VALUES ('inv-1','ws','guest@example.test','viewer','owner','token-hash-1',1760000000000,1760600000000,NULL,NULL);
INSERT INTO projects VALUES ('p1','ws','Launch','#123456','zernio-profile-1','drive-folder-1'),('p2','ws','Second','#5943ce','','');
INSERT INTO records VALUES ('r1','p1','posts','${oddJson}'),('r2','p1','campaigns','{"id":"r2","name":"Spring","projectId":"p1"}'),('r3','p2','assets','[1,2,{"b":1,"a":2}]');
DELETE FROM records WHERE id = 'r2';
INSERT INTO records VALUES ('r2','p1','campaigns','{"id":"r2","name":"Spring","projectId":"p1"}');
INSERT INTO activity VALUES ('act-1','p1','Sample project created','2026-01-01T00:00:00.000Z',1),('act-2','p1','Post scheduled','2026-01-02T00:00:00.000Z',0);
INSERT INTO campaign_links VALUES ('l1','p1','abc123','Spring','https://example.test/spring','r2','https://go.example.test',0,'2026-01-03T00:00:00.000Z'),('l2','p1','def456','Old','https://example.test/spring','r2','https://go.example.test',1,'2026-01-04T00:00:00.000Z');
INSERT INTO campaign_link_daily VALUES ('l1','2026-01-05',7,2);
INSERT INTO project_approval_policy VALUES ('p1',1,'owner','2026-01-05T00:00:00.000Z');
INSERT INTO post_approval_reviews VALUES ('rev-1','p1','r1','fp-1','${oddJson}','approved','member','2026-01-05T00:00:00.000Z','owner','2026-01-05T01:00:00.000Z','');
INSERT INTO integration_operations VALUES ('op-1','p1','key-1','hash-1','complete','{"id":"post-9","status":"scheduled"}',201,'2026-01-06T00:00:00.000Z','/posts','run-1','post:r1'),('op-2','p1','key-2','hash-2','uncertain',NULL,NULL,'2026-01-06T00:01:00.000Z','/ads/budget','','adset:9');
INSERT INTO integration_operation_reviews VALUES ('op-2','p1','owner','not_applied','Checked the provider','ticket-42','2026-01-06T02:00:00.000Z');
INSERT INTO integration_settings VALUES ('zernio',X'000102030405060708090a0b',X'deadbeef00ff',X'0f0e0d0c0b0a09080706050403020100','2026-01-06T00:00:00.000Z');
INSERT INTO zernio_bluesky_mutations VALUES ('bluesky:acct-1','p1','key-3');
INSERT INTO zernio_adset_budget_claims VALUES ('adset:9','p1','key-2');
INSERT INTO zernio_campaign_copy_receipts VALUES ('p1','key-4','zernio-profile-1','cmp-1','meta','acct-1','adv-1','campaign:cmp-1',NULL,NULL,'pending',NULL);
INSERT INTO agent_runs VALUES ('run-1','p1','owner','req-1','in-hash','complete','Draft a post','model-x','{"text":"ok"}','{"input":10,"output":5}',NULL,'2026-01-06T00:00:00.000Z');
INSERT INTO agent_actions VALUES ('action-1','run-1','p1','owner','posts','{"b":2,"a":1}','applied','r1');
INSERT INTO direct_contacts VALUES ('c1','p1','{"email":"lead@example.test","name":"Lead"}');
INSERT INTO direct_campaigns VALUES ('dc1','p1','{"name":"Newsletter","status":"sent"}');
INSERT INTO direct_deliveries VALUES ('dd1','dc1','c1','{"status":"delivered"}');
INSERT INTO zernio_contact_links VALUES ('zl1','p1','zernio-profile-1','acct-1','c1','pc-1','ch-1','instagram','@lead','2026-01-07T00:00:00.000Z');
INSERT INTO zernio_external_post_references VALUES ('p1','zernio-profile-1','acct-1','native-1','platform-post-1','{"url":"https://example.test/p"}','r2','2026-01-07T00:00:00.000Z');
INSERT INTO sms_conversations VALUES ('conv-1','p1','AC1','+15550001','+15550002','MG1','{"unread":1}');
INSERT INTO sms_messages (id,project_id,conversation_id,account_sid,provider_id,data) VALUES ('m1','p1','conv-1','AC1','SM1','{"body":"Hi"}'),('m2','p1','conv-1','AC1','SM2','{"body":"Hello"}');
INSERT INTO project_ooh_inventory VALUES ('p1',9007199254740000,'{"name":"Screen"}');
INSERT INTO website_event_ids VALUES ('p1','evt-1',1760000003000);
INSERT INTO webhook_project_bindings VALUES ('e1','zernio-profile-1','p1');
INSERT INTO webhook_inbox_updates (project_id,profile_id,account_id,event_id,event,data) VALUES ('p1','zernio-profile-1','acct-1','inbox-e1','message.received','{"text":"hi"}');
INSERT INTO sessions VALUES ('session-token-hash','owner',1760000000000);
INSERT INTO oidc_flows VALUES ('state-1','browser-1','verifier-1','nonce-1',1760000000000);
INSERT INTO oidc_return_targets VALUES ('state-1','invite-token-1');
INSERT INTO login_limits VALUES ('ip:127.0.0.1',3,1760000000000);
`;

// Seven webhook events with one ad update each; e3 and the newest (e7) are deleted, leaving a rowid gap and an
// AUTOINCREMENT sequence (7) above the surviving maximum.
function seedWebhooks(source) {
  for (let index = 1; index <= 7; index += 1) {
    source.prepare("INSERT INTO webhook_events (id,event,payload,body_hash,status,received_at) VALUES (?,'ads.updated',?,?,'processed',?)").run(`e${index}`, `{"event":"ads.updated","n":${index}}`, `body-hash-${index}`, `2026-01-0${index}T00:00:00.000Z`);
    source.prepare("INSERT INTO webhook_ad_updates (project_id,profile_id,account_id,platform,ad_account_id,event_id,event_at,event,data) VALUES ('p1','zernio-profile-1','acct-1','meta','adacct-1',?,?,'ads.updated',?)").run(`e${index}`, `2026-01-0${index}T00:00:00.000Z`, `{"n":${index}}`);
  }
  source.exec("DELETE FROM webhook_ad_updates WHERE event_id IN ('e3','e7'); DELETE FROM webhook_events WHERE id IN ('e3','e7');");
}

async function sourceFile(t, change) {
  const directory = await mkdtemp(join(tmpdir(), 'campaign-import-')), file = join(directory, 'campaign.sqlite');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = new DatabaseSync(file);
  try { source.exec(await readFile(fixture, 'utf8')); source.exec(seed); seedWebhooks(source); change?.(source); }
  finally { source.close(); }
  return file;
}

const normalise = value => value === null ? null : typeof value === 'boolean' ? (value ? '1' : '0') : value instanceof Uint8Array ? Buffer.from(value).toString('hex') : String(value);
function sourceTables(file) {
  const source = new DatabaseSync(file, { readOnly: true });
  try { return source.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name); }
  finally { source.close(); }
}
function sourceRows(file, table) {
  const source = new DatabaseSync(file, { readOnly: true });
  try { return source.prepare(`SELECT * FROM ${table}`).all().map(row => JSON.stringify(Object.values(row).map(normalise))).sort(); }
  finally { source.close(); }
}
// Target rows over the source's columns, with json read back as its stored text.
async function targetRows(pool, table, columns) {
  const types = new Map((await pool.query('SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1', [table])).rows.map(row => [row.column_name, row.data_type]));
  const select = columns.map(column => types.get(column) === 'json' ? `"${column}"::text` : `"${column}"`).join(', ');
  return (await pool.query({ text: `SELECT ${select} FROM ${table}`, rowMode: 'array' })).rows.map(row => JSON.stringify(row.map(normalise))).sort();
}
const sourceColumns = (file, table) => { const source = new DatabaseSync(file, { readOnly: true }); try { return source.prepare('SELECT name FROM pragma_table_info(?)').all(table).map(row => row.name); } finally { source.close(); } };
async function counts(pool) {
  const tables = (await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name")).rows.map(row => row.table_name);
  return Object.fromEntries(await Promise.all(tables.map(async table => [table, (await pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count])));
}
// The cursor zernio-ad-events exposes: the webhook event's rowid (SQLite) or seq (PostgreSQL), newest first.
function sourceAdHistory(file) {
  const source = new DatabaseSync(file, { readOnly: true });
  try { return source.prepare('SELECT e.rowid AS sequence, u.event_id FROM webhook_ad_updates u JOIN webhook_events e ON e.id = u.event_id ORDER BY e.rowid DESC').all().map(row => ({ ...row })); }
  finally { source.close(); }
}

// Admin-created databases for the unmigrated-target and restore cases; dropped after the test.
async function emptyDatabase(t) {
  const name = `campaign_import_${randomBytes(6).toString('hex')}`, url = new URL(process.env.TEST_DATABASE_URL);
  const admin = async statement => { const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }); await client.connect(); try { await client.query(statement); } finally { await client.end(); } };
  await admin(`CREATE DATABASE ${name}`);
  t.after(() => admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  url.pathname = `/${name}`;
  return url.href;
}

// pg_dump/pg_restore through the Postgres container (matching the server version), else from PATH.
function dumpTool() {
  const container = process.env.CAMPAIGN_PG_CONTAINER || 'campaign-m6-pg';
  if (spawnSync('docker', ['exec', container, 'pg_dump', '--version'], { encoding: 'utf8' }).status === 0) {
    // Inside the container the server listens on its own port 5432.
    const local = value => { const url = new URL(value); url.hostname = '127.0.0.1'; url.port = '5432'; return url.href; };
    return { major: Infinity, run: (tool, args, url, input) => spawnSync('docker', ['exec', '-i', container, tool, ...args, local(url)], { input, maxBuffer: 1 << 30 }) };
  }
  // A client on PATH must be at least the server's major version, or pg_dump refuses to dump it.
  const version = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' });
  if (version.status === 0) return { major: Number(version.stdout.match(/(d+)./)?.[1] || 0), run: (tool, args, url, input) => spawnSync(tool, [...args, url], { input, maxBuffer: 1 << 30 }) };
  return null;
}
function dumpAndRestore(tool, from, to) {
  const dump = tool.run('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--dbname'], from);
  assert.equal(dump.status, 0, String(dump.stderr));
  const restore = tool.run('pg_restore', ['--no-owner', '--no-acl', '--exit-on-error', '--dbname'], to, dump.stdout);
  assert.equal(restore.status, 0, String(restore.stderr));
}

test('import-sqlite without a source path prints usage and changes nothing', () => {
  const result = runCli(undefined, 'import-sqlite');
  assert.equal(result.status, 1); assert.match(result.stderr, /Usage: .*import-sqlite <path-to-campaign\.sqlite>/);
});

test('import-sqlite copies every table with ids, json text, flags, blobs and insertion order preserved', pgOnly, async t => {
  const file = await sourceFile(t), { pool, url } = await testDatabase(t);
  const history = sourceAdHistory(file), cursor = history[1].sequence;
  assert.deepEqual(history.map(row => row.event_id), ['e6', 'e5', 'e4', 'e2', 'e1']);
  const result = runCli(url, 'import-sqlite', file);
  assert.equal(result.status, 0, result.stderr);
  for (const secret of [passwordHash, 'session-token-hash', 'verifier-1', 'deadbeef', 'lead@example.test']) assert.equal((result.stdout + result.stderr).includes(secret), false, 'The summary must not print row data or secrets.');
  assert.match(result.stdout, /row counts and fingerprints verified/);
  assert.match(result.stdout, /sessions 1, oidc_flows 1, oidc_return_targets 1, login_limits 1/);
  assert.match(result.stdout, /webhook_events\.seq to 6/); assert.match(result.stdout, /webhook_ad_updates\.sequence to 7/);

  // Round trip: every imported table matches the source in count and content.
  for (const table of sourceTables(file).filter(name => !ephemeral.includes(name) && name !== 'installation')) {
    const columns = sourceColumns(file, table);
    assert.deepEqual(await targetRows(pool, table, columns), sourceRows(file, table), table);
  }
  for (const table of ephemeral) assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, 0, `${table} must not be imported`);
  assert.deepEqual((await pool.query('SELECT id, claimed FROM installation')).rows, [{ id: 1, claimed: true }], 'Any user claims the installation, as the SQLite backfill did.');

  assert.equal((await pool.query("SELECT data::text AS data FROM records WHERE id = 'r1'")).rows[0].data, oddJson, 'Record JSON text must be byte-identical.');
  assert.equal((await pool.query("SELECT snapshot FROM post_approval_reviews WHERE id = 'rev-1'")).rows[0].snapshot, oddJson);
  assert.deepEqual((await pool.query('SELECT id, password FROM users ORDER BY id')).rows, [{ id: 'member', password: null }, { id: 'owner', password: passwordHash }]);
  assert.deepEqual((await pool.query('SELECT issuer, subject, user_id FROM oidc_identities')).rows, [{ issuer: 'https://idp.example.test/realms/campaign', subject: 'subject-0001', user_id: 'member' }]);
  assert.deepEqual((await pool.query('SELECT user_id FROM instance_operators')).rows, [{ user_id: 'owner' }]);
  assert.deepEqual((await pool.query('SELECT id, user_id, action, source, created_at FROM instance_operator_audit ORDER BY created_at')).rows.map(row => [row.id, row.action, row.created_at]), [['audit-1', 'bootstrap', 1760000000000], ['audit-2', 'grant', 1760000001000], ['audit-3', 'revoke', 1760000002000]]);
  assert.deepEqual((await pool.query('SELECT id, sample FROM activity ORDER BY id')).rows, [{ id: 'act-1', sample: true }, { id: 'act-2', sample: false }]);
  assert.deepEqual((await pool.query('SELECT id, archived FROM campaign_links ORDER BY id')).rows, [{ id: 'l1', archived: false }, { id: 'l2', archived: true }]);
  assert.equal((await pool.query('SELECT require_approval FROM project_approval_policy')).rows[0].require_approval, true);
  assert.deepEqual((await pool.query("SELECT nonce, ciphertext, tag FROM integration_settings WHERE provider = 'zernio'")).rows[0], { nonce: Buffer.from('000102030405060708090a0b', 'hex'), ciphertext: Buffer.from('deadbeef00ff', 'hex'), tag: Buffer.from('0f0e0d0c0b0a09080706050403020100', 'hex') });
  assert.deepEqual((await pool.query('SELECT id, status, response, http_status, action_path, run_id, resource_key FROM integration_operations ORDER BY id')).rows, [
    { id: 'op-1', status: 'complete', response: '{"id":"post-9","status":"scheduled"}', http_status: 201, action_path: '/posts', run_id: 'run-1', resource_key: 'post:r1' },
    { id: 'op-2', status: 'uncertain', response: null, http_status: null, action_path: '/ads/budget', run_id: '', resource_key: 'adset:9' }]);
  // seq is the source rowid: r2 was re-inserted last, so it is newest.
  assert.deepEqual((await pool.query("SELECT id FROM records WHERE project_id = 'p1' ORDER BY seq DESC")).rows.map(row => row.id), ['r2', 'r1']);
  assert.deepEqual((await pool.query('SELECT sequence::int AS sequence, id FROM sms_messages ORDER BY sequence')).rows, [{ sequence: 1, id: 'm1' }, { sequence: 2, id: 'm2' }]);

  // Cursor continuity: a cursor taken from SQLite pages the same older events after import.
  const page = (await pool.query('SELECT e.seq AS sequence, u.event_id FROM webhook_ad_updates u JOIN webhook_events e ON e.id = u.event_id WHERE e.seq < $1 ORDER BY e.seq DESC', [cursor])).rows;
  assert.deepEqual(page, history.filter(row => row.sequence < cursor).map(row => ({ sequence: Number(row.sequence), event_id: row.event_id })));
  assert.deepEqual(page.map(row => row.event_id), ['e4', 'e2', 'e1']);
  const maxSeq = (await pool.query('SELECT max(seq) AS max FROM webhook_events')).rows[0].max;
  const added = (await pool.query("INSERT INTO webhook_events (id,event,payload,body_hash,received_at) VALUES ('e-new','ads.updated','{}','h','2026-02-01T00:00:00.000Z') RETURNING seq")).rows[0].seq;
  assert.ok(added > maxSeq, 'New events must sort after every imported event.');
  const adSequence = (await pool.query("INSERT INTO webhook_ad_updates (project_id,profile_id,account_id,platform,ad_account_id,event_id,event_at,event,data) VALUES ('p1','zernio-profile-1','acct-1','meta','adacct-1','e-new','2026-02-01T00:00:00.000Z','ads.updated','{}') RETURNING sequence")).rows[0].sequence;
  assert.ok(adSequence > 7, 'AUTOINCREMENT values SQLite already issued must not be reused.');
  const record = (await pool.query("INSERT INTO records (id, project_id, collection, data) VALUES ('r-new','p1','posts','{}') RETURNING seq")).rows[0].seq;
  assert.ok(record > (await pool.query("SELECT max(seq) AS max FROM records WHERE id <> 'r-new'")).rows[0].max);
});

test('import-sqlite refuses a target that already has data and changes nothing', pgOnly, async t => {
  const file = await sourceFile(t), { pool, url } = await testDatabase(t);
  assert.equal(runCli(url, 'import-sqlite', file).status, 0);
  const before = await counts(pool);
  const again = runCli(url, 'import-sqlite', file);
  assert.equal(again.status, 1); assert.match(again.stderr, /already has data/);
  assert.deepEqual(await counts(pool), before);
});

test('import-sqlite refuses a target that is not migrated', pgOnly, async t => {
  const file = await sourceFile(t), url = await emptyDatabase(t);
  const result = runCli(url, 'import-sqlite', file);
  assert.equal(result.status, 1); assert.match(result.stderr, /Database schema is incompatible/);
});

test('import-sqlite refuses a file that is not a Campaign SQLite database', pgOnly, async t => {
  const { pool, url } = await testDatabase(t), directory = await mkdtemp(join(tmpdir(), 'campaign-import-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const other = join(directory, 'other.sqlite'), text = join(directory, 'notes.txt'), source = new DatabaseSync(other);
  source.exec('CREATE TABLE users(id TEXT PRIMARY KEY)'); source.close();
  await writeFile(text, 'not a database');
  for (const file of [other, text, join(directory, 'missing.sqlite')]) {
    const result = runCli(url, 'import-sqlite', file);
    assert.equal(result.status, 1); assert.match(result.stderr, /not a Campaign SQLite database|does not exist/);
  }
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM users')).rows[0].count, 0);
});

test('import-sqlite skips empty tables older releases left behind but refuses one with rows', pgOnly, async t => {
  const file = await sourceFile(t), { pool, url } = await testDatabase(t), source = new DatabaseSync(file);
  // Production 0.9.x databases still carry these 0.8.x webhook tables, unused and empty.
  source.exec('CREATE TABLE webhook_messages(id TEXT PRIMARY KEY); CREATE TABLE webhook_engagement_updates(id TEXT PRIMARY KEY); CREATE TABLE legacy_with_rows(id TEXT PRIMARY KEY); INSERT INTO legacy_with_rows VALUES ('kept')');
  source.close();
  const refused = runCli(url, 'import-sqlite', file);
  assert.equal(refused.status, 1); assert.match(refused.stderr, /tables with rows the PostgreSQL schema does not: legacy_with_rows./);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM users')).rows[0].count, 0);
  const again = new DatabaseSync(file); again.exec('DROP TABLE legacy_with_rows'); again.close();
  const imported = runCli(url, 'import-sqlite', file);
  assert.equal(imported.status, 0, imported.stderr);
  assert.match(imported.stdout, /Empty tables no longer used, skipped: webhook_engagement_updates, webhook_messages./);
  assert.ok((await pool.query('SELECT count(*)::int AS count FROM users')).rows[0].count > 0);
});

test('invalid JSON in one record rolls back the whole import', pgOnly, async t => {
  const file = await sourceFile(t, source => source.exec(`UPDATE records SET data = '{"broken":' WHERE id = 'r3'`)), { pool, url } = await testDatabase(t);
  const result = runCli(url, 'import-sqlite', file);
  assert.equal(result.status, 1); assert.match(result.stderr, /records row rowid \d+, column data: the value is not valid JSON/);
  assert.equal(result.stderr.includes('broken'), false, 'Errors must not print row data.');
  const after = await counts(pool);
  assert.deepEqual(Object.entries(after).filter(([table, count]) => count && !['installation', 'schema_version'].includes(table)), []);
  assert.equal((await pool.query('SELECT claimed FROM installation')).rows[0].claimed, false);
});

test('an imported database survives pg_dump and restore with identical counts and fingerprints', pgOnly, async t => {
  const tool = dumpTool();
  if (!tool) { t.skip('Neither the campaign-m6-pg container nor pg_dump on PATH is available.'); return; }
  const file = await sourceFile(t), imported = await testDatabase(t);
  const serverMajor = Math.floor(Number((await imported.pool.query('SHOW server_version_num')).rows[0].server_version_num) / 10000);
  if (tool.major < serverMajor) { t.skip(`pg_dump ${tool.major} on PATH is older than PostgreSQL ${serverMajor}; set CAMPAIGN_PG_CONTAINER to the server container.`); return; }
  assert.equal(runCli(imported.url, 'import-sqlite', file).status, 0);
  const restoredUrl = await emptyDatabase(t);
  dumpAndRestore(tool, imported.url, restoredUrl);
  const restored = connect(restoredUrl), expected = await fingerprintDatabase(imported.pool);
  let actual; try { actual = await fingerprintDatabase(restored.pool); } finally { await restored.pool.end(); }
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort());
  for (const [table, value] of expected) assert.deepEqual(actual.get(table), value, table);
  assert.ok(expected.get('records').rows > 0 && expected.get('webhook_events').rows === 5);
});
