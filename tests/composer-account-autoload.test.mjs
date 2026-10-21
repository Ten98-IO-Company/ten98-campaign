import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const source = await readFile(new URL('../src/PostComposer.tsx', import.meta.url), 'utf8');
const effect = source.match(/useEffect\((\(\) => \{ if \(autoLoaded\.current[^\n]+?\}), \[\]\);/)?.[1];

function run(changes = {}, mounts = 1) {
  let loads = 0; const autoLoaded = { current: false };
  const context = { autoLoaded, readOnly: false, canWrite: true, providerPost: false, onLoadAccounts: async () => ({}), connectedAccounts: [], loadAccounts: async () => { loads++; }, ...changes };
  const open = new Function(...Object.keys(context), `return (${stripTypeScriptTypes(effect)});`)(...Object.values(context));
  for (let mount = 0; mount < mounts; mount++) open();
  return loads;
}

test('an open composer with no accounts loads them once, even when its effect runs again', () => {
  assert.ok(effect, 'PostComposer has the account auto-load effect.');
  assert.equal(run(), 1);
  assert.equal(run({}, 3), 1, 'A remount of the same composer (Strict Mode) does not load again.');
});

test('read-only, viewer, provider-post, already-loaded and unsupported composers do not auto-load accounts', () => {
  for (const changes of [{ readOnly: true }, { canWrite: false }, { providerPost: true }, { connectedAccounts: [{ id: 'account' }] }, { onLoadAccounts: undefined }]) assert.equal(run(changes), 0, JSON.stringify(Object.keys(changes)));
});
