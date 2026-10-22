import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { getTableConfig } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from '../server/schema.ts';
import { assertSchema, closeDatabase, getDatabase, migrate, migrationSources, parseInt8, pendingMigrations } from '../server/database.ts';

const tables = Object.values(schema).map(table => getTableConfig(table));
const migrationSql = async () => (await migrationSources()).map(migration => migration.sql).join('\n');

test('every Drizzle table and column is created by the SQL migrations', async () => {
  const sql = await migrationSql(), type = '(?:text|bigint|integer|boolean|json|bytea)\\b';
  const created = new Map([...sql.matchAll(/^CREATE TABLE (\w+) \((.*)\);$/gm)].map(([, name, body]) => [name, [...body.matchAll(new RegExp(`(?:^|, )(\\w+) ${type}`, 'g'))].map(match => match[1])]));
  for (const [, name, column] of sql.matchAll(new RegExp(`^ALTER TABLE (\\w+) ADD COLUMN (\\w+) ${type}`, 'gm'))) created.get(name).push(column);
  assert.equal(tables.length, 83);
  assert.deepEqual(tables.map(table => table.name).sort(), [...created.keys()].sort());
  for (const table of tables) assert.deepEqual(table.columns.map(column => column.name), created.get(table.name), table.name);
});

test('the migration ledger accepts only an unmodified prefix of the shipped migrations', async () => {
  const sources = await migrationSources();
  assert.ok(sources.every(source => !source.sql.includes('\r') && /^[0-9a-f]{64}$/.test(source.checksum)));
  assert.equal((await pendingMigrations([])).length, sources.length);
  assert.equal((await pendingMigrations(sources.map(({ version, checksum }) => ({ version, checksum })))).length, 0);
  await assert.rejects(pendingMigrations([{ version: sources[0].version, checksum: '0'.repeat(64) }]), { code: 'SCHEMA_MISMATCH' });
  await assert.rejects(pendingMigrations([{ version: '0000', checksum: sources[0].checksum }]), { code: 'SCHEMA_MISMATCH' });
  await assert.rejects(pendingMigrations([...sources, { version: '9999', checksum: sources[0].checksum }]), { code: 'SCHEMA_MISMATCH' });
});

test('int8 values parse to numbers and refuse to lose precision', () => {
  assert.equal(pg.types.getTypeParser(pg.types.builtins.INT8)('1761000000000'), 1761000000000);
  assert.equal(parseInt8('-9007199254740991'), -9007199254740991);
  for (const value of ['9007199254740992', '-9007199254740992', '18446744073709551615']) assert.throws(() => parseInt8(value), RangeError);
});

// Needs a disposable PostgreSQL server: TEST_DATABASE_URL must name a role allowed to create databases.
test('migrations build exactly the Drizzle schema on PostgreSQL, once, and keep JSON text and insertion order', { skip: !process.env.TEST_DATABASE_URL && 'TEST_DATABASE_URL is not set', timeout: 60000 }, async () => {
  const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }), name = `campaign_schema_${randomBytes(6).toString('hex')}`;
  await admin.connect(); await admin.query(`CREATE DATABASE ${name}`);
  try {
    const url = new URL(process.env.TEST_DATABASE_URL); url.pathname = `/${name}`;
    const { pool } = getDatabase(url.href);
    const runs = await Promise.all([migrate(), migrate(), migrate()]);
    assert.deepEqual(runs.flat(), (await migrationSources()).map(source => source.version));
    assert.deepEqual(await migrate(), []);
    await assertSchema();
    assert.deepEqual((await pool.query('SELECT id, claimed FROM installation')).rows, [{ id: 1, claimed: false }]);

    const columns = (await pool.query(`SELECT table_name, column_name, data_type, is_nullable, column_default, is_identity, identity_generation FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> 'schema_version' ORDER BY table_name, ordinal_position`)).rows;
    const constraints = (await pool.query(`SELECT c.conrelid::regclass::text AS table_name, c.conname, c.contype, array(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(n, i) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n ORDER BY k.i)::text[] AS columns, c.confrelid::regclass::text AS foreign_table, c.confdeltype FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public' AND c.conrelid::regclass::text <> 'schema_version'`)).rows;
    const indexes = (await pool.query(`SELECT tablename, indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname NOT IN (SELECT conname FROM pg_constraint)`)).rows;
    const onDelete = { a: 'no action', c: 'cascade', n: 'set null' };
    assert.equal(new Set(columns.map(row => row.table_name)).size, tables.length);
    for (const table of tables) {
      const actual = columns.filter(row => row.table_name === table.name), own = constraints.filter(row => row.table_name === table.name);
      assert.deepEqual(actual.map(row => [row.column_name, row.data_type, row.is_nullable === 'NO', row.column_default !== null || row.is_identity === 'YES', { ALWAYS: 'always', 'BY DEFAULT': 'byDefault' }[row.identity_generation]]),
        table.columns.map(column => [column.name, column.getSQLType(), column.notNull, column.hasDefault || column.generatedIdentity !== undefined, column.generatedIdentity?.type]), table.name);
      const primary = table.columns.filter(column => column.primary).map(column => column.name).concat(table.primaryKeys.flatMap(key => key.columns.map(column => column.name)));
      assert.deepEqual(own.find(row => row.contype === 'p').columns, primary, `${table.name} primary key`);
      const uniques = table.columns.filter(column => column.isUnique).map(column => [column.name]).concat(table.uniqueConstraints.map(unique => unique.columns.map(column => column.name)));
      assert.deepEqual(own.filter(row => row.contype === 'u').map(row => row.columns.join()).sort(), uniques.map(columns => columns.join()).sort(), `${table.name} unique`);
      assert.deepEqual(own.filter(row => row.contype === 'c').map(row => row.conname).sort(), table.checks.map(check => check.name).sort(), `${table.name} checks`);
      assert.deepEqual(own.filter(row => row.contype === 'f').map(row => [row.columns.join(), row.foreign_table, onDelete[row.confdeltype]]).sort(),
        table.foreignKeys.map(key => { const ref = key.reference(); return [ref.columns.map(column => column.name).join(), getTableConfig(ref.foreignTable).name, key.onDelete ?? 'no action']; }).sort(), `${table.name} foreign keys`);
      assert.deepEqual(indexes.filter(row => row.tablename === table.name).map(row => row.indexname).sort(), table.indexes.map(index => index.config.name).sort(), `${table.name} indexes`);
    }

    // Fingerprints hash JSON.stringify of parsed documents, so key order must survive the database (jsonb would sort it).
    const document = JSON.stringify({ zeta: 1, id: 'r1', nested: { yy: [3, { b: 2, a: 1 }], x: 'é' }, a: null });
    await pool.query("INSERT INTO workspaces (id, name) VALUES ('w', 'W'); INSERT INTO projects (id, workspace_id, name) VALUES ('p', 'w', 'P'); INSERT INTO users (id, name, email) VALUES ('u', 'U', 'u@example.com')");
    for (const id of ['r1', 'r2', 'r3']) await pool.query("INSERT INTO records (id, project_id, collection, data) VALUES ($1, 'p', 'posts', $2)", [id, document]);
    await pool.query("INSERT INTO post_recycling_reviews VALUES ('v', 'p', 'post', 'f', $1, $1, 'u', 'now')", [document]);
    const stored = (await pool.query("SELECT data, data->'nested'->>'x' AS x FROM records WHERE id = 'r1'")).rows[0];
    assert.equal(JSON.stringify(stored.data), document); assert.equal(stored.x, 'é');
    assert.deepEqual((await pool.query("SELECT snapshot, configuration FROM post_recycling_reviews")).rows[0], { snapshot: document, configuration: document });
    assert.notEqual(JSON.stringify((await pool.query('SELECT $1::jsonb AS value', [document])).rows[0].value), document);
    // rowid order becomes seq; the importer writes old rowids with OVERRIDING SYSTEM VALUE.
    assert.deepEqual((await pool.query("SELECT id FROM records WHERE project_id = 'p' AND collection = 'posts' ORDER BY seq DESC")).rows.map(row => row.id), ['r3', 'r2', 'r1']);
    await assert.rejects(pool.query("INSERT INTO records (seq, id, project_id, collection, data) VALUES (9, 'r9', 'p', 'posts', '{}')"), { code: '428C9' });
    await pool.query("INSERT INTO records (seq, id, project_id, collection, data) OVERRIDING SYSTEM VALUE VALUES (100, 'r100', 'p', 'posts', '{}')");
    assert.equal((await pool.query("SELECT seq FROM records WHERE id = 'r100'")).rows[0].seq, 100);
    assert.equal((await pool.query('SELECT count(*) AS count FROM records')).rows[0].count, 4);
    await assert.rejects(pool.query('SELECT 9007199254740993::bigint AS value'), RangeError);

    await pool.query("UPDATE schema_version SET checksum = repeat('0', 64)");
    await assert.rejects(assertSchema(), { code: 'SCHEMA_MISMATCH' });
    await assert.rejects(migrate(), { code: 'SCHEMA_MISMATCH' });
  } finally {
    await closeDatabase();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.end();
  }
});
