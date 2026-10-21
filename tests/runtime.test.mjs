import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.ts';
import { postgresSkip, testDatabase } from './postgres.mjs';

test('startup rejects unsafe OIDC issuers before opening the database or starting background work', { skip: postgresSkip }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ten98-campaign-oidc-'));
  try {
    for (const issuer of ['http://identity.example', 'https://user:secret@identity.example', 'https://identity.example?scope=openid', 'https://identity.example#fragment', 'not a URL']) {
      // No database is supplied: the issuer check must reject before any connection is attempted.
      await assert.rejects(createApp({ dataDir, env: { OIDC_ISSUER: issuer, OIDC_CLIENT_ID: 'fixture' } }));
      assert.deepEqual(await readdir(dataDir), [], 'Invalid OIDC configuration must fail before creating local data.');
    }
    const { pool, db } = await testDatabase(t), app = await createApp({ dataDir, env: { OIDC_ISSUER: 'https://identity.example/realms/team', OIDC_CLIENT_ID: 'fixture' }, directScheduler: false, database: { pool, db } });
    try { assert.equal(app.config.oidcEnabled, true); } finally { await app.close(); }
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
