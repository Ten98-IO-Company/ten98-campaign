import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppField } from '@ten98/ui/app';
import * as ui from '@ten98/ui';
import { Checkbox } from '@ten98/ui';
import { transformWithOxc } from 'vite';

// Exercise the complete composer with its actual JSX, fields and mocked request boundary.
const source = await readFile(new URL('../src/AdComposer.tsx', import.meta.url), 'utf8');
const { code } = await transformWithOxc(source.replace(/^import .+;\r?\n/gm, '').replace('export default function ', 'function '), 'AdTargetingInteraction.tsx', { jsx: { runtime: 'classic' } });
const nodes = node => !React.isValidElement(node) ? [] : [node, ...React.Children.toArray(node.props.children).flatMap(nodes)];
const text = node => !React.isValidElement(node) ? String(node ?? '') : React.Children.toArray(node.props.children).map(text).join('');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const interest = (id = 'opaque / interest', name = 'Provider interest', extra = {}) => ({ id, name, type: 'interest', ...extra });
const accounts = [{ _id: 'meta /a', platform: 'facebook' }, { _id: 'meta /b', platform: 'instagram' }, { _id: 'google /a', platform: 'googleads' }];
const advertisers = [{ id: 'advertiser /a', name: 'Advertiser A', currency: 'AED' }, { id: 'advertiser /b', name: 'Advertiser B', currency: 'AED' }];
const values = { countries: 'AE, SA', name: 'Interest audience', budgetAmount: '50', ageMin: '22', ageMax: '55', gender: 'female', languages: 'en, ar', headline: 'A headline', body: 'Ad text', linkUrl: 'https://example.test/offer', imageUrl: 'https://example.test/ad.jpg', callToAction: 'LEARN_MORE' };

async function browser(respond = async () => ({ results: [interest()] })) {
  const hooks = [], queued = [], calls = []; let cursor = 0, dirty = true, tree, unmounted = false, postUnmountUpdates = 0, created = 0, props = {};
  const state = initial => { const index = cursor++; if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial }; return [hooks[index].value, value => { if (unmounted) postUnmountUpdates++; const next = typeof value === 'function' ? value(hooks[index].value) : value; if (!Object.is(next, hooks[index].value)) { hooks[index].value = next; dirty = true; } }]; };
  const ref = initial => { const index = cursor++; return hooks[index] ||= { current: initial }; };
  const effect = (run, dependencies) => { const index = cursor++, old = hooks[index]; if (!old || dependencies.some((value, key) => !Object.is(value, old.dependencies[key]))) { hooks[index] = { dependencies, close: old?.close }; queued.push(() => { hooks[index].close?.(); hooks[index].close = run(); }); } };
  const request = async (...args) => { calls.push(args); if (args[0] === 'accounts') return { accounts }; if (args[0].startsWith('ads/accounts?')) return { accounts: advertisers }; return respond(...args); };
  const scope = { ...ui, AppField, React, useState: state, useRef: ref, useEffect: effect, FormData: class { constructor(form) { return Object.entries(form); } } };
  const Component = new Function(...Object.keys(scope), code + '; return AdComposer;')(...Object.values(scope));
  function paint() { if (unmounted) return; for (let pass = 0; dirty; pass++) { assert.ok(pass < 25, 'Rendering settles.'); dirty = false; cursor = 0; tree = Component({ request, onCreated() { created++; }, onCancel() {}, ...props }); while (queued.length) queued.shift()(); } }
  // React may call the component for a same-value update, then retain the previous committed JSX.
  const discardRender = () => { cursor = 0; Component({ request, onCreated() { created++; }, onCancel() {}, ...props }); assert.equal(queued.length, 0); };
  const tick = async () => { await new Promise(resolve => setImmediate(resolve)); paint(); };
  const html = () => renderToStaticMarkup(tree);
  // Interests are picked in the library MultiCombobox; "Add/Remove <name>" drive its options and values as a pick or tag removal would.
  const picker = () => nodes(tree).find(node => node.type === ui.MultiCombobox);
  const choice = label => { const box = picker(), adding = label.startsWith('Add '), name = label.slice(adding ? 4 : 7), option = box && (adding ? box.props.options : box.props.values).find(item => item.label === name); if (!option) return undefined; const picked = box.props.values.some(item => item.value === option.value); return { props: { disabled: !!box.props.disabled || (adding ? picked : !picked), onClick: () => box.props.onValuesChange(adding ? [...box.props.values, option] : box.props.values.filter(item => item.value !== option.value)) } }; };
  const button = label => nodes(tree).find(node => node.type === ui.Button && (node.props['aria-label'] === label || text(node) === label)) || (/^(Add|Remove) /.test(label) ? choice(label) : undefined);
  // "Interest search" is the MultiCombobox's typed text, driven as the field's onInputValueChange would be.
  const typed = () => { const box = picker(); return box && { props: { value: box.props.inputValue, disabled: !!box.props.disabled, onChange: event => box.props.onInputValueChange(event.target.value) } }; };
  const input = label => { if (label === 'Interest search') return typed(); const wrapper = nodes(tree).find(node => node.type === ui.Field && node.props.label === label.replace(/ \*$/, '')); return nodes(wrapper).find(node => [ui.Input, ui.Select].includes(node.type)); };
  const change = async (label, value) => { const field = input(label); assert.ok(field, label); field.props.onChange({ target: { value } }); paint(); await tick(); };
  const click = label => { const control = button(label); assert.ok(control, label); assert.equal(!!control.props.disabled, false, label); const pending = control.props.onClick(); paint(); return pending; };
  const form = () => { const node = nodes(tree).find(node => node.type === ui.Form); return React.cloneElement(node, { onSubmit: event => node.props.onSubmit(undefined, event) }); };
  const event = (extra = {}) => ({ preventDefault() {}, currentTarget: { ...values, ...extra } });
  const submit = (extra = {}) => { const pending = form().props.onSubmit(event(extra)); paint(); return pending; };
  const choose = async (account = accounts[0]._id, advertiser = advertisers[0].id) => { await change('Connected channel *', account); await change('Advertising account *', advertiser); };
  const search = async (query = 'fitness') => { await change('Interest search', query); await click('Search interests'); await tick(); };
  paint(); await tick(); await choose();
  return { calls, tick, html, input, button, picker, change, click, form, event, submit, choose, search, discardRender, get created() { return created; }, get postUnmountUpdates() { return postUnmountUpdates; }, props: async next => { props = { ...props, ...next }; dirty = true; paint(); await tick(); }, unmount: () => { hooks.forEach(hook => hook.close?.()); unmounted = true; } };
}

test('a discarded same-value render leaves committed search, selection and submit handlers usable', async () => {
  const ui = await browser(async path => path === 'ads/create' ? {} : { results: [interest()] });
  await ui.change('Interest search', 'fitness'); ui.discardRender();
  await ui.click('Search interests'); await ui.tick(); assert.match(ui.html(), /Provider interest/);
  ui.discardRender(); await ui.click('Add Provider interest'); await ui.tick(); assert.match(ui.html(), /Selected interests: 1 \/ 100/);
  ui.discardRender(); await ui.submit(); await ui.tick();
  assert.equal(ui.created, 1); assert.deepEqual(ui.calls.at(-1)[1].targeting.interests, [{ id: 'opaque / interest', name: 'Provider interest' }]);
});

test('explicit interest search renders provider text inertly and selected IDs/names merge into the exact paused-ad payload', async () => {
  const literal = interest('opaque/<script>&+', '<img src=x onerror=bad()>', { path: ['<b>Sport</b>'], audienceSize: null }), zero = interest('zero', 'Zero reach', { audienceSize: 0 });
  const ui = await browser(async path => path === 'ads/create' ? {} : { results: [literal, zero, interest('unknown', 'Missing reach')] });
  assert.match(ui.html(), /No search results are loaded/); assert.equal(ui.button('Search interests').props.disabled, true);
  const before = ui.calls.length, query = '  fitness / & +  ';
  await ui.change('Interest search', query); assert.equal(ui.calls.length, before, 'Typing does not fetch per keystroke.');
  await ui.click('Search interests'); await ui.tick();
  assert.deepEqual(ui.calls.at(-1), ['ads/targeting?accountId=meta%20%2Fa&adAccountId=advertiser%20%2Fa&dimension=interest&q=fitness%20%2F%20%26%20%2B']);
  const html = ui.html(); assert.match(html, /&lt;img src=x onerror=bad\(\)&gt;/); assert.match(html, /&lt;b&gt;Sport&lt;\/b&gt;/); assert.match(html, /opaque\/&lt;script&gt;&amp;\+/); assert.equal((html.match(/Reach unknown/g) || []).length, 2); assert.match(html, /Estimated audience: 0/); assert.doesNotMatch(html, /<img|<script|<b>Sport/);
  const retainedAdd = ui.button('Add ' + literal.name).props.onClick, retainedSubmit = ui.form().props.onSubmit;
  retainedAdd(); retainedAdd(); await ui.tick(); retainedAdd(); await ui.tick();
  assert.match(ui.html(), /Selected interests: 1 \/ 100/); assert.equal(ui.button('Add ' + literal.name).props.disabled, true);
  await retainedSubmit(ui.event()); assert.equal(ui.calls.some(([path]) => path === 'ads/create'), false, 'A retained submit cannot send its previous selection.');
  await ui.click('Add Zero reach'); await ui.tick(); await ui.click('Remove ' + literal.name); await ui.tick();
  await ui.submit(); await ui.tick();
  assert.deepEqual(ui.calls.at(-1), ['ads/create', { platform: 'facebook', accountId: accounts[0]._id, adAccountId: advertisers[0].id, name: values.name, goal: 'traffic', budgetAmount: 50, budgetType: 'daily', countries: ['AE', 'SA'], status: 'PAUSED', currency: 'AED', targeting: { ageMin: 22, ageMax: 55, gender: 'female', languages: ['en', 'ar'], interests: [{ id: 'zero', name: 'Zero reach' }] }, headline: values.headline, body: values.body, linkUrl: values.linkUrl, imageUrl: values.imageUrl, callToAction: 'LEARN_MORE', advantageAudience: 0 }]);
  assert.equal(ui.created, 1);
  await ui.click('Remove Zero reach'); await ui.tick(); await ui.submit(); await ui.tick(); assert.equal(ui.calls.at(-1)[1].targeting.interests, undefined);
  assert.ok(ui.calls.filter(([path]) => path !== 'ads/create').every(args => args.length === 1), 'Only fully mocked creation has a body.'); assert.equal(ui.calls.some(([path]) => path === 'ads/validate'), false);
});

test('typed interest text searches once after a pause, and short or replaced text never searches', async () => {
  const ui = await browser(), searches = () => ui.calls.filter(([path]) => path.startsWith('ads/targeting?'));
  const pause = async () => { await new Promise(resolve => setTimeout(resolve, 450)); await ui.tick(); await ui.tick(); };
  await ui.change('Interest search', 'f'); await pause(); assert.equal(searches().length, 0, 'One character never searches.');
  for (const text of ['fi', 'fit', 'fitn', 'fitness']) await ui.change('Interest search', text);
  assert.equal(searches().length, 0, 'No provider request per keystroke.');
  await pause(); assert.deepEqual(searches(), [['ads/targeting?accountId=meta%20%2Fa&adAccountId=advertiser%20%2Fa&dimension=interest&q=fitness']]); assert.match(ui.html(), /Provider interest/);
  await pause(); assert.equal(searches().length, 1, 'A finished search is not repeated.');
  await ui.change('Interest search', 'yoga'); await ui.click('Search interests'); await pause(); assert.equal(searches().length, 2, 'An explicit search replaces the pending one.');
  await ui.change('Interest search', 'running'); await ui.change('Advertising account *', advertisers[1].id); await pause(); assert.equal(searches().length, 2, 'A scope change cancels the pending search.');
  await ui.change('Interest search', 'cycling'); ui.unmount(); await new Promise(resolve => setTimeout(resolve, 450)); assert.equal(searches().length, 2, 'Unmounting cancels the pending search.'); assert.equal(ui.postUnmountUpdates, 0);
});

test('advertiser, connection, source and platform transitions clear selection and reject A to B to A retained actions', async () => {
  const ui = await browser();
  const select = async () => { await ui.search(); await ui.click('Add Provider interest'); await ui.tick(); assert.match(ui.html(), /Selected interests: 1 \/ 100/); };
  for (const transition of ['advertiser', 'connection', 'source', 'platform']) {
    await select(); const add = ui.button('Add Provider interest').props.onClick, submit = ui.form().props.onSubmit;
    if (transition === 'advertiser') { await ui.change('Advertising account *', advertisers[1].id); await ui.change('Advertising account *', advertisers[0].id); }
    if (transition === 'connection') { await ui.choose(accounts[1]._id); await ui.choose(); }
    if (transition === 'source') { await ui.change('Campaign source', 'boost'); assert.doesNotMatch(ui.html(), /Interest search|Selected interests/); await ui.change('Campaign source', 'create'); }
    if (transition === 'platform') { await ui.choose(accounts[2]._id); assert.doesNotMatch(ui.html(), /Interest search|Selected interests/); await ui.choose(); }
    add(); await submit(ui.event()); await ui.tick(); assert.match(ui.html(), /Selected interests: 0 \/ 100/); assert.equal(ui.input('Interest search').props.value, '');
    assert.equal(ui.calls.some(([path]) => path === 'ads/create'), false, transition);
  }
});

test('new queries, A to B to A, read-only changes and unmount ignore delayed search success and failure', async () => {
  const reads = [], ui = await browser(() => { const read = deferred(); reads.push(read); return read.promise; });
  const start = async query => { await ui.change('Interest search', query); ui.click('Search interests'); await ui.tick(); };
  await start('old'); await start('new'); reads[0].resolve({ results: [interest('stale', 'STALE RESULT')] }); await ui.tick(); assert.doesNotMatch(ui.html(), /STALE RESULT|No interests were returned/);
  reads[1].resolve({ results: [interest('current', 'Current result')] }); await ui.tick(); assert.match(ui.html(), /Current result/);
  const retainedAdd = ui.button('Add Current result').props.onClick;
  await start('query-a'); await ui.change('Interest search', 'query-b'); await ui.change('Interest search', 'query-a'); reads[2].resolve({ results: [interest('stale-query', 'STALE QUERY CYCLE')] }); await ui.tick(); assert.doesNotMatch(ui.html(), /STALE QUERY CYCLE/);
  await start('scope'); await ui.change('Advertising account *', advertisers[1].id); await ui.change('Advertising account *', advertisers[0].id); reads[3].reject(new Error('STALE ERROR')); await ui.tick(); assert.doesNotMatch(ui.html(), /STALE ERROR|Current result/); retainedAdd(); await ui.tick(); assert.match(ui.html(), /Selected interests: 0 \/ 100/);
  await start('readonly'); const search = ui.button('Searching interests…').props.onClick, submit = ui.form().props.onSubmit;
  await ui.props({ readOnly: true }); assert.equal(ui.input('Interest search').props.disabled, true); assert.equal(ui.button('Search interests').props.disabled, true); assert.equal(ui.button('Create paused ad').props.disabled, true);
  search(); retainedAdd(); await submit(ui.event()); await ui.tick(); assert.equal(reads.length, 5);
  await ui.props({ readOnly: false }); reads[4].resolve({ results: [interest('stale-readonly', 'STALE READONLY')] }); await ui.tick(); assert.doesNotMatch(ui.html(), /STALE READONLY/);
  await start('unmount'); const late = ui.form().props.onSubmit; ui.unmount(); reads[5].resolve({ results: [interest('late', 'LATE RESULT')] }); retainedAdd(); await late(ui.event()); await ui.tick(); assert.equal(ui.postUnmountUpdates, 0); assert.equal(ui.calls.some(([path]) => path === 'ads/create'), false);
});

test('unknown, empty, provider failure and malformed search responses remain distinct and query boundaries are enforced', async () => {
  let response = { results: [] }; const ui = await browser(async () => { if (response instanceof Error) throw response; return response; });
  await ui.search('x'); assert.match(ui.html(), /No interests were returned for this search/); assert.doesNotMatch(ui.html(), /No search results are loaded/);
  response = new Error('Synthetic search unavailable'); await ui.search('failure'); assert.match(ui.html(), /Synthetic search unavailable/); assert.doesNotMatch(ui.html(), /No interests were returned/);
  response = { results: [{ ...interest(), audienceSize: -1 }] }; await ui.search('malformed'); assert.match(ui.html(), /interest search response could not be read/); assert.doesNotMatch(ui.html(), /Add interest|Estimated audience/);
  const count = ui.calls.length; await ui.change('Interest search', ' '); assert.equal(ui.button('Search interests').props.disabled, true); await ui.button('Search interests').props.onClick(); assert.equal(ui.calls.length, count);
  await ui.change('Interest search', 'x'.repeat(201)); assert.equal(ui.input('Interest search').props.value.length, 200, 'Typed text is capped at 200 characters.');
  response = { results: [] }; await ui.search('x'.repeat(200)); assert.equal(new URL(ui.calls.at(-1)[0], 'https://example.test').searchParams.get('q').length, 200);
});

test('opaque-ID deduplication preserves the original selected provider name and the 100-interest cap survives disabled handlers', async () => {
  let batch = 0, renamed = false; const ui = await browser(async path => path === 'ads/create' ? {} : { results: Array.from({ length: 25 }, (_, index) => interest(`opaque:${batch * 25 + index}`, `${renamed ? 'Renamed ' : ''}Interest ${batch * 25 + index}`)) });
  for (batch = 0; batch < 4; batch++) { await ui.search('batch ' + batch); for (let index = 0; index < 25; index++) { await ui.click('Add Interest ' + (batch * 25 + index)); await ui.tick(); } }
  assert.match(ui.html(), /Selected interests: 100 \/ 100/); await ui.search('over the cap'); assert.equal(ui.picker().props.max, 100, 'At the cap the library lists further interests as not pickable.'); const box = ui.picker(); box.props.onValuesChange([...box.props.values, { value: 'opaque:100', label: 'Interest 100' }]); await ui.tick(); assert.match(ui.html(), /Selected interests: 100 \/ 100/);
  await ui.click('Remove Interest 99'); await ui.tick(); assert.match(ui.html(), /Selected interests: 99 \/ 100/);
  batch = 0; renamed = true; await ui.search('duplicate id'); assert.equal(ui.button('Add Renamed Interest 0').props.disabled, true); ui.button('Add Renamed Interest 0').props.onClick(); await ui.tick(); await ui.submit(); await ui.tick();
  assert.equal(ui.calls.at(-1)[1].targeting.interests.length, 99); assert.deepEqual(ui.calls.at(-1)[1].targeting.interests[0], { id: 'opaque:0', name: 'Interest 0' });
});

test('verified lead-form metadata survives interest selection and boosts omit the cleared targeting selection', async () => {
  const leadForm = { id: 'form-1', name: 'Provider lead form', version: 'a'.repeat(64), status: 'ACTIVE', privacyPolicyUrl: 'https://example.test/privacy', questions: [] };
  const ui = await browser(async path => path.startsWith('leads/') ? path.includes('/forms?') ? { forms: [leadForm], pagination: { hasMore: false } } : { form: leadForm } : path.startsWith('ads/targeting?') ? { results: [interest()] } : {});
  await ui.search(); await ui.click('Add Provider interest'); await ui.tick(); await ui.change('Campaign goal', 'lead_generation'); await ui.change('Verified forms *', leadForm.id);
  const review = nodes(ui.form()).find(node => node.type === Checkbox && node.props.checked === false && !node.props.name); assert.ok(review); review.props.onChange({ target: { checked: true } }); await ui.tick();
  await ui.submit({ linkUrl: '' }); await ui.tick(); const leadPayload = ui.calls.at(-1)[1]; assert.equal(ui.calls.at(-1)[0], 'ads/create'); assert.equal(leadPayload.status, 'PAUSED'); assert.equal(leadPayload.leadGenFormId, leadForm.id); assert.deepEqual(leadPayload.leadFormReview, { id: leadForm.id, name: leadForm.name, version: leadForm.version }); assert.deepEqual(leadPayload.targeting.interests, [{ id: 'opaque / interest', name: 'Provider interest' }]); assert.deepEqual(leadPayload.countries, ['AE', 'SA']);
  await ui.props({ posts: [{ id: 'post-1', externalId: 'provider-post', status: 'published' }] }); await ui.change('Campaign source', 'boost'); assert.doesNotMatch(ui.html(), /Interest search|Selected interests/); await ui.submit({ postId: 'post-1' }); await ui.tick(); assert.deepEqual(ui.calls.at(-1), ['ads/boost', { platform: 'facebook', accountId: accounts[0]._id, adAccountId: advertisers[0].id, name: values.name, goal: 'traffic', budgetAmount: 50, budgetType: 'daily', countries: ['AE', 'SA'], status: 'PAUSED', currency: 'AED', postId: 'post-1' }]);
});

test('busy creation rejects retained picker and submit events while its existing mocked create remains paused', async () => {
  const write = deferred(), ui = await browser(async path => path === 'ads/create' ? write.promise : { results: [interest()] });
  await ui.search(); const add = ui.button('Add Provider interest').props.onClick, search = ui.button('Search interests').props.onClick, submit = ui.form().props.onSubmit, query = ui.input('Interest search').props.onChange;
  const pending = ui.submit(); await ui.tick(); const before = ui.calls.length;
  assert.equal(ui.input('Interest search').props.disabled, true); assert.equal(ui.button('Search interests').props.disabled, true); assert.equal(ui.button('Working with provider…').props.disabled, true);
  add(); search(); query({ target: { value: 'ignored' } }); await submit(ui.event()); await ui.tick(); assert.equal(ui.calls.length, before); assert.equal(ui.input('Interest search').props.value, 'fitness');
  write.resolve({}); await pending; await ui.tick(); assert.equal(ui.created, 1); const creations = ui.calls.filter(([path]) => path === 'ads/create'); assert.equal(creations.length, 1); assert.equal(creations[0][1].status, 'PAUSED'); assert.equal(creations[0][1].targeting.interests, undefined);
});

test('a role change blocks new actions without dropping an already dispatched receipt or leaving the form busy', async () => {
  for (const rejected of [false, true]) {
    const write = deferred(), ui = await browser(async path => path === 'ads/create' ? write.promise : { results: [interest()] });
    const oldSubmit = ui.form().props.onSubmit, pending = ui.submit(); await ui.tick(); await ui.props({ readOnly: true });
    await oldSubmit(ui.event()); await ui.form().props.onSubmit(ui.event()); assert.equal(ui.calls.filter(([path]) => path === 'ads/create').length, 1);
    if (rejected) write.reject(new Error('Synthetic creation failure')); else write.resolve({});
    await pending; await ui.tick(); assert.equal(ui.created, rejected ? 0 : 1); await ui.props({ readOnly: false });
    assert.equal(ui.button('Create paused ad').props.disabled, false); assert.doesNotMatch(ui.html(), /Working with provider/); if (rejected) assert.match(ui.html(), /Synthetic creation failure/);
    assert.equal(ui.calls.filter(([path]) => path === 'ads/create').length, 1, 'Permission changes never resend.');
  }
});

test('Meta validates the exact paused-ad payload through the provider dry run without creating it', async () => {
  const ui = await browser(async path => path === 'ads/validate' ? { validateOnly: true, results: [], message: 'Validated; nothing created.' } : { results: [] });
  assert.ok(ui.button('Validate without creating'), 'Meta offers the dry run.');
  await ui.form().props.onSubmit({ ...ui.event(), nativeEvent: { submitter: { getAttribute: name => name === 'data-action' ? 'validate' : null } } }); await ui.tick();
  const [path, payload] = ui.calls.at(-1);
  assert.equal(path, 'ads/validate'); assert.equal(payload.platform, 'facebook'); assert.equal(payload.status, 'PAUSED');
  assert.equal(ui.created, 0); assert.equal(ui.calls.some(([name]) => name === 'ads/create'), false);
  assert.match(ui.html(), /Validated; nothing created./);
});
