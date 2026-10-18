import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Run from the repository/image root. The container needs only loopback networking.
const { createApp } = await import(pathToFileURL(resolve('server/index.mjs')));
const dataDir = await mkdtemp(join(tmpdir(), 'ten98-container-check-'));
const app = createApp({ dataDir, env: {}, appUrl: 'http://127.0.0.1:3018', directScheduler: false });
try {
  assert.notEqual(process.getuid?.(), 0, 'The production image must run as an unprivileged user.');
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const health = await fetch(base + '/api/health');
  assert.equal(health.status, 200); assert.equal((await health.json()).ok, true);
  const session = await fetch(base + '/api/session');
  assert.equal(session.status, 200); assert.equal((await session.json()).setupRequired, true);
  assert.equal((await fetch(base + '/api/state')).status, 401);
  const home = await fetch(base + '/'), html = await home.text();
  assert.equal(home.status, 200); assert.match(html, /<script nonce="[^"]+"[^>]+src="\/assets\//);
  const bundle = html.match(/src="(\/assets\/[^\"]+\.js)"/)[1];
  assert.equal((await fetch(base + bundle)).status, 200);
  console.log('Container imports, non-root startup, database, auth boundary and frontend bundle passed.');
} finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
