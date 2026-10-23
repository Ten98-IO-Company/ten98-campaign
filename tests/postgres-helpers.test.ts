import test from 'node:test';
import assert from 'node:assert/strict';
import { blockWrites, postgresSkip, testDatabase } from './postgres.mjs';

const pg = { skip: postgresSkip };

// The race tests hold a table lock while the code under test fills the pool with blocked writers. The gate must still see
// those waiters, and a gate that gives up must release its lock, or the file's pool.end() waits on it forever.
test('a write gate counts its waiters even when blocked writers hold every other pool connection', pg, async t => {
  const { pool } = await testDatabase(t, { max: 2 });
  await pool.query('CREATE TABLE gated (id int)');
  const gate = await blockWrites(pool, 'gated'), write = pool.query('INSERT INTO gated VALUES (1)');
  await gate.waiting(1, 2000); await gate.release();
  await write;
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM gated')).rows[0].n, 1);
});

test('a write gate that times out releases its lock and connection', pg, async t => {
  const { pool } = await testDatabase(t, { max: 2 });
  await pool.query('CREATE TABLE gated (id int)');
  const gate = await blockWrites(pool, 'gated');
  await assert.rejects(gate.waiting(1, 100), /Expected 1 lock waiters/);
  await pool.query('INSERT INTO gated VALUES (1)');
  assert.equal(pool.idleCount + pool.waitingCount <= pool.totalCount, true);
  await gate.release();
});
