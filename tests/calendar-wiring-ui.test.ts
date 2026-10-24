import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import * as ui from '@ten98/ui';
import { PLATFORM_RULES } from '../shared/social-posts.ts';
import { postScheduleEntries } from '../shared/post-schedule.ts';

type Row = { id: string; [key: string]: any };
type Node = { type?: unknown; props?: Record<string, any> } | null | undefined;

// The real agenda adapter, evaluated without its imports as the other calendar suites do.
const library = ui as unknown as Record<string, unknown>;
const agendaSource = await readFile(new URL('../src/PublishingAgenda.tsx', import.meta.url), 'utf8');
const agendaCode = (await transformWithOxc(agendaSource.replace(/^import .+;\r?\n/gm, '').replace('export default ', ''), 'PublishingAgenda.tsx', { jsx: { runtime: 'classic' } })).code;
const Agenda = new Function('React', 'PLATFORM_RULES', ...Object.keys(library), agendaCode + '; return CampaignPublishingAgenda;')(React, PLATFORM_RULES, ...Object.values(library));

// main.tsx's own calendar wiring: its calendar useState declarations and the agenda element on the Calendar page.
const app = (await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const declarations = app.match(/^ {2}const \[calendar\w*, setCalendar\w*\] = useState[^\n]+$/gm) || [];
const calendarPage = app.match(/^ +\{page === 'Calendar' && [^\n]+$/m)?.[0] || '';
const agendaElement = calendarPage.match(/<CampaignPublishingAgenda [\s\S]*?\/><\/Suspense>/)?.[0].slice(0, -'</Suspense>'.length) || '';
const elementCode = (await transformWithOxc(`const element = ${agendaElement};`, 'calendar-wiring.tsx', { jsx: { runtime: 'classic' } })).code;

// Renders the agenda with exactly the props main.tsx passes, from main.tsx's initial calendar state.
function wiredAgenda(state: { projectId: string; posts: Row[]; campaigns: Row[]; activations?: Row[] }) {
  const updates: Record<string, unknown[]> = {};
  const useState = (initial: unknown) => [typeof initial === 'function' ? (initial as () => unknown)() : initial, () => {}];
  const names = declarations.flatMap(line => [...line.matchAll(/\[(\w+), (\w+)\]/g)].flatMap(match => [match[1], match[2]]));
  const hooks: Record<string, unknown> = new Function('useState', 'React', 'CampaignPublishingAgenda', stripTypeScriptTypes(declarations.join('\n')) + `; return { ${names.join(', ')} };`)(useState, React, Agenda);
  for (const name of names.filter(name => name.startsWith('set'))) hooks[name] = (value: unknown) => (updates[name] ||= []).push(value);
  const calendarPosts = state.posts.flatMap(post => postScheduleEntries(post as any));
  const scope = { ...hooks, React, CampaignPublishingAgenda: Agenda, Inline: ui.Inline, Button: ui.Button, state, calendarPosts, calendarOverlay: [], remote: {}, canWrite: true, approvalSummary: null, approvalGate: () => null, postLabel: (post: Row) => post.content || 'Media post', setModal() {}, eventActions: () => null };
  const element: Node = new Function('scope', `with (scope) { ${elementCode}; return element; }`)(scope);
  return { element, updates };
}
const children = (node: Node): Node[] => node && typeof node === 'object' ? React.Children.toArray(node.props?.children) as Node[] : [];
const find = (node: Node, match: (node: NonNullable<Node>) => boolean): Node => { if (!node || typeof node !== 'object') return undefined; if (match(node)) return node; for (const child of children(node)) { const found = find(child, match); if (found) return found; } };
const render = (node: Node) => (node!.type as (props: unknown) => Node)(node!.props);
const today = (hour: number) => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour).toISOString(); };

test('the Calendar page wires the redesigned agenda props from main.tsx', () => {
  assert.ok(agendaElement, 'main.tsx renders CampaignPublishingAgenda on the Calendar page.');
  const { element } = wiredAgenda({ projectId: 'p1', posts: [], campaigns: [] });
  for (const prop of ['records', 'campaigns', 'weekStart', 'onWeekChange', 'filters', 'onFiltersChange']) assert.ok(Object.hasOwn(element!.props!, prop), prop);
  assert.match(calendarPage, /<Suspense fallback=\{<Stack[^>]*><Skeleton\/>[^\n]*<\/Stack>\}><CampaignPublishingAgenda /, 'The agenda loads behind library Skeleton rows.');
});

test('a published post with publishedAt and no scheduledAt reaches the calendar through main.tsx (#139)', () => {
  const post = { id: 'published', status: 'published', platforms: ['facebook'], content: 'Published caption', publishedAt: today(12) };
  assert.equal(postScheduleEntries(post).length, 0, 'The schedule entries alone skip a post with no scheduledAt.');
  const { element } = wiredAgenda({ projectId: 'p1', posts: [post], campaigns: [] });
  const markup = renderToStaticMarkup(element as React.ReactElement);
  assert.match(markup, /Published caption/, 'The post is placed on its publishedAt.');
  assert.match(markup, /<strong[^>]*>1<\/strong> published/, 'It counts as published.');
});

test('Week is the default calendar view, and week and filter changes go back to main.tsx state', () => {
  const { element, updates } = wiredAgenda({ projectId: 'p1', posts: [], campaigns: [{ id: 'c1', name: 'Autumn launch' }] });
  assert.equal(element!.props!.view, 'week');
  const control = find(render(element), node => node.type === ui.SegmentedControl);
  assert.equal(control?.props?.value, 'week');
  assert.deepEqual(control?.props?.options.map((option: { value: string }) => option.value), ['week', 'month', 'list']);
  element!.props!.onWeekChange('2099-10-26'); element!.props!.onFiltersChange({ campaign: 'c1' }); control!.props!.onValueChange('month');
  assert.deepEqual(Object.values(updates).flat(), ['2099-10-26', { campaign: 'c1' }, 'month']);
});

test('field activity reaches the calendar through main.tsx with no Google events loaded (#185)', () => {
  const activation = { id: 'road', name: 'Mall of the Emirates roadshow', type: 'roadshow', status: 'planned', location: 'Mall of the Emirates', startAt: today(10), endAt: today(16) };
  const { element } = wiredAgenda({ projectId: 'p1', posts: [], campaigns: [], activations: [activation] });
  assert.match(renderToStaticMarkup(element as React.ReactElement), /Field activity · Mall of the Emirates roadshow/);
});
