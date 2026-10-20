import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

test('the Calendar UI ignores stale month and unmounted responses and reloads after saving', async () => {
  const source = await readFile(new URL('../src/GoogleCalendar.tsx', import.meta.url), 'utf8');
  const loadSource = source.slice(source.indexOf('async function load()'), source.indexOf('  async function save('));
  const pending = [], accepted = [], loaded = [], scope = { current: 'october' }, active = { current: true };
  function calendar(view, from, to) {
    return new Function('request', 'path', 'from', 'to', 'active', 'scope', 'view', 'updateEvents', 'setLoaded', `return (${loadSource});`)(() => new Promise((resolve, reject) => pending.push({ resolve, reject })), '/projects/a/calendar', from, to, active, scope, view, value => accepted.push(value), value => loaded.push(value));
  }
  const october = calendar('october', '2026-10-01', '2026-10-31'), first = october();
  scope.current = 'november'; const november = calendar('november', '2026-11-01', '2026-11-30'), second = november();
  pending[1].resolve({ events: [{ id: 'november-event' }] }); await second;
  pending[0].resolve({ events: [{ id: 'old-october-event' }] }); await first;
  assert.deepEqual(accepted, [[{ id: 'november-event' }]]); assert.deepEqual(loaded, [true]);
  await october(); assert.equal(pending.length, 2, 'A write finishing in an old view must not load its previous month.');
  const third = november(); active.current = false; pending[2].resolve({ events: [{ id: 'old-project-event' }] }); await third;
  assert.equal(accepted.length, 1, 'An unmounted calendar must not overwrite the parent grid.');

  const saveSource = stripTypeScriptTypes(source.slice(source.indexOf('async function save('), source.indexOf('  async function reviewPlan(')));
  const calls = [], draft = { summary: 'Launch', description: '', allDay: true, start: '2026-11-01', end: '2026-11-02', etag: 'old-editor-revision', calendarId: 'old-calendar@example.test' };
  const save = new Function('action', 'draft', 'write', 'editing', 'setEditing', 'setDraft', 'blank', 'setNotice', 'load', `return (${saveSource});`)(run => run(), draft, async (path, method, body) => { calls.push({ path, method, body }); }, null, () => {}, () => {}, draft, () => {}, async () => { calls.push('reload'); });
  await save({ preventDefault() {} });
  assert.deepEqual(calls, [{ path: 'events', method: 'POST', body: { summary: 'Launch', description: '', allDay: true, start: '2026-11-01', end: '2026-11-02' } }, 'reload'], 'Creating a manual event must not send an old edit revision or calendar snapshot.');
});

test('Calendar deletion sends the selected revision and calendar even after the event list refreshes', async () => {
  const source = await readFile(new URL('../src/GoogleCalendar.tsx', import.meta.url), 'utf8');
  const selectSource = source.match(/onClick=\{(\(\) => setDeleting\(.+?\))\}>Delete<\/button>/)?.[1];
  assert.ok(selectSource, 'The event delete control must select an event for confirmation.');
  const removeSource = stripTypeScriptTypes(source.slice(source.indexOf('async function removeEvent('), source.indexOf('  function edit(')));
  const writeSource = stripTypeScriptTypes(source.slice(source.indexOf('async function write('), source.indexOf('  async function load(')));
  const event = { id: 'launch / reviewed', etag: 'reviewed-version', summary: 'Reviewed launch', start: { date: '2026-11-01' }, end: { date: '2026-11-02' } }, status = { calendarId: 'reviewed@example.test' };
  let deleting;
  new Function('event', 'status', 'setDeleting', `return (${selectSource});`)(event, status, value => { deleting = value; })();
  const refreshed = { ...event, etag: 'new-provider-version', summary: 'Changed elsewhere' }, unrelated = { id: 'keep-me' }, requests = [], changes = {};
  status.calendarId = 'new-mapping@example.test';
  const context = { path: '/projects/a/calendar', keys: { current: new Map() }, active: { current: true }, scope: { current: 'november' }, view: 'november', request: async (...args) => { requests.push(args); return {}; } };
  const write = new Function(...Object.keys(context), `return (${writeSource});`)(...Object.values(context));
  const dependencies = { canWrite: true, deleting, action: run => run(), write, events: [refreshed, unrelated], updateEvents: value => { changes.events = value; }, editing: event.id, setEditing: value => { changes.editing = value; }, setDraft: value => { changes.draft = value; }, blank: { summary: '' }, setDeleting: value => { changes.deleting = value; }, setNotice: value => { changes.notice = value; } };
  await new Function(...Object.keys(dependencies), `return (${removeSource});`)(...Object.values(dependencies))();
  assert.deepEqual(requests[0].slice(0, 3), ['/projects/a/calendar/events/launch%20%2F%20reviewed', 'DELETE', { etag: 'reviewed-version', calendarId: 'reviewed@example.test' }], 'Refreshing rows must not silently approve the newer provider revision.');
  assert.equal(requests.length, 1);
  assert.deepEqual(changes, { events: [unrelated], editing: null, draft: { summary: '' }, deleting: null, notice: 'Google Calendar event deleted.' });
});

test('Calendar edit saves the revision and calendar captured when editing began', async () => {
  const source = await readFile(new URL('../src/GoogleCalendar.tsx', import.meta.url), 'utf8');
  const editSource = stripTypeScriptTypes(source.slice(source.indexOf('function edit('), source.indexOf('  function when(')));
  const saveSource = stripTypeScriptTypes(source.slice(source.indexOf('async function save('), source.indexOf('  async function reviewPlan(')));
  const event = { id: 'launch / edit', etag: 'reviewed-edit-version', summary: 'Launch', start: { date: '2026-11-01' }, end: { date: '2026-11-02' } }, status = { calendarId: 'reviewed@example.test' }, calls = [];
  let editing, draft;
  const edit = new Function('status', 'setEditing', 'setDraft', `return (${editSource});`)(status, value => { editing = value; }, value => { draft = value; });
  edit(event); event.etag = 'new-provider-version'; status.calendarId = 'new-mapping@example.test'; draft.summary = 'Edited launch';
  const dependencies = { action: run => run(), draft, write: async (...args) => calls.push(args), editing, setEditing() {}, setDraft() {}, blank: {}, setNotice() {}, load: async () => calls.push('reload') };
  await new Function(...Object.keys(dependencies), `return (${saveSource});`)(...Object.values(dependencies))({ preventDefault() {} });
  assert.deepEqual(calls, [['events/launch%20%2F%20edit', 'PATCH', { summary: 'Edited launch', description: '', allDay: true, start: '2026-11-01', end: '2026-11-02', etag: 'reviewed-edit-version', calendarId: 'reviewed@example.test' }], 'reload']);
});

test('Calendar delete handlers cannot write from a stale view, unmounted page or read-only role', async () => {
  const source = await readFile(new URL('../src/GoogleCalendar.tsx', import.meta.url), 'utf8');
  const removeSource = stripTypeScriptTypes(source.slice(source.indexOf('async function removeEvent('), source.indexOf('  function edit(')));
  const writeSource = stripTypeScriptTypes(source.slice(source.indexOf('async function write('), source.indexOf('  async function load(')));
  for (const blocked of ['stale-view', 'unmounted', 'read-only', 'unselected']) {
    const requests = [], changes = [], context = { path: '/projects/a/calendar', keys: { current: new Map() }, active: { current: blocked !== 'unmounted' }, scope: { current: blocked === 'stale-view' ? 'december' : 'november' }, view: 'november', request: async (...args) => requests.push(args) };
    const write = new Function(...Object.keys(context), `return (${writeSource});`)(...Object.values(context));
    const dependencies = { canWrite: blocked !== 'read-only', deleting: blocked === 'unselected' ? null : { id: 'reviewed', etag: 'version', calendarId: 'shared@example.test' }, action: run => run(), write, events: [], updateEvents: value => changes.push(value), editing: null, setEditing: value => changes.push(value), setDraft: value => changes.push(value), blank: {}, setDeleting: value => changes.push(value), setNotice: value => changes.push(value) };
    const pending = new Function(...Object.keys(dependencies), `return (${removeSource});`)(...Object.values(dependencies))();
    if (blocked === 'stale-view' || blocked === 'unmounted') await assert.rejects(pending, { name: 'AbortError' }); else await pending;
    assert.deepEqual(requests, [], `${blocked} must not issue a delete request.`); assert.deepEqual(changes, [], `${blocked} must not clear the current selection or rows.`); assert.equal(context.keys.current.size, 0);
  }
});

test('a delayed calendar status response preserves integration mapping edits', async () => {
  const source = await readFile(new URL('../src/IntegrationSettings.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('request(`/projects/${project.id}/calendar/status`).then(') + 'request(`/projects/${project.id}/calendar/status`).then('.length;
  const callback = source.slice(start, source.indexOf(').catch', start));
  let mapping = { zernioProfileId: 'new-profile', driveFolderId: 'new-folder', calendarId: '' }, loaded = false;
  const accept = new Function('current', 'setMapping', 'setCalendarLoaded', `return (${callback});`)(true, value => { mapping = typeof value === 'function' ? value(mapping) : value; }, value => { loaded = value; });
  accept({ calendarId: 'shared@example.test' });
  assert.deepEqual(mapping, { zernioProfileId: 'new-profile', driveFolderId: 'new-folder', calendarId: 'shared@example.test' }); assert.equal(loaded, true);
});

test('calendar writes finishing in a departed month or closed page do not continue changing the current view', async () => {
  const source = await readFile(new URL('../src/GoogleCalendar.tsx', import.meta.url), 'utf8');
  const handler = stripTypeScriptTypes(source.slice(source.indexOf('async function write('), source.indexOf('  async function load(')));
  for (const stale of ['month', 'unmounted']) {
    let finish; const calls = [], keys = { current: new Map() }, active = { current: true }, scope = { current: 'october' };
    const write = new Function('path', 'keys', 'request', 'active', 'scope', 'view', `return (${handler});`)('/projects/a/calendar', keys, (...args) => { calls.push(args); return new Promise(resolve => { finish = resolve; }); }, active, scope, 'october');
    let changed = false;
    const pending = write('events/october-event', 'DELETE').then(() => { changed = true; });
    if (stale === 'month') scope.current = 'november'; else active.current = false;
    finish({}); await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(changed, false, 'A completed old write must not publish October events or reset a newer form.');
    assert.equal(keys.current.size, 0, 'The confirmed mutation must release its idempotency key.');
    await assert.rejects(write('sync', 'POST', {}), { name: 'AbortError' });
    assert.equal(calls.length, 1, 'A stale continuation must not issue another provider write.');
  }
  const updateSource = stripTypeScriptTypes(source.match(/  function updateEvents\([^\n]+/)[0].trim());
  const parent = [], local = [], active = { current: true }, scope = { current: 'november' };
  const update = new Function('active', 'scope', 'view', 'setEvents', 'callback', `return (${updateSource});`)(active, scope, 'october', rows => local.push(rows), { current: rows => parent.push(rows) });
  update([{ id: 'old-october-event' }]);
  scope.current = 'october'; active.current = false; update([]);
  assert.deepEqual(parent, [], 'A late calendar mapping callback must not clear a newly mounted calendar.'); assert.deepEqual(local, []);
  active.current = true; update([{ id: 'current-event' }]); assert.deepEqual(parent, [[{ id: 'current-event' }]]);
});

test('team changes completing after Settings closes cannot reload a different page or fetch the old workspace', async () => {
  const source = await readFile(new URL('../src/TeamPanel.tsx', import.meta.url), 'utf8');
  const handler = stripTypeScriptTypes(source.slice(source.indexOf('async function change('), source.indexOf('  async function add(')));
  for (const userId of ['self', 'colleague']) {
    let finish, refreshed = false, reloaded = false;
    const active = { current: true }, context = { busy: false, canManage: true, active, setBusy() {}, setError() {}, request: () => new Promise(resolve => { finish = resolve; }), path: '/workspaces/old/members', currentUserId: 'self', window: { location: { reload() { reloaded = true; } } }, load: async () => { refreshed = true; } };
    const change = new Function(...Object.keys(context), `return (${handler});`)(...Object.values(context));
    const pending = change('PATCH', { userId }, { role: 'viewer' }); active.current = false; finish({}); await pending;
    assert.equal(reloaded, false); assert.equal(refreshed, false);
  }
});

test('an agent history refresh failure preserves the uncertain paid request error and retry key', async () => {
  const source = await readFile(new URL('../src/CampaignAgent.tsx', import.meta.url), 'utf8');
  const sendSource = source.slice(source.indexOf('async function send('), source.indexOf('  async function applyDraft(')).replace('event: React.FormEvent', 'event').replace('key.current!.value', 'key.current.value').replace('error as any', 'error');
  const failure = Object.assign(new Error('Review OpenRouter usage before retrying.'), { status: 409, run: { status: 'uncertain' } }), key = { current: null }, input = { message: 'Plan a launch' };
  const send = new Function('message', 'key', 'crypto', 'run', 'request', 'path', 'active', 'setRuns', 'setMessage', 'history', `return (${sendSource});`)(input.message, key, { randomUUID: () => 'original-paid-request-key' }, action => action(), async () => { throw failure; }, '/projects/a/agent', { current: true }, () => {}, () => {}, async () => { throw new Error('History could not be loaded.'); });
  await assert.rejects(send({ preventDefault() {} }), error => error === failure);
  assert.deepEqual(key.current, { input: JSON.stringify(input), value: 'original-paid-request-key' });
});
