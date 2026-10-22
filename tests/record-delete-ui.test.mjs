import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const app = (await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

test('deleting a local record asks in the shared confirm dialog and then runs the unchanged delete', async () => {
  const remove = app.slice(app.indexOf('async function remove('), app.indexOf('  async function clearSampleData('));
  assert.doesNotMatch(app, /window\.confirm\(/, 'No native confirm remains in the app shell.');
  assert.match(remove, /await api\(endpoint\(collection \+ '\/' \+ item\.id\), 'DELETE'\)/);
  assert.match(app, /\[confirm, confirmDialog\] = useConfirmDialog\(\)/); assert.match(app, /\n    \{confirmDialog\}\n/, 'The app renders the confirm dialog.');
  const handler = app.match(/<Button variant="danger" disabled=\{busy\} onClick=\{(async \(\) => \{ const collection = [^\n]+?\})\}>Delete<\/Button>/)?.[1]; assert.ok(handler);
  // Run the button's own handler: only a confirmed request reaches the unchanged delete, with the record's collection.
  for (const answer of [false, true]) {
    const requests = [], removed = [], modal = { type: 'asset', item: { id: 'asset-1', name: 'Hero image' } };
    const click = new Function('modal', 'confirm', 'remove', `return (${stripTypeScriptTypes(handler)});`)(modal, async request => { requests.push(request); return answer; }, async (...args) => { removed.push(args); });
    await click();
    assert.deepEqual(requests, [{ title: 'Delete “Hero image”?', description: 'This removes the local record.', confirmLabel: 'Delete', danger: true }]);
    assert.deepEqual(removed, answer ? [['assets', modal.item]] : []);
  }
});
