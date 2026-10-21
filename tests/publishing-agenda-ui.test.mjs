import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import * as ui from '@ten98/ui';
import { postScheduleEntries } from '../shared/post-schedule.ts';

const source = await readFile(new URL('../src/PublishingAgenda.tsx', import.meta.url), 'utf8');
const { code } = await transformWithOxc(source.replace(/^import .+;\r?\n/gm, '').replace('export default ', ''), 'PublishingAgenda.tsx', { jsx: { runtime: 'classic' } });
const { PublishingAgenda } = ui;
const Agenda = new Function('React', ...Object.keys(ui), code + '; return CampaignPublishingAgenda;')(React, ...Object.values(ui));
const appSource = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
const overlay = new Function(stripTypeScriptTypes(appSource.match(/^function calendarOverlayEvents\([^\r\n]+\}$/m)[0]) + '; return calendarOverlayEvents;')();
const postLabel = post => post.content || 'Media post';
const children = element => React.Children.toArray(element.props.children);

test('the month grid is gone and the publishing agenda is always rendered inside the Google Calendar page', async () => {
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.doesNotMatch(styles, /\.(?:calendar-panel|calendar-week|calendar-grid|calendar-day|calendar-post|day-number)\b/, 'No month-grid rules remain.');
  await assert.rejects(access(new URL('../src/publishing-agenda.css', import.meta.url)), 'The desktop-hiding agenda stylesheet is deleted.');
  assert.doesNotMatch(source, /\.css'/);
  assert.doesNotMatch(appSource, /calendar-panel|calendar-grid|day-number|Create post for /);
  const page = appSource.match(/\{page === 'Calendar' && [^\r\n]+/g);
  assert.equal(page.length, 1, 'The Calendar page is one agenda inside GoogleCalendar.');
  assert.match(page[0], /^\{page === 'Calendar' && <GoogleCalendar key=\{state\.projectId\}[^\r\n]*agenda=\{eventActions => <React\.Suspense[^\r\n]*<CampaignPublishingAgenda [^\r\n]*googleEventActions=\{eventActions\}/);
  for (const label of ['aria-label="Previous month"', '>Today<', 'aria-label="Next month"']) assert.ok(page[0].includes(label), label);
});

test('the real expanded schedules retain account captions, timezone instants, order, and original post click identity', () => {
  const originalTimezone = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const post = { id: 'post', status: 'scheduled', platforms: ['facebook'], content: 'Shared caption', scheduledAt: '2026-11-01T05:30:00Z', accounts: ['first', 'second'], accountOverrides: { second: { platform: 'facebook', content: 'Second caption', scheduledAt: '2026-11-01T10:30:00+04:00' } } };
    const previousDay = { ...post, id: 'previous-local-day', accounts: [], accountOverrides: {}, scheduledAt: '2026-11-01T03:30:00Z' };
    const selected = [], props = { posts: [...postScheduleEntries(post), ...postScheduleEntries(previousDay)], googleEvents: [], month: new Date(2026, 10, 1), accounts: [{ id: 'first', displayName: 'First account' }, { id: 'second', displayName: 'Second account' }], canWrite: true, postLabel, onSelect: item => selected.push(item) };
    const shared = children(Agenda(props))[0], entries = shared.props.entries;
    assert.equal(shared.type, PublishingAgenda);
    assert.equal(shared.props.timezoneLabel, 'America/New_York');
    assert.deepEqual(entries.map(entry => [entry.id, entry.title, entry.dateTime, entry.details]), [
      ['post:post:first', 'Shared caption', '2026-11-01T05:30:00Z', 'facebook · First account'],
      ['post:post:second', 'Second caption', '2026-11-01T10:30:00+04:00', 'facebook · Second account'],
    ]);
    assert.match(entries[0].when, /Nov 1, 01:30 AM EDT/);
    assert.match(entries[1].when, /Nov 1, 01:30 AM EST/);
    entries.forEach(entry => entry.actions.props.onClick());
    assert.ok(selected.every(item => item === post));
    assert.match(renderToStaticMarkup(Agenda(props)), /Second caption/);
  } finally { if (originalTimezone === undefined) delete process.env.TZ; else process.env.TZ = originalTimezone; }
});

test('verified Google copies stay deduplicated while cross-month all-day and unrelated events retain native boundaries', () => {
  const post = { id: 'post', content: 'Caption', scheduledAt: new Date(2026, 9, 15, 12).toISOString(), status: 'draft' }, posts = postScheduleEntries(post);
  const copy = { id: 'copy', managed: true, projectId: 'project', plan: { collection: 'posts', recordId: 'post' }, summary: 'Social · Caption', start: { dateTime: post.scheduledAt }, end: { dateTime: new Date(Date.parse(post.scheduledAt) + 1800000).toISOString() } };
  const events = [copy, { ...copy, id: 'manual', managed: false }, { id: 'all-day', summary: 'Carry over', start: { date: '2026-09-30' }, end: { date: '2026-10-02' } }, { id: 'expired', summary: 'Ends before month', start: { date: '2026-09-29' }, end: { date: '2026-10-01' } }, { id: 'next-month', summary: 'Later', start: { date: '2026-11-01' }, end: { date: '2026-11-02' } }];
  const component = Agenda({ posts, googleEvents: overlay(events, posts, 'project'), month: new Date(2026, 9, 1), canWrite: false, postLabel, onSelect() {} }), shared = children(component)[0];
  assert.deepEqual(shared.props.entries.map(entry => entry.id), ['google:all-day', 'post:post', 'google:manual']);
  assert.equal(shared.props.entries[0].when, '2026-09-30 – 2026-10-02');
  assert.equal(shared.props.entries[0].status, 'All day · End date exclusive');
  assert.equal(shared.props.entries[0].actions, undefined);
  assert.equal(shared.props.onSelect, undefined, 'Google records must not become dead selection buttons.');
  const html = renderToStaticMarkup(component);
  assert.match(html, /Read only/); assert.match(html, /View post/); assert.doesNotMatch(html, /Create post on date/);
  const empty = renderToStaticMarkup(Agenda({ posts: [], googleEvents: [], month: new Date(2026, 9, 1), canWrite: true, postLabel, onSelect() {} }));
  assert.match(empty, /No scheduled posts or loaded Google events this month/);
});

test('agenda creation forwards the chosen date to the native composer and resets the default with the month', () => {
  const dates = [], props = { posts: [], googleEvents: [], month: new Date(2026, 9, 1), canWrite: true, postLabel, onSelect() {}, onCreateDay: day => dates.push(day) };
  const form = children(Agenda(props))[1], input = children(children(form)[0])[0];
  assert.equal(form.props.as, 'form'); assert.equal(input.type, ui.Input); assert.equal(children(form)[1].props.type, 'submit');
  assert.equal(input.props.defaultValue, '2026-10-01');
  const NativeFormData = globalThis.FormData;
  try { globalThis.FormData = class { get(name) { assert.equal(name, 'day'); return '2026-10-27'; } }; form.props.onSubmit({ preventDefault() {}, currentTarget: {} }); }
  finally { globalThis.FormData = NativeFormData; }
  assert.deepEqual(dates, ['2026-10-27']);
  assert.notEqual(form.key, children(Agenda({ ...props, month: new Date(2026, 10, 1) }))[1].key);
});

test('Google entries carry the supplied event actions and month navigation reaches the shared agenda header', () => {
  const event = { id: 'google-a', summary: 'Launch', start: { dateTime: new Date(2026, 9, 3, 9).toISOString() }, end: { dateTime: new Date(2026, 9, 3, 10).toISOString() } }, seen = [];
  const navigation = React.createElement('span', null, 'Month navigation');
  const shared = children(Agenda({ posts: [], googleEvents: [event], month: new Date(2026, 9, 1), canWrite: true, postLabel, onSelect() {}, actions: navigation, googleEventActions: item => { seen.push(item); return 'Google actions'; } }))[0];
  assert.deepEqual(seen, [event]); assert.equal(shared.props.entries[0].actions, 'Google actions'); assert.equal(shared.props.actions, navigation);
  assert.match(renderToStaticMarkup(shared), /Month navigation[\s\S]*Google actions/);
});
