import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const source = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
const routes = source.slice(source.indexOf('const pageRoutes:'), source.indexOf('const pages:'));
const { readNavigation, navigationUrl, editorValues, pageRoutes, pageSections } = new Function(stripTypeScriptTypes(routes) + '; return {readNavigation, navigationUrl, editorValues, pageRoutes, pageSections};')();
const tick = () => new Promise(resolve => setImmediate(resolve));

test('outcome checks preserve the original key without creating a first send and editor wrappers forward the check', async () => {
  const pendingKeys = { current: new Map() }, calls = []; let mode = 'lost';
  const invoke = new Function('state', 'activeProject', 'pendingKeys', 'crypto', 'api', 'endpoint', 'DOMException', `return (${stripTypeScriptTypes(declaration('integrate'))});`)(
    { projectId: 'a' }, { current: 'a' }, pendingKeys, { randomUUID: () => 'original-key' },
    async (...args) => { calls.push(args); if (mode === 'lost') throw new Error('Request may not have arrived'); if (mode === 'missing') throw Object.assign(new Error('Receipt unavailable'), { status: 409, code: 'OPERATION_OUTCOME_UNAVAILABLE' }); return { accepted: true }; }, path => path, DOMException,
  );
  const path = 'products/store/product/archive', body = { confirmArchive: true };
  await assert.rejects(invoke(path, body, undefined, true), /original action key/); assert.equal(calls.length, 0); assert.equal(pendingKeys.current.size, 0);
  await assert.rejects(invoke(path, body), /may not have arrived/); mode = 'missing';
  await assert.rejects(invoke(path, body, undefined, true), /Receipt unavailable/);
  assert.equal(calls[1][0], 'integrations/' + path + '?check=1'); assert.equal(calls[1][3], calls[0][3]); assert.equal(pendingKeys.current.size, 1);
  mode = 'complete'; await invoke(path, body, undefined, true); assert.equal(pendingKeys.current.size, 0); assert.equal(calls[2][3], 'original-key');
  let forwarded;
  const editor = new Function('modalRef', 'document', 'dirtyScopes', 'integrate', 'editorSaved', `return (${stripTypeScriptTypes(declaration('editorIntegrate'))});`)(
    { current: {} }, {}, { current: new Map() }, async (...args) => { forwarded = args; return {}; }, () => assert.fail('No form can be marked saved'),
  );
  await editor(path, body, undefined, true); assert.equal(forwarded[3], true);
});
test('metadata form saves only after its acceptance validator and retains edits made during the request', async () => {
  const form = {}, opened = {}, revisions = new Map([[form, 1]]), saved = [], response = deferred();
  let result = { metadataAcceptance: { postId: 'foreign' } }, wait = false;
  const invoke = new Function('modalRef', 'document', 'dirtyScopes', 'integrate', 'editorSaved', `return (${stripTypeScriptTypes(declaration('editorIntegrate'))});`)(
    { current: opened }, { activeElement: { closest: () => form } }, { current: revisions }, async (_path, _body, validate) => { const receipt = await (wait ? response.promise : result); validate?.(receipt); return receipt; },
    (scope, revision) => { if (revisions.get(scope) === revision) saved.push(scope); },
  );
  await invoke('social/update-metadata', {}); assert.equal(saved.length, 0, 'A truthy receipt alone cannot clear the draft.');
  const validate = receipt => { if (receipt.metadataAcceptance?.postId !== 'reviewed') throw new Error('Foreign acceptance'); };
  await assert.rejects(invoke('social/update-metadata', {}, validate), /Foreign acceptance/); assert.equal(saved.length, 0);
  result = { metadataAcceptance: { postId: 'reviewed' } }; await invoke('social/update-metadata', {}, validate); assert.equal(saved.length, 1);
  wait = true; const pending = invoke('social/update-metadata', {}, validate); revisions.set(form, 2); response.resolve(result); await pending;
  assert.equal(saved.length, 1, 'A valid old receipt cannot clear newer edits.');
});
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
for (const path of ['blogs/site/91/create', 'blogs/site/91/articles/12/update']) test(`blog save ${path} clears only a validated complete receipt and preserves newer editor changes`, async () => {
  const form = {}, opened = {}, revisions = new Map([[form, 1]]), saved = [], response = deferred();
  let result = { article: { id: '12' }, operation: { status: 'pending' } }, wait = false;
  const invoke = new Function('modalRef', 'document', 'dirtyScopes', 'integrate', 'editorSaved', `return (${stripTypeScriptTypes(declaration('editorIntegrate'))});`)(
    { current: opened }, { activeElement: { closest: () => form } }, { current: revisions }, async (_path, _body, validate) => { const receipt = await (wait ? response.promise : result); validate?.(receipt); return receipt; },
    (scope, revision) => { if (revisions.get(scope) === revision) saved.push(scope); },
  );
  const validate = receipt => { if (receipt.accountId !== 'site') throw new Error('Foreign draft'); };
  await invoke(path, {}); assert.equal(saved.length, 0);
  result.accountId = 'site'; await invoke(path, {}, validate); assert.equal(saved.length, 0, 'Pending saves are not saved.');
  result.operation.status = 'complete'; await invoke(path, {}, validate); assert.equal(saved.length, 1);
  await invoke('blogs/site/91/articles/12', {}, validate); assert.equal(saved.length, 1, 'Reading an article cannot clear a draft.');
  wait = true; const pending = invoke(path, {}, validate); revisions.set(form, 2); response.resolve(result); await pending;
  assert.equal(saved.length, 1, 'A completed save cannot clear later edits.');
  assert.match(source, /modal\.type === 'blog-draft' \? <Suspense/);
  assert.match(source, /onCreate=\{canWrite \?/);
  assert.match(source, /onEditDraft=\{canWrite \?/);
  assert.match(source, /article=\{modal\.item!\.article\}/);
  assert.match(source, /<BlogDraftComposer[^>]+readOnly=\{!canWrite\} request=\{editorIntegrate\}/);
});
for (const [path, receiptField] of [['products/shop/9001/update', 'product'], ['products/shop/create', 'product'], ['products/shop/9001/price', 'product'], ['products/shop/9001/deactivate', 'product'], ['products/shop/collections/gid%3A%2F%2Fshopify%2FCollection%2F7001/rename', 'collection']]) test(`store save ${path} clears only validated readback and preserves newer modal edits`, async () => {
  const form = {}, opened = {}, revisions = new Map([[form, 1]]), saved = [], response = deferred();
  let result = { accountId: 'shop', [receiptField]: { id: '9001' }, readback: false, operation: { status: 'complete' } }, wait = false;
  const invoke = new Function('modalRef', 'document', 'dirtyScopes', 'integrate', 'editorSaved', `return (${stripTypeScriptTypes(declaration('editorIntegrate'))});`)(
    { current: opened }, { activeElement: { closest: () => form } }, { current: revisions }, async (_path, _body, validate) => { const receipt = await (wait ? response.promise : result); validate?.(receipt); return receipt; },
    (scope, revision) => { if (revisions.get(scope) === revision) saved.push(scope); },
  );
  const validate = receipt => { if (receipt.accountId !== 'shop' || receipt[receiptField]?.id !== '9001') throw new Error('Foreign product'); };
  await invoke(path, {}, validate); assert.equal(saved.length, 0, 'Unverified readback cannot clear a draft.');
  result.readback = true; await invoke(path, {}); assert.equal(saved.length, 0, 'A product object alone cannot clear a draft.');
  result.operation.status = 'pending'; await invoke(path, {}, validate); assert.equal(saved.length, 0);
  result.operation.status = 'complete'; result.accountId = 'foreign'; await assert.rejects(invoke(path, {}, validate), /Foreign product/); assert.equal(saved.length, 0);
  result.accountId = 'shop'; await invoke(path, {}, validate); assert.equal(saved.length, 1);
  await invoke('products/shop/9001', {}, validate); assert.equal(saved.length, 1, 'Reading cannot clear a draft.');
  wait = true; const pending = invoke(path, {}, validate); revisions.set(form, 2); response.resolve(result); await pending; assert.equal(saved.length, 1);
  assert.match(source, /modal\.type === 'product-edit' \? <Suspense/);
  assert.match(source, /<ProductEditor[^>]+readOnly=\{!canWrite\} request=\{editorIntegrate\}/);
  assert.match(source, /modal\.type === 'product-create' \? <Suspense/);
  assert.match(source, /<ProductCreator[^>]+readOnly=\{!canWrite\} request=\{editorIntegrate\}/);
  assert.match(source, /modal\.type === 'product-price' \? <Suspense/);
  assert.match(source, /<ProductPriceEditor[^>]+readOnly=\{!canWrite\} request=\{editorIntegrate\}/);
  assert.match(source, /<ProductStateReview[^>]+readOnly=\{!canWrite\} request=\{editorIntegrate\}/);
  assert.match(source, /onDeactivate=\{canWrite \?/);
  assert.match(source, /<CollectionTitleEditor[^>]+readOnly=\{!canWrite\} request=\{editorIntegrate\}/);
  assert.match(source, /onRenameCollection=\{canWrite \?/);
});
test('metadata receipt validation retains the original action key until the receipt is valid', async () => {
  const pendingKeys = { current: new Map() }, keys = []; let receipt = { metadataAcceptance: { accountId: 'foreign' } };
  const invoke = new Function('state', 'activeProject', 'pendingKeys', 'crypto', 'api', 'endpoint', 'DOMException', `return (${stripTypeScriptTypes(declaration('integrate'))});`)(
    { projectId: 'a' }, { current: 'a' }, pendingKeys, { randomUUID: () => 'original-key' },
    async (_path, _method, _body, key) => { keys.push(key); return receipt; }, path => path, DOMException,
  );
  const validate = result => { if (result.metadataAcceptance?.accountId !== 'reviewed') throw new Error('Invalid acceptance'); };
  await assert.rejects(invoke('social/update-metadata', { title: 'Reviewed' }, validate), /Invalid acceptance/); assert.equal(pendingKeys.current.size, 1);
  receipt = { metadataAcceptance: { accountId: 'reviewed' } }; await invoke('social/update-metadata', { title: 'Reviewed' }, validate);
  assert.deepEqual(keys, ['original-key', 'original-key']); assert.equal(pendingKeys.current.size, 0);
});
test('a clean form becoming dirty while metadata is pending retains its actual editor revision', async () => {
  const form = {}, opened = {}, response = deferred(), dirtyScopes = { current: new Map() }; let draftDirty = false;
  const editorSaved = new Function('dirtyScopes', 'setDraftDirty', `return (${stripTypeScriptTypes(declaration('editorSaved'))});`)(dirtyScopes, value => { draftDirty = value; });
  const invoke = new Function('modalRef', 'document', 'dirtyScopes', 'integrate', 'editorSaved', `return (${stripTypeScriptTypes(declaration('editorIntegrate'))});`)(
    { current: opened }, { activeElement: { closest: () => form } }, dirtyScopes, async (_path, _body, validate) => { const result = await response.promise; validate(result); return result; }, editorSaved,
  );
  const pending = invoke('social/update-metadata', {}, () => {}); dirtyScopes.current.set(form, 1); draftDirty = true;
  response.resolve({ metadataAcceptance: {} }); await pending;
  assert.equal(dirtyScopes.current.get(form), 1); assert.equal(draftDirty, true);
});
test('provider errors retain action keys until the request is known to have failed', async () => {
  for (const problem of [{ status: 502 }, { status: 502, code: 'PROVIDER_UNAVAILABLE', operation: { status: 'failed' } }, { status: 409, code: 'OPERATION_UNCERTAIN' }, { status: 409, code: 'OPERATION_PENDING' }, { status: 409, code: 'OPERATION_IN_PROGRESS' }, { status: 409, code: 'BLOG_PREVIOUS_OUTCOME_UNRESOLVED' }, { status: 409, code: 'PRODUCT_PREVIOUS_OUTCOME_UNRESOLVED' }, { status: 409, code: 'OPERATION_NOT_SENT', operation: { status: 'failed' } }, { status: 409, code: 'PRODUCT_PREVIOUS_OUTCOME_UNRESOLVED', operation: { status: 'failed' } }, { status: 409, code: 'BLOG_PREVIOUS_OUTCOME_UNRESOLVED', operation: { status: 'failed' } }, { status: 400, code: 'INVALID_INPUT' }]) {
    const pendingKeys = { current: new Map() };
    const invoke = new Function('state', 'activeProject', 'pendingKeys', 'crypto', 'api', 'endpoint', 'DOMException', `return (${stripTypeScriptTypes(declaration('integrate'))});`)(
      { projectId: 'a' }, { current: 'a' }, pendingKeys, { randomUUID: () => 'original-key' },
      async () => { throw Object.assign(new Error('Provider request failed'), problem); }, path => path, DOMException,
    );
    await assert.rejects(invoke('blogs/site/91/create', { title: 'Reviewed' }));
    assert.equal(pendingKeys.current.size, problem.status === 400 || problem.operation?.status === 'failed' ? 0 : 1, JSON.stringify(problem));
  }
});
function declaration(name) {
  const start = source.search(new RegExp(`^  (?:async )?function ${name}\\(`, 'm')), end = source.indexOf('\n  }', start) + 4;
  assert.ok(start > 0 && end > start, name);
  // Several tiny handlers occupy one line; larger handlers end at the outer two-space brace.
  return source.slice(start, source.indexOf('\n', start) < end && source.slice(start, source.indexOf('\n', start)).trimEnd().endsWith(' }') ? source.indexOf('\n', start) : end).trim();
}
const stateFor = projectId => ({ projectId, projects: [{ id: 'a' }, { id: 'b' }] });
function app(href = 'https://campaign.example/?view=overview&project=a', initial = stateFor('a')) {
  const listeners = new Map(), entries = [{ url: new URL(href), state: { campaignIndex: 0 } }]; let index = 0;
  const window = {
    get location() { const url = entries[index].url; return { href: url.href, pathname: url.pathname, search: url.search, hash: url.hash }; },
    addEventListener(name, listener) { listeners.set(name, listener); }, removeEventListener(name) { listeners.delete(name); },
    history: { get state() { return entries[index].state; }, pushState(state, _title, url) { entries.splice(index + 1); entries.push({ state, url: new URL(url, entries[index].url) }); index++; }, replaceState(state, _title, url) { entries[index] = { state, url: new URL(url || entries[index].url, entries[index].url) }; }, go(delta) { queueMicrotask(() => { if (index + delta < 0 || index + delta >= entries.length) return; index += delta; listeners.get('popstate')?.(); }); } },
  };
  const dialog = { contains: () => true, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, close() { this.open = false; }, showModal() { this.open = true; } }, context = {
    window, document: { activeElement: null }, pageSections, navigationUrl, readNavigation, editorValues, DOMException, setTimeout,
    state: initial, navigationRef: { current: readNavigation(window.location.search) }, historyIndex: { current: 0 }, restoringPop: { current: null },
    modal: null, modalRef: { current: null }, dialogRef: { current: dialog }, triggerRef: { current: null }, draftDirty: false, discardPrompt: false, discardAction: { current: null }, dirtyScopes: { current: new Map() },
    inboxDirty: false, inboxDraft: { current: { dirty: false, revision: 0 } }, discardSwitch: { current: false }, pendingKeys: { current: new Map() },
    loadVersion: { current: 0 }, activeProject: { current: initial?.projectId || '' }, workspace: { id: 'workspace-a' }, FormData: class { constructor(form) { return new Map(Object.entries(form)); } }, error: '', calls: [],
    api: async path => { context.calls.push(path); return stateFor(path.includes('projectId=b') ? 'b' : 'a'); },
    setState: value => { context.state = value; }, setNavigation: value => { context.navigation = value; }, setLoading: value => { context.loading = value; },
    setDraftDirty: value => { context.draftDirty = value; }, setInboxDirty: value => { context.inboxDirty = value; }, setDiscardPrompt: value => { context.discardPrompt = value; }, setModal: value => { context.modal = value; context.modalRef.current = value; }, setError: value => { context.error = value; }, setNotice: value => { context.notice = value; }, setRemote: () => {}, setSession: value => { context.session = value; },
    run: async work => { try { return await work(); } catch (error) { if (error.name !== 'AbortError') context.error = error.message; } },
  };
  const invoke = (name, ...args) => new Function(...Object.keys(context), `return (${stripTypeScriptTypes(declaration(name))});`)(...Object.values(context))(...args);
  for (const name of ['writeNavigation', 'reload', 'leaveEditor', 'closeEditor', 'keepEditing', 'discardChanges', 'cancelEditor', 'navigate', 'setPage', 'changeProject', 'markEditorDirty', 'editorSaved', 'watchEditorButtons', 'inboxDraftChanged', 'signOut', 'submitForm', 'saveEditor']) context[name] = (...args) => invoke(name, ...args);
  const popStart = source.indexOf('    const onPop = () =>'), popEnd = source.indexOf('\n  }, [state, draftDirty]);', popStart);
  context.listen = () => new Function(...Object.keys(context), `return (${stripTypeScriptTypes('function listen(){' + source.slice(popStart, popEnd) + '}')})();`)(...Object.values(context));
  const unloadStart = source.indexOf('    if (!(draftDirty && modal) && !inboxDirty) return;'), unloadEnd = source.indexOf('\n  }, [draftDirty, modal, inboxDirty]);', unloadStart);
  context.warnOnUnload = () => new Function(...Object.keys(context), 'modal', `return (${stripTypeScriptTypes('function listen(){' + source.slice(unloadStart, unloadEnd) + '}')})();`)(...Object.values(context), context.modalRef.current);
  context.unload = event => listeners.get('beforeunload')?.(event);
  const modalStart = source.indexOf('    const dialog = dialogRef.current;'), modalEnd = source.indexOf('\n  }, [modal]);', modalStart);
  context.syncModal = () => new Function(...Object.keys(context), `return (${stripTypeScriptTypes('function sync(){' + source.slice(modalStart, modalEnd) + '}')})();`)(...Object.values(context));
  return context;
}

test('all page URLs round-trip, preserve connection links, and reject sections from another page', () => {
  assert.equal(Object.keys(pageRoutes).length, 16);
  for (const [page, view] of Object.entries(pageRoutes)) for (const section of pageSections[page] || ['']) {
    const route = { page, section, projectId: 'project with spaces' }, url = new URL(navigationUrl(route, 'https://campaign.example/?invite=retain#main'), 'https://campaign.example');
    assert.equal(url.searchParams.get('invite'), 'retain'); assert.equal(url.hash, '#main');
    assert.deepEqual(readNavigation(url.search), route); assert.equal(url.searchParams.get('view'), view);
  }
  assert.equal(readNavigation('?view=integrations').page, 'Integrations'); assert.equal(readNavigation('?view=settings').page, 'Settings');
  assert.equal(readNavigation('?view=assistant').page, 'Draft content');
  assert.deepEqual(readNavigation('?view=ads&section=contacts'), { page: 'Ads manager', section: 'campaigns', projectId: '' });
  assert.deepEqual(readNavigation('?view=unknown&section=shopping'), { page: 'Overview', section: '', projectId: '' });
});

test('initial deep links verify membership before requesting a project and never retain a foreign project URL', async () => {
  for (const requested of ['b', 'foreign']) {
    const ui = app(`https://campaign.example/?view=ads&section=shopping&project=${requested}`, null);
    await ui.reload(requested);
    assert.deepEqual(ui.calls, requested === 'b' ? ['/state', '/state?projectId=b'] : ['/state']);
    assert.equal(ui.state.projectId, requested === 'b' ? 'b' : 'a');
    assert.equal(new URL(ui.window.location.href).searchParams.get('project'), ui.state.projectId);
    assert.equal(ui.navigation.page, 'Ads manager'); assert.equal(ui.navigation.section, 'shopping');
  }
  const ui = app(); ui.changeProject('foreign'); await tick();
  assert.equal(ui.error, 'That project is unavailable.'); assert.deepEqual(ui.calls, []); assert.equal(ui.state.projectId, 'a');
});

test('navigation commits project URLs only after a successful scoped load, and newer navigation cancels older reads', async () => {
  const ui = app(), response = deferred(); ui.api = async path => { ui.calls.push(path); return response.promise; };
  ui.changeProject('b'); assert.equal(new URL(ui.window.location.href).searchParams.get('project'), 'a');
  ui.setPage('Calendar'); response.resolve(stateFor('b')); await tick();
  assert.equal(ui.state.projectId, 'a'); assert.equal(ui.navigation.page, 'Calendar'); assert.equal(ui.navigation.projectId, 'a');
  ui.api = async () => stateFor('b'); ui.changeProject('b'); await tick();
  assert.equal(ui.state.projectId, 'b'); assert.equal(ui.navigation.page, 'Calendar'); assert.equal(ui.navigation.projectId, 'b');
  const failed = app(); failed.api = async () => { throw new Error('Offline'); }; failed.changeProject('b'); await tick();
  assert.equal(failed.state.projectId, 'a'); assert.equal(new URL(failed.window.location.href).searchParams.get('project'), 'a'); assert.equal(failed.error, 'Offline');
  const created = app(); created.api = async path => path === '/state' ? { projectId: 'a', projects: [{ id: 'a' }, { id: 'new' }] } : { projectId: 'new', projects: [{ id: 'a' }, { id: 'new' }] };
  await created.reload('new'); assert.equal(created.state.projectId, 'new', 'Successful project/workspace creation can load newly granted membership.');
});

test('native Back and Forward retain page sections and project scope', async () => {
  const ui = app(); ui.listen(); ui.setPage('Ads manager', 'shopping'); ui.setPage('Publishing', 'queues');
  ui.window.history.go(-1); await tick(); assert.equal(ui.navigation.page, 'Ads manager'); assert.equal(ui.navigation.section, 'shopping');
  ui.window.history.go(1); await tick(); assert.equal(ui.navigation.page, 'Publishing'); assert.equal(ui.navigation.section, 'queues');
  ui.changeProject('b'); await tick(); ui.listen(); ui.window.history.go(-1); await tick();
  assert.equal(ui.state.projectId, 'a'); assert.equal(ui.navigation.projectId, 'a');
  ui.listen(); ui.window.history.go(1); await tick(); assert.equal(ui.state.projectId, 'b'); assert.equal(ui.navigation.projectId, 'b');
});

test('a failed obsolete Back read cannot rewind newer navigation or swallow the following Back', async () => {
  const ui = app(); ui.setPage('Campaigns'); ui.changeProject('b'); await tick(); ui.listen();
  const oldRead = deferred(); ui.api = async () => oldRead.promise;
  ui.window.history.go(-1); await tick(); ui.setPage('Calendar');
  oldRead.reject(new Error('Obsolete Back request failed')); await tick();
  assert.equal(ui.navigation.page, 'Calendar'); assert.equal(ui.error, ''); assert.equal(ui.restoringPop.current, null);
  ui.api = async path => stateFor(path.includes('projectId=b') ? 'b' : 'a');
  ui.window.history.go(-1); await tick();
  assert.equal(ui.navigation.page, 'Campaigns'); assert.equal(new URL(ui.window.location.href).searchParams.get('view'), 'campaigns');
});

test('Escape, closing, and project navigation preserve edits until explicit discard; saved scopes do not clear other forms', async () => {
  const ui = app(), first = { closest: () => first }, second = { closest: () => second };
  ui.modalRef.current = { type: 'campaign' }; ui.markEditorDirty(first); ui.markEditorDirty(second);
  const oldRevision = ui.dirtyScopes.current.get(first); ui.markEditorDirty(first); ui.editorSaved(first, oldRevision);
  assert.equal(ui.dirtyScopes.current.size, 2, 'A late save cannot clear edits made after it began.');
  ui.editorSaved(first); assert.equal(ui.draftDirty, true, 'Another form still has unsaved changes.');
  ui.closeEditor(); assert.equal(ui.discardPrompt, true); assert.ok(ui.modalRef.current);
  ui.keepEditing(); assert.equal(ui.discardPrompt, false); assert.equal(ui.draftDirty, true); assert.ok(ui.modalRef.current);
  let prevented = 0; ui.cancelEditor({ preventDefault() { prevented++; } }); assert.equal(prevented, 1); assert.equal(ui.discardPrompt, true);
  ui.cancelEditor({ preventDefault() { prevented++; } }); assert.equal(ui.discardPrompt, false); assert.equal(ui.draftDirty, true);
  ui.changeProject('b'); assert.equal(ui.discardPrompt, true); assert.deepEqual(ui.calls, []); ui.discardChanges(); await tick();
  assert.equal(ui.state.projectId, 'b'); assert.equal(ui.draftDirty, false); assert.equal(ui.modalRef.current, null);
});

test('unsaved Back restores the current entry while Keep editing preserves Forward; discard performs the original Back', async () => {
  const ui = app(); ui.setPage('Campaigns'); ui.setPage('Publishing', 'posts');
  ui.modalRef.current = { type: 'post' }; ui.draftDirty = true; ui.listen();
  ui.window.history.go(-1); await tick(); assert.equal(ui.navigation.page, 'Publishing'); assert.equal(new URL(ui.window.location.href).searchParams.get('view'), 'publishing'); assert.equal(ui.discardPrompt, true);
  ui.keepEditing(); ui.window.history.go(-1); await tick(); assert.equal(ui.discardPrompt, true); ui.discardChanges(); ui.listen(); await tick();
  assert.equal(ui.navigation.page, 'Campaigns'); ui.window.history.go(1); await tick(); assert.equal(ui.navigation.page, 'Publishing');
});

test('button-based edits are detected while preview and platform-tab buttons leave drafts clean', async () => {
  const ui = app(), values = [{ tagName: 'INPUT', name: 'url', type: 'url', value: 'https://example.com/a.jpg' }], form = { closest: () => form, isConnected: true, querySelectorAll: () => values };
  ui.modalRef.current = { type: 'post' }; ui.dialogRef.current.querySelectorAll = () => [form];
  const click = role => ({ currentTarget: ui.dialogRef.current, target: { closest: () => ({ type: 'button', getAttribute: () => role }) } });
  ui.watchEditorButtons(click(null)); await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(ui.draftDirty, false);
  ui.watchEditorButtons(click('tab')); values.push({ ...values[0], value: '' }); await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(ui.draftDirty, false);
  ui.watchEditorButtons(click(null)); values.pop(); await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(ui.draftDirty, true);
});

test('inbox drafts guard page exits without a modal and leave same-route and unrelated modal closes intact', () => {
  const ui = app('https://campaign.example/?view=inbox&project=a'); ui.inboxDraftChanged(true);
  ui.setPage('Unified inbox'); assert.equal(ui.discardPrompt, false); assert.equal(ui.inboxDirty, true);
  ui.modalRef.current = { type: 'project' }; ui.closeEditor(); assert.equal(ui.modalRef.current, null); assert.equal(ui.inboxDirty, true); assert.equal(ui.discardPrompt, false);
  ui.modalRef.current = { type: 'project' }; ui.draftDirty = true; ui.closeEditor(); ui.discardChanges();
  assert.equal(ui.modalRef.current, null); assert.equal(ui.inboxDirty, true, 'Discarding another editor does not discard the inbox.');
  ui.setPage('Calendar'); assert.equal(ui.discardPrompt, true); assert.equal(ui.discardSwitch.current, true); assert.equal(ui.navigationRef.current.page, 'Unified inbox');
  ui.keepEditing(); assert.equal(ui.inboxDirty, true); assert.equal(ui.discardPrompt, false);
  ui.setPage('Calendar'); ui.discardChanges(); assert.equal(ui.navigationRef.current.page, 'Calendar'); assert.equal(ui.inboxDirty, false);
});

test('discarded project navigation keeps inbox protection through failed, obsolete and newly edited loads', async () => {
  for (const outcome of ['success', 'failure', 'obsolete', 'edited']) {
    const ui = app('https://campaign.example/?view=inbox&project=a'), response = deferred(); ui.inboxDraftChanged(true);
    ui.api = async path => { ui.calls.push(path); return response.promise; };
    ui.changeProject('b'); assert.equal(ui.discardPrompt, true); assert.deepEqual(ui.calls, []); ui.discardChanges();
    assert.equal(ui.inboxDirty, true, 'The original inbox remains protected until the switch commits.');
    if (outcome === 'obsolete') ui.setPage('Unified inbox');
    if (outcome === 'edited') ui.inboxDraftChanged(true);
    if (outcome === 'failure') response.reject(new Error('Offline')); else response.resolve(stateFor('b'));
    await tick();
    assert.equal(ui.state.projectId, outcome === 'success' ? 'b' : 'a'); assert.equal(ui.inboxDirty, outcome !== 'success');
    if (outcome === 'failure') assert.equal(ui.error, 'Offline');
    if (outcome === 'edited') assert.match(ui.error, /draft changed/);
    if (outcome !== 'success') { ui.setPage('Calendar'); assert.equal(ui.discardPrompt, true); }
  }
});

test('inbox Back and Forward require explicit discard, preserve history on Keep editing, and retain drafts on project-load failure', async () => {
  const ui = app(); ui.setPage('Unified inbox'); ui.inboxDraftChanged(true); ui.listen();
  ui.window.history.go(-1); await tick(); assert.equal(ui.navigationRef.current.page, 'Unified inbox'); assert.equal(ui.discardPrompt, true); assert.equal(new URL(ui.window.location.href).searchParams.get('view'), 'inbox');
  ui.keepEditing(); ui.window.history.go(-1); await tick(); ui.discardChanges(); await tick();
  assert.equal(ui.navigationRef.current.page, 'Overview'); assert.equal(ui.inboxDirty, false);
  ui.window.history.go(1); await tick(); assert.equal(ui.navigationRef.current.page, 'Unified inbox');
  ui.changeProject('b'); await tick(); ui.inboxDraftChanged(true); ui.listen(); ui.api = async () => { throw new Error('Offline'); };
  ui.window.history.go(-1); await tick(); ui.discardChanges(); await tick();
  assert.equal(ui.state.projectId, 'b'); assert.equal(ui.inboxDirty, true); assert.equal(ui.error, 'Offline'); assert.equal(new URL(ui.window.location.href).searchParams.get('project'), 'b');
});

test('inbox-only drafts register native unload protection, show an accessible confirmation, and guard sign-out', async () => {
  const ui = app('https://campaign.example/?view=inbox&project=a'); ui.inboxDraftChanged(true);
  const cleanup = ui.warnOnUnload(); let prevented = 0; const event = { preventDefault() { prevented++; } }; ui.unload(event);
  assert.equal(prevented, 1); assert.equal(event.returnValue, ''); cleanup(); ui.unload(event); assert.equal(prevented, 1);
  ui.signOut(); assert.equal(ui.discardPrompt, true); assert.deepEqual(ui.calls, []);
  ui.keepEditing(); assert.equal(ui.discardPrompt, false); assert.equal(ui.inboxDirty, true);
  ui.api = async path => { ui.calls.push(path); return { user: null }; }; ui.signOut(); ui.discardChanges(); await tick();
  assert.deepEqual(ui.calls, ['/auth/logout', '/session']); assert.equal(ui.inboxDirty, false); assert.equal(ui.state, null);
  // The prompt is the library's accessible ConfirmDialog, opened by discardPrompt and cancelled into keepEditing.
  assert.match(source, /<ConfirmDialog open=\{discardPrompt\} onOpenChange=\{open => \{ if \(!open\) keepEditing\(\); \}\} danger title="Discard unsaved changes\?"[^>]*onConfirm=\{discardChanges\}/);
  assert.match(source, /onDraftChange=\{inboxDraftChanged\}/); assert.match(source, /Discard and switch/);
});

test('Forward protects the mounted inbox and unavailable historical projects never discard it', async () => {
  const ui = app(); ui.setPage('Unified inbox'); ui.setPage('Calendar'); ui.listen(); ui.window.history.go(-1); await tick();
  ui.inboxDraftChanged(true); ui.window.history.go(1); await tick();
  assert.equal(ui.discardPrompt, true); assert.equal(new URL(ui.window.location.href).searchParams.get('view'), 'inbox');
  ui.keepEditing(); ui.window.history.go(1); await tick(); ui.discardChanges(); await tick();
  assert.equal(ui.navigationRef.current.page, 'Calendar'); assert.equal(ui.inboxDirty, false);
  ui.setPage('Unified inbox'); ui.inboxDraftChanged(true); ui.state.projects = [{ id: 'a' }];
  ui.window.history.pushState({ campaignIndex: ui.historyIndex.current + 1 }, '', '?view=inbox&project=foreign'); ui.window.history.go(-1); await tick(); ui.window.history.go(1); await tick();
  assert.equal(ui.error, 'That project is unavailable.'); assert.equal(ui.discardPrompt, false); assert.equal(ui.inboxDirty, true); assert.equal(new URL(ui.window.location.href).searchParams.get('project'), 'a');
});

test('actual project and workspace creation completion guards inbox drafts before loading newly granted membership', async () => {
  for (const kind of ['project', 'workspace']) for (const outcome of ['keep', 'discard', 'failure', 'edited', 'new-draft']) {
    const ui = app('https://campaign.example/?view=inbox&project=a'), creation = deferred(), scoped = deferred(), created = { projectId: 'new', projects: [{ id: 'a' }, { id: 'new' }] };
    ui.setModal({ type: kind }); ui.syncModal(); if (outcome !== 'new-draft') ui.inboxDraftChanged(true);
    ui.api = async (path, method) => {
      ui.calls.push([path, method]);
      if (method === 'POST') return creation.promise;
      if (outcome === 'failure') throw new Error('Created project read failed');
      return path === '/state' ? { ...created, projectId: 'a' } : scoped.promise;
    };
    const saving = ui.saveEditor({ name: 'New team' });
    if (outcome === 'new-draft') ui.inboxDraftChanged(true);
    creation.resolve(kind === 'project' ? { project: { id: 'new' } } : { projectId: 'new' }); await saving;
    ui.syncModal(); assert.equal(ui.modalRef.current, null); assert.equal(ui.discardPrompt, true, 'Closing the saved creation modal must retain the switch confirmation.');
    assert.deepEqual(ui.calls, [[kind === 'project' ? '/projects' : '/workspaces', 'POST']]); assert.equal(ui.state.projectId, 'a'); assert.equal(ui.inboxDirty, true);
    if (outcome === 'keep') { ui.keepEditing(); assert.equal(ui.state.projectId, 'a'); assert.equal(ui.inboxDirty, true); continue; }
    ui.discardChanges(); await tick(); if (outcome === 'edited') ui.inboxDraftChanged(true); scoped.resolve(created); await tick();
    assert.equal(ui.state.projectId, ['failure', 'edited'].includes(outcome) ? 'a' : 'new'); assert.equal(ui.inboxDirty, ['failure', 'edited'].includes(outcome));
    if (outcome === 'failure') assert.equal(ui.error, 'Created project read failed');
    if (outcome === 'edited') assert.match(ui.error, /draft changed/);
  }
});


test('a terminal failed preflight releases its key even when the newly reviewed body is unchanged', async () => {
  const pendingKeys = { current: new Map() }, keys = []; let failed = true, sequence = 0;
  const invoke = new Function('state', 'activeProject', 'pendingKeys', 'crypto', 'api', 'endpoint', 'DOMException', `return (${stripTypeScriptTypes(declaration('integrate'))});`)(
    { projectId: 'a' }, { current: 'a' }, pendingKeys, { randomUUID: () => 'request-key-' + (++sequence) },
    async (_path, _method, _body, key) => { keys.push(key); if (failed) throw Object.assign(new Error('Preflight unavailable'), { status: 502, code: 'PROVIDER_UNAVAILABLE', operation: { status: 'failed' } }); return { operation: { status: 'complete' } }; }, path => path, DOMException,
  );
  const body = { version: 'unchanged-current-version', confirmDeactivate: true };
  await assert.rejects(invoke('products/shop/9001/deactivate', body), /Preflight unavailable/); assert.equal(pendingKeys.current.size, 0);
  failed = false; await invoke('products/shop/9001/deactivate', body);
  assert.notEqual(keys[0], keys[1], 'Explicit fresh review must not replay a terminal failed key when its provider version remains unchanged.');
});


test('main navigation reveals its current route after delayed sidebar mount, route changes and mobile reopening', () => {
  const selector = 'nav[aria-label="Main navigation"] [aria-current="page"]';
  const effect = source.split(/\r?\n/).find(line => line.includes('useEffect(() => { document.querySelector<HTMLElement>(\'nav[aria-label="Main navigation"]'));
  assert.ok(effect);
  assert.match(source, /<AppShell sidebarLabel="Campaign navigation" /); assert.match(source, /<SidebarNav label="Main navigation" /);
  assert.doesNotMatch(effect, /\.focus\(/);
  const calls = []; let dependencies, current = null;
  const useEffect = (callback, next) => {
    if (!dependencies || next.some((value, index) => !Object.is(value, dependencies[index]))) callback();
    dependencies = next;
  };
  const documentStub = { querySelector(query) { assert.equal(query, selector); return current; } };
  const render = new Function('useEffect', 'document', 'page', 'project', 'mobile', stripTypeScriptTypes(effect));
  const item = { scrollIntoView(options) { calls.push(options); }, focus() { assert.fail('Route reveal must not move focus'); } };
  render(useEffect, documentStub, 'Media providers', undefined, false); assert.equal(calls.length, 0, 'A deep link begins before the asynchronous sidebar mounts.');
  current = item;
  render(useEffect, documentStub, 'Media providers', { id: 'a' }, false); assert.equal(calls.length, 1, 'Loading the actual project reveals a same-route deep link.');
  render(useEffect, documentStub, 'Media providers', { id: 'a' }, false); assert.equal(calls.length, 1, 'Unrelated renders do not scroll.');
  render(useEffect, documentStub, 'Integrations', { id: 'a' }, false); assert.equal(calls.length, 2);
  render(useEffect, documentStub, 'Integrations', { id: 'a' }, true); assert.equal(calls.length, 3, 'Opening mobile navigation reveals the selected route again.');
  render(useEffect, documentStub, 'Integrations', { id: 'a' }, false);
  render(useEffect, documentStub, 'Integrations', { id: 'a' }, true); assert.equal(calls.length, 5, 'Reopening is not limited to the first mobile open.');
  render(useEffect, documentStub, 'Integrations', { id: 'b' }, true); assert.equal(calls.length, 6, 'A loaded project change remains a readiness transition.');
  current = null;
  render(useEffect, documentStub, 'Settings', { id: 'b' }, true); assert.equal(calls.length, 6, 'Nothing to reveal when no route is current.');
  for (const options of calls) assert.deepEqual(options, { block: 'nearest', inline: 'nearest' });
});
