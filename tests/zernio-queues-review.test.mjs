import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/ZernioQueues.tsx', import.meta.url), 'utf8');

test('queue deletion and rescheduling confirm in dialogs that call the unchanged writes', () => {
  assert.doesNotMatch(source, /window\.confirm/);
  assert.ok(source.includes("if (moveExisting && !reshuffleConfirmed) { setConfirming({ kind: 'reshuffle' }); return; }"), 'Rescheduling waits for the dialog.');
  assert.ok(source.includes('onConfirm={async () => { setConfirming(null); await save(undefined, true); }}'));
  assert.ok(source.includes("function remove(row: Queue) { if (canManage) setConfirming({ kind: 'delete', row }); }"));
  assert.ok(source.includes("await write(`${path}/${encodeURIComponent(row._id)}/delete`, { expectedVersion: row.version, confirmDelete: row._id }, 'delete')"), 'The delete write is unchanged.');
  assert.ok(source.includes('if (target) await removeConfirmed(target);'));
});

test('the queue timezone is picked from the browser IANA list and an unknown zone blocks saving', () => {
  assert.ok(source.includes('<Combobox label="Timezone" required allowCustom={false} options={timeZones}'));
  assert.ok(source.includes('<Button type="submit" variant="primary" disabled={!timeZones.includes(draft.timezone)}>'));
  const zones = new Function(source.match(/^const timeZones = .+;$/m)[0] + '; return timeZones;')();
  assert.ok(zones.includes('UTC') && zones.includes('Asia/Dubai')); assert.equal(new Set(zones).size, zones.length);
});

test('a saved post enters its queue only through the reviewed confirmation', () => {
  assert.ok(source.includes('acknowledgements={[]} confirmLabel="Add saved post to queue" onConfirm={() => enqueue(item)}'));
  assert.ok(source.includes("!reviewed ? 'Check the statement above to continue.'"), 'Confirm explains the unchecked review.');
  assert.ok(source.includes("approvalRequired && item.status !== 'approved' || enqueueReviews[post.id] !== enqueueReviewKey(item, queue)) return;"), 'enqueue keeps its own review and approval guard.');
});

test('pausing or activating a queue sends the editor update with only active changed and the current version', () => {
  const body = source.slice(source.indexOf('async function setActive('), source.indexOf('  function remove('));
  assert.ok(body.includes('{ name: row.name, timezone: row.timezone, slots: row.slots.map(slot => ({ ...slot })), active, expectedVersion: row.version, setAsDefault: row.isDefault, reshuffleExisting: false }'), 'Same fields the server already validates for an update, without a reshuffle.');
  assert.ok(body.includes("'queue');") && body.includes('if (!canManage) return;'));
  assert.ok(source.includes("onClick={() => setActive(row, !row.active)}>{row.active ? 'Pause' : 'Activate'}</Button>"));
});
