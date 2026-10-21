import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { postgresSkip, testApp } from './postgres.mjs';

test('health reports ready only while PostgreSQL answers, and a scheduler switch typo refuses to start', { skip: postgresSkip }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'campaign-health-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  await assert.rejects(testApp(t, { dataDir, env: { DIRECT_SCHEDULER: 'of' }, directScheduler: false }), /DIRECT_SCHEDULER must be on or off/);
  const app = await testApp(t, { dataDir, env: { DIRECT_SCHEDULER: 'off' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const health = async () => { const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/health`); return { status: response.status, data: await response.json() }; };
  assert.deepEqual(await health(), { status: 200, data: { ok: true } });
  // An ended pool fails every query, as an unreachable database does.
  await app.database.pool.end();
  assert.equal((await health()).status, 503);
});

test('DIRECT_SCHEDULER=off never runs the direct-campaign sender, which otherwise runs every second', { skip: postgresSkip }, async t => {
  const ticks = async env => {
    const dataDir = await mkdtemp(join(tmpdir(), 'campaign-scheduler-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
    const app = await testApp(t, { dataDir, env }); let calls = 0;
    app.direct.processPending = async () => { calls++; };
    await new Promise(resolve => setTimeout(resolve, 1500));
    return calls;
  };
  assert.equal(await ticks({ DIRECT_SCHEDULER: 'off' }), 0);
  assert.ok(await ticks({}) > 0, 'Without the switch the scheduler runs, so the zero above is not vacuous.');
});
