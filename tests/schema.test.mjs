import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { getTableConfig } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from '../server/schema.ts';
import { assertSchema, closeDatabase, getDatabase, migrate, migrationSources, pendingMigrations } from '../server/database.ts';

const tables = Object.values(schema).map(table => getTableConfig(table));
const migrationSql = async () => (await migrationSources()).map(migration => migration.sql).join('\n');

test('every Drizzle table and column is created by the SQL migrations', async () => {
  const created = new Map([...(await migrationSql()).matchAll(/^CREATE TABLE (\w+) \((.*)\);$/gm)].map(([, name, body]) => [name, body]));
  assert.equal(tables.length, 81);
  assert.deepEqual(tables.map(table => table.name).sort(), [...created.keys()].sort());
  for (const table of tables) {
    const columns = [...created.get(table.name).matchAll(/(?:^|, )(\w+) (?:text|bigint|integer|boolean|json|bytea)\b/g)].map(match => match[1]);
    assert.deepEqual(table.columns.map(column => column.name), columns, table.name);
  }
});

// Until cutover, dev still creates SQLite tables lazily; a table or column added there must reach the PostgreSQL schema too.
test('the PostgreSQL schema covers every table and column the SQLite modules still create', async () => {
  const sqlite = new DatabaseSync(':memory:'), statements = [];
  for (const file of (await readdir(new URL('../server/', import.meta.url))).filter(name => name.endsWith('.ts'))) {
    const source = await readFile(new URL(`../server/${file}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/CREATE TABLE IF NOT EXISTS/g)) {
      let index = source.indexOf('(', match.index), depth = 0;
      for (; index < source.length; index++) { if (source[index] === '(') depth++; else if (source[index] === ')' && --depth === 0) break; }
      statements.push(source.slice(match.index, index + 1));
    }
    for (const match of source.matchAll(/ALTER TABLE (\w+) ADD COLUMN (?:\$\{name\}|(\w+))/g)) statements.push({ table: match[1], column: match[2] });
  }
  for (const statement of statements) if (typeof statement === 'string') sqlite.exec(statement);
  const pgColumns = new Map(tables.map(table => [table.name, table.columns.map(column => column.name)]));
  const names = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('sqlite_sequence','schema_version')").all().map(row => row.name);
  assert.ok(names.length >= 1);
  for (const name of names) {
    assert.ok(pgColumns.has(name), `${name} is missing from server/schema.ts`);
    for (const { name: column } of sqlite.prepare(`PRAGMA table_info(${name})`).all()) assert.ok(pgColumns.get(name).includes(column), `${name}.${column} is missing from server/schema.ts`);
  }
  for (const { table, column } of statements.filter(statement => typeof statement === 'object' && statement.column)) assert.ok(pgColumns.get(table).includes(column), `${table}.${column} is missing from server/schema.ts`);
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

// Needs a disposable PostgreSQL server: TEST_DATABASE_URL must name a role allowed to create databases.
test('migrations build exactly the Drizzle schema on PostgreSQL, once, under concurrency', { skip: !process.env.TEST_DATABASE_URL && 'TEST_DATABASE_URL is not set', timeout: 60000 }, async () => {
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

    const columns = (await pool.query(`SELECT table_name, column_name, data_type, is_nullable, column_default, is_identity FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> 'schema_version' ORDER BY table_name, ordinal_position`)).rows;
    const constraints = (await pool.query(`SELECT c.conrelid::regclass::text AS table_name, c.conname, c.contype, array(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(n, i) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n ORDER BY k.i)::text[] AS columns, c.confrelid::regclass::text AS foreign_table, c.confdeltype FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public' AND c.conrelid::regclass::text <> 'schema_version'`)).rows;
    const indexes = (await pool.query(`SELECT tablename, indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname NOT IN (SELECT conname FROM pg_constraint)`)).rows;
    const onDelete = { a: 'no action', c: 'cascade', n: 'set null' };
    assert.equal(new Set(columns.map(row => row.table_name)).size, tables.length);
    for (const table of tables) {
      const actual = columns.filter(row => row.table_name === table.name), own = constraints.filter(row => row.table_name === table.name);
      assert.deepEqual(actual.map(row => [row.column_name, row.data_type, row.is_nullable === 'NO', row.column_default !== null || row.is_identity === 'YES']),
        table.columns.map(column => [column.name, column.getSQLType(), column.notNull, column.hasDefault || column.generatedIdentity !== undefined]), table.name);
      const primary = table.columns.filter(column => column.primary).map(column => column.name).concat(table.primaryKeys.flatMap(key => key.columns.map(column => column.name)));
      assert.deepEqual(own.find(row => row.contype === 'p').columns, primary, `${table.name} primary key`);
      const uniques = table.columns.filter(column => column.isUnique).map(column => [column.name]).concat(table.uniqueConstraints.map(unique => unique.columns.map(column => column.name)));
      assert.deepEqual(own.filter(row => row.contype === 'u').map(row => row.columns.join()).sort(), uniques.map(columns => columns.join()).sort(), `${table.name} unique`);
      assert.deepEqual(own.filter(row => row.contype === 'c').map(row => row.conname).sort(), table.checks.map(check => check.name).sort(), `${table.name} checks`);
      assert.deepEqual(own.filter(row => row.contype === 'f').map(row => [row.columns.join(), row.foreign_table, onDelete[row.confdeltype]]).sort(),
        table.foreignKeys.map(key => { const ref = key.reference(); return [ref.columns.map(column => column.name).join(), getTableConfig(ref.foreignTable).name, key.onDelete ?? 'no action']; }).sort(), `${table.name} foreign keys`);
      assert.deepEqual(indexes.filter(row => row.tablename === table.name).map(row => row.indexname).sort(), table.indexes.map(index => index.config.name).sort(), `${table.name} indexes`);
    }

    await pool.query("UPDATE schema_version SET checksum = repeat('0', 64)");
    await assert.rejects(assertSchema(), { code: 'SCHEMA_MISMATCH' });
    await assert.rejects(migrate(), { code: 'SCHEMA_MISMATCH' });
  } finally {
    await closeDatabase();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.end();
  }
});
