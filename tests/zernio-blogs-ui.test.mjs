import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppField as Field } from '@ten98/ui/app';
import { transformWithOxc } from 'vite';

const source = (await readFile(new URL('../src/ZernioBlogDrafts.tsx', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const section = (start, end, from = 0) => source.slice(source.indexOf(start, from), source.indexOf(end, source.indexOf(start, from)));
const compile = (code, context = {}) => new Function(...Object.keys(context), `return (${stripTypeScriptTypes(code)});`)(...Object.values(context));
const helpers = stripTypeScriptTypes(section('const supported =', '\nexport default'));
const { draftBody, validateDraftReceipt, pageCursor } = new Function(helpers + '; return { draftBody, validateDraftReceipt, pageCursor };')();
const account = { id: 'account/a', platform: 'wordpress', name: 'Our site', isActive: true, needsReconnection: false }, blog = { id: '11', platform: 'wordpress', title: 'News', handle: null };
const receipt = () => ({ accountId: account.id, operation: { id: 'operation-a', status: 'complete' }, blog, article: { id: '101', blogId: '11', platform: 'wordpress', title: 'Normalized title', bodyHtml: '<p>Normalized HTML</p>', isPublished: false, publicationState: 'draft', status: 'draft', publishedAt: null, publishDate: null } });
const helperContext = new Function(helpers + ';return { readableBlog, readableArticle, pageCursor, draftBody, validateDraftReceipt, validateUpdateReceipt, unpublishedDraft, publishedContent, articleStatus, scheduleInstant, scheduledArticle, canPublication, localSchedule, validatePublicationReceipt };')();
const { code: componentCode } = await transformWithOxc(source.replace(/^import .+;\n/gm, '').replaceAll('export type ', 'type ').replace('export default function ', 'function ').replaceAll('export function ', 'function '), 'BlogInteraction.tsx', { jsx: { runtime: 'classic' } });
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(nodes)];
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const detail = (article = receipt().article, version = 'article-version') => ({ article, version });

function browser(kind, initialProps) {
  const hooks = [], queued = [], calls = []; let cursor = 0, dirty = true, tree, props = initialProps;
  const useState = initial => { const index = cursor++; hooks[index] ||= { value: typeof initial === 'function' ? initial() : initial }; return [hooks[index].value, update => { const next = typeof update === 'function' ? update(hooks[index].value) : update; if (!Object.is(next, hooks[index].value)) { hooks[index].value = next; dirty = true; } }]; };
  const useRef = initial => { const index = cursor++; return hooks[index] ||= { current: initial }; };
  const useMemo = (make, dependencies) => { const index = cursor++, old = hooks[index]; if (!old || dependencies.some((value, key) => !Object.is(value, old.dependencies[key]))) hooks[index] = { value: make(), dependencies }; return hooks[index].value; };
  const useEffect = (run, dependencies) => { const index = cursor++, old = hooks[index]; if (!old || dependencies.some((value, key) => !Object.is(value, old.dependencies[key]))) { hooks[index] = { dependencies, close: old?.close }; queued.push(() => { hooks[index].close?.(); hooks[index].close = run(); }); } };
  const request = async (...args) => { calls.push(args); return props.request(...args); };
  const components = new Function('React', 'Field', 'useState', 'useRef', 'useEffect', 'useLayoutEffect', 'useMemo', componentCode + ';return { ZernioBlogDrafts, BlogDraftComposer, BlogPublicationReview };')(React, Field, useState, useRef, useEffect, useEffect, useMemo);
  function paint() { for (let pass = 0; dirty; pass++) { assert.ok(pass < 20, 'Rendering settles.'); dirty = false; cursor = 0; tree = components[kind]({ ...props, request }); while (queued.length) queued.shift()(); } }
  const tick = async () => { await new Promise(resolve => setImmediate(resolve)); paint(); };
  const find = predicate => nodes(tree).find(predicate), button = text => find(node => node.type === 'button' && React.Children.toArray(node.props.children).join('') === text);
  const field = label => { const shared = find(node => node.type === Field && node.props.label === label); return shared ? nodes(Field(shared.props)).find(node => ['input', 'textarea'].includes(node.type)) : nodes(find(node => node.type === 'label' && nodes(node).some(child => child.type === 'span' && React.Children.toArray(child.props.children).join('') === label))).find(node => ['select', 'input', 'textarea'].includes(node.type)); };
  paint();
  return { calls, tick, field, button, find, html: () => renderToStaticMarkup(tree),
    change: async (label, value) => { const input = field(label); assert.ok(input, label); input.props.onChange({ target: { value } }); paint(); await tick(); },
    click: text => { const control = button(text); assert.ok(control, text); assert.equal(!!control.props.disabled, false, text); const pending = control.props.onClick(); paint(); return pending; },
    confirm: () => { const input = find(node => node.type === 'input' && node.props.type === 'checkbox'); assert.ok(input, 'Review confirmation'); input.props.onChange({ target: { checked: true } }); paint(); },
    submit: () => { const pending = find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); paint(); return pending; },
    setProps: changes => { props = { ...props, ...changes }; dirty = true; paint(); },
    discardProps: changes => { const oldProps = props, oldTree = tree, oldHooks = hooks.slice(), oldQueued = queued.slice(); props = { ...props, ...changes }; cursor = 0; components[kind]({ ...props, request }); props = oldProps; tree = oldTree; hooks.splice(0, hooks.length, ...oldHooks); queued.splice(0, queued.length, ...oldQueued); },
    unmount: () => hooks.forEach(hook => hook.close?.()),
  };
}
function composer(respond, article = receipt().article, other = {}) { return browser('BlogDraftComposer', { account, blog, article, request: async (path, ...args) => respond ? respond(path, ...args) : path.endsWith('/101') ? detail() : { blog, version: 'blog-version' }, ...other }); }
async function reviewed(ui) { await ui.tick(); await ui.change('Article title', '  Our launch  '); await ui.change('Article HTML', ' <p>Launch & raw</p> '); await ui.click('Review draft and destination'); await ui.tick(); ui.confirm(); }

test('article HTML prefill and edits pass through the actual shared native textarea', async () => {
  const ui = composer(); await ui.tick();
  assert.equal(ui.field('Article HTML').type, 'textarea');
  assert.equal(ui.field('Article HTML').props.value, receipt().article.bodyHtml);
  await ui.change('Article HTML', '<p>Native edited HTML</p>'); await ui.click('Review draft and destination'); await ui.tick();
  assert.match(ui.html(), /&lt;p&gt;Native edited HTML&lt;\/p&gt;/);
});

test('draft validation trims titles, rejects controls and enforces HTML bounds without altering HTML', () => {
  assert.deepEqual(draftBody('  Launch  ', ' <p> raw </p> '), { title: 'Launch', bodyHtml: ' <p> raw </p> ' });
  for (const title of [' ', 'x'.repeat(501), 'bad\nname', 'bad\u0085name']) assert.throws(() => draftBody(title, ''), /title/);
  assert.equal(draftBody('x'.repeat(500), 'x'.repeat(500000)).bodyHtml.length, 500000);
  assert.throws(() => draftBody('Title', 'x'.repeat(500001)), /HTML/);
});

test('receipt validation requires exact account, blog, platform, operation and unpublished proof', () => {
  assert.doesNotThrow(() => validateDraftReceipt(receipt(), account, blog));
  for (const mutate of [r => { r.accountId = 'other'; }, r => { r.blog = { ...blog, id: '12' }; }, r => { r.article.blogId = '12'; }, r => { r.article.platform = 'shopify'; }, r => { r.article.id = ''; }, r => { r.article.bodyHtml = null; }, r => { r.article.isPublished = true; }, r => { delete r.article.publicationState; }, r => { r.article.publicationState = 'unverified'; }, r => { r.article.publishedAt = '2026-10-19'; }, r => { r.article.publishDate = '2026-10-20'; }, r => { r.article.status = 'pending'; }, r => { r.operation.status = 'pending'; }, r => { delete r.operation.id; }]) { const result = receipt(); mutate(result); assert.throws(() => validateDraftReceipt(result, account, blog), /receipt/); }
  assert.equal(helperContext.readableArticle({ ...receipt().article, bodyHtml: null }), true, 'Existing articles may omit their HTML.');
  const shopAccount = { ...account, platform: 'shopify' }, shopBlog = { ...blog, platform: 'shopify' }, result = receipt(); result.blog = shopBlog; result.article.platform = 'shopify'; result.article.status = null;
  assert.doesNotThrow(() => validateDraftReceipt(result, shopAccount, shopBlog)); result.article.status = 'draft'; assert.throws(() => validateDraftReceipt(result, shopAccount, shopBlog));
});

test('opaque cursor pagination encodes the cursor and rejects repeated or malformed next pages', async () => {
  assert.equal(pageCursor(null, new Set()), ''); assert.equal(pageCursor('opaque+/=', new Set()), 'opaque+/=');
  for (const value of ['', {}, 'again']) assert.throws(() => pageCursor(value, new Set(['again'])));
  const paths = [], accepted = [], view = { pending: false }, reads = { current: 0 };
  const context = { ...helperContext, current: () => true, view, reads, account, blog: undefined, blogId: '', target: 'blogs/account%2Fa', requester: { current: async path => { paths.push(path); return { blogs: [blog], nextCursor: null }; } }, cursors: { current: new Set() }, setBusy() {}, setError() {}, setArticle() {}, setNextCursor() {}, setPage() {}, setLoaded() {}, setBlogs: rows => accepted.push(rows), setArticles() {} };
  await compile(section('async function load(resource:', '\n  return <section'), context)('blogs', 'opaque+/=');
  assert.deepEqual(paths, ['blogs/account%2Fa?limit=20&cursor=opaque%2B%2F%3D']); assert.deepEqual(accepted, [[blog]]);
});

test('browser ignores late account, blog, detail and unmounted reads and preserves rows on malformed pages', async () => {
  for (const resource of ['blogs', 'articles', 'article']) {
    let finish, active = true; const accepted = [], errors = [], context = { ...helperContext, current: () => active, view: { pending: false }, reads: { current: 0 }, account, blog, blogId: blog.id, target: 'blogs/account%2Fa/11', requester: { current: () => new Promise(resolve => { finish = resolve; }) }, cursors: { current: new Set() }, setBusy() {}, setError: value => errors.push(value), setArticle: value => { if (value) accepted.push(value); }, setNextCursor() {}, setPage() {}, setLoaded() {}, setBlogs: value => accepted.push(value), setArticles: value => accepted.push(value) };
    const load = compile(section('async function load(resource:', '\n  return <section'), context), pending = load(resource, '', '101'); active = false; finish({ blogs: [blog], articles: [receipt().article], article: receipt().article }); await pending; assert.deepEqual(accepted, [], resource);
    active = true; context.view.pending = false; context.requester.current = async () => ({ blogs: [{ ...blog, platform: 'shopify' }], articles: [{ ...receipt().article, blogId: 'other' }], article: { ...receipt().article, id: 'wrong' } });
    await compile(section('async function load(resource:', '\n  return <section'), context)(resource, '', '101'); assert.deepEqual(accepted, []); assert.match(errors.at(-1), /verified/);
  }
});

test('actual edit composer loads fresh scoped content, explicitly reviews changes and invalidates every edit', async () => {
  const ui = composer(); assert.equal(ui.field('Article title').props.value, ''); assert.equal(ui.find(node => node.type === 'fieldset').props.disabled, true); await ui.tick();
  assert.equal(ui.calls[0][0], 'blogs/account%2Fa/11/articles/101'); assert.equal(ui.field('Article title').props.value, 'Normalized title'); assert.equal(ui.field('Article HTML').props.value, '<p>Normalized HTML</p>'); assert.doesNotMatch(ui.html(), /Review draft changes/);
  await ui.change('Article title', 'Our launch'); await ui.click('Review draft and destination'); await ui.tick(); assert.match(ui.html(), /Current article · 101 · Unpublished draft/); assert.match(ui.html(), /Current title: Normalized title/); assert.match(ui.html(), /Changes to save/); ui.confirm();
  await ui.change('Article HTML', '<script>raw()</script>'); assert.doesNotMatch(ui.html(), /Review draft changes|Save unpublished draft changes/); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 0);
  await ui.click('Review draft and destination'); await ui.tick(); assert.match(ui.html(), /&lt;script&gt;raw\(\)&lt;\/script&gt;/); assert.doesNotMatch(ui.html(), /<script|<iframe|<img/); assert.equal(ui.button('Save unpublished draft changes').props.disabled, true);
});

test('actual create and edit handlers send reviewed fields, validate before key release and show accepted normalization', async () => {
  for (const editing of [false, true]) {
    const events = [], result = receipt(), ui = composer(async (path, body, validate) => {
      if (!body) return path.endsWith('/101') ? detail() : { blog, version: 'blog-version' };
      events.push('requested'); assert.equal(typeof validate, 'function'); validate(result); events.push('validated-before-key-clear'); return result;
    }, editing ? receipt().article : undefined, { article: editing ? receipt().article : undefined, onSaved: value => events.push(value.article.title) });
    await reviewed(ui); await ui.submit(); await ui.tick();
    const [path, body] = ui.calls.find(call => call[1]); assert.equal(path, `blogs/account%2Fa/11/${editing ? 'articles/101/update' : 'create'}`); assert.deepEqual(body, { title: 'Our launch', bodyHtml: ' <p>Launch & raw</p> ', version: editing ? 'article-version' : 'blog-version', [editing ? 'confirmUpdate' : 'confirmCreate']: true });
    assert.deepEqual(events, ['requested', 'validated-before-key-clear', 'Normalized title']); assert.match(ui.html(), editing ? /Unpublished draft updated/ : /Unpublished draft created/); if (editing) assert.match(ui.html(), /Accepted article HTML.*&lt;p&gt;Normalized HTML&lt;\/p&gt;/);
    await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 1, 'A verified receipt prevents duplicate submission.');
  }
});

test('malformed receipts retain content and the same action for deliberate recovery with independent validation', async () => {
  for (const validateInRequester of [false, true]) for (const mutate of [r => { r.article.id = '102'; }, r => { r.article.bodyHtml = null; }, r => { r.article.title = ''; }, r => { r.article.isPublished = true; }, r => { r.operation.status = 'pending'; }]) {
    const ui = composer(async (path, body, validate) => {
      if (!body) return path.endsWith('/101') ? detail() : { blog, version: 'blog-version' };
      const result = receipt(); mutate(result); if (validateInRequester) validate(result); return result;
    }); await reviewed(ui); await ui.submit(); await ui.tick();
    assert.match(ui.html(), /Your content and action key are retained/); assert.doesNotMatch(ui.html(), /Unpublished draft updated/); assert.equal(ui.field('Article title').props.value, '  Our launch  '); assert.equal(ui.field('Article HTML').props.value, ' <p>Launch & raw</p> '); assert.equal(ui.find(node => node.type === 'fieldset').props.disabled, true);
    assert.equal(ui.calls.filter(call => call[1]).length, 1, 'Unknown outcomes do not retry automatically.'); await ui.submit(); await ui.tick(); const writes = ui.calls.filter(call => call[1]); assert.equal(writes.length, 2); assert.equal(writes[0][0], writes[1][0]); assert.deepEqual(writes[0][1], writes[1][1]);
  }
});

test('failed or malformed initial reads prevent review and saving; null HTML requires an explicit replacement', async () => {
  for (const result of [new Error('Permission denied'), { article: { ...receipt().article, id: 'other' }, version: 'v' }, { article: receipt().article }, detail({ ...receipt().article, status: 'published' })]) {
    const ui = composer(async () => { if (result instanceof Error) throw result; return result; }); await ui.tick(); assert.equal(ui.find(node => node.type === 'fieldset').props.disabled, true); await ui.submit(); await ui.button('Review draft and destination').props.onClick(); await ui.tick(); assert.equal(ui.calls.length, 1); assert.doesNotMatch(ui.html(), /Review draft changes|Unpublished draft updated/);
  }
  const nullable = { ...receipt().article, bodyHtml: null }, ui = composer(async path => path.endsWith('/101') ? detail(nullable) : { blog, version: 'blog-version' }); await ui.tick(); assert.equal(ui.field('Article HTML'), undefined); assert.equal(ui.button('Review draft and destination').props.disabled, true); assert.match(ui.html(), /empty replacement clears the article body/);
  await ui.click('Replace unavailable article HTML'); assert.equal(ui.field('Article HTML').props.value, ''); await ui.click('Review draft and destination'); await ui.tick(); assert.match(ui.html(), /No article HTML was returned/); assert.match(ui.html(), /Replace the article HTML below/);
});

test('edit review rejects changed versions and newly published articles while keeping local edits', async () => {
  for (const result of [detail(receipt().article, 'new-version'), detail({ ...receipt().article, isPublished: true, status: 'publish' }), detail({ ...receipt().article, publishDate: '2099-01-01T00:00:00Z' })]) {
    let initial = true; const ui = composer(async path => { if (!path.endsWith('/101')) return { blog, version: 'blog-version' }; if (initial) { initial = false; return detail(); } return result; }); await ui.tick(); await ui.change('Article title', 'Kept local title'); await ui.click('Review draft and destination'); await ui.tick();
    assert.doesNotMatch(ui.html(), /Review draft changes/); assert.equal(ui.field('Article title').props.value, 'Kept local title'); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 0);
  }
});

test('read-only selections cannot start editing and disabled account props retain entered content', async () => {
  for (const selected of [{ ...receipt().article, publicationState: undefined }, { ...receipt().article, publicationState: 'unverified' }, { ...receipt().article, isPublished: true }, { ...receipt().article, status: 'pending' }, { ...receipt().article, publishDate: '2099-01-01' }]) {
    const ui = composer(undefined, selected); await ui.tick(); assert.equal(ui.calls.length, 0); assert.equal(ui.find(node => node.type === 'fieldset').props.disabled, true); await ui.submit(); assert.equal(ui.calls.length, 0);
  }
  const ui = composer(); await reviewed(ui); ui.setProps({ account: { ...account, isActive: false } }); await ui.tick(); assert.equal(ui.field('Article title').props.value, '  Our launch  '); assert.equal(ui.field('Article HTML').props.value, ' <p>Launch & raw</p> '); assert.equal(ui.find(node => node.type === 'fieldset').props.disabled, true); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 0);
});

test('retained save handlers cannot bypass account access, publication, edited content or withdrawn confirmation', async () => {
  for (const scenario of ['inactive', 'reconnect', 'published', 'edited', 'unconfirmed']) {
    const ui = composer(async (path, body) => body ? receipt() : path.endsWith('/101') ? detail() : { blog, version: 'blog-version' }); await reviewed(ui);
    const retained = ui.find(node => node.type === 'form').props.onSubmit;
    if (scenario === 'inactive') ui.setProps({ account: { ...account, isActive: false } });
    if (scenario === 'reconnect') ui.setProps({ account: { ...account, needsReconnection: true } });
    if (scenario === 'published') ui.setProps({ article: { ...receipt().article, isPublished: true, status: 'publish' } });
    if (scenario === 'edited') await ui.change('Article title', 'Current unreviewed title');
    if (scenario === 'unconfirmed') ui.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: false } });
    await retained({ preventDefault() {} }); await ui.tick(); assert.equal(ui.calls.filter(call => call[1]).length, 0, scenario);
    if (scenario === 'unconfirmed') ui.confirm();
    else { ui.setProps({ account, article: receipt().article }); await ui.click('Review draft and destination'); await ui.tick(); ui.confirm(); }
    await ui.submit(); await ui.tick(); assert.equal(ui.calls.filter(call => call[1]).length, 1, scenario); assert.match(ui.html(), /Unpublished draft updated/);
  }
});

test('retained review handlers cannot review an earlier form revision and completed handlers cannot resubmit', async () => {
  for (const editing of [false, true]) {
    const ui = composer(async (path, body) => body ? receipt() : path.endsWith('/101') ? detail() : { blog, version: 'blog-version' }, undefined, { article: editing ? receipt().article : undefined }); await reviewed(ui);
    const staleReview = ui.button('Review draft and destination').props.onClick;
    await ui.change('Article title', 'Current title'); const reads = ui.calls.length; await staleReview(); await ui.tick(); assert.equal(ui.calls.length, reads); assert.doesNotMatch(ui.html(), /Review draft changes|Review new draft/);
    await ui.click('Review draft and destination'); await ui.tick(); ui.confirm(); const retained = ui.find(node => node.type === 'form').props.onSubmit;
    await ui.submit(); await ui.tick(); await retained({ preventDefault() {} }); await ui.tick(); assert.equal(ui.calls.filter(call => call[1]).length, 1);
  }
});

test('access transitions preserve pending results and the same uncertain action for recovery', async () => {
  for (const malformed of [false, true]) {
    const pending = deferred(), ui = composer(async (path, body) => body ? pending.promise : path.endsWith('/101') ? detail() : { blog, version: 'blog-version' }); await reviewed(ui);
    const saving = ui.submit(); ui.setProps({ account: { ...account, isActive: false } }); const result = receipt(); if (malformed) result.article.bodyHtml = null;
    pending.resolve(result); await saving; await ui.tick(); assert.equal(ui.calls.filter(call => call[1]).length, 1);
    ui.setProps({ account }); await ui.tick();
    if (malformed) { assert.match(ui.html(), /Your content and action key are retained/); await ui.submit(); await ui.tick(); const writes = ui.calls.filter(call => call[1]); assert.equal(writes.length, 2); assert.deepEqual(writes[0].slice(0, 2), writes[1].slice(0, 2)); }
    else { assert.match(ui.html(), /Unpublished draft updated/); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 1); }
  }
});

test('a new article loads after a prior completed or uncertain action', async () => {
  for (const bad of [false, true]) {
    const ui = composer(async (path, body) => body ? bad ? { ...receipt(), accountId: 'wrong' } : receipt() : path.endsWith('/101') ? detail() : path.endsWith('/102') ? detail({ ...receipt().article, id: '102', title: 'Next article' }) : { blog, version: 'blog-version' });
    await reviewed(ui); await ui.submit(); await ui.tick(); ui.setProps({ article: { ...receipt().article, id: '102' } }); await ui.tick(); assert.equal(ui.field('Article title').props.value, 'Next article'); assert.equal(ui.find(node => node.type === 'fieldset').props.disabled, false); assert.doesNotMatch(ui.html(), /Your content and action key are retained|Unpublished draft updated/);
  }
});

test('A to B to A scope changes and unmount discard late initial reads and review completion', async () => {
  const reads = [], ui = composer(() => { const next = deferred(); reads.push(next); return next.promise; }); const other = { ...receipt().article, id: '102' };
  ui.setProps({ article: other }); ui.setProps({ article: receipt().article }); assert.equal(reads.length, 3); reads[0].resolve(detail({ ...receipt().article, title: 'STALE_FIRST_A' })); reads[1].reject(new Error('STALE_B_ERROR')); await ui.tick(); assert.doesNotMatch(ui.html(), /STALE_FIRST_A|STALE_B_ERROR/); assert.equal(ui.field('Article title').props.value, '');
  reads[2].resolve(detail()); await ui.tick(); const review = ui.click('Review draft and destination'); assert.equal(reads.length, 5); ui.setProps({ article: other }); ui.setProps({ article: receipt().article }); reads[3].resolve({ blog, version: 'blog-version' }); reads[4].resolve(detail({ ...receipt().article, title: 'STALE_REVIEW' })); await review; await ui.tick(); assert.doesNotMatch(ui.html(), /STALE_REVIEW|Review draft changes/);
  ui.unmount(); reads.at(-1).resolve(detail({ ...receipt().article, title: 'UNMOUNTED_RESULT' })); await ui.tick(); assert.doesNotMatch(ui.html(), /UNMOUNTED_RESULT/);
});

test('an access change and restoration cannot revive an earlier article load', async () => {
  const pending = deferred(), ui = composer(() => pending.promise);
  ui.setProps({ account: { ...account, isActive: false } }); ui.setProps({ account });
  pending.resolve(detail({ ...receipt().article, title: 'STALE_ACCESS_RESULT' })); await ui.tick();
  assert.equal(ui.field('Article title').props.value, ''); assert.doesNotMatch(ui.html(), /STALE_ACCESS_RESULT/);
  assert.match(ui.html(), /Reload existing draft/);
});

test('actual browser exposes editing only for proven unscheduled drafts and never for viewers', async () => {
  for (const platform of ['wordpress', 'shopify']) for (const viewer of [false, true]) {
    const selected = { ...account, platform }, destination = { ...blog, platform }, base = { ...receipt().article, platform, status: platform === 'wordpress' ? 'draft' : null }, articles = [base, { ...base, id: '102', isPublished: true }, { ...base, id: '103', publishedAt: '2099-01-01' }, { ...base, id: '104', publishDate: '2099-01-01' }, { ...base, id: '105', publishedAt: undefined }, ...(platform === 'wordpress' ? [{ ...base, id: '106', status: 'pending' }] : [])], edits = [];
    const ui = browser('ZernioBlogDrafts', { request: async path => path === 'blogs/accounts' ? { accounts: [selected] } : path.includes('/articles') ? { articles, nextCursor: null } : { blogs: [destination], nextCursor: null }, onEditDraft: viewer ? undefined : (...args) => edits.push(args) }); await ui.tick(); await ui.change('Blog account', selected.id); await ui.change('Blog', destination.id);
    const buttons = nodes(ui.find(node => node.type === 'table')).filter(node => node.type === 'button' && String(node.props.children).startsWith('Edit draft')); assert.equal(buttons.length, viewer ? 0 : 1); if (!viewer) { await ui.click('Edit draft Normalized title'); assert.deepEqual(edits, [[selected, destination, base]]); }
  }
});

test('article details escape provider HTML without inventing destination links', async () => {
  const jsx = section('    {article && <section', '\n  </section>;');
  const { code } = await transformWithOxc(`const render = () => <React.Fragment>${jsx}</React.Fragment>;`, 'BlogDetails.tsx', { jsx: { runtime: 'classic' } });
  const article = { ...receipt().article, bodyHtml: '<img src=x onerror=alert(1)><script>bad()</script>', excerpt: '<b>raw excerpt</b>' };
  const html = renderToStaticMarkup(new Function('React', 'article', 'articleStatus', 'account', code + ';return render();')(React, article, helperContext.articleStatus, undefined));
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/); assert.match(html, /&lt;b&gt;raw excerpt&lt;\/b&gt;/); assert.match(html, /Read-only/); assert.doesNotMatch(html, /<script|<img|<button|<a\s|<input|<textarea/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
});

test('viewer browser renders nullable article details without a creation action', async () => {
  const jsx = section('  return <section className="panel settings-panel">', '\n}\n\nexport function BlogDraftComposer').replace(/^  return /, '').replace(/;\s*$/, '');
  const { code } = await transformWithOxc(`const render = () => (${jsx});`, 'BlogBrowser.tsx', { jsx: { runtime: 'classic' } });
  const context = { React, ...helperContext, BlogPublicationReview: () => null, canWrite: false, request() {}, accounts: [account], accountId: account.id, account, blogs: [blog], blogId: blog.id, blog, articles: [], article: { ...receipt().article, bodyHtml: null }, nextCursor: '', page: 1, loaded: true, busy: false, error: '', accountsLoaded: true, onCreate: undefined, chooseAccount() {}, chooseBlog() {}, setRetry() {}, load() {} };
  const html = renderToStaticMarkup(new Function(...Object.keys(context), code + ';return render();')(...Object.values(context)));
  assert.match(html, /No article HTML was returned/); assert.doesNotMatch(html, /Create article draft/); assert.match(html, /scheduling and publication changes require a fresh review/);
});

test('Shopify scheduled articles are distinguished from unpublished drafts', () => {
  const article = { ...receipt().article, platform: 'shopify', status: null };
  assert.equal(helperContext.articleStatus(article), 'Draft');
  assert.equal(helperContext.articleStatus({ ...article, publishedAt: '2099-01-01T00:00:00Z' }), 'Scheduled');
  assert.equal(helperContext.articleStatus({ ...article, isPublished: true }), 'Published');
});

const publishedArticle = (platform = 'wordpress') => ({ ...receipt().article, platform, canEditPublished: platform === 'wordpress', publicationState: 'published', isPublished: true, status: platform === 'wordpress' ? 'publish' : null, publishedAt: '2026-01-01T00:00:00Z' });
function publication(respond, selected = receipt().article, other = {}) {
  return browser('BlogPublicationReview', { account, blog, article: selected, canWrite: true, request: async (path, body, validate) => respond ? respond(path, body, validate) : path.endsWith('/101') ? detail(selected) : { blog, version: 'blog-version' }, ...other });
}
async function reviewedPublication(ui, action = 'publish') { await ui.click(action === 'publish' ? 'Review Publish now' : 'Review Unpublish'); await ui.tick(); ui.confirm(); }

test('publication actions review fresh scoped native content and submit only version and explicit confirmation', async () => {
  for (const platform of ['wordpress', 'shopify']) for (const action of ['publish', 'unpublish']) {
    const nativeAccount = { ...account, platform }, nativeBlog = { ...blog, platform }, draft = { ...receipt().article, platform, status: platform === 'wordpress' ? 'draft' : null }, selected = action === 'publish' ? draft : publishedArticle(platform), result = { ...receipt(), blog: nativeBlog, article: action === 'publish' ? publishedArticle(platform) : draft }, order = [];
    const ui = publication(async (path, body, validate) => { if (!body) return path.endsWith('/101') ? detail({ ...selected, title: 'Fresh exact title', bodyHtml: '<script>inert()</script>' }) : { blog: nativeBlog, version: 'blog-version' }; order.push('requested'); validate(result); order.push('validated before key release'); return result; }, selected, { account: nativeAccount, blog: nativeBlog, onChanged: () => order.push('accepted') });
    await ui.submit(); assert.equal(ui.calls.length, 0); await ui.click(action === 'publish' ? 'Review Publish now' : 'Review Unpublish'); await ui.tick();
    assert.match(ui.html(), /Fresh exact title/); assert.match(ui.html(), /&lt;script&gt;inert\(\)&lt;\/script&gt;/); assert.doesNotMatch(ui.html(), /<script|<iframe|<img/); assert.match(ui.html(), /Account account\/a.*Blog 11.*Article 101/); assert.match(ui.html(), /external edit after that check can still race/);
    assert.equal(ui.button(action === 'publish' ? 'Publish now' : 'Unpublish').props.disabled, true); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 0);
    ui.confirm(); await ui.submit(); await ui.tick(); const [path, body] = ui.calls.find(call => call[1]); assert.equal(path, `blogs/account%2Fa/11/articles/101/${action}`); assert.deepEqual(body, { version: 'article-version', [action === 'publish' ? 'confirmPublish' : 'confirmUnpublish']: true }); assert.deepEqual(order, ['requested', 'validated before key release', 'accepted']); assert.match(ui.html(), action === 'publish' ? /Article published/ : /Article unpublished and retained as a draft/);
    await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 1);
  }
});

test('viewers, scheduled and unverified articles cannot start publication review', async () => {
  for (const changes of [{ canWrite: false }, { account: { ...account, isActive: false } }, { account: { ...account, needsReconnection: true } }, { article: { ...receipt().article, publicationState: 'unverified' } }, { article: { ...receipt().article, publicationState: undefined } }, { article: { ...receipt().article, publishDate: '2099-01-01' } }, { article: { ...publishedArticle(), publishDate: '2026-01-01' } }, { article: { ...publishedArticle(), publishedAt: '2099-01-01' } }]) {
    const ui = publication(undefined, undefined, changes); assert.equal(ui.button('Review Publish now'), undefined); assert.equal(ui.button('Review Unpublish'), undefined); await ui.submit(); assert.equal(ui.calls.length, 0);
  }
});

test('fresh publication review rejects wrong scope, missing versions and changed state', async () => {
  for (const bad of [detail({ ...receipt().article, id: '102' }), detail({ ...receipt().article, blogId: '12' }), detail({ ...receipt().article, platform: 'shopify' }), detail({ ...receipt().article, bodyHtml: null }), detail(publishedArticle()), detail({ ...receipt().article, publicationState: 'unverified' }), { article: receipt().article }]) {
    const ui = publication(async path => path.endsWith('/101') ? bad : { blog, version: 'blog-version' }); await ui.click('Review Publish now'); await ui.tick(); assert.match(ui.html(), /could not be verified/); assert.equal(ui.button('Publish now'), undefined); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 0);
  }
});

test('publication validates receipts independently and retains one deliberate recovery action', async () => {
  for (const mutate of [value => { value.accountId = 'wrong'; }, value => { value.blog.id = '12'; }, value => { value.article.id = '102'; }, value => { value.article.blogId = '12'; }, value => { value.article.platform = 'shopify'; }, value => { value.article.publicationState = 'unverified'; }, value => { value.article.isPublished = false; }, value => { value.article.status = 'future'; }, value => { value.operation.status = 'pending'; }, value => { value.operation.id = ''; }]) {
    const ui = publication(async (path, body) => { if (!body) return path.endsWith('/101') ? detail() : { blog, version: 'blog-version' }; const result = { ...receipt(), blog: { ...blog }, article: publishedArticle() }; mutate(result); return result; });
    await reviewedPublication(ui); await ui.submit(); await ui.tick(); assert.match(ui.html(), /action key is retained/); assert.doesNotMatch(ui.html(), /Article published ·/); assert.equal(ui.calls.filter(call => call[1]).length, 1); await ui.submit(); await ui.tick(); const writes = ui.calls.filter(call => call[1]); assert.equal(writes.length, 2); assert.deepEqual(writes[0].slice(0, 2), writes[1].slice(0, 2));
  }
});

test('committed permission changes revoke retained publication handlers including A to B to A', async () => {
  for (const transition of ['viewer', 'inactive', 'reconnect', 'article', 'unconfirmed']) {
    const ui = publication(async (path, body) => body ? { ...receipt(), article: publishedArticle() } : path.endsWith('/101') ? detail() : { blog, version: 'blog-version' }); await reviewedPublication(ui); const retained = ui.find(node => node.type === 'form').props.onSubmit;
    if (transition === 'viewer') { ui.setProps({ canWrite: false }); ui.setProps({ canWrite: true }); }
    if (transition === 'inactive') { ui.setProps({ account: { ...account, isActive: false } }); ui.setProps({ account }); }
    if (transition === 'reconnect') { ui.setProps({ account: { ...account, needsReconnection: true } }); ui.setProps({ account }); }
    if (transition === 'article') { ui.setProps({ article: { ...receipt().article, id: '102' } }); ui.setProps({ article: receipt().article }); }
    if (transition === 'unconfirmed') ui.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: false } });
    await retained({ preventDefault() {} }); await ui.tick(); assert.equal(ui.calls.filter(call => call[1]).length, 0, transition);
  }
});

test('discarded renders do not replace committed draft or publication handler scopes', async () => {
  const draft = composer(async (path, body) => body ? receipt() : path.endsWith('/101') ? detail() : { blog, version: 'blog-version' }); await reviewed(draft); const draftSave = draft.find(node => node.type === 'form').props.onSubmit; draft.discardProps({ account: { ...account, isActive: false }, article: { ...receipt().article, id: '102' } }); await draftSave({ preventDefault() {} }); await draft.tick(); assert.equal(draft.calls.filter(call => call[1]).length, 1); assert.match(draft.html(), /Unpublished draft updated/);
  const ui = publication(async (path, body) => body ? { ...receipt(), article: publishedArticle() } : path.endsWith('/101') ? detail() : { blog, version: 'blog-version' }); await reviewedPublication(ui); const publish = ui.find(node => node.type === 'form').props.onSubmit; ui.discardProps({ canWrite: false, article: { ...receipt().article, id: '102' } }); await publish({ preventDefault() {} }); await ui.tick(); assert.equal(ui.calls.filter(call => call[1]).length, 1); assert.match(ui.html(), /Article published/);
});

test('pending publication outcomes survive access changes and uncertain outcomes recover with the same request', async () => {
  for (const malformed of [false, true]) {
    const pending = deferred(), ui = publication(async (path, body) => body ? pending.promise : path.endsWith('/101') ? detail() : { blog, version: 'blog-version' }); await reviewedPublication(ui); const saving = ui.submit(); ui.setProps({ canWrite: false }); pending.resolve({ ...receipt(), article: malformed ? { ...publishedArticle(), publicationState: 'unverified' } : publishedArticle() }); await saving; await ui.tick(); ui.setProps({ canWrite: true }); await ui.tick();
    assert.equal(ui.calls.filter(call => call[1]).length, 1); if (malformed) { assert.match(ui.html(), /action key is retained/); await ui.submit(); await ui.tick(); const writes = ui.calls.filter(call => call[1]); assert.equal(writes.length, 2); assert.deepEqual(writes[0].slice(0, 2), writes[1].slice(0, 2)); } else { assert.match(ui.html(), /Article published/); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 1); }
  }
});

const scheduledArticle = (publishDate = '2099-01-10T08:30:00.000Z') => ({ ...receipt().article, publicationState: 'scheduled', status: 'future', publishDate });
const timingLabel = 'Publication time (your local timezone)', localPublicationTime = '2099-02-10T12:30';
async function reviewedSchedule(ui, reschedule = false) { await ui.change(timingLabel, localPublicationTime); await ui.click(reschedule ? 'Review Reschedule' : 'Review Schedule'); await ui.tick(); ui.confirm(); }

test('WordPress schedule, reschedule and cancel review exact fresh content and accept only explicit native timing receipts', async () => {
  for (const action of ['schedule', 'reschedule', 'cancel-schedule']) {
    const selected = action === 'schedule' ? receipt().article : scheduledArticle(), acceptedDate = new Date(localPublicationTime).toISOString(), events = [];
    const ui = publication(async (path, body, validate) => {
      if (!body) return path.endsWith('/101') ? detail({ ...selected, title: 'Fresh scheduled title', bodyHtml: '<script>inert_schedule()</script>' }) : { blog, version: 'blog-version' };
      const result = { ...receipt(), article: action === 'cancel-schedule' ? receipt().article : scheduledArticle(acceptedDate) }; validate(result); events.push('validated before key release'); return result;
    }, selected, { onChanged: () => events.push('accepted') });
    if (action === 'cancel-schedule') { await ui.click('Review Cancel schedule'); await ui.tick(); ui.confirm(); } else await reviewedSchedule(ui, action === 'reschedule');
    assert.match(ui.html(), /Account account\/a.*Blog 11.*Article 101/); assert.match(ui.html(), /Fresh scheduled title/); assert.match(ui.html(), /&lt;script&gt;inert_schedule\(\)&lt;\/script&gt;/); assert.doesNotMatch(ui.html(), /<script|<iframe|<img/);
    assert.match(ui.html(), /your local timezone.*UTC 2099-/); assert.match(ui.html(), action === 'cancel-schedule' ? /retains it as an unpublished draft/ : /WordPress will make this article public at the reviewed time/);
    await ui.submit(); await ui.tick(); const [path, body] = ui.calls.find(call => call[1]);
    assert.equal(path, `blogs/account%2Fa/11/articles/101/${action === 'reschedule' ? 'schedule' : action}`);
    assert.deepEqual(body, action === 'cancel-schedule' ? { version: 'article-version', confirmCancelSchedule: true } : { version: 'article-version', publishDate: acceptedDate, confirmSchedule: true });
    assert.deepEqual(events, ['validated before key release', 'accepted']); assert.match(ui.html(), action === 'cancel-schedule' ? /Article unpublished and retained as a draft/ : /Article scheduled for/);
    await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 1);
  }
});

test('native local times convert to exact UTC instants and reject invalid or elapsed dates without guessing', () => {
  const originalZone = process.env.TZ;
  try {
    for (const [zone, expected] of [['Asia/Dubai', '2099-02-10T08:30:00.000Z'], ['America/New_York', '2099-02-10T17:30:00.000Z']]) {
      process.env.TZ = zone; assert.equal(helperContext.localSchedule(localPublicationTime), expected);
    }
    process.env.TZ = 'America/New_York';
    for (const value of ['', '2099-02-30T12:30', '2099-03-08T02:30', '2020-01-01T12:00', '2099-01-01T12:00Z']) assert.throws(() => helperContext.localSchedule(value), /valid future/);
    assert.throws(() => helperContext.localSchedule('2099-11-01T01:30'), /occurs twice.*Choose UTC/);
    assert.equal(helperContext.localSchedule('2099-11-01T05:30', 'utc'), '2099-11-01T05:30:00.000Z');
    assert.equal(helperContext.localSchedule('2099-11-01T06:30', 'utc'), '2099-11-01T06:30:00.000Z');
    assert.throws(() => helperContext.localSchedule('2099-02-30T12:30', 'utc'), /valid future/);
  } finally { if (originalZone === undefined) delete process.env.TZ; else process.env.TZ = originalZone; }
  assert.equal(helperContext.scheduleInstant('2099-02-10T12:30:00+04:00'), '2099-02-10T08:30:00.000Z');
  for (const value of ['2099-02-30T12:30:00Z', '2099-01-01T24:00:00Z', '2099-01-01', '2099-01-01T12:30:00']) assert.equal(helperContext.scheduleInstant(value), null);
});

test('timing edits revoke every retained publication review and acknowledgment, including A to B to A', async () => {
  for (const action of ['publish', 'schedule', 'cancel-schedule']) {
    const ui = publication(undefined, action === 'cancel-schedule' ? scheduledArticle() : receipt().article);
    if (action === 'publish') await reviewedPublication(ui); else if (action === 'schedule') await reviewedSchedule(ui); else { await ui.click('Review Cancel schedule'); await ui.tick(); ui.confirm(); }
    const retainedSave = ui.find(node => node.type === 'form').props.onSubmit, retainedConfirm = ui.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange;
    await ui.change(timingLabel, '2099-03-01T12:30'); await ui.change(timingLabel, localPublicationTime); retainedConfirm({ target: { checked: true } }); await retainedSave({ preventDefault() {} }); await ui.tick();
    assert.equal(ui.calls.filter(call => call[1]).length, 0); assert.equal(ui.find(node => node.type === 'input' && node.props.type === 'checkbox'), undefined);
  }
});

test('elapsed scheduling times stop during review and before submission without any implicit publish', async () => {
  const now = Date.now, instant = Date.parse(new Date(localPublicationTime).toISOString());
  try {
    for (const phase of ['review', 'submit']) {
      Date.now = () => instant - 60000; const pending = deferred();
      const ui = publication(async path => path.endsWith('/101') ? pending.promise : { blog, version: 'blog-version' }); await ui.change(timingLabel, localPublicationTime);
      const reviewing = ui.click('Review Schedule'); if (phase === 'review') Date.now = () => instant + 1; pending.resolve(detail()); await reviewing; await ui.tick();
      if (phase === 'submit') { ui.confirm(); Date.now = () => instant + 1; }
      await ui.submit(); await ui.tick(); assert.equal(ui.calls.filter(call => call[1]).length, 0); assert.match(ui.html(), /time has passed|time or state is no longer valid/); assert.equal(ui.button('Schedule'), undefined);
    }
  } finally { Date.now = now; }
});

test('schedule receipts require exact native scheduled proof and independently retain the same unknown action', async () => {
  for (const mutate of [value => { value.accountId = 'wrong'; }, value => { value.article.id = '102'; }, value => { value.article.status = 'draft'; }, value => { value.article.isPublished = true; }, value => { value.article.publishedAt = value.article.publishDate; }, value => { value.article.publishDate = '2099-02-10T00:00:00.000Z'; }, value => { value.article.publicationState = 'draft'; }, value => { value.operation.status = 'pending'; }]) {
    const ui = publication(async (path, body) => { if (!body) return path.endsWith('/101') ? detail() : { blog, version: 'blog-version' }; const value = { ...receipt(), article: scheduledArticle(body.publishDate) }; mutate(value); return value; });
    await reviewedSchedule(ui); const timing = ui.field(timingLabel).props.value; await ui.submit(); await ui.tick();
    assert.match(ui.html(), /action key is retained/); assert.doesNotMatch(ui.html(), /Article scheduled for/); assert.equal(ui.field(timingLabel).props.disabled, true);
    await ui.change(timingLabel, '2099-03-01T10:00'); assert.equal(ui.field(timingLabel).props.value, timing); await ui.submit(); await ui.tick();
    const writes = ui.calls.filter(call => call[1]); assert.equal(writes.length, 2); assert.deepEqual(writes[0].slice(0, 2), writes[1].slice(0, 2));
  }
});

test('viewers, Shopify, missing future proof and unverified states cannot schedule or cancel', async () => {
  for (const changes of [{ canWrite: false }, { account: { ...account, platform: 'shopify' }, blog: { ...blog, platform: 'shopify' }, article: { ...receipt().article, platform: 'shopify', status: null } }, { article: { ...scheduledArticle(), platform: 'shopify' } }, { article: { ...scheduledArticle(), publishedAt: '2099-01-10T08:30:00.000Z' } }, { article: { ...scheduledArticle(), publishDate: '2099-01-01' } }, { article: { ...scheduledArticle(), status: 'draft' } }, { article: { ...scheduledArticle(), publicationState: 'unverified' } }, { article: publishedArticle() }]) {
    const ui = publication(undefined, undefined, changes); assert.equal(ui.button('Review Schedule'), undefined); assert.equal(ui.button('Review Reschedule'), undefined); assert.equal(ui.button('Review Cancel schedule'), undefined); await ui.submit(); assert.equal(ui.calls.length, 0);
    if (changes.account?.platform === 'shopify') assert.match(ui.html(), /Shopify scheduling is unavailable/);
  }
});

test('schedule recovery survives access changes while committed revocations block retained scheduling handlers', async () => {
  const pending = deferred(), ui = publication(async (path, body) => body ? pending.promise : path.endsWith('/101') ? detail() : { blog, version: 'blog-version' }); await reviewedSchedule(ui);
  const saving = ui.submit(); ui.setProps({ canWrite: false }); pending.resolve({ ...receipt(), article: scheduledArticle('2099-02-11T00:00:00.000Z') }); await saving; await ui.tick(); ui.setProps({ canWrite: true }); await ui.tick();
  assert.match(ui.html(), /action key is retained/); await ui.submit(); await ui.tick(); const writes = ui.calls.filter(call => call[1]); assert.equal(writes.length, 2); assert.deepEqual(writes[0].slice(0, 2), writes[1].slice(0, 2));
  const guarded = publication(); await reviewedSchedule(guarded); const retained = guarded.find(node => node.type === 'form').props.onSubmit;
  guarded.setProps({ canWrite: false }); guarded.setProps({ canWrite: true }); await retained({ preventDefault() {} }); await guarded.tick(); assert.equal(guarded.calls.filter(call => call[1]).length, 0);
});

test('fresh scheduling reads reject missing HTML, shifted states and wrong destination before any write', async () => {
  for (const action of ['schedule', 'cancel-schedule']) for (const bad of ['html', 'state', 'version', 'scope']) {
    const selected = action === 'schedule' ? receipt().article : scheduledArticle(), fresh = detail({ ...selected });
    if (bad === 'html') fresh.article.bodyHtml = null; if (bad === 'state') fresh.article = action === 'schedule' ? scheduledArticle() : receipt().article; if (bad === 'version') delete fresh.version; if (bad === 'scope') fresh.article.blogId = '12';
    const ui = publication(async path => path.endsWith('/101') ? fresh : { blog, version: 'blog-version' }, selected);
    if (action === 'schedule') await ui.change(timingLabel, localPublicationTime); await ui.click(action === 'schedule' ? 'Review Schedule' : 'Review Cancel schedule'); await ui.tick();
    assert.match(ui.html(), /could not be verified/); assert.equal(ui.find(node => node.type === 'input' && node.props.type === 'checkbox'), undefined); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 0);
  }
});

test('schedule receipts accept the same explicit-offset instant and reject millisecond drift; cancel requires exact draft proof', () => {
  const expected = '2099-02-10T08:30:00.001Z', accepted = { ...receipt(), article: scheduledArticle('2099-02-10T12:30:00.001+04:00') };
  assert.doesNotThrow(() => helperContext.validatePublicationReceipt(accepted, account, blog, receipt().article, 'schedule', expected));
  assert.throws(() => helperContext.validatePublicationReceipt(accepted, account, blog, receipt().article, 'schedule', '2099-02-10T08:30:00.000Z'), /receipt/);
  assert.doesNotThrow(() => helperContext.validatePublicationReceipt(receipt(), account, blog, scheduledArticle(), 'cancel-schedule'));
  assert.throws(() => helperContext.validatePublicationReceipt({ ...receipt(), article: scheduledArticle() }, account, blog, scheduledArticle(), 'cancel-schedule'), /receipt/);
});

test('completed or definitively rejected actions cannot be revived by retained confirmation handlers', async () => {
  for (const rejected of [false, true]) for (const scheduling of [false, true]) {
    const ui = publication(async (path, body) => { if (!body) return path.endsWith('/101') ? detail() : { blog, version: 'blog-version' }; if (rejected) throw Object.assign(new Error('Review changed'), { status: 409 }); return { ...receipt(), article: scheduling ? scheduledArticle(body.publishDate) : publishedArticle() }; });
    if (scheduling) await reviewedSchedule(ui); else await reviewedPublication(ui);
    const retainedSubmit = ui.find(node => node.type === 'form').props.onSubmit, retainedConfirm = ui.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange;
    await ui.submit(); await ui.tick(); retainedConfirm({ target: { checked: true } }); await retainedSubmit({ preventDefault() {} }); await ui.tick(); assert.equal(ui.calls.filter(call => call[1]).length, 1);
  }
});

test('timezone edits revoke every publication review and retained acknowledgment including Local to UTC to Local', async () => {
  for (const action of ['publish', 'schedule', 'cancel-schedule']) {
    const ui = publication(undefined, action === 'cancel-schedule' ? scheduledArticle() : receipt().article);
    if (action === 'publish') await reviewedPublication(ui); else if (action === 'schedule') await reviewedSchedule(ui); else { await ui.click('Review Cancel schedule'); await ui.tick(); ui.confirm(); }
    const submit = ui.find(node => node.type === 'form').props.onSubmit, confirm = ui.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange;
    await ui.change('Publication timezone', 'utc'); await ui.change('Publication timezone', 'local'); confirm({ target: { checked: true } }); await submit({ preventDefault() {} }); await ui.tick();
    assert.equal(ui.calls.filter(call => call[1]).length, 0); assert.equal(ui.find(node => node.type === 'input' && node.props.type === 'checkbox'), undefined);
  }
});

test('ambiguous local input requires UTC choice and each repeated-hour instant is reviewed and sent exactly', async () => {
  const originalZone = process.env.TZ; process.env.TZ = 'America/New_York';
  try {
    for (const [input, expected] of [['2099-11-01T05:30', '2099-11-01T05:30:00.000Z'], ['2099-11-01T06:30', '2099-11-01T06:30:00.000Z']]) {
      const ui = publication(async (path, body, validate) => { if (!body) return path.endsWith('/101') ? detail() : { blog, version: 'blog-version' }; const accepted = { ...receipt(), article: scheduledArticle(body.publishDate) }; validate(accepted); return accepted; });
      await ui.change(timingLabel, '2099-11-01T01:30'); await ui.click('Review Schedule'); await ui.tick(); assert.match(ui.html(), /occurs twice.*Choose UTC/); assert.equal(ui.calls.length, 0);
      await ui.change('Publication timezone', 'utc'); await ui.change('Publication time (UTC)', input); await ui.click('Review Schedule'); await ui.tick(); assert.match(ui.html(), /America\/New_York, your local timezone/); assert.ok(ui.html().includes(`UTC ${expected}`));
      ui.confirm(); await ui.submit(); await ui.tick(); assert.equal(ui.calls.find(call => call[1])[1].publishDate, expected);
    }
  } finally { if (originalZone === undefined) delete process.env.TZ; else process.env.TZ = originalZone; }
});

test('scheduling acceptance receipts remain verifiable after their time while new dispatch still requires the future', async () => {
  const now = Date.now, instant = Date.parse(new Date(localPublicationTime).toISOString());
  try {
    for (const recovering of [false, true]) {
      Date.now = () => instant - 60000; let providerWrites = 0, checks = 0, accepted = 0, stored; const pending = deferred();
      const ui = publication(async (path, body, validate) => {
        if (!body) return path.endsWith('/101') ? detail() : { blog, version: 'blog-version' };
        checks++; if (checks === 1) { providerWrites++; stored = { ...receipt(), article: scheduledArticle(body.publishDate) }; if (recovering) throw Object.assign(new Error('Outcome needs checking'), { status: 409, code: 'OPERATION_UNCERTAIN' }); await pending.promise; }
        validate(stored); return stored;
      }, undefined, { onChanged: () => { accepted++; } });
      await reviewedSchedule(ui); const retainedSubmit = ui.find(node => node.type === 'form').props.onSubmit, saving = ui.submit();
      if (recovering) { await saving; await ui.tick(); assert.match(ui.html(), /action key is retained/); }
      Date.now = () => instant + 60000;
      await ui.change(timingLabel, '2099-03-01T12:30'); await ui.change('Publication timezone', 'utc'); assert.equal(ui.field(timingLabel).props.value, localPublicationTime); assert.equal(ui.field('Publication timezone').props.value, 'local');
      if (recovering) await ui.submit(); else { pending.resolve(); await saving; } await ui.tick();
      assert.equal(accepted, 1); assert.equal(providerWrites, 1); assert.equal(checks, recovering ? 2 : 1); assert.match(ui.html(), /receipt records scheduling acceptance; refresh the article to check its current state/); assert.doesNotMatch(ui.html(), /action key is retained/);
      if (recovering) { const writes = ui.calls.filter(call => call[1]); assert.deepEqual(writes[0].slice(0, 2), writes[1].slice(0, 2)); }
      await retainedSubmit({ preventDefault() {} }); await ui.submit(); assert.equal(checks, recovering ? 2 : 1);
      await ui.click('Review Schedule'); await ui.tick(); assert.match(ui.html(), /valid future/); assert.equal(checks, recovering ? 2 : 1);
      await ui.change(timingLabel, '2099-03-01T12:30'); await ui.click('Review Schedule'); await ui.tick(); assert.equal(ui.field(timingLabel).props.value, '2099-03-01T12:30'); assert.equal(ui.button('Schedule').props.disabled, true);
    }
  } finally { Date.now = now; }
});

async function reviewedPublished(ui) { await ui.tick(); await ui.change('Article title', '  Public launch  '); await ui.change('Article HTML', ' <script>literal_public()</script> '); await ui.click('Review published article and destination'); await ui.tick(); ui.confirm(); }
const publishedReceipt = () => ({ ...receipt(), article: publishedArticle() });

test('published WordPress editing uses the existing composer, exact content-only update and accepted publication facts', async () => {
  const events = [], ui = composer(async (path, body, validate) => {
    if (!body) return path.endsWith('/101') ? detail(publishedArticle()) : { blog, version: 'blog-version' };
    const accepted = publishedReceipt(); accepted.article.publishedAt = '2026-01-01T04:00:00+04:00'; validate(accepted); events.push('validated before key release'); return accepted;
  }, publishedArticle(), { onSaved: value => events.push(value.article.title) });
  await reviewedPublished(ui); assert.match(ui.html(), /changes the public article immediately while preserving its publication time and published state/); assert.match(ui.html(), /Current article · 101 · Published/); assert.match(ui.html(), /Account account\/a.*Blog 11/); assert.match(ui.html(), /Publication time: 2026-01-01T00:00:00Z/); assert.match(ui.html(), /&lt;script&gt;literal_public\(\)&lt;\/script&gt;/); assert.doesNotMatch(ui.html(), /<script|<iframe|<img/);
  const confirm = ui.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange, submit = ui.find(node => node.type === 'form').props.onSubmit;
  await ui.submit(); await ui.tick(); assert.deepEqual(ui.calls.find(call => call[1]).slice(0, 2), ['blogs/account%2Fa/11/articles/101/update', { title: 'Public launch', bodyHtml: ' <script>literal_public()</script> ', version: 'article-version', confirmUpdate: true }]); assert.deepEqual(events, ['validated before key release', 'Normalized title']); assert.match(ui.html(), /Published article updated/); assert.match(ui.html(), /Published state preserved.*2026-01-01T04:00:00\+04:00/); assert.match(ui.html(), /Accepted article HTML.*Normalized HTML/);
  confirm({ target: { checked: true } }); await submit({ preventDefault() {} }); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 1);
});

test('published update receipt validation independently requires exact original publication proof and retains one unknown action', async () => {
  for (const validateInRequester of [false, true]) for (const mutate of [r => { r.accountId = 'wrong'; }, r => { r.article.id = '102'; }, r => { r.article.blogId = '12'; }, r => { r.article.platform = 'shopify'; }, r => { r.article.bodyHtml = null; }, r => { r.article.title = ''; }, r => { r.article.status = 'draft'; }, r => { r.article.isPublished = false; }, r => { r.article.publicationState = 'unverified'; }, r => { delete r.article.canEditPublished; }, r => { r.article.publishDate = undefined; }, r => { r.article.publishedAt = null; }, r => { r.article.publishedAt = '2026-01-01T00:00:00.001Z'; }, r => { r.article.publishedAt = '2026-01-01'; }, r => { r.operation.status = 'pending'; }]) {
    const ui = composer(async (path, body, validate) => { if (!body) return path.endsWith('/101') ? detail(publishedArticle()) : { blog, version: 'blog-version' }; const result = publishedReceipt(); mutate(result); if (validateInRequester) validate(result); return result; }, publishedArticle());
    await reviewedPublished(ui); await ui.submit(); await ui.tick(); assert.match(ui.html(), /Your content and action key are retained/); assert.doesNotMatch(ui.html(), /Published article updated/); const title = ui.field('Article title').props.value, html = ui.field('Article HTML').props.value;
    await ui.change('Article title', 'Ignored replacement'); await ui.change('Article HTML', 'Ignored HTML'); assert.equal(ui.field('Article title').props.value, title); assert.equal(ui.field('Article HTML').props.value, html); await ui.submit(); await ui.tick(); const writes = ui.calls.filter(call => call[1]); assert.equal(writes.length, 2); assert.deepEqual(writes[0].slice(0, 2), writes[1].slice(0, 2));
  }
});

test('published editor eligibility requires WordPress raw proof, explicit valid past time and write access', async () => {
  for (const changes of [{ readOnly: true }, { article: publishedArticle('shopify'), account: { ...account, platform: 'shopify' }, blog: { ...blog, platform: 'shopify' } }, ...[{ status: 'pending' }, { status: 'private' }, { publicationState: 'scheduled' }, { publicationState: 'unverified' }, { isPublished: false }, { canEditPublished: undefined }, { canEditPublished: false }, { publishDate: undefined }, { publishDate: '2099-01-01T00:00:00Z' }, { publishedAt: null }, { publishedAt: undefined }, { publishedAt: '2099-01-01T00:00:00Z' }, { publishedAt: '2026-02-30T00:00:00Z' }, { publishedAt: '2026-01-01T24:00:00Z' }, { publishedAt: '2026-01-01T00:00:00' }].map(change => ({ article: { ...publishedArticle(), ...change } }))]) {
    const ui = composer(undefined, publishedArticle(), changes); await ui.tick(); assert.equal(ui.calls.length, 0); assert.equal(ui.find(node => node.type === 'fieldset').props.disabled, true); await ui.submit(); assert.equal(ui.calls.length, 0);
  }
});

test('initial and review reads cannot switch the bound draft or published mode or publication instant', async () => {
  for (const selected of [receipt().article, publishedArticle()]) for (const phase of ['initial', 'review']) for (const changed of [selected.publicationState === 'draft' ? publishedArticle() : receipt().article, { ...selected, canEditPublished: false, publicationState: 'unverified' }, { ...selected, publishedAt: '2026-01-01T00:00:00.001Z' }]) {
    let reads = 0; const ui = composer(async path => path.endsWith('/101') ? detail(++reads === 1 && phase === 'review' ? selected : changed) : { blog, version: 'blog-version' }, selected); await ui.tick();
    if (phase === 'review') { await ui.change('Article title', 'Kept title'); await ui.click(selected.publicationState === 'draft' ? 'Review draft and destination' : 'Review published article and destination'); await ui.tick(); assert.equal(ui.field('Article title').props.value, 'Kept title'); }
    assert.match(ui.html(), /could not be verified/); assert.equal(ui.find(node => node.type === 'input' && node.props.type === 'checkbox'), undefined); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 0);
  }
});

test('committed permissions and mode changes revoke retained published reviews including A to B to A', async () => {
  for (const changes of [{ readOnly: true }, { account: { ...account, isActive: false } }, { account: { ...account, needsReconnection: true } }, { article: receipt().article }, { article: { ...publishedArticle(), canEditPublished: false } }]) {
    const ui = composer(async path => path.endsWith('/101') ? detail(publishedArticle()) : { blog, version: 'blog-version' }, publishedArticle()); await reviewedPublished(ui);
    const confirm = ui.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange, submit = ui.find(node => node.type === 'form').props.onSubmit, review = ui.button('Review published article and destination').props.onClick;
    ui.setProps(changes); ui.setProps({ readOnly: false, account, article: publishedArticle() }); confirm({ target: { checked: true } }); await submit({ preventDefault() {} }); await review(); await ui.tick(); assert.equal(ui.calls.filter(call => call[1]).length, 0); assert.equal(ui.find(node => node.type === 'input' && node.props.type === 'checkbox'), undefined); assert.equal(ui.field('Article title').props.value, '  Public launch  ');
  }
});

test('delayed published reads ignore committed access restoration and discarded renders cannot revoke committed saves', async () => {
  const pending = deferred(), initial = composer(() => pending.promise, publishedArticle()); initial.setProps({ readOnly: true }); initial.setProps({ readOnly: false }); pending.resolve(detail({ ...publishedArticle(), title: 'STALE_READ' })); await initial.tick(); assert.equal(initial.field('Article title').props.value, ''); assert.doesNotMatch(initial.html(), /STALE_READ/);
  const ui = composer(async (path, body) => body ? publishedReceipt() : path.endsWith('/101') ? detail(publishedArticle()) : { blog, version: 'blog-version' }, publishedArticle()); await reviewedPublished(ui); const submit = ui.find(node => node.type === 'form').props.onSubmit; ui.discardProps({ readOnly: true, article: receipt().article }); await submit({ preventDefault() {} }); await ui.tick(); assert.equal(ui.calls.filter(call => call[1]).length, 1); assert.match(ui.html(), /Published article updated/);
});

test('published null HTML needs explicit replacement and an empty literal replacement is reviewed and sent', async () => {
  const selected = { ...publishedArticle(), bodyHtml: null }, ui = composer(async (path, body) => body ? { ...publishedReceipt(), article: { ...publishedArticle(), bodyHtml: '' } } : path.endsWith('/101') ? detail(selected) : { blog, version: 'blog-version' }, selected); await ui.tick(); assert.equal(ui.field('Article HTML'), undefined); assert.equal(ui.button('Review published article and destination').props.disabled, true); await ui.click('Replace unavailable article HTML'); await ui.click('Review published article and destination'); await ui.tick(); assert.match(ui.html(), /No article HTML was returned/); assert.match(ui.html(), /Replace the article HTML below/); ui.confirm(); await ui.submit(); await ui.tick(); assert.equal(ui.calls.find(call => call[1])[1].bodyHtml, ''); assert.match(ui.html(), /Published article updated/);
});

test('pending published outcomes survive access changes and operator closure requires a fresh explicit review', async () => {
  let writes = 0, reads = 0; const pending = deferred(), ui = composer(async (path, body) => {
    if (!body) return path.endsWith('/101') ? (reads++, detail(publishedArticle(), writes > 1 ? 'fresh-version' : 'article-version')) : { blog, version: 'blog-version' };
    writes++; if (writes === 1) return pending.promise; if (writes === 2) throw Object.assign(new Error('Closed after operator review'), { status: 409, code: 'OPERATION_REVIEWED', operation: { id: 'closed-published', status: 'reviewed-failed' } }); return publishedReceipt();
  }, publishedArticle()); await reviewedPublished(ui); const saving = ui.submit(); ui.setProps({ readOnly: true }); pending.resolve({ ...publishedReceipt(), accountId: 'wrong' }); await saving; await ui.tick(); ui.setProps({ readOnly: false }); await ui.tick(); assert.match(ui.html(), /Your content and action key are retained/); const oldConfirm = ui.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange, oldSubmit = ui.find(node => node.type === 'form').props.onSubmit;
  await ui.submit(); await ui.tick(); assert.equal(reads, 2); assert.match(ui.html(), /closed-published.*reviewed-failed/); assert.equal(ui.field('Article title').props.value, '  Public launch  '); assert.equal(ui.field('Article HTML').props.value, ' <script>literal_public()</script> '); assert.doesNotMatch(ui.html(), /Your content and action key are retained|Review published article changes|Published article updated/); oldConfirm({ target: { checked: true } }); await oldSubmit({ preventDefault() {} }); await ui.submit(); assert.equal(writes, 2);
  await ui.click('Refresh current article review'); await ui.tick(); assert.equal(reads, 3); assert.equal(ui.field('Article title').props.value, '  Public launch  '); await ui.click('Review published article and destination'); await ui.tick(); assert.equal(ui.button('Save published article changes').props.disabled, true); ui.confirm(); await ui.submit(); await ui.tick(); assert.equal(writes, 3); assert.equal(ui.calls.filter(call => call[1]).at(-1)[1].version, 'fresh-version'); assert.match(ui.html(), /Published article updated/);
});

test('article rows offer published editing only for strict WordPress proof and never for Shopify or viewers', async () => {
  for (const viewer of [false, true]) for (const platform of ['wordpress', 'shopify']) {
    const selected = { ...account, platform }, destination = { ...blog, platform }, base = { ...publishedArticle(platform) }, articles = [base, { ...base, id: '102', canEditPublished: false }, { ...base, id: '103', publishedAt: null }, { ...base, id: '104', publishedAt: '2099-01-01T00:00:00Z' }, { ...base, id: '105', publishDate: undefined }], edits = [];
    const ui = browser('ZernioBlogDrafts', { request: async path => path === 'blogs/accounts' ? { accounts: [selected] } : path.includes('/articles') ? { articles, nextCursor: null } : { blogs: [destination], nextCursor: null }, onEditDraft: viewer ? undefined : (...args) => edits.push(args) }); await ui.tick(); await ui.change('Blog account', selected.id); await ui.change('Blog', destination.id); const button = ui.button('Edit published article Normalized title'); assert.equal(!!button, !viewer && platform === 'wordpress'); if (button) { await ui.click('Edit published article Normalized title'); assert.deepEqual(edits, [[selected, destination, base]]); }
  }
});


test('lost blog responses recover terminal unsent drafts and publication reviews without an automatic write', async () => {
  for (const code of ['OPERATION_NOT_SENT', 'BLOG_PREVIOUS_OUTCOME_UNRESOLVED']) for (const published of [false, true]) {
    let writes = 0, reads = 0; const selected = published ? publishedArticle() : receipt().article;
    const ui = composer(async (path, body) => { if (!body) return path.endsWith('/101') ? (reads++, detail(selected, writes > 1 ? 'fresh-version' : 'article-version')) : { blog, version: 'blog-version' }; writes++; if (writes === 1) throw new TypeError('Response lost'); if (writes === 2) throw Object.assign(new Error('Blocked before dispatch'), { status: 409, code, operation: { id: 'not-sent', status: 'failed' } }); return published ? publishedReceipt() : receipt(); }, selected);
    if (published) await reviewedPublished(ui); else await reviewed(ui);
    await ui.submit(); await ui.tick(); const oldSubmit = ui.find(node => node.type === 'form').props.onSubmit, oldConfirm = ui.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange;
    await ui.submit(); await ui.tick(); assert.match(ui.html(), /request was not sent/); assert.doesNotMatch(ui.html(), /closed after operator review|action key are retained/); assert.equal(ui.field('Article title').props.value, published ? '  Public launch  ' : '  Our launch  ');
    oldConfirm({ target: { checked: true } }); await oldSubmit({ preventDefault() {} }); await ui.submit(); assert.equal(writes, 2); assert.equal(reads, 2);
    await ui.click('Refresh current article review'); await ui.tick(); assert.equal(reads, 3); await ui.click(published ? 'Review published article and destination' : 'Review draft and destination'); await ui.tick(); await ui.submit(); assert.equal(writes, 2); ui.confirm(); await ui.submit(); await ui.tick(); assert.equal(writes, 3); assert.equal(ui.calls.filter(call => call[1]).at(-1)[1].version, 'fresh-version');
  }
  let writes = 0; const ui = publication(async (path, body) => { if (!body) return path.endsWith('/101') ? detail() : { blog, version: 'blog-version' }; if (++writes === 1) throw new TypeError('Response lost'); throw Object.assign(new Error('Not sent'), { status: 409, code: 'OPERATION_NOT_SENT', operation: { status: 'failed' } }); });
  await reviewedPublication(ui); await ui.submit(); await ui.tick(); await ui.submit(); await ui.tick(); assert.match(ui.html(), /request was not sent/); assert.doesNotMatch(ui.html(), /action key is retained/); await ui.submit(); assert.equal(writes, 2); await ui.click('Review Publish now'); await ui.tick(); await ui.submit(); assert.equal(writes, 2); ui.confirm(); assert.equal(writes, 2);
});
