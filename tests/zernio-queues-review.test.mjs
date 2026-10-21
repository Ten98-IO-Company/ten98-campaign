import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const source = await readFile(new URL('../src/ZernioQueues.tsx', import.meta.url), 'utf8');

test('queue deletion and rescheduling confirm in dialogs that call the unchanged writes', () => {
  assert.doesNotMatch(source, /window\.confirm/);
  assert.ok(source.includes("if (moveExisting && !reshuffleConfirmed) { setConfirming({ kind: 'reshuffle' }); return; }"), 'Rescheduling waits for the dialog.');
  assert.ok(source.includes('onConfirm={async () => { setConfirming(null); await save(undefined, true); }}'));
  assert.ok(source.includes("function remove(row: Queue) { if (canManage) setConfirming({ kind: 'delete', row }); }"));
  assert.ok(source.includes("await write(`${path}/${encodeURIComponent(row._id)}/delete`, { expectedVersion: row.version, confirmDelete: row._id }, 'delete')"), 'The delete write is unchanged.');
  assert.ok(source.includes('if (target) await removeConfirmed(target);'));
});

test('the queue timezone is validated like the server, so saved zones the browser list omits stay usable', () => {
  assert.ok(source.includes('<Combobox label="Timezone" required allowCustom={false} options={zoneOptions(draft.timezone)}'));
  assert.ok(source.includes('<Button type="submit" variant="primary" disabled={!validZone(draft.timezone)}>'));
  const helpers = ['timeZones', 'validZone', 'zoneOptions'].map(name => source.match(new RegExp(`^const ${name} = .+;$`, 'm'))[0]).join('\n');
  const { timeZones, validZone, zoneOptions } = new Function(stripTypeScriptTypes(helpers) + '; return { timeZones, validZone, zoneOptions };')();
  assert.ok(timeZones.includes('UTC') && timeZones.includes('Asia/Dubai')); assert.equal(new Set(timeZones).size, timeZones.length);
  // Intl.supportedValuesOf omits aliases such as Asia/Kolkata; the server accepts any zone Intl.DateTimeFormat accepts.
  for (const zone of ['Asia/Kolkata', 'Europe/Kyiv', 'Etc/UTC']) { assert.equal(validZone(zone), true, zone); assert.ok(zoneOptions(zone).includes(zone), zone + ' is offered while it is the saved zone'); }
  for (const zone of ['Not/AZone', 'Asia/Ko', '', 'x'.repeat(101)]) { assert.equal(validZone(zone), false, zone); assert.equal(zoneOptions(zone), timeZones, 'An invalid draft is never offered as a choice.'); }
});

test('a saved post enters its queue only through the reviewed confirmation', () => {
  assert.ok(source.includes('acknowledgements={[]} confirmLabel="Add saved post to queue" onConfirm={() => enqueue(item)}'));
  assert.ok(source.includes("!reviewed ? 'Check the statement above to continue.'"), 'Confirm explains the unchecked review.');
  assert.ok(source.includes("approvalRequired && item.status !== 'approved' || enqueueReviews[post.id] !== enqueueReviewKey(item, queue)) return;"), 'enqueue keeps its own review and approval guard.');
});

const compile = (code, context) => new Function(...Object.keys(context), `return (${stripTypeScriptTypes(code)});`)(...Object.values(context));
function statusWriter(response) {
  const keys = { current: new Map() }, calls = [], path = '/projects/p/integrations/queues';
  const write = compile(source.slice(source.indexOf('async function write('), source.indexOf('  async function save(')), { current: () => true, keys, crypto: { randomUUID: () => 'status-key-' + (calls.length + 1) }, setEnqueueReviews() {}, requester: { current: async (...args) => { calls.push(args); if (response instanceof Error) throw response; return response; } } });
  return { write, keys, calls, target: `${path}/${encodeURIComponent('queue/1')}/status` };
}
const queue = (active, version = 'b'.repeat(64)) => ({ _id: 'queue/1', active, version, slots: [{ dayOfWeek: 1, time: '09:00' }] });

test('pausing or activating a queue posts only the wanted state and reviewed version to the status endpoint', async () => {
  const body = source.slice(source.indexOf('async function setActive('), source.indexOf('  function remove('));
  assert.ok(body.includes("await write(`${path}/${encodeURIComponent(row._id)}/status`, { active, expectedVersion: row.version }, 'status')"), 'The dedicated status endpoint carries only the state and the reviewed version.');
  assert.ok(body.includes('if (!canManage) return;'));
  assert.ok(source.includes("onClick={() => setActive(row, !row.active)}>{row.active ? 'Pause' : 'Activate'}</Button>"));
  const sent = { active: false, expectedVersion: 'a'.repeat(64) }, done = { operation: { status: 'complete' }, queue: queue(false), queues: [queue(false)], version: 'c'.repeat(64), changed: true };
  const ok = statusWriter(done); assert.equal(await ok.write(ok.target, sent, 'status'), done); assert.deepEqual(ok.calls[0].slice(0, 3), [ok.target, 'POST', sent]); assert.equal(ok.keys.current.size, 0);
  const same = statusWriter({ ...done, queue: queue(false, sent.expectedVersion), changed: false }); await same.write(same.target, sent, 'status'); assert.equal(same.keys.current.size, 0, 'An unchanged receipt confirms the reviewed version.');
  for (const receipt of [{ ...done, queue: queue(true) }, { ...done, queue: { ...queue(false), _id: 'other' } }, { ...done, queue: { ...queue(false), version: 1 } }, { ...done, changed: false }, { ...done, changed: undefined }, { ...done, queues: undefined }, { ...done, operation: { status: 'uncertain' } }]) {
    const bad = statusWriter(receipt); await assert.rejects(bad.write(bad.target, sent, 'status'), /receipt could not be read/); assert.equal(bad.keys.current.size, 1, 'A wrong or unreadable receipt keeps its action key.');
  }
});

test('stale, unreviewed and slotless status changes explain what to do', async () => {
  const body = source.slice(source.indexOf('async function setActive('), source.indexOf('  function remove('));
  const explain = compile(source.match(/^const statusProblem = (.+);$/m)[1], {});
  for (const code of ['QUEUE_CHANGED', 'QUEUE_REVIEW_REQUIRED']) assert.match(explain(Object.assign(new Error('Server text'), { code })).message, /changed since.*Refresh/);
  assert.match(explain(Object.assign(new Error('Server text'), { code: 'QUEUE_SLOTS_REQUIRED' })).message, /weekly slot/);
  const other = Object.assign(new Error('Provider unavailable'), { code: 'PROVIDER_UNAVAILABLE' }); assert.equal(explain(other), other);
  assert.ok(body.includes('catch (failure) { throw statusProblem(failure as Error & { code?: string }); }'));
  assert.ok(source.includes("disabled={busy || !row.active && !row.slots.length"), 'A queue without slots cannot be activated from the list.');
});
