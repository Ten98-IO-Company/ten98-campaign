import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = (await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

test('deleting a local record asks in a ConfirmDialog and then runs the unchanged delete', () => {
  const remove = app.slice(app.indexOf('async function remove('), app.indexOf('  async function clearSampleData('));
  assert.doesNotMatch(app, /window\.confirm\(/, 'No native confirm remains in the app shell.');
  assert.match(remove, /await api\(endpoint\(collection \+ '\/' \+ item\.id\), 'DELETE'\)/);
  assert.match(app, /<Button variant="danger" disabled=\{busy\} onClick=\{\(\) => setRemoving\(\{ collection: \(\{ campaign: 'campaigns', post: 'posts', placement: 'placements', asset: 'assets', provider: 'providers' \} as Record<string, string>\)\[modal\.type\], item: modal\.item! \}\)\}>Delete<\/Button>/);
  const dialog = app.match(/<ConfirmDialog open=\{!!removing\}[^\n]+?\/>/)?.[0]; assert.ok(dialog);
  assert.match(dialog, /danger/); assert.match(dialog, /This removes the local record\./);
  assert.match(dialog, /onConfirm=\{async \(\) => \{ const target = removing; if \(target\) await remove\(target\.collection, target\.item\); setRemoving\(null\); \}\}/);
});
