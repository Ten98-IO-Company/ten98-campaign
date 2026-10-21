import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const source = await readFile(new URL('../src/ContentApprovals.tsx', import.meta.url), 'utf8');
// Evaluate the component body up to its markup with chosen state: 0 queue, 4 status filter, 7 selection, 10 sort, 11 platform.
function view(posts, state = {}) {
  const start = source.indexOf('export default function '), end = source.indexOf('  return <', start), values = [], initial = { 0: { requireApproval: true, posts }, ...state };
  const context = {
    useState(value) { const index = values.length; values.push(Object.hasOwn(initial, index) ? initial[index] : value); return [values[index], () => {}]; },
    useRef: value => ({ current: value }), useEffect() {}, document: { getElementById: () => null },
    ...Object.fromEntries(['approveBlocked', 'postName'].map(name => [name, new Function('return ' + stripTypeScriptTypes(source.match(new RegExp(`^const ${name} = (.+);$`, 'm'))[1]))()])),
  };
  return new Function(...Object.keys(context), `return (${stripTypeScriptTypes(source.slice(start, end).replace('export default ', '') + 'return { posts, counts, actionable, chosen };\n}')});`)(...Object.values(context))({ projectId: 'project', role: 'owner', request: async () => ({}) });
}
const item = (id, platforms, status, requestedAt, scheduledAt) => ({ post: { id, platforms, ...(scheduledAt ? { scheduledAt } : {}) }, status, review: requestedAt ? { id: 'r-' + id, requestedAt } : null });
const queue = [
  item('old-fb', ['facebook'], 'pending', '2030-01-01T09:00:00Z', '2030-02-03T09:00:00Z'),
  item('new-ig', ['instagram'], 'pending', '2030-01-03T09:00:00Z', '2030-02-01T09:00:00Z'),
  item('mid-both', ['facebook', 'instagram'], 'approved', '2030-01-02T09:00:00Z'),
  item('draft-fb', ['facebook'], 'not_requested'),
  { ...item('sample', ['facebook'], 'pending', '2030-01-04T09:00:00Z'), post: { id: 'sample', platforms: ['facebook'], sample: true } },
];

test('status counts match the platform-filtered list, which sorts newest request first by default', () => {
  const all = view(queue);
  assert.deepEqual(all.posts.map(row => row.post.id), ['new-ig', 'mid-both', 'old-fb', 'draft-fb'], 'Newest review request first; posts never requested sort last.');
  assert.deepEqual(all.counts, { all: 4, pending: 2, stale: 0, approved: 1, rejected: 0, not_requested: 1 }, 'Sample posts are never counted.');
  const facebook = view(queue, { 11: 'facebook' });
  assert.deepEqual(facebook.posts.map(row => row.post.id), ['mid-both', 'old-fb', 'draft-fb']);
  assert.deepEqual(facebook.counts, { all: 3, pending: 1, stale: 0, approved: 1, rejected: 0, not_requested: 1 });
  const pending = view(queue, { 4: 'pending', 11: 'facebook' });
  assert.deepEqual(pending.posts.map(row => row.post.id), ['old-fb']);
});

test('planned-time sort puts the soonest planned post first and bulk selection stays within the visible list', () => {
  assert.deepEqual(view(queue, { 10: 'planned' }).posts.map(row => row.post.id), ['new-ig', 'old-fb', 'mid-both', 'draft-fb'], 'Posts without a planned time sort last.');
  const narrowed = view(queue, { 7: ['old-fb', 'new-ig'], 11: 'instagram' });
  assert.deepEqual(narrowed.actionable.map(row => row.post.id), ['new-ig']); assert.deepEqual(narrowed.chosen.map(row => row.post.id), ['new-ig'], 'A selected post hidden by the platform filter is not acted on.');
});
