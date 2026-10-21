// One-shot import of a Campaign 0.8.x SQLite file into a freshly migrated, empty PostgreSQL database (#25).
// This is the only remaining SQLite use: it reads the legacy file read-only and never writes to it.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type pg from 'pg';

/** A refusal or verification failure whose message is safe to print: it names tables and columns, never values. */
export class ImportError extends Error { readonly code = 'IMPORT_REFUSED'; }

/** Ephemeral sign-in state is not imported: everyone signs in again after cutover. */
export const ephemeralTables = ['sessions', 'oidc_flows', 'oidc_return_targets', 'login_limits'];
const ledgerTable = 'schema_version', rowidAlias = '__import_rowid';

type Column = { name: string; type: string; identity: boolean };
type Table = { name: string; columns: Column[]; primaryKey: string[] };
type Value = string | boolean | Buffer | null;
export type ImportSummary = {
  tables: { name: string; rows: number }[];
  absent: string[];
  ephemeral: { name: string; rows: number }[];
  defaulted: string[];
  sequences: { column: string; value: number }[];
  claimed: boolean;
};

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

async function targetTables(client: pg.PoolClient): Promise<Map<string, Table>> {
  const tables = new Map<string, Table>();
  const columns = await client.query(`SELECT c.table_name, c.column_name, c.data_type, c.is_identity FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE' ORDER BY c.table_name, c.ordinal_position`);
  for (const row of columns.rows) {
    const table = tables.get(row.table_name) ?? tables.set(row.table_name, { name: row.table_name, columns: [], primaryKey: [] }).get(row.table_name)!;
    table.columns.push({ name: row.column_name, type: row.data_type, identity: row.is_identity === 'YES' });
  }
  const keys = await client.query(`SELECT c.relname AS table_name, a.attname AS column_name FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN unnest(k.conkey) WITH ORDINALITY AS u(attnum, position) ON true
    JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum
    WHERE k.contype = 'p' AND n.nspname = current_schema() ORDER BY c.relname, u.position`);
  for (const row of keys.rows) tables.get(row.table_name)?.primaryKey.push(row.column_name);
  return tables;
}

// Parents before children, so every foreign key already has its referenced row; ties stay alphabetical.
async function foreignKeyOrder(client: pg.PoolClient, names: string[]): Promise<string[]> {
  const parents = new Map(names.map(name => [name, new Set<string>()]));
  const references = await client.query(`SELECT c.relname AS child, r.relname AS parent FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class r ON r.oid = k.confrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE k.contype = 'f' AND n.nspname = current_schema()`);
  for (const { child, parent } of references.rows) if (child !== parent && parents.has(child) && parents.has(parent)) parents.get(child)!.add(parent);
  const ordered: string[] = [], placed = new Set<string>();
  while (ordered.length < names.length) {
    const ready = [...parents].filter(([name, from]) => !placed.has(name) && [...from].every(parent => placed.has(parent))).map(([name]) => name).sort();
    if (!ready.length) throw new ImportError('The target schema has a foreign key cycle; the import cannot order its tables.');
    for (const name of ready) { ordered.push(name); placed.add(name); }
  }
  return ordered;
}

function openSource(file: string): DatabaseSync {
  if (!existsSync(file)) throw new ImportError('The SQLite source file does not exist.');
  let source: DatabaseSync | undefined;
  try {
    source = new DatabaseSync(file, { readOnly: true });
    const names = new Set(source.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    if (names.has('users') && names.has('records')) return source;
  } catch { /* not an SQLite database */ }
  source?.close();
  throw new ImportError('The source is not a Campaign SQLite database (it has no users and records tables).');
}

function sourceRows(statement: StatementSync) { statement.setReadBigInts(true); return statement.iterate() as Iterable<Record<string, unknown>>; }

// Converts one SQLite value to the parameter for its PostgreSQL column, following the 0001 header decisions.
function convert(value: unknown, column: Column, where: string): Value {
  if (value === null) return null;
  const fail = (reason: string) => new ImportError(`${where}, column ${column.name}: ${reason}`);
  switch (column.type) {
    case 'boolean':
      if (value === 0n || value === 1n) return value === 1n;
      throw fail('expected a 0/1 flag.');
    case 'json':
      if (typeof value !== 'string') throw fail('expected JSON text.');
      try { JSON.parse(value); } catch { throw fail('the value is not valid JSON.'); }
      // The original text, never re-stringified: approval and recycling fingerprints hash these exact bytes.
      return value;
    case 'bytea':
      if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      throw fail('expected a BLOB.');
    case 'bigint': case 'integer':
      if (typeof value === 'bigint') return value.toString();
      throw fail('expected an integer.');
    case 'text':
      if (typeof value === 'string') return value;
      if (typeof value === 'bigint') return value.toString();
      throw fail('expected text.');
    default:
      throw fail(`the target type ${column.type} is not supported by the importer.`);
  }
}

// Canonical row text for the fingerprint: booleans as 0/1, JSON as its exact text, bytea as hex, numbers as
// decimal strings. Each value is length-prefixed so adjacent values cannot run together.
function canonical(values: Value[]): string {
  return values.map(value => {
    if (value === null) return 'N';
    const text = typeof value === 'boolean' ? (value ? '1' : '0') : Buffer.isBuffer(value) ? value.toString('hex') : value;
    return `V${text.length}:${text}`;
  }).join('') + '\n';
}

type Plan = { table: Table; columns: Column[]; seqFromRowid: boolean; hasRowid: boolean; rows: number };

function plan(source: DatabaseSync, table: Table): Plan {
  const sourceColumns = source.prepare(`SELECT name FROM pragma_table_info(?)`).all(table.name).map(row => String(row.name));
  const known = new Set(table.columns.map(column => column.name));
  const extra = sourceColumns.filter(name => !known.has(name));
  if (extra.length) throw new ImportError(`Source table ${table.name} has columns the PostgreSQL schema does not: ${extra.join(', ')}. Nothing was imported.`);
  let hasRowid = true;
  try { source.prepare(`SELECT rowid FROM ${quote(table.name)} LIMIT 0`); } catch { hasRowid = false; }
  // Migration 0002: `seq` replaces SQLite's rowid, so it takes the rowid value.
  const seqFromRowid = !sourceColumns.includes('seq') && table.columns.some(column => column.name === 'seq' && column.identity);
  if (seqFromRowid && !hasRowid) throw new ImportError(`Source table ${table.name} has no rowid to carry into seq.`);
  const columns = table.columns.filter(column => sourceColumns.includes(column.name) || seqFromRowid && column.name === 'seq');
  return { table, columns, seqFromRowid, hasRowid, rows: 0 };
}

const select = (plan: Plan) => plan.columns.map(column => plan.seqFromRowid && column.name === 'seq' ? `rowid AS ${quote('seq')}` : quote(column.name));
const orderKey = (table: Table) => table.primaryKey.length ? table.primaryKey : table.columns.map(column => column.name);

async function copy(client: pg.PoolClient, source: DatabaseSync, plan: Plan) {
  const { table, columns } = plan, names = columns.map(column => quote(column.name)).join(', ');
  const overriding = columns.some(column => column.identity) ? ' OVERRIDING SYSTEM VALUE' : '';
  const order = plan.hasRowid ? 'rowid' : orderKey(table).map(quote).join(', ');
  const statement = source.prepare(`SELECT ${plan.hasRowid ? `rowid AS ${rowidAlias}, ` : ''}${select(plan).join(', ')} FROM ${quote(table.name)} ORDER BY ${order}`);
  const batchSize = Math.max(1, Math.min(1000, Math.floor(60000 / columns.length)));
  let batch: Value[][] = [];
  const flush = async () => {
    if (!batch.length) return;
    const tuples = batch.map((_, row) => `(${columns.map((__, index) => `$${row * columns.length + index + 1}`).join(', ')})`).join(', ');
    try { await client.query(`INSERT INTO ${quote(table.name)} (${names})${overriding} VALUES ${tuples}`, batch.flat()); }
    catch (error: any) {
      // Only the SQLSTATE and constraint name are reported: driver messages and details can contain row values.
      if (typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)) throw new ImportError(`Inserting into ${table.name} failed (SQLSTATE ${error.code}${error.constraint ? `, constraint ${error.constraint}` : ''}). Nothing was imported.`);
      throw error;
    }
    batch = [];
  };
  for (const row of sourceRows(statement)) {
    plan.rows += 1;
    const where = `Source table ${table.name} row ${plan.hasRowid ? `rowid ${row[rowidAlias]}` : plan.rows}`;
    batch.push(columns.map(column => convert(row[column.name], column, where)));
    if (batch.length >= batchSize) await flush();
  }
  await flush();
}

// Runs inside a transaction (the cursor needs one).
async function targetFingerprint(client: pg.PoolClient, table: Table, columns: Column[]) {
  // SQLite BINARY and PostgreSQL "C" both order text by its UTF-8 bytes, so both sides hash rows in the same order.
  const type = new Map(table.columns.map(column => [column.name, column.type])), hash = createHash('sha256');
  const expressions = columns.map(column => ['json', 'bigint', 'integer'].includes(column.type) ? `${quote(column.name)}::text` : quote(column.name));
  const order = orderKey(table).map(name => type.get(name) === 'text' ? `${quote(name)} COLLATE "C"` : quote(name)).join(', ');
  await client.query(`DECLARE import_fingerprint NO SCROLL CURSOR FOR SELECT ${expressions.join(', ')} FROM ${quote(table.name)} ORDER BY ${order}`);
  let rows = 0;
  for (;;) {
    const batch = (await client.query({ text: 'FETCH FORWARD 1000 FROM import_fingerprint', rowMode: 'array' })).rows;
    if (!batch.length) break;
    for (const row of batch) { rows += 1; hash.update(canonical(row as Value[])); }
  }
  await client.query('CLOSE import_fingerprint');
  return { rows, sha256: hash.digest('hex') };
}

/** Row count and fingerprint of every table, over all columns; compares a database with its pg_dump restore. */
export async function fingerprintDatabase(pool: pg.Pool): Promise<Map<string, { rows: number; sha256: string }>> {
  const client = await pool.connect(), result = new Map<string, { rows: number; sha256: string }>();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    for (const table of (await targetTables(client)).values()) result.set(table.name, await targetFingerprint(client, table, table.columns));
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

async function verify(client: pg.PoolClient, source: DatabaseSync, plan: Plan) {
  const { table, columns } = plan, key = orderKey(table);
  const expected = createHash('sha256');
  let sourceCount = 0;
  const statement = source.prepare(`SELECT ${select(plan).join(', ')} FROM ${quote(table.name)} ORDER BY ${key.map(name => `${quote(name)} COLLATE BINARY`).join(', ')}`);
  for (const row of sourceRows(statement)) { sourceCount += 1; expected.update(canonical(columns.map(column => convert(row[column.name], column, `Source table ${table.name}`)))); }
  const actual = await targetFingerprint(client, table, columns);
  if (sourceCount !== plan.rows || actual.rows !== sourceCount) throw new ImportError(`Verification failed for ${table.name}: the source has ${sourceCount} rows and PostgreSQL has ${actual.rows}. The import was rolled back.`);
  if (expected.digest('hex') !== actual.sha256) throw new ImportError(`Verification failed for ${table.name}: the row fingerprint differs from the source. The import was rolled back.`);
}

/**
 * Copies every Campaign table in the SQLite file into PostgreSQL in one transaction, then verifies row counts and
 * fingerprints before COMMIT. The caller has already checked that the schema is fully migrated.
 */
export async function importSqlite(pool: pg.Pool, file: string): Promise<ImportSummary> {
  const source = openSource(file);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL statement_timeout = 0');
      await client.query('SELECT pg_advisory_xact_lock(109858, 3)'); // One import at a time.
      const tables = await targetTables(client);
      for (const name of [...tables.keys()].sort()) {
        if (name === 'installation' || name === ledgerTable) continue;
        if ((await client.query(`SELECT 1 FROM ${quote(name)} LIMIT 1`)).rowCount) throw new ImportError(`The target database already has data (table ${name}). Import only into a freshly migrated, empty database.`);
      }
      const present = new Set(source.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").all().map(row => String(row.name)));
      const unknown = [...present].filter(name => !tables.has(name) || name === ledgerTable).sort();
      if (unknown.length) throw new ImportError(`The source has tables the PostgreSQL schema does not: ${unknown.join(', ')}. Nothing was imported.`);
      const count = (name: string) => Number(source.prepare(`SELECT count(*) AS count FROM ${quote(name)}`).get()!.count);
      const summary: ImportSummary = { tables: [], absent: [], ephemeral: [], defaulted: [], sequences: [], claimed: false };
      const candidates = [...tables.keys()].filter(name => name !== 'installation' && name !== ledgerTable && !ephemeralTables.includes(name));
      summary.absent = candidates.filter(name => !present.has(name)).sort();
      summary.ephemeral = ephemeralTables.filter(name => present.has(name)).map(name => ({ name, rows: count(name) }));

      const plans: Plan[] = [];
      for (const name of await foreignKeyOrder(client, candidates.filter(name => present.has(name)))) {
        const current = plan(source, tables.get(name)!);
        for (const column of current.table.columns) if (!current.columns.includes(column)) summary.defaulted.push(`${name}.${column.name}`);
        await copy(client, source, current);
        plans.push(current);
        summary.tables.push({ name, rows: current.rows });
      }

      // Reproduces the SQLite backfill: UPDATE installation SET claimed=1 WHERE EXISTS(SELECT 1 FROM users).
      const sourceClaim = present.has('installation') ? source.prepare('SELECT claimed FROM installation WHERE id = 1').get()?.claimed : undefined;
      summary.claimed = sourceClaim === 1 || count('users') > 0;
      if (!(await client.query('UPDATE installation SET claimed = $1 WHERE id = 1', [summary.claimed])).rowCount) await client.query('INSERT INTO installation (id, claimed) VALUES (1, $1)', [summary.claimed]);

      // New rows continue after the imported ones; AUTOINCREMENT tables also never reuse a value SQLite already issued.
      const autoincrement = source.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").get();
      const issued = autoincrement ? new Map(source.prepare('SELECT name, seq FROM sqlite_sequence').all().map(row => [String(row.name), Number(row.seq)])) : new Map<string, number>();
      for (const { table, columns } of plans) for (const column of columns.filter(column => column.identity)) {
        const max = Number((await client.query(`SELECT coalesce(max(${quote(column.name)}), 0)::text AS max FROM ${quote(table.name)}`)).rows[0].max);
        const value = Math.max(max, column.name === 'seq' ? 0 : issued.get(table.name) ?? 0);
        if (value < 1) continue;
        await client.query('SELECT setval(pg_get_serial_sequence($1, $2), $3)', [quote(table.name), column.name, value]);
        summary.sequences.push({ column: `${table.name}.${column.name}`, value });
      }

      for (const current of plans) await verify(client, source, current);
      if ((await client.query('SELECT claimed FROM installation WHERE id = 1')).rows[0]?.claimed !== summary.claimed) throw new ImportError('Verification failed for installation. The import was rolled back.');
      await client.query('COMMIT');
      return summary;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
    source.close();
  }
}
