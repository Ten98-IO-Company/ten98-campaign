import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

const app = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8'), source = await readFile(new URL('../src/ContentApprovals.tsx', import.meta.url), 'utf8');
const details = [{ platform: 'instagram', field: 'mediaItems', message: 'Instagram needs an image or video.' }, { platform: 'facebook', field: 'content', message: 'Caption is too long.', accountId: 'page-1' }];
const restricted = () => Object.assign(new Error('instagram: Instagram needs an image or video.'), { status: 422, code: 'APPROVAL_POST_RESTRICTIONS', details });

test('the app request helper keeps the error details the server returns', async () => {
  const start = app.indexOf('async function api('), helper = app.slice(start, app.indexOf('\n}\n', start) + 2);
  const api = runInNewContext(stripTypeScriptTypes(helper) + '; api', { fetch: async () => ({ ok: false, status: 422, json: async () => ({ error: { code: 'APPROVAL_POST_RESTRICTIONS', message: 'Blocked', details } }) }) });
  await assert.rejects(api('/projects/p/approvals/posts/post/review', 'POST', {}), error => error.status === 422 && error.code === 'APPROVAL_POST_RESTRICTIONS' && error.message === 'Blocked' && error.details === details);
});

// Run the component's own handlers up to its markup; state 0 is the queue, 7 the selection and 12 the restrictions by post.
function view(request, posts, selected = []) {
  const start = source.indexOf('export default function '), end = source.indexOf('  return <', start), state = [], initial = { 0: { requireApproval: true, posts }, 7: selected };
  const context = {
    useState(value) { const index = state.length; state.push(Object.hasOwn(initial, index) ? initial[index] : value); return [state[index], next => { state[index] = typeof next === 'function' ? next(state[index]) : next; }]; },
    useRef: value => ({ current: value }), useEffect() {}, document: { getElementById: () => null }, useFocusReturn: () => () => {},
    ...Object.fromEntries(['approveBlocked', 'postName', 'reviewItem'].map(name => [name, new Function('return ' + stripTypeScriptTypes(source.match(new RegExp(`^const ${name} = (.+);$`, 'm'))[1]))()])),
  };
  const component = new Function(...Object.keys(context), `return (${stripTypeScriptTypes(source.slice(start, end).replace('export default ', '') + 'return { review, bulkReview };\n}')});`)(...Object.values(context));
  return { ...component({ projectId: 'project', role: 'owner', request, onChanged: async () => {} }), state };
}
const card = id => ({ post: { id, content: 'Caption ' + id, platforms: ['instagram'] }, status: 'pending', review: { id: 'review-' + id } });

test('a single approval refused for publishing restrictions keeps its details beside that post', async () => {
  const ui = view(async (_path, method) => { if (method) throw restricted(); return { requireApproval: true, posts: [] }; }, [card('one')]);
  await ui.review(card('one'), 'approved');
  assert.deepEqual(ui.state[12], { one: details }); assert.match(ui.state[2], /Instagram needs/);
  const retry = view(async (_path, method) => method ? { item: { ...card('one'), status: 'approved' } } : { requireApproval: true, posts: [] }, [card('one')]);
  retry.state[12] = { one: details }; await retry.review(card('one'), 'approved'); assert.deepEqual(retry.state[12], {}, 'A new attempt clears the old restrictions.');
});

test('bulk approval records each refused post with its own restrictions and ignores other failures', async () => {
  const ui = view(async (path, method) => { if (!method) return { requireApproval: true, posts: [] }; if (path.includes('/one/')) throw restricted(); if (path.includes('/two/')) throw new Error('Review expired'); return { item: card('three') }; }, [card('one'), card('two'), card('three')], ['one', 'two', 'three']);
  await ui.bulkReview('approved');
  assert.deepEqual(ui.state[12], { one: details }); assert.deepEqual(ui.state[7], ['one', 'two']);
  assert.deepEqual(ui.state[9].failed.map(row => row.id), ['one', 'two']);
});

test('malformed details are not shown as restrictions', async () => {
  const ui = view(async (_path, method) => { if (method) throw Object.assign(new Error('Blocked'), { code: 'APPROVAL_POST_RESTRICTIONS', details: [{ message: 7 }, null, { platform: 'x', message: 'Valid' }] }); return {}; }, [card('one')]);
  await ui.review(card('one'), 'approved'); assert.deepEqual(ui.state[12], { one: [{ platform: 'x', message: 'Valid' }] });
});
