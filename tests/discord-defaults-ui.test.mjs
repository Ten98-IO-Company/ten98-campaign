import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppField as Field } from '@ten98/ui/app';
import { publicMediaUrl } from '../shared/social-posts.ts';
import { transformWithOxc } from 'vite';

const source = await readFile(new URL('../src/ZernioAccounts.tsx', import.meta.url), 'utf8');
const { code } = await transformWithOxc(source.replace(/^import .+;\r?\n/gm, '').replace(/export (?:default )?function /g, 'function '), 'DiscordInteraction.tsx', { jsx: { runtime: 'classic' } });
const settings = { accountId: 'discord-a', guildId: '222222222222222222', channelId: '111111111111111111', channelName: 'Updates', channelType: '0', webhookUsername: 'Current', webhookAvatarUrl: 'https://images.example/current.png', accountVersion: 'a'.repeat(64), version: 'b'.repeat(64) };
const rows = [{ _id: 'discord-a', platform: 'discord', displayName: 'Updates', isActive: true, health: null }];
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(nodes)];
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

async function browser(respond, canManage = true) {
  const hooks = [], queued = [], calls = []; let cursor = 0, dirty = true, tree, props = { projectId: 'project-a', canManage };
  const useState = initial => { const index = cursor++; if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial }; return [hooks[index].value, value => { const next = typeof value === 'function' ? value(hooks[index].value) : value; if (!Object.is(next, hooks[index].value)) { hooks[index].value = next; dirty = true; } }]; };
  const useRef = initial => { const index = cursor++; return hooks[index] ||= { current: initial }; };
  const useMemo = (compute, dependencies) => { const index = cursor++, old = hooks[index]; if (!old || dependencies.some((value, key) => !Object.is(value, old.dependencies[key]))) hooks[index] = { dependencies, value: compute() }; return hooks[index].value; };
  const useEffect = (run, dependencies) => { const index = cursor++, old = hooks[index]; if (!old || dependencies.some((value, key) => !Object.is(value, old.dependencies[key]))) { hooks[index] = { dependencies, close: old?.close }; queued.push(() => { hooks[index].close?.(); hooks[index].close = run(); }); } };
  const request = async (...args) => { calls.push(args); return args[0].endsWith('/health') ? { accounts: rows } : respond(...args); };
  const Component = new Function('React', 'Field', 'publicMediaUrl', 'useState', 'useRef', 'useEffect', 'useLayoutEffect', 'useMemo', code + ';return ZernioAccounts;')(React, Field, publicMediaUrl, useState, useRef, useEffect, useEffect, useMemo);
  function paint(force = false) { dirty ||= force; for (let pass = 0; dirty; pass++) { assert.ok(pass < 20, 'Rendering settles.'); dirty = false; cursor = 0; tree = Component({ request, ...props }); while (queued.length) queued.shift()(); } }
  function discard(value) { const committed = [...hooks], pending = queued.length; cursor = 0; try { Component({ request, ...props, ...value }); } finally { hooks.splice(0, hooks.length, ...committed); queued.length = pending; } }
  const tick = async () => { await new Promise(resolve => setImmediate(resolve)); paint(); };
  const html = () => renderToStaticMarkup(tree);
  const handler = text => { const button = nodes(tree).find(node => node.type === 'button' && (node.props['aria-label'] || React.Children.toArray(node.props.children).join('')) === text); assert.ok(button, text); return button.props.onClick; };
  const click = text => { const result = handler(text)(); paint(); return result; };
  const change = (label, value) => { const field = nodes(tree).find(node => node.type === Field && node.props.label === label); assert.ok(field, label); field.props.onChange({ target: { value } }); paint(); };
  const check = (text, checked) => { const label = nodes(tree).find(node => node.type === 'label' && React.Children.toArray(node.props.children).includes(text)); assert.ok(label, text); nodes(label).find(node => node.type === 'input').props.onChange({ target: { checked } }); paint(); };
  paint(); await tick(); await click('Manage Updates'); await tick();
  return { calls, tick, click, handler, change, check, html, discard, rerender: () => paint(true), scope: value => { props = { ...props, ...value }; paint(true); } };
}

test('Discord mounted UI reviews set and explicit resets, uses shared fields, and keeps the same action key after a malformed success', async () => {
  let receipt = 'bad', current = { ...settings };
  const ui = await browser(async (_path, method, body) => {
    if (!method) return { ...current };
    if (receipt === 'bad') return { ...current, readback: true, operation: { id: 'receipt-a', status: 'complete' }, guildId: '333333333333333333' };
    current = { ...current, webhookUsername: body.webhookUsername, webhookAvatarUrl: body.webhookAvatarUrl, version: 'c'.repeat(64) };
    return { ...current, readback: true, operation: { id: 'receipt-a', status: 'complete' } };
  });
  await ui.click('Load Discord identity'); await ui.tick(); ui.rerender();
  assert.match(ui.html(), /Server:.*222222222222222222/); assert.doesNotMatch(ui.html(), /Switch channel|Create webhook/);
  ui.change('Discord default author name', 'New author'); ui.check(' Clear default avatar', true);
  await ui.click('Review latest Discord identity'); await ui.tick(); assert.match(ui.html(), /Review Discord identity change/);
  await ui.click('Confirm and save Discord identity'); await ui.tick(); assert.match(ui.html(), /draft and action key were retained/); assert.match(ui.html(), /value="New author"/); assert.doesNotMatch(ui.html(), /confirmed with Zernio/);
  receipt = 'good'; await ui.click('Confirm and save Discord identity'); await ui.tick(); assert.match(ui.html(), /Discord default message identity confirmed/);
  let writes = ui.calls.filter(call => call[1] === 'POST'); assert.equal(writes.length, 2); assert.equal(writes[0][3], writes[1][3]); assert.deepEqual(Object.keys(writes[1][2]), ['webhookUsername', 'webhookAvatarUrl', 'clearUsername', 'clearAvatar', 'expectedVersion', 'confirmed']); assert.equal(writes[1][2].webhookAvatarUrl, '');
  ui.check(' Clear default author name', true); await ui.click('Review latest Discord identity'); await ui.tick(); await ui.click('Confirm and save Discord identity'); await ui.tick(); writes = ui.calls.filter(call => call[1] === 'POST'); assert.equal(writes.at(-1)[2].webhookUsername, ''); assert.equal(writes.at(-1)[2].clearUsername, true); assert.notEqual(writes.at(-1)[3], writes[0][3]);
  const viewer = await browser(async () => ({ ...settings }), false); await viewer.click('Load Discord identity'); await viewer.tick(); assert.match(viewer.html(), /Current author/); assert.doesNotMatch(viewer.html(), /Review latest Discord identity|Discord default author name|Confirm and save Discord identity/);
});

test('Discord UI rejects forbidden names and private avatars without a request', async () => {
  const ui = await browser(async () => ({ ...settings })); await ui.click('Load Discord identity'); await ui.tick();
  for (const value of ['Clyde support', 'Our DISCORD', 'a'.repeat(81), '']) { ui.change('Discord default author name', value); const before = ui.calls.length; await ui.click('Review latest Discord identity'); await ui.tick(); assert.equal(ui.calls.length, before); assert.match(ui.html(), /Enter an author name/); }
  ui.change('Discord default author name', 'Support');
  for (const value of ['', 'http://images.example/a', 'https://127.0.0.1/a', 'https://a.local/a', 'https://u:p@example.com/a']) { ui.change('Discord default avatar URL (public HTTPS)', value); const before = ui.calls.length; await ui.click('Review latest Discord identity'); await ui.tick(); assert.equal(ui.calls.length, before); assert.match(ui.html(), /Enter a public HTTPS avatar URL/); }
});

test('Discord same-value renders preserve pending review while meaningful edits, access or scope invalidate stale work', async () => {
  const pendingRead = deferred(); let reads = 0;
  const ui = await browser(async () => ++reads === 1 ? { ...settings } : pendingRead.promise); await ui.click('Load Discord identity'); await ui.tick();
  ui.change('Discord default author name', 'Reviewed'); const pending = ui.click('Review latest Discord identity'); await ui.tick(); ui.rerender(); pendingRead.resolve({ ...settings }); await pending; await ui.tick(); assert.match(ui.html(), /Review Discord identity change/);
  for (const departed of ['edit', 'role', 'project', 'role-return', 'project-return']) {
    const saving = deferred(); let writing = false;
    const ui = await browser(async (_path, method) => method ? (writing = true, saving.promise) : { ...settings }); await ui.click('Load Discord identity'); await ui.tick(); ui.change('Discord default author name', 'Reviewed'); await ui.click('Review latest Discord identity'); await ui.tick();
    const pending = ui.click('Confirm and save Discord identity'); await ui.tick(); assert.equal(writing, true);
    if (departed === 'edit') ui.change('Discord default author name', 'Newer edit');
    if (departed === 'role') ui.scope({ canManage: false });
    if (departed === 'project') ui.scope({ projectId: 'project-b' });
    if (departed === 'role-return') { ui.scope({ canManage: false }); ui.scope({ canManage: true }); }
    if (departed === 'project-return') { ui.scope({ projectId: 'project-b' }); ui.scope({ projectId: 'project-a' }); }
    saving.resolve({ ...settings, webhookUsername: 'Reviewed', version: 'c'.repeat(64), readback: true, operation: { id: 'receipt-a', status: 'complete' } }); await pending; await ui.tick(); assert.doesNotMatch(ui.html(), /Discord default message identity confirmed/); if (departed === 'edit') assert.match(ui.html(), /value="Newer edit"/);
  }
  const staleRead = deferred(); let read = 0;
  const edited = await browser(async () => ++read === 1 ? { ...settings } : staleRead.promise); await edited.click('Load Discord identity'); await edited.tick(); const reviewing = edited.click('Review latest Discord identity'); await edited.tick(); edited.change('Discord default author name', 'Latest draft'); staleRead.resolve({ ...settings }); await reviewing; await edited.tick(); assert.doesNotMatch(edited.html(), /Review Discord identity change/); assert.match(edited.html(), /value="Latest draft"/);
});

test('Discord discarded renders preserve committed review access, requester and pending review freshness', async () => {
  for (const abandoned of [{ canManage: false }, { projectId: 'project-b' }, { request: () => { throw new Error('Uncommitted requester used.'); } }]) {
    const ui = await browser(async (_path, method, body) => method ? { ...settings, ...body, readback: true, operation: { id: 'receipt-a', status: 'complete' } } : { ...settings });
    await ui.click('Load Discord identity'); await ui.tick(); ui.change('Discord default author name', 'Reviewed'); await ui.click('Review latest Discord identity'); await ui.tick();
    const committed = ui.html(); ui.discard(abandoned); assert.equal(ui.html(), committed);
    const saving = ui.click('Confirm and save Discord identity'); ui.discard(abandoned); await saving; await ui.tick(); assert.equal(ui.calls.filter(call => call[1] === 'POST').length, 1); assert.match(ui.html(), /Discord default message identity confirmed/);
  }
  let committedCallbacks = 0, discardedCallbacks = 0;
  const callbacks = await browser(async () => ({ ...settings })); callbacks.scope({ onAccountsChanged: () => { committedCallbacks++; } }); callbacks.discard({ onAccountsChanged: () => { discardedCallbacks++; } });
  await callbacks.click('Refresh connections'); await callbacks.tick(); assert.equal(committedCallbacks, 1); assert.equal(discardedCallbacks, 0);
  const pendingRead = deferred(); let reads = 0;
  const ui = await browser(async () => ++reads === 1 ? { ...settings } : pendingRead.promise); await ui.click('Load Discord identity'); await ui.tick();
  ui.change('Discord default author name', 'Reviewed'); const pending = ui.click('Review latest Discord identity'); await ui.tick(); ui.discard({ canManage: false });
  pendingRead.resolve({ ...settings }); await pending; await ui.tick(); assert.match(ui.html(), /Review Discord identity change/); assert.match(ui.html(), /Reviewed/);
});

test('a committed permission cycle cannot revive an earlier Discord review or save handler', async () => {
  const ui = await browser(async (_path, method, body) => method ? { ...settings, ...body, readback: true, operation: { id: 'receipt-a', status: 'complete' } } : { ...settings });
  await ui.click('Load Discord identity'); await ui.tick(); ui.change('Discord default author name', 'Reviewed');
  const oldReview = ui.handler('Review latest Discord identity'); await oldReview(); await ui.tick();
  const oldSave = ui.handler('Confirm and save Discord identity');
  ui.scope({ canManage: false }); ui.scope({ canManage: true });
  const before = ui.calls.length; await oldReview(); await oldSave(); await ui.tick();
  assert.equal(ui.calls.length, before); assert.doesNotMatch(ui.html(), /Review Discord identity change|confirmed with Zernio/);
  await ui.click('Review latest Discord identity'); await ui.tick(); await ui.click('Confirm and save Discord identity'); await ui.tick();
  assert.equal(ui.calls.filter(call => call[1] === 'POST').length, 1); assert.match(ui.html(), /confirmed with Zernio/);
});
