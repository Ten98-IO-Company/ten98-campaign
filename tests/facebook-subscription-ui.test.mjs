import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import * as design from '@ten98/ui';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';

const source = await readFile(new URL('../src/ZernioAccounts.tsx', import.meta.url), 'utf8');
const { code } = await transformWithOxc(source.replace(/^import .+;\r?\n/gm, '').replace(/export (?:default )?function /g, 'function '), 'FacebookSubscriptionInteraction.tsx', { jsx: { runtime: 'classic' } });
const account = { _id: 'fb/a', platform: 'facebook', displayName: 'Connected Page', isActive: true, health: null };
const settings = (extra = {}) => ({ accountId: account._id, pageId: 'opaque-page-42', appSubscribed: false, leadgen: false, subscribedFields: [], warning: '<img src=x onerror=alert(1)>', accountVersion: 'a'.repeat(64), version: 'b'.repeat(64), ...extra });
const receipt = (extra = {}) => ({ ...settings(), readback: true, resubscribed: false, operation: { id: 'subscription-operation', status: 'complete' }, ...extra });
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(nodes)];
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

async function browser(respond = async (_path, method) => method ? receipt() : settings(), initial = {}) {
  let hooks = [], queued = [], cursor = 0, dirty = true, tree, props = { projectId: 'project/a', account, canManage: true, ...initial };
  const calls = [];
  const useState = initial => { const index = cursor++; if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial }; return [hooks[index].value, value => { const next = typeof value === 'function' ? value(hooks[index].value) : value; if (!Object.is(next, hooks[index].value)) { hooks[index].value = next; dirty = true; } }]; };
  const useRef = initial => { const index = cursor++; return hooks[index] ||= { current: initial }; };
  const useMemo = (compute, dependencies) => { const index = cursor++, old = hooks[index]; if (!old || dependencies.some((value, key) => !Object.is(value, old.dependencies[key]))) hooks[index] = { dependencies, value: compute() }; return hooks[index].value; };
  const useEffect = (run, dependencies) => { const index = cursor++, old = hooks[index]; if (!old || dependencies.some((value, key) => !Object.is(value, old.dependencies[key]))) { hooks[index] = { dependencies, close: old?.close }; queued.push(() => { hooks[index].close?.(); hooks[index].close = run(); }); } };
  const request = async (...args) => { calls.push(args); return respond(...args); };
  const Component = new Function('React', ...Object.keys(design), 'useState', 'useRef', 'useEffect', 'useLayoutEffect', 'useMemo', code + ';return FacebookPageSubscription;')(React, ...Object.values(design), useState, useRef, useEffect, useEffect, useMemo);
  function paint(force = false) { dirty ||= force; for (let pass = 0; dirty; pass++) { assert.ok(pass < 20, 'Rendering settles.'); dirty = false; cursor = 0; tree = Component({ request, ...props }); while (queued.length) queued.shift()(); } }
  const tick = async () => { await new Promise(resolve => setImmediate(resolve)); paint(); };
  const button = text => { const found = nodes(tree).find(node => node.type === design.Button && React.Children.toArray(node.props.children).join('') === text); assert.ok(found, text); return found; };
  const click = text => { const result = button(text).props.onClick(); paint(); return result; };
  const confirm = (checked = true) => { const input = nodes(tree).find(node => node.type === design.Checkbox); assert.ok(input, 'Consequence acknowledgement'); input.props.onChange({ target: { checked } }); paint(); };
  const unmount = () => { for (const hook of hooks) hook?.close?.(); };
  paint(); await tick();
  return { calls, tick, click, button, confirm, html: () => renderToStaticMarkup(tree), handler: text => button(text).props.onClick, scope: value => { props = { ...props, ...value }; paint(true); }, rerender: () => paint(true), unmount,
    remount: value => { unmount(); hooks = []; queued = []; props = { ...props, ...value }; paint(true); },
    discard: value => { const committed = [...hooks], pending = queued.length; cursor = 0; try { Component({ request, ...props, ...value }); } finally { hooks = committed; queued.length = pending; } }
  };
}
async function review(ui) { await ui.click('Load Page event access'); await ui.tick(); await ui.click('Review Page event repair'); await ui.tick(); ui.confirm(); }

test('Facebook Page event access requires explicit inspection, fresh review and acknowledgement, and reports actual degraded results', async () => {
  let reads = 0;
  const ui = await browser(async (_path, method) => method ? receipt() : (reads++, settings({ subscribedFields: reads === 1 ? ['feed'] : ['leadgen'] })));
  assert.equal(ui.calls.length, 0); await ui.click('Load Page event access'); await ui.tick();
  assert.match(ui.html(), /Facebook Page event access/); assert.match(ui.html(), /Native Page ID:.*opaque-page-42/); assert.match(ui.html(), /Zernio subscribed to this Page:.*No.*Lead event access:.*No/); assert.match(ui.html(), /Returned subscribed fields: feed/);
  assert.match(ui.html(), /&lt;img src=x onerror=alert\(1\)&gt;/); assert.doesNotMatch(ui.html(), /<img|<script|Page selection|Switch Page|Instagram|Meta Ads/);
  await ui.click('Review Page event repair'); await ui.tick(); assert.equal(reads, 2); assert.match(ui.html(), /Returned subscribed fields: leadgen/); assert.match(ui.html(), /Meta may grant fewer fields/); assert.match(ui.html(), /does not prove event delivery/);
  await ui.click('Resubscribe Page events'); assert.equal(ui.calls.filter(call => call[1]).length, 0);
  ui.confirm(); await ui.click('Resubscribe Page events'); await ui.tick();
  assert.match(ui.html(), /Subscription outcome checked/); assert.match(ui.html(), /Zernio subscribed to this Page:.*No.*Lead event access:.*No/); assert.doesNotMatch(ui.html(), /all healthy|fully subscribed|outcome is unknown/i);
  const write = ui.calls.find(call => call[1]); assert.equal(write[0], '/projects/project%2Fa/integrations/accounts/fb%2Fa/webhook-subscription'); assert.deepEqual(write[2], { expectedVersion: 'b'.repeat(64), confirmed: true }); assert.equal(typeof write[3], 'string');
  const viewer = await browser(async () => settings(), { canManage: false }); await viewer.click('Load Page event access'); await viewer.tick(); assert.match(viewer.html(), /Lead event access/); assert.doesNotMatch(viewer.html(), /Review Page event repair|Resubscribe Page events/);
});

test('malformed or foreign scope inspection never enables repair', async () => {
  for (const extra of [{ accountId: 'foreign' }, { pageId: '' }, { pageId: '000' }, { pageId: 'page with whitespace' }, { appSubscribed: 'true' }, { leadgen: null }, { subscribedFields: ['feed', 'feed'] }, { subscribedFields: [42] }, { warning: {} }, { accountVersion: 'bad' }, { accountVersion: ['a'.repeat(64)] }, { version: ['b'.repeat(64)] }, { version: '' }]) {
    const ui = await browser(async () => settings(extra)); await ui.click('Load Page event access'); await ui.tick(); assert.match(ui.html(), /could not be verified/); await ui.click('Review Page event repair'); assert.equal(ui.calls.length, 1); assert.doesNotMatch(ui.html(), /Resubscribe Page events/);
  }
  for (const platform of ['instagram', 'metaads']) { const ui = await browser(async () => assert.fail('Unsupported scope cannot request'), { account: { ...account, platform } }); await ui.click('Load Page event access'); assert.equal(ui.calls.length, 0); }
});

test('malformed receipts retain the immutable action and same key until a verified truthful readback', async () => {
  for (const extra of [{ accountId: 'foreign' }, { pageId: 'foreign' }, { accountVersion: 'c'.repeat(64) }, { subscribedFields: null }, { readback: false }, { resubscribed: undefined }, { operation: { id: '', status: 'complete' } }, { operation: { id: 'pending', status: 'pending' } }]) {
    let malformed = true;
    const ui = await browser(async (_path, method) => method ? receipt(malformed ? extra : { appSubscribed: true, leadgen: false, subscribedFields: ['feed'] }) : settings()); await review(ui);
    await ui.click('Resubscribe Page events'); await ui.tick(); assert.match(ui.html(), /outcome is unknown/); assert.doesNotMatch(ui.html(), /Subscription outcome checked|Review Page event repair|Load Page event access/);
    const retained = ui.handler('Check outcome'); ui.scope({ canManage: false }); await retained(); assert.equal(ui.calls.filter(call => call[1]).length, 1); assert.equal(ui.button('Check outcome').props.disabled, true);
    ui.scope({ canManage: true }); malformed = false; await retained(); assert.equal(ui.calls.filter(call => call[1]).length, 1, 'Committed access cycle invalidates the old callback.'); await ui.click('Check outcome'); await ui.tick();
    const writes = ui.calls.filter(call => call[1]); assert.equal(writes.length, 2); assert.deepEqual(writes[0], writes[1]); assert.equal(writes[0][2], writes[1][2]); assert.equal(Object.isFrozen(writes[1][2]), true); assert.match(ui.html(), /Subscription outcome checked/); assert.match(ui.html(), /Lead event access:.*No/);
  }
});

test('committed role, project, account and snapshot changes withdraw reviews and old callbacks even after A to B to A', async () => {
  for (const mode of ['role', 'project', 'account', 'snapshot', 'snapshot-copy', 'cancel', 'refresh']) {
    const ui = await browser(); await review(ui); const send = ui.handler('Resubscribe Page events'), oldLoad = ui.handler('Refresh Page event access'), oldReview = ui.handler('Review Page event repair');
    if (mode === 'role') { ui.scope({ canManage: false }); ui.scope({ canManage: true }); }
    if (mode === 'project') { ui.scope({ projectId: 'other' }); ui.scope({ projectId: 'project/a' }); }
    if (mode === 'account') { ui.scope({ account: { ...account, _id: 'fb-b' } }); ui.scope({ account }); }
    if (mode === 'snapshot') { ui.scope({ account: { ...account, needsReconnection: true } }); ui.scope({ account }); }
    if (mode === 'snapshot-copy') ui.scope({ account: { ...account } });
    if (mode === 'cancel') await ui.click('Cancel Page event review');
    if (mode === 'refresh') { await ui.click('Refresh Page event access'); await ui.tick(); }
    const before = ui.calls.length; await send(); await oldLoad(); await oldReview(); await ui.tick(); assert.equal(ui.calls.length, before, mode); assert.doesNotMatch(ui.html(), /Resubscribe Page events|Subscription outcome checked/, mode);
  }
  const ui = await browser(); await review(ui); ui.discard({ canManage: false }); ui.discard({ projectId: 'discarded' }); ui.discard({ request: () => assert.fail('Discarded request cannot run') }); ui.rerender(); assert.match(ui.html(), /Resubscribe Page events/); await ui.click('Resubscribe Page events'); await ui.tick(); assert.match(ui.html(), /Subscription outcome checked/);
});

test('late reads and writes cannot restore a departed committed view, and pending actions survive keyed unmounts', async () => {
  const read = deferred(); const ui = await browser(async () => read.promise); const loading = ui.click('Load Page event access'); ui.scope({ canManage: false }); ui.scope({ canManage: true }); read.resolve(settings()); await loading; await ui.tick(); assert.doesNotMatch(ui.html(), /Native Page ID/);
  const held = deferred(); let writes = 0;
  const changing = await browser(async (_path, method) => method ? (++writes === 1 ? held.promise : receipt()) : settings()); await review(changing); const oldSend = changing.handler('Resubscribe Page events'), sending = changing.click('Resubscribe Page events');
  changing.remount({ account: { ...account, _id: 'fb-b' } }); changing.remount({ account }); assert.match(changing.html(), /request is in progress/); assert.equal(changing.button('Checking outcome…').props.disabled, true); await changing.click('Checking outcome…'); await oldSend(); assert.equal(writes, 1);
  held.resolve({ ...receipt(), readback: false }); await sending; await changing.tick(); assert.match(changing.html(), /outcome is unknown/); assert.doesNotMatch(changing.html(), /Subscription outcome checked|Load Page event access/); await changing.click('Check outcome'); await changing.tick(); assert.equal(writes, 2); assert.match(changing.html(), /Subscription outcome checked/); assert.equal(changing.calls.filter(call => call[1])[0][3], changing.calls.filter(call => call[1])[1][3]);
  for (const mode of ['role', 'project', 'account', 'snapshot']) {
    const pending = deferred(), raced = await browser(async (_path, method) => method ? pending.promise : settings()); await review(raced); const saving = raced.click('Resubscribe Page events');
    if (mode === 'role') { raced.scope({ canManage: false }); raced.scope({ canManage: true }); }
    if (mode === 'project') { raced.scope({ projectId: 'other' }); raced.scope({ projectId: 'project/a' }); }
    if (mode === 'account') { raced.scope({ account: { ...account, _id: 'other' } }); raced.scope({ account }); }
    if (mode === 'snapshot') { raced.scope({ account: { ...account, displayName: 'Changed Page' } }); raced.scope({ account }); }
    pending.resolve(receipt()); await saving; await raced.tick(); assert.doesNotMatch(raced.html(), /Subscription outcome checked|Native Page ID/, mode); assert.ok(raced.button('Load Page event access'));
  }
});

test('operator closure deletes the original action and every retained callback, then requires an explicit fresh load and review', async () => {
  let writes = 0;
  const ui = await browser(async (_path, method) => {
    if (!method) return settings({ version: (writes > 1 ? 'c' : 'b').repeat(64) }); writes++;
    if (writes === 1) throw Object.assign(new Error('Outcome pending'), { code: 'OPERATION_PENDING', status: 409 });
    if (writes === 2) throw Object.assign(new Error('Operator closed action'), { code: 'OPERATION_REVIEWED', status: 409, operation: { id: 'closed-subscription', status: 'reviewed-failed' } });
    return receipt();
  });
  await review(ui); const send = ui.handler('Resubscribe Page events'); await send(); await ui.tick(); const check = ui.handler('Check outcome'); await check(); await ui.tick();
  assert.match(ui.html(), /closed-subscription.*reviewed-failed/); assert.doesNotMatch(ui.html(), /outcome is unknown|Subscription outcome checked/); await check(); await send(); await ui.click('Review Page event repair'); assert.equal(writes, 2);
  await review(ui); assert.equal(ui.calls.filter(call => call[1]).length, 2); await ui.click('Resubscribe Page events'); await ui.tick(); assert.equal(writes, 3); const actions = ui.calls.filter(call => call[1]); assert.equal(actions[0][3], actions[1][3]); assert.notEqual(actions[1][3], actions[2][3]); assert.equal(actions[2][2].expectedVersion, 'c'.repeat(64)); assert.match(ui.html(), /Subscription outcome checked/);
});

test('known safe rejection permits a fresh inspection while uncertain provider and transport outcomes keep their key', async () => {
  for (const code of ['OPERATION_UNCERTAIN', 'OPERATION_IN_PROGRESS', 'FACEBOOK_PREVIOUS_OUTCOME_UNRESOLVED']) {
    let first = true; const ui = await browser(async (_path, method) => { if (!method) return settings(); if (first) { first = false; throw Object.assign(new Error('Unresolved'), { status: 409, code }); } return receipt(); }); await review(ui); await ui.click('Resubscribe Page events'); await ui.tick(); assert.match(ui.html(), /outcome is unknown/); await ui.click('Check outcome'); await ui.tick(); const calls = ui.calls.filter(call => call[1]); assert.equal(calls[0][3], calls[1][3]);
  }
  const safe = await browser(async (_path, method) => { if (!method) return settings(); throw Object.assign(new Error('Page changed'), { status: 409, code: 'FACEBOOK_ACCOUNT_CHANGED' }); }); await review(safe); await safe.click('Resubscribe Page events'); await safe.tick(); assert.doesNotMatch(safe.html(), /outcome is unknown|Resubscribe Page events/); assert.ok(safe.button('Load Page event access'));
  let blocked = true;
  const prior = await browser(async (_path, method) => { if (!method) return settings(); if (blocked) throw Object.assign(new Error('This action was not sent; close the prior operation first.'), { status: 409, code: 'FACEBOOK_PREVIOUS_OUTCOME_UNRESOLVED', operation: { id: 'unsent-action', status: 'failed' } }); return receipt(); });
  await review(prior); const retainedSend = prior.handler('Resubscribe Page events'); await retainedSend(); await prior.tick(); assert.doesNotMatch(prior.html(), /outcome is unknown|Check outcome|Resubscribe Page events/); assert.ok(prior.button('Load Page event access')); blocked = false; await retainedSend(); await prior.click('Review Page event repair'); assert.equal(prior.calls.filter(call => call[1]).length, 1);
  await review(prior); await prior.click('Resubscribe Page events'); await prior.tick(); const sends = prior.calls.filter(call => call[1]); assert.equal(sends.length, 2); assert.notEqual(sends[0][3], sends[1][3]); assert.match(prior.html(), /Subscription outcome checked/);
});


test('a lost not-sent receipt withdraws unknown recovery and requires a newly reviewed key', async () => {
  for (const terminal of [{ status: 409, code: 'OPERATION_NOT_SENT' }, { status: 502, code: 'PROVIDER_UNAVAILABLE' }]) {
  let writes = 0;
  const ui = await browser(async (_path, method) => {
    if (!method) return settings(); writes++;
    if (writes === 1) throw new Error('Lost blocked acknowledgement');
    if (writes === 2) throw Object.assign(new Error('The request was not sent'), { ...terminal, operation: { id: 'blocked-key', status: 'failed' } });
    return receipt();
  });
  await review(ui); const oldSend = ui.handler('Resubscribe Page events'); await oldSend(); await ui.tick();
  const check = ui.handler('Check outcome'); await check(); await ui.tick();
  assert.match(ui.html(), /earlier request was not sent/); assert.doesNotMatch(ui.html(), /outcome is unknown|Check outcome|closed after operator/);
  await check(); await oldSend(); assert.equal(writes, 2);
  await review(ui); assert.equal(writes, 2); await ui.click('Resubscribe Page events'); await ui.tick();
  assert.equal(writes, 3); const sends = ui.calls.filter(call => call[1]); assert.equal(sends[0][3], sends[1][3]); assert.notEqual(sends[1][3], sends[2][3]);
  }
});
