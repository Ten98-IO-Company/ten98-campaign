import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const tick = () => new Promise(resolve => setImmediate(resolve));
const source = await readFile(new URL('../src/ContentApprovals.tsx', import.meta.url), 'utf8');

// Run the component's own handlers up to its markup, with controlled state and a recording request boundary.
function view(request, { selected = [], notes = {}, posts }) {
  const start = source.indexOf('export default function '), end = source.indexOf('  return <', start), state = [];
  // State 0 is the review queue, 5 the per-post notes and 7 the bulk selection.
  const initial = { 0: { requireApproval: true, posts }, 5: notes, 7: selected };
  const context = {
    useState(value) { const index = state.length; state.push(Object.hasOwn(initial, index) ? initial[index] : value); return [state[index], next => { state[index] = typeof next === 'function' ? next(state[index]) : next; }]; },
    useRef: value => ({ current: value }), useEffect() {}, document: { getElementById: () => null },
    ...Object.fromEntries(['approveBlocked', 'postName', 'reviewItem'].map(name => [name, new Function('return ' + stripTypeScriptTypes(source.match(new RegExp(`^const ${name} = (.+);$`, 'm'))[1]))()])),
  };
  const component = new Function(...Object.keys(context), `return (${stripTypeScriptTypes(source.slice(start, end).replace('export default ', '') + 'return { bulkReview };\n}')});`)(...Object.values(context));
  let changed = 0;
  return { ...component({ projectId: 'project /1', role: 'owner', request, onChanged: async () => { changed++; } }), state, get changed() { return changed; } };
}
const card = (id, extra = {}) => ({ post: { id, content: `Caption ${id}`, platforms: ['facebook'] }, status: 'pending', review: { id: 'review-' + id }, ...extra });
const posts = () => [
  card('ready'), card('blocked', { asset: { id: 'asset', approval: 'pending' } }), card('failing'), card('approved', { status: 'approved' }), card('unselected'),
  card('sample', { post: { id: 'sample', sample: true, content: 'Sample' } }),
];
const selected = ['ready', 'blocked', 'failing', 'approved', 'sample', 'removed-from-view'];

test('bulk approve sends the single-card review once per visible selected post, sequentially, skipping blocked approvals', async () => {
  const calls = []; let open = 0, overlapped = false;
  const request = async (path, method, body) => {
    calls.push({ path, method, body }); if (!method) return { requireApproval: true, posts: [] };
    if (open) overlapped = true; open++; await tick(); open--;
    if (path.includes('failing')) throw new Error('Review expired');
    return { item: { ...card(path.split('/')[5]), status: 'approved' } };
  };
  const ui = view(request, { posts: posts(), selected });
  await ui.bulkReview('approved');
  assert.equal(overlapped, false, 'The next review starts only after the previous one settles.');
  const reviews = calls.filter(call => call.method === 'POST');
  assert.deepEqual(reviews, [
    { path: '/projects/project%20%2F1/approvals/posts/ready/review', method: 'POST', body: { decision: 'approved', note: '', reviewId: 'review-ready' } },
    { path: '/projects/project%20%2F1/approvals/posts/failing/review', method: 'POST', body: { decision: 'approved', note: '', reviewId: 'review-failing' } },
  ], 'Only visible, actionable, selected and unblocked posts are approved through the per-post review request.');
  assert.deepEqual(ui.state[7], ['blocked', 'failing', 'approved', 'sample', 'removed-from-view'], 'Only succeeded posts are deselected.');
  assert.deepEqual(ui.state[9], { decision: 'approved', ok: 1, skipped: 1, failed: [{ id: 'failing', name: 'Caption failing', message: 'Review expired' }] });
  assert.equal(calls.filter(call => !call.method).length, 1, 'The queue refreshes once after the loop.'); assert.equal(ui.changed, 1);
  assert.equal(ui.state[8], null, 'Progress clears after the loop.');
});

test('bulk request changes sends each post its own note and includes posts whose approval is blocked', async () => {
  const calls = [], request = async (path, method, body) => { calls.push({ path, method, body }); return method ? { item: card(path.split('/')[5]) } : { requireApproval: true, posts: [] }; };
  const ui = view(request, { posts: posts(), selected, notes: { blocked: 'Replace the creative', approved: 'Ignored' } });
  await ui.bulkReview('rejected');
  assert.deepEqual(calls.filter(call => call.method).map(call => [call.path.split('/')[5], call.body]), [
    ['ready', { decision: 'rejected', note: '', reviewId: 'review-ready' }],
    ['blocked', { decision: 'rejected', note: 'Replace the creative', reviewId: 'review-blocked' }],
    ['failing', { decision: 'rejected', note: '', reviewId: 'review-failing' }],
  ]);
  assert.deepEqual(ui.state[7], ['approved', 'sample', 'removed-from-view']); assert.equal(ui.state[5].blocked, '', 'A sent note is cleared like a single review.');
});

test('a bulk action with nothing actionable sends no request', async () => {
  const calls = [], ui = view(async (...args) => { calls.push(args); return {}; }, { posts: posts(), selected: ['blocked', 'approved'] });
  await ui.bulkReview('approved'); assert.deepEqual(calls, []);
});
