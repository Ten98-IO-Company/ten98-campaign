import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('the Calendar UI ignores stale month and unmounted responses and reloads after saving', async () => {
  const source = await readFile(new URL('../src/GoogleCalendar.tsx', import.meta.url), 'utf8');
  const loadSource = source.slice(source.indexOf('async function load()'), source.indexOf('  async function mapCalendar('));
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

  const saveSource = source.slice(source.indexOf('async function save('), source.indexOf('  function edit(')).replace('event: React.FormEvent<HTMLFormElement>', 'event');
  const calls = [], draft = { summary: 'Launch', description: '', allDay: true, start: '2026-11-01', end: '2026-11-02' };
  const save = new Function('action', 'draft', 'write', 'editing', 'setEditing', 'setDraft', 'blank', 'setNotice', 'load', `return (${saveSource});`)(run => run(), draft, async (path, method, body) => { calls.push({ path, method, body }); }, null, () => {}, () => {}, draft, () => {}, async () => { calls.push('reload'); });
  await save({ preventDefault() {} });
  assert.deepEqual(calls, [{ path: 'events', method: 'POST', body: draft }, 'reload']);
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

test('an agent history refresh failure preserves the uncertain paid request error and retry key', async () => {
  const source = await readFile(new URL('../src/CampaignAgent.tsx', import.meta.url), 'utf8');
  const sendSource = source.slice(source.indexOf('async function send('), source.indexOf('  return <div')).replace('event: React.FormEvent', 'event').replace('key.current!.value', 'key.current.value').replace('error as any', 'error');
  const failure = Object.assign(new Error('Review OpenRouter usage before retrying.'), { status: 409, run: { status: 'uncertain' } }), key = { current: null }, input = { message: 'Plan a launch' };
  const send = new Function('message', 'key', 'crypto', 'run', 'request', 'path', 'active', 'setRuns', 'setMessage', 'history', `return (${sendSource});`)(input.message, key, { randomUUID: () => 'original-paid-request-key' }, action => action(), async () => { throw failure; }, '/projects/a/agent', { current: true }, () => {}, () => {}, async () => { throw new Error('History could not be loaded.'); });
  await assert.rejects(send({ preventDefault() {} }), error => error === failure);
  assert.deepEqual(key.current, { input: JSON.stringify(input), value: 'original-paid-request-key' });
});
