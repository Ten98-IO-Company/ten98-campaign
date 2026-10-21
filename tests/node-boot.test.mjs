import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { postgresSkip, testDatabase } from './postgres.mjs';

// Type checking does not prove Node can strip and load the TypeScript modules; boot the real entrypoint.
test('the production entrypoint boots on Node 24 and serves a request', { timeout: 60000, skip: postgresSkip }, async t => {
  assert.equal(process.versions.node.split('.')[0], '24');
  const port = await new Promise(resolve => { const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
  // The entrypoint refuses to start without DATABASE_URL naming a migrated database. Windows sockets need SystemRoot.
  const { url } = await testDatabase(t);
  const dataDir = await mkdtemp(join(tmpdir(), 'campaign-boot-')), origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server/index.ts', import.meta.url))], { env: { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), DATA_DIR: dataDir, DATABASE_URL: url, PORT: String(port), APP_URL: origin }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server did not start:\n${output}`)), 30000);
      child.stdout.on('data', () => { if (output.includes('Campaign manager available')) { clearTimeout(timer); resolve(); } });
      exited.then(code => { clearTimeout(timer); reject(new Error(`Server exited with ${code}:\n${output}`)); });
    });
    const response = await fetch(`${origin}/api/health`);
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true });
    assert.doesNotMatch(output, /ExperimentalWarning|Error/);
  } finally {
    child.kill('SIGTERM'); await exited; await rm(dataDir, { recursive: true, force: true });
  }
});
