import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import * as library from '@ten98/ui';

const source = await readFile(new URL('../src/ZernioQueues.tsx', import.meta.url), 'utf8');
const section = (start, end) => { const from = source.indexOf(start), to = source.indexOf(end, from); assert.ok(from >= 0 && to > from); return stripTypeScriptTypes(source.slice(from, to)); };
const compile = (code, context) => new Function(...Object.keys(context), `return (${code});`)(...Object.values(context));
const loadCode = section('async function load()', '  function choose('), actionCode = section('async function action(', '  async function load()');
const localPosts = source.match(/^  const localPosts = .+;$/m)?.[0], localEmpty = source.match(/\{[^{}\n]*!localPosts\.length && <Text>No unsent local posts[^<]*<\/Text>\}/)?.[0];
assert.ok(localPosts && localEmpty);
const { code: renderCode } = await transformWithOxc(`const render = () => { ${localPosts} return (<>${source.slice(source.indexOf('    {error &&'), source.indexOf('    {!!queues.length'))}${localEmpty}</>); };`, 'QueueReadState.tsx', { jsx: { runtime: 'classic' } });
function ui(read) {
  const state = { loaded: false, queues: [], listVersion: '', posts: [], approvalRequired: false, enqueueReviews: {}, error: '', notice: '', busy: false };
  const set = name => value => { state[name] = typeof value === 'function' ? value(state[name]) : value; };
  const context = { path: '/projects/one/integrations/queues', projectPath: '/projects/one', current: () => true, busyRef: { current: false }, requester: { current: read }, ...Object.fromEntries(Object.keys(state).map(name => ['set' + name[0].toUpperCase() + name.slice(1), set(name)])) };
  const load = compile(loadCode, context), action = compile(actionCode, context);
  const html = () => { const values = { React, ...library, ...state }; return renderToStaticMarkup(new Function(...Object.keys(values), renderCode + '; return render();')(...Object.values(values))); };
  return { state, context, load, action, html };
}

test('queue reads distinguish verified empty results from failed refreshes and retain each diagnostic', async () => {
  let failing = '/projects/one/integrations/queues', release;
  const view = ui(async path => {
    if (path === failing) throw new Error('Zernio did not confirm the request.');
    if (release && path.endsWith('/approvals/posts')) return new Promise(resolve => { release = resolve; });
    return path.endsWith('/queues') ? { queues: [], version: 'verified-list' } : { posts: [], requireApproval: false };
  });
  assert.doesNotMatch(view.html(), /No queues exist|No unsent local posts/);
  const initial = view.action(view.load); assert.doesNotMatch(view.html(), /No queues exist|No unsent local posts/);
  await initial; assert.equal(view.state.loaded, false); assert.doesNotMatch(view.html(), /No queues exist|No unsent local posts/);
  for (const path of ['/projects/one/integrations/queues', '/projects/one/approvals/posts']) {
    failing = ''; await view.action(view.load);
    assert.equal(view.state.loaded, true); assert.match(view.html(), /No queues exist for this project profile/); assert.match(view.html(), /No unsent local posts/);
    failing = path; const pending = view.action(view.load);
    assert.equal(view.state.loaded, false); assert.doesNotMatch(view.html(), /No queues exist|No unsent local posts/);
    await pending;
    assert.equal(view.state.error, 'Could not load publishing queues. Zernio did not confirm the request.');
    assert.match(view.html(), /role="alert"/); assert.doesNotMatch(view.html(), /No queues exist|No unsent local posts/);
    assert.equal(view.state.listVersion, 'verified-list'); assert.equal(view.state.busy, false);
  }
  failing = ''; release = true; const pending = view.action(view.load);
  await Promise.resolve(); assert.equal(view.state.loaded, false);
  release({ posts: [], requireApproval: false }); await pending;
  assert.equal(view.state.loaded, true); assert.match(view.html(), /No queues exist/);
  await view.action(async () => { throw new Error('The mutation outcome needs review.'); });
  assert.equal(view.state.error, 'The mutation outcome needs review.');
});

test('confirmed enqueue keeps refresh diagnostics and its confirmed-write warning without resending', async () => {
  for (const failureAt of ['onChanged', 'load']) {
    const view = ui(async () => { throw new Error('Gateway unavailable'); });
    const item = { post: { id: 'post-one', queueId: 'queue-one', queueVersion: 'v1' } }, queue = { _id: 'queue-one', version: 'v1', active: true, slots: [{}] };
    let writes = 0; view.state.posts = [item]; view.state.loaded = true;
    const enqueue = compile(section('async function enqueue(', '  const localPosts ='), { ...view.context, canWrite: true, queues: [queue], approvalRequired: false, enqueueReviews: { 'post-one': 'reviewed' }, enqueueReviewKey: () => 'reviewed', action: view.action, load: view.load, onChanged: failureAt === 'onChanged' ? async () => { throw new Error('Project refresh unavailable'); } : null, write: async () => { writes++; return { post: { scheduledAt: '2070-01-01T09:00:00Z' } }; } });
    await enqueue(item);
    assert.equal(writes, 1); assert.equal(view.state.posts.length, 0); assert.equal(view.state.loaded, failureAt === 'onChanged');
    assert.match(view.state.notice, /Post assigned to the provider queue/);
    const diagnostic = failureAt === 'onChanged' ? 'Project refresh unavailable' : 'Could not load publishing queues. Gateway unavailable';
    assert.equal(view.state.error, 'The queue submission was confirmed, but the latest local list could not be refreshed. Refresh before another action. ' + diagnostic);
    if (failureAt === 'load') assert.doesNotMatch(view.html(), /No unsent local posts/);
  }
});

test('queue row actions keep short visible labels, full accessible identities and their role/readiness guards', async () => {
  const start = source.indexOf('    {!!queues.length'), end = source.indexOf('    {preview &&', start);
  assert.ok(start > 0 && end > start);
  const { code } = await transformWithOxc(`const render = () => (<>${source.slice(start, end)}</>);`, 'QueueRowActions.tsx', { jsx: { runtime: 'classic' } });
  const queue = { _id: 'queue-one', name: 'Weekly launch queue for a long descriptive campaign', timezone: 'UTC', slots: [{ dayOfWeek: 1, time: '09:00' }], active: true, isDefault: true };
  const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(nodes)];
  function render(canManage, busy, row = queue, editor = { selected: null, editing: false }) {
    const calls = [], context = { React, ...library, queues: [row], canManage, busy, ...editor, days: ['Sunday', 'Monday'], inspect: value => calls.push(['Preview', value]), choose: value => calls.push(['Edit', value]), remove: value => calls.push(['Delete', value]), setActive: (value, active) => calls.push([active ? 'Activate' : 'Pause', value]) };
    const tree = new Function(...Object.keys(context), code + '; return render();')(...Object.values(context)), table = nodes(tree).find(node => node.type === library.DataTable);
    return { tree, table, calls, buttons: nodes(table.props.rowActions(row)).filter(node => node.type === library.Button) };
  }
  for (const canManage of [false, true]) for (const busy of [false, true]) {
    const view = render(canManage, busy), actions = canManage ? ['Preview', 'Pause', 'Edit', 'Delete'] : ['Preview'];
    assert.deepEqual(view.buttons.map(button => button.props.children), actions);
    for (const [index, button] of view.buttons.entries()) {
      assert.equal(button.props['aria-label'], actions[index] + ' ' + queue.name); assert.equal(button.props.disabled, busy);
      if (!busy) button.props.onClick();
    }
    assert.deepEqual(view.calls.map(([action]) => action), busy ? [] : actions); assert.ok(view.calls.every(([, row]) => row === queue));
    assert.equal(view.table.props.ariaLabel, 'Publishing queues');
    assert.match(renderToStaticMarkup(view.tree), /aria-label="Preview Weekly launch queue for a long descriptive campaign"/);
  }
  for (const row of [{ ...queue, active: false }, { ...queue, slots: [] }]) assert.equal(render(false, false, row).buttons[0].props.disabled, true);
  const toggle = (row, editor) => render(true, false, row, editor).buttons.find(button => ['Pause', 'Activate'].includes(button.props.children));
  assert.equal(toggle(queue, { selected: queue, editing: true }).props.disabled, true, 'The row open with unsaved edits cannot be paused.');
  assert.equal(toggle(queue, { selected: queue, editing: false }).props.disabled, false);
  assert.equal(toggle(queue, { selected: { ...queue, _id: 'other' }, editing: true }).props.disabled, false, 'Edits to another queue do not block this row.');
  assert.equal(toggle({ ...queue, active: false, slots: [] }, { selected: null, editing: false }).props.disabled, true, 'A paused queue without slots cannot be activated.');
});
