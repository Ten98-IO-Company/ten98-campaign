import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import * as ui from '@ten98/ui';
import { approvalGate as gate, readableApprovalSummary } from '../src/approval-status.ts';

const app = (await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const summary = (statuses, requireApproval = true) => ({ requireApproval, pending: Object.values(statuses).filter(value => value === 'pending').length, statuses });

test('publishing follows the server approval rule only when the project requires approval', () => {
  assert.equal(gate(summary({ post: 'pending' }, false), 'post'), null, 'Without required approval the card keeps its existing actions.');
  assert.equal(gate(null, 'post'), null, 'An unreadable summary falls back to letting the server decide.');
  assert.deepEqual(gate(summary({ post: 'approved' }), 'post'), { status: 'approved', label: 'Approved', publishable: true, reason: '' });
  for (const [status, label, reason] of [['pending', 'Awaiting approval', /waiting for an owner or administrator/], ['rejected', 'Changes requested', /Changes were requested/], ['stale', 'Changed since approval', /changed after it was approved/], ['not_requested', 'Approval not requested', /requires approval before publishing/]]) {
    const result = gate(summary({ post: status }), 'post'); assert.equal(result.publishable, false, status); assert.equal(result.label, label); assert.match(result.reason, reason);
  }
  assert.equal(gate(summary({}), 'new-post').status, 'not_requested', 'A post the summary does not know yet is not publishable until the summary refreshes.');
});

test('the summary loader keeps the project guard and treats unreadable or failed reads as unavailable', async () => {
  const start = app.indexOf('async function loadApprovalSummary('), body = app.slice(start, app.indexOf('\n  useEffect(', start));
  assert.ok(start > 0);
  async function load(response, changeProject = false) {
    const accepted = [], calls = [], activeProject = { current: 'project-a' };
    const api = async path => { calls.push(path); if (changeProject) activeProject.current = 'project-b'; if (response instanceof Error) throw response; return response; };
    await new Function('api', 'activeProject', 'setApprovalSummary', 'readableApprovalSummary', `return (${stripTypeScriptTypes(body)});`)(api, activeProject, value => accepted.push(value), readableApprovalSummary)('project-a');
    return { accepted, calls };
  }
  const valid = summary({ one: 'pending', two: 'approved' });
  assert.deepEqual(await load(valid), { accepted: [valid], calls: ['/projects/project-a/approvals/summary'] });
  for (const malformed of [{}, { requireApproval: 'yes', pending: 0, statuses: {} }, { requireApproval: true, pending: -1, statuses: {} }, { requireApproval: true, pending: 0, statuses: [] }]) assert.deepEqual((await load(malformed)).accepted, [null]);
  assert.deepEqual((await load(new Error('Summary unavailable'))).accepted, [null], 'A failed read does not block the UI; the server still decides.');
  assert.deepEqual((await load(valid, true)).accepted, [], 'A response for a project the user left is ignored.');
  for (const failed of [true, false]) assert.deepEqual((await load(failed ? new Error('Late failure') : valid, true)).accepted, []);
});

test('the sidebar, post cards and agenda consume the loaded summary without their own reads', () => {
  assert.match(app, /useEffect\(\(\) => \{ setApprovalSummary\(null\); \}, \[state\?\.projectId\]\);/, 'Switching projects clears the previous project summary.');
  assert.match(app, /useEffect\(\(\) => \{ if \(state\?\.projectId\) void loadApprovalSummary\(state\.projectId\); \}, \[state\]\);/, 'Every reload, including after approval changes, refreshes the summary.');
  assert.match(app, /p\.label === 'Approvals' && approvalSummary\?\.pending \? \{ badge: approvalSummary\.pending, badgeLabel: /);
  assert.match(app, /title=\{!connected \? 'Connect Zernio in Settings' : ''\} onClick=\{\(\) => setPublishing\(p\)\}>/, 'An approved post keeps the unchanged publish confirmation.');
  assert.match(app, /approvalGate\(approvalSummary, p\.id\)/); assert.match(app, />Open approvals<\/Button>/);
  assert.match(app, /<CampaignPublishingAgenda posts=\{calendarPosts\} googleEvents=\{calendarOverlay\}[^\r\n]*postApprovals=\{approvalSummary\?\.requireApproval \? Object\.fromEntries\(Object\.keys\(approvalSummary\.statuses\)\.map\(id => \[id, approvalGate\(approvalSummary, id\)!\.label\]\)\) : undefined\}/);
});

test('agenda list and month grid entries name the approval status only when it is supplied', async () => {
  const source = await readFile(new URL('../src/PublishingAgenda.tsx', import.meta.url), 'utf8');
  const { code } = await transformWithOxc(source.replace(/^import .+;\r?\n/gm, '').replace('export default ', ''), 'PublishingAgenda.tsx', { jsx: { runtime: 'classic' } });
  const Agenda = new Function('React', ...Object.keys(ui), code + '; return CampaignPublishingAgenda;')(React, ...Object.values(ui));
  const month = new Date(2026, 10, 1), post = { id: 'post', status: 'scheduled', content: 'Launch' };
  const props = { posts: [{ id: 'post', post, content: 'Launch', scheduledAt: new Date(2026, 10, 3, 9).toISOString() }], googleEvents: [], month, canWrite: true, postLabel: row => row.content, onSelect() {} };
  const list = renderToStaticMarkup(React.createElement(Agenda, { ...props, postApprovals: { post: 'Changed since approval' } }));
  assert.match(list, /scheduled · Changed since approval/);
  const grid = renderToStaticMarkup(React.createElement(Agenda, { ...props, view: 'month', onMonthChange() {}, postApprovals: { post: 'Awaiting approval' } }));
  assert.match(grid, /Launch · Awaiting approval/);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(Agenda, props)), /approval/i, 'Without required approval nothing extra is shown.');
});
