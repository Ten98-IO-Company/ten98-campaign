import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';

test('provider team UI reads explicitly, pages only returned members, renders literal content and withdraws stale data', async () => {
  const source = await readFile(new URL('../src/ZernioTeam.tsx', import.meta.url), 'utf8');
  const { code } = await transformWithOxc(source.replace(/^import .+;\r?\n/gm, '').replace('export default function ', 'function '), 'ZernioTeam.tsx', { jsx: { runtime: 'classic' } });
  const hooks = [], queued = [], calls = [], pending = []; let cursor = 0, dirty = true, tree, props = { projectId: 'project-a' };
  const state = initial => { const index = cursor++; hooks[index] ||= { value: initial }; return [hooks[index].value, value => { const next = typeof value === 'function' ? value(hooks[index].value) : value; if (!Object.is(next, hooks[index].value)) { hooks[index].value = next; dirty = true; } }]; };
  const ref = initial => { const index = cursor++; return hooks[index] ||= { current: initial }; };
  const effect = (run, dependencies) => { const index = cursor++, previous = hooks[index]; if (!previous || dependencies.some((value, key) => !Object.is(value, previous.dependencies[key]))) { hooks[index] = { dependencies, close: previous?.close }; queued.push(() => { hooks[index].close?.(); hooks[index].close = run(); }); } };
  const request = (...args) => { calls.push(args); return new Promise((resolve, reject) => pending.push({ resolve, reject })); };
  const Component = new Function('React', 'useState', 'useRef', 'useEffect', `${code}; return ZernioTeam;`)(React, state, ref, effect);
  function paint() { for (let pass = 0; dirty; pass++) { assert.ok(pass < 20); dirty = false; cursor = 0; tree = Component({ ...props, request }); while (queued.length) queued.shift()(); } }
  const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(nodes)];
  const html = () => renderToStaticMarkup(tree), tick = async () => { await new Promise(resolve => setImmediate(resolve)); paint(); };
  const click = text => { const button = nodes(tree).find(node => node.type === 'button' && node.props.children === text); assert.ok(button, text); assert.equal(!!button.props.disabled, false); const result = button.props.onClick(); paint(); return result; };
  const changeProject = projectId => { props = { projectId }; dirty = true; paint(); };
  const member = (id, name = id) => ({ _id: id, name, email: `${id}@example.test`, role: '<provider-role>', isRoot: null, profileAccess: null, createdAt: null, lastLoginAt: null });
  const team = (name, count = 1) => ({ currentUserId: 'caller', users: [member('caller', name), ...Array.from({ length: count - 1 }, (_, index) => member(`member-${index}`))] });
  paint(); assert.equal(calls.length, 0); assert.match(html(), /Workspace membership is managed separately/);
  let reading = click('Read provider team'); assert.equal(calls.length, 1); assert.match(html(), /Reading provider team/);
  pending.shift().resolve(team('<img src="https://never.example/member"><script>raw()</script>', 26)); await reading; await tick();
  assert.match(html(), /Showing 1–25 of 26 returned members/); assert.match(html(), /Configured credential’s provider caller/); assert.match(html(), /&lt;script&gt;raw\(\)&lt;\/script&gt;/); assert.match(html(), /&lt;provider-role&gt;/); assert.match(html(), /Last sign-in: Not provided/); assert.doesNotMatch(html(), /<img|<script|<iframe|<a\s/);
  click('Next members'); assert.match(html(), /Showing 26–26 of 26 returned members/); assert.equal(calls.length, 1, 'Local pages never request undocumented provider pagination.');
  reading = click('Refresh provider team'); assert.doesNotMatch(html(), /caller@example.test/); pending.shift().reject(new Error('Zernio did not allow this credential.')); await reading; await tick(); assert.match(html(), /role="alert"/); assert.doesNotMatch(html(), /caller@example.test/);
  const oldA = click('Read provider team'), firstA = pending.shift(); changeProject('project-b'); const readB = click('Read provider team'), firstB = pending.shift(); changeProject('project-a'); const newA = click('Read provider team');
  pending.shift().resolve(team('Fresh A')); await newA; await tick(); firstB.resolve(team('Stale B')); firstA.resolve(team('Stale A')); await Promise.all([oldA, readB]); await tick(); assert.match(html(), /Fresh A/); assert.doesNotMatch(html(), /Stale A|Stale B/);
  reading = click('Refresh provider team'); const closing = pending.shift(); hooks.forEach(hook => hook.close?.()); closing.resolve(team('After close')); await reading; await tick(); assert.doesNotMatch(html(), /After close|Fresh A/);
  assert.ok(calls.every(args => args.length === 1 && /\/integrations\/admin\/team$/.test(args[0])), 'Only the authenticated team GET is requested.');
});
