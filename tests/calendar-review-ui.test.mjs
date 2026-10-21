import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import * as ui from '@ten98/ui';

const { ReviewSummary } = ui;

const source = await readFile(new URL('../src/GoogleCalendar.tsx', import.meta.url), 'utf8');
const { code } = await transformWithOxc(source.replace(/^import .*;\r?$/gm, '').replace('export default function', 'function'), 'GoogleCalendar.tsx', { jsx: { runtime: 'classic' } });
const elements = node => Array.isArray(node) ? node.flatMap(elements) : React.isValidElement(node) ? [node, ...elements(node.props.children), ...elements(node.props.actions)] : [];

test('Calendar shared review renders exact plan changes and keeps current, stale and uncertain fingerprint submission guards', async () => {
  const projectId = 'project / exact', calendarId = 'shared@example.test', path = '/projects/project%20%2F%20exact/calendar';
  const plan = { fingerprint: 'a'.repeat(64), projectId, calendarId, upserts: [
    { id: 'create-exact', action: 'create', summary: 'New campaign', description: 'First line\nExact proposed detail', start: { date: '2030-01-01' }, end: { date: '2030-01-04' } },
    { id: 'update-exact', action: 'update', summary: 'Updated campaign', start: { date: '2030-02-01' }, end: { date: '2030-02-03' } }
  ], deletions: [{ id: 'delete-exact', summary: 'Obsolete campaign', start: { date: '2029-12-01' }, end: { date: '2029-12-04' } }] };
  const draft = { summary: 'Unsaved manual event', description: '', start: '2030-01-01T12:00', end: '2030-01-01T13:00', allDay: false, etag: '', calendarId: '' };
  const states = [{ configured: true, mapped: true, calendarId }, [], false, '2030-01-01', '2030-01-31', false, '', '', null, null, null, draft], refs = [], calls = [];
  let stateIndex, refIndex, uncertain = true;
  const request = async (target, method, body, key) => {
    calls.push({ target, method, body, key });
    if (target.endsWith('/plan')) return structuredClone(plan);
    if (target.endsWith('/sync')) {
      if (uncertain) throw Object.assign(new Error('The campaign plan changed. Review it again before publishing.'), { status: 409, code: 'OPERATION_UNCERTAIN' });
      return { created: 1, updated: 1, deleted: 1 };
    }
    if (target.includes('/events?')) return { events: [] };
    throw new Error('Unexpected synthetic request: ' + target);
  };
  const Component = new Function('React', 'useEffect', 'useRef', 'useState', ...Object.keys(ui), code + '; return GoogleCalendar;')(React, () => {}, initial => { const index = refIndex++; return refs[index] ||= { current: initial }; }, initial => { const index = stateIndex++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; }, ...Object.values(ui));
  function render(extra = {}) { stateIndex = 0; refIndex = 0; return Component({ projectId, isOperator: true, canWrite: true, request, ...extra }); }
  const button = (tree, label) => elements(tree).find(node => node.type === ui.Button && node.props.children === label);
  const preview = async () => button(render(), 'Review campaign plan for Google').props.onClick();
  await preview();
  assert.equal(calls.filter(call => call.method === 'POST').length, 0, 'Previewing never writes to Google.');
  let tree = render();
  const review = elements(tree).find(node => node.type === ReviewSummary), html = renderToStaticMarkup(review);
  assert.ok(review, 'The actual calendar review must use the installed shared component.');
  for (const detail of ['t98-review-summary', 'Proposed changes', `Project: ${projectId}`, `Shared calendar: ${calendarId}`, '2 planned events to create or update; 1 obsolete app-managed plan events to delete.', 'Create · New campaign', 'Update · Updated campaign', 'First line\nExact proposed detail', 'Previous fields were not included in this preview.', 'Obsolete campaign', 'Event ID: delete-exact', '2029-12-01', '2029-12-04', '2030-01-01', '2030-01-04', '2030-02-01', '2030-02-03', 'Manually created and unrelated events are excluded.', 'Calendar events do not publish social posts.']) assert.ok(html.includes(detail), detail);
  const publishLabel = 'Publish reviewed plan and delete listed obsolete events';
  await button(tree, publishLabel).props.onClick();
  await button(render(), publishLabel).props.onClick();
  const writes = () => calls.filter(call => call.method === 'POST');
  assert.equal(writes().length, 2); assert.equal(writes()[0].key, writes()[1].key, 'Uncertain retries retain the original operation identity.');
  assert.deepEqual(writes()[0], { target: path + '/sync', method: 'POST', body: { planFingerprint: 'a'.repeat(64) }, key: writes()[0].key });
  assert.match(renderToStaticMarkup(render()), /role="alert"[^>]*>(?:<svg[\s\S]*?<\/svg>)?(?:<div[^>]*>)*The campaign plan changed/);
  plan.fingerprint = 'b'.repeat(64); uncertain = false; await preview();
  tree = render(); const stalePublish = button(tree, publishLabel);
  states[3] = '2030-02-01'; assert.equal(elements(render()).filter(node => node.type === ReviewSummary).length, 0);
  await stalePublish.props.onClick(); assert.equal(writes().length, 2, 'A handler retained from an old month cannot write.');
  states[3] = '2030-01-01'; states[0] = { ...states[0], calendarId: 'different@example.test' };
  await button(render(), publishLabel).props.onClick(); assert.equal(writes().length, 2, 'A changed mapping cannot publish the reviewed calendar.');
  states[0] = { ...states[0], calendarId }; states[5] = true;
  assert.equal(button(render(), publishLabel).props.disabled, true); await button(render(), publishLabel).props.onClick(); assert.equal(writes().length, 2);
  states[5] = false;
  assert.equal(elements(render({ canWrite: false })).filter(node => node.type === ReviewSummary).length, 0);
  assert.equal(button(render({ canWrite: false }), publishLabel), undefined);
  states[0] = { configured: false, mapped: false }; assert.equal(elements(render()).filter(node => node.type === ReviewSummary).length, 0);
  states[0] = { configured: true, mapped: true, calendarId };
  await button(render(), publishLabel).props.onClick();
  assert.deepEqual(writes().at(-1).body, { planFingerprint: 'b'.repeat(64) }); assert.notEqual(writes().at(-1).key, writes()[0].key);
  assert.equal(states[9], null); assert.match(states[7], /1 events created, 1 updated, 1 obsolete app events removed/);
  assert.equal(states[11], draft, 'Review and sync must preserve the manual event draft.');
  await preview(); button(render(), 'Cancel review').props.onClick(); assert.equal(states[9], null); assert.equal(states[11], draft);
  plan.upserts = []; plan.deletions = []; await preview();
  tree = render();
  assert.match(renderToStaticMarkup(tree), /0 planned events to create or update; 0 obsolete app-managed plan events to delete\./);
  assert.match(renderToStaticMarkup(tree), /No changes to review\./);
  assert.ok(button(tree, 'Publish reviewed plan to Google')); assert.equal(button(tree, publishLabel), undefined);
});
