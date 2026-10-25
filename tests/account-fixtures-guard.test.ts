import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

// Tests create people, workspaces, memberships and instance operators through tests/fixtures/accounts.ts, so the
// identity and workspace migration (code-system #97) changes one file. These few still write raw SQL because they
// build the statement from data or need ON CONFLICT / a subselect; phase 1 of the migration converts them by hand.
const allowed = new Map([
  ['ad-spend-approval.test.mjs', 'builds its user rows from a member list'],
  ['agent.test.mjs', 'builds its fixture SQL from user and project lists'],
  ['ad-targeting.test.mjs', 'restores a role with ON CONFLICT … DO UPDATE'],
  ['auth-races.test.mjs', 'reseeds the same rows with ON CONFLICT DO NOTHING'],
  ['sms-media.test.mjs', 'resolves the workspace with a subselect'],
]);
const raw = /INSERT INTO (users|workspaces|memberships|instance_operators)\b/;
const root = new URL('./', import.meta.url);

test('tests create accounts and workspaces through the shared fixtures, not raw INSERTs', async () => {
  const found: string[] = [];
  for (const file of (await readdir(root)).filter(name => /\.test\.(mjs|ts)$/.test(name) && !allowed.has(name))) {
    if (raw.test(await readFile(new URL(file, root), 'utf8'))) found.push(file);
  }
  assert.deepEqual(found, [], 'Use seedAccounts / addUsers / addWorkspaces / addMemberships / grantOperators from tests/fixtures/accounts.ts:\n' + found.join('\n'));
  for (const file of allowed.keys()) assert.match(await readFile(new URL(file, root), 'utf8'), raw, `${file} no longer needs its exception; remove it from the list.`);
});
