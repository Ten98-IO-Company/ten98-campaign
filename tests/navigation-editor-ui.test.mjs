import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const source = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
const routes = source.slice(source.indexOf('const pageRoutes:'), source.indexOf('const pages:'));
const { readNavigation, navigationUrl, editorValues, pageRoutes, pageSections } = new Function(stripTypeScriptTypes(routes) + '; return {readNavigation, navigationUrl, editorValues, pageRoutes, pageSections};')();
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
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
  const dialog = { contains: () => true, querySelectorAll: () => [] }, context = {
    window, document: { activeElement: null }, pageSections, navigationUrl, readNavigation, editorValues, DOMException, setTimeout,
    state: initial, navigationRef: { current: readNavigation(window.location.search) }, historyIndex: { current: 0 }, restoringPop: { current: null },
    modalRef: { current: null }, dialogRef: { current: dialog }, draftDirty: false, discardPrompt: false, discardAction: { current: null }, dirtyScopes: { current: new Map() },
    loadVersion: { current: 0 }, activeProject: { current: initial?.projectId || '' }, error: '', calls: [],
    api: async path => { context.calls.push(path); return stateFor(path.includes('projectId=b') ? 'b' : 'a'); },
    setState: value => { context.state = value; }, setNavigation: value => { context.navigation = value; }, setLoading: value => { context.loading = value; },
    setDraftDirty: value => { context.draftDirty = value; }, setDiscardPrompt: value => { context.discardPrompt = value; }, setModal: value => { context.modalRef.current = value; }, setError: value => { context.error = value; }, setNotice: value => { context.notice = value; },
    run: async work => { try { return await work(); } catch (error) { if (error.name !== 'AbortError') context.error = error.message; } },
  };
  const invoke = (name, ...args) => new Function(...Object.keys(context), `return (${stripTypeScriptTypes(declaration(name))});`)(...Object.values(context))(...args);
  for (const name of ['writeNavigation', 'reload', 'leaveEditor', 'closeEditor', 'keepEditing', 'discardChanges', 'cancelEditor', 'navigate', 'setPage', 'changeProject', 'markEditorDirty', 'editorSaved', 'watchEditorButtons']) context[name] = (...args) => invoke(name, ...args);
  const popStart = source.indexOf('    const onPop = () =>'), popEnd = source.indexOf('\n  }, [state, draftDirty]);', popStart);
  context.listen = () => new Function(...Object.keys(context), `return (${stripTypeScriptTypes('function listen(){' + source.slice(popStart, popEnd) + '}')})();`)(...Object.values(context));
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
