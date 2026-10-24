import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import * as ui from '@ten98/ui';
import { PLATFORM_RULES } from '../shared/social-posts.ts';

type Node = { type?: unknown; key?: unknown; props?: Record<string, any> } | null | undefined;

// Evaluate Campaign's real agenda adapter (no hooks) the same way publishing-agenda-ui.test.mjs does.
const source = await readFile(new URL('../src/PublishingAgenda.tsx', import.meta.url), 'utf8');
const { code } = await transformWithOxc(source.replace(/^import .+;\r?\n/gm, '').replace('export default ', ''), 'PublishingAgenda.tsx', { jsx: { runtime: 'classic' } });
const library = ui as unknown as Record<string, unknown>;
const Agenda: (props: Record<string, unknown>) => Node = new Function('React', 'PLATFORM_RULES', ...Object.keys(library), code + '; return CampaignPublishingAgenda;')(React, PLATFORM_RULES, ...Object.values(library));
const html = (props: Record<string, unknown>) => renderToStaticMarkup(React.createElement(Agenda as any, props));
const children = (node: Node): Node[] => node && typeof node === 'object' ? React.Children.toArray(node.props?.children) as Node[] : [];
const findAll = (node: Node, match: (node: NonNullable<Node>) => boolean, found: NonNullable<Node>[] = []) => { if (!node || typeof node !== 'object') return found; if (match(node)) found.push(node); for (const child of children(node)) findAll(child, match, found); return found; };
const find = (node: Node, match: (node: NonNullable<Node>) => boolean) => findAll(node, match)[0];
const ofType = (type: unknown) => (node: NonNullable<Node>) => node.type === type;
const text = (node: Node): string => node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node) : children(node).map(text).join(' ');
const at = (day: number, hour: number, month = 9) => new Date(2099, month, day, hour).toISOString();
// Fixtures are submitted to the provider (externalId) unless a test says otherwise.
const entry = (id: string, scheduledAt: string, extra: Record<string, unknown> = {}) => { const post = { id, status: 'scheduled', externalId: 'remote-' + id, content: id + ' caption', ...extra }; return { id, post, platform: 'facebook', content: post.content, scheduledAt }; };
const base = { googleEvents: [], month: new Date(2099, 9, 1), canWrite: true, postLabel: (post: { content?: string }) => post.content || 'Media post', onSelect() {} };
const days = (element: Node) => findAll(element, node => node.props?.role === 'group' && node.props?.tabIndex === 0);
const key = (element: NonNullable<Node>, keyName: string, target?: object) => { let prevented = false; const currentTarget = {}; element.props!.onKeyDown({ key: keyName, target: target ?? currentTarget, currentTarget, preventDefault() { prevented = true; } }); return prevented; };

test('the week view lists the seven days of the chosen week, including days in the next month, with rich entries', () => {
  const posts = [entry('monday', at(26, 9)), entry('sunday', at(1, 18, 10), { platform: 'instagram' }), entry('outside', at(2, 9, 10))];
  posts[1].platform = 'instagram';
  const element = Agenda({ ...base, posts, view: 'week', weekStart: '2099-10-26' }), sections = days(element);
  assert.equal(sections.length, 7, 'One focusable group per day, Monday first.');
  assert.match(String(sections[0].props!['aria-label']), /^Monday, October 26, 2099, 1 entry$/);
  assert.match(String(sections[6].props!['aria-label']), /^Sunday, November 1, 2099, 1 entry$/);
  const markup = html({ ...base, posts, view: 'week', weekStart: '2099-10-26' });
  assert.match(markup, /Oct 26 – Nov 1, 2099/, 'The header names the range.');
  assert.ok(markup.includes(Intl.DateTimeFormat().resolvedOptions().timeZone), 'The header names the timezone once.');
  assert.doesNotMatch(markup, /outside caption/, 'Posts outside the week are not listed.');
  const button = find(sections[0], node => node.type === ui.Button)!;
  assert.match(text(button), /Facebook[\s\S]*monday caption[\s\S]*Scheduled/, 'An entry shows its network, snippet and status in its accessible name.');
  assert.match(text(find(sections[6], node => node.type === ui.Button)), /Instagram/);
});

test('week entries carry a status tone, approval state and a campaign colour, and open the original post', () => {
  const selected: unknown[] = [];
  const posts = [entry('draft', at(26, 9), { status: 'draft' }), entry('failed', at(27, 9), { status: 'failed' }), entry('waiting', at(28, 9), { campaignId: 'c1' }), entry('approved', at(29, 9))];
  const element = Agenda({ ...base, posts, view: 'week', weekStart: '2099-10-26', campaigns: [{ id: 'c1', name: 'Autumn launch' }], postApprovals: { waiting: 'Awaiting approval', approved: 'Approved' }, onSelect: (post: unknown) => selected.push(post) });
  const badges = findAll(element, node => node.type === ui.Badge && Boolean(node.props?.dot));
  assert.deepEqual(badges.map(badge => [text(badge), badge.props!.tone]), [['Draft · Approval not requested', 'neutral'], ['Failed · Approval not requested', 'danger'], ['Scheduled · Awaiting approval', 'warning'], ['Scheduled · Approved', 'info']]);
  const campaign = find(element, node => node.type === ui.Badge && Boolean(node.props?.palette))!;
  assert.equal(text(campaign), 'Autumn launch'); assert.ok(ui.badgePalettes.includes(campaign.props!.palette));
  find(element, node => node.type === ui.Button && text(node).includes('failed caption'))!.props!.onClick();
  assert.equal(selected[0], posts[1].post);
});

test('week navigation moves by whole weeks and keeps the loaded month in step with the week', () => {
  const weeks: string[] = [], months: number[][] = [];
  const element = Agenda({ ...base, posts: [], view: 'week', weekStart: '2099-10-26', onWeekChange: (week: string) => weeks.push(week), onMonthChange: (month: Date) => months.push([month.getFullYear(), month.getMonth(), month.getDate()]) });
  const nav = (label: string) => find(element, node => node.type === ui.Button && (node.props?.['aria-label'] === label || text(node) === label))!.props!.onClick();
  nav('Previous week'); nav('Next week');
  assert.deepEqual(weeks, ['2099-10-19', '2099-11-02']);
  assert.deepEqual(months, [[2099, 10, 1]], 'A week whose Thursday falls in November loads November.');
  nav('Today'); assert.equal(new Date(weeks[2] + 'T00:00').getDay(), 1, 'Today moves to the Monday of the current week.');
  assert.equal(find(Agenda({ ...base, posts: [], view: 'week', weekStart: '2099-10-26' }), node => node.props?.['aria-label'] === 'Next week'), undefined, 'Navigation needs the app handler.');
});

test('a focused week day opens the composer on Enter or N, but never for past days, read-only roles or entry buttons', () => {
  const created: string[] = [], props = { ...base, posts: [], view: 'week', weekStart: '2099-10-26', onCreateDay: (day: string) => created.push(day) };
  const [monday, tuesday] = days(Agenda(props));
  assert.equal(key(monday, 'n'), true); key(tuesday, 'Enter'); key(monday, 'N'); key(monday, 'x');
  key(monday, 'n', { tagName: 'BUTTON' });
  assert.deepEqual(created, ['2099-10-26', '2099-10-27', '2099-10-26']);
  key(days(Agenda({ ...props, weekStart: '2000-01-03' }))[0], 'n'); key(days(Agenda({ ...props, canWrite: false }))[0], 'n');
  assert.equal(created.length, 3);
  const empty = html(props);
  assert.match(empty, /No posts this week/); assert.match(empty, /Add a post/);
  assert.doesNotMatch(html({ ...props, canWrite: false }), /Add a post/);
});

test('the month grid has no per-day create buttons; a focused day creates with Enter or N', () => {
  const created: string[] = [], props = { ...base, posts: [entry('post', at(15, 9))], view: 'month', onMonthChange() {}, onCreateDay: (day: string) => created.push(day) };
  const element = Agenda(props), grid = find(element, ofType(ui.CalendarMonth))!;
  assert.equal(grid.props!.onCreateDay, undefined); assert.equal(grid.props!.createDisabledReason, undefined);
  const markup = html(props);
  assert.doesNotMatch(markup, /Create on /, 'Rows stay equal height: no permanent per-day buttons.');
  assert.match(markup, /role="gridcell" data-date="2099-10-01"/, 'The library still marks focused cells with their date.');
  const wrapper = find(element, node => typeof node.props?.onKeyDown === 'function' && Boolean(find(node, ofType(ui.CalendarMonth))))!;
  key(wrapper, 'n', { dataset: { date: '2099-10-20' } }); key(wrapper, 'Enter', { dataset: { date: '2099-10-21' } });
  key(wrapper, 'n', { dataset: {} }); key(wrapper, 'n', { dataset: { date: '2000-10-21' } });
  assert.deepEqual(created, ['2099-10-20', '2099-10-21']);
  assert.match(grid.props!.days.get('2099-10-15')[0].label, /^Facebook · post caption · Scheduled$/, 'Grid entries name network and status.');
  const readOnly = Agenda({ ...props, canWrite: false });
  key(find(readOnly, node => typeof node.props?.onKeyDown === 'function')!, 'n', { dataset: { date: '2099-10-22' } });
  assert.equal(created.length, 2); assert.match(html({ ...props, canWrite: false }), /Read only: your role cannot create posts\./);
});

test('the view switch offers Week, Month and List once the app handles weeks', () => {
  const views: string[] = [], props = { ...base, posts: [], view: 'week', onViewChange: (view: string) => views.push(view) };
  const control = find(Agenda({ ...props, onWeekChange() {} }), ofType(ui.SegmentedControl))!;
  assert.deepEqual(control.props!.options.map((option: { value: string }) => option.value), ['week', 'month', 'list']);
  control.props!.onValueChange('week'); assert.deepEqual(views, ['week']);
  assert.deepEqual(find(Agenda(props), ofType(ui.SegmentedControl))!.props!.options.map((option: { value: string }) => option.value), ['month', 'list'], 'A two-view app keeps its two views.');
});

test('channel, status, campaign and Google filters apply to the week, month and list views and report what they hide', () => {
  const posts = [entry('facebook', at(27, 9)), entry('instagram', at(28, 9), { status: 'draft', campaignId: 'c1' })];
  posts[1].platform = 'instagram';
  const google = { id: 'g', summary: 'Shoot', start: { dateTime: at(29, 9) }, end: { dateTime: at(29, 10) } };
  const changes: unknown[] = [], props = { ...base, posts, googleEvents: [google], weekStart: '2099-10-26', campaigns: [{ id: 'c1', name: 'Autumn launch' }], onFiltersChange: (filters: unknown) => changes.push(filters), onMonthChange() {} };
  const filtered = { ...props, filters: { channel: 'instagram', googleHidden: true } };
  const week = html({ ...filtered, view: 'week' }), month = find(Agenda({ ...filtered, view: 'month' }), ofType(ui.CalendarMonth))!, list = find(Agenda({ ...filtered, view: 'list' }), ofType(ui.PublishingAgenda))!;
  assert.match(week, /instagram caption/); assert.doesNotMatch(week, /facebook caption|Shoot/);
  assert.deepEqual([...month.props!.days.keys()], ['2099-10-28']);
  assert.deepEqual(list.props!.entries.map((item: { id: string }) => item.id), ['post:instagram']);
  assert.match(week, /2 hidden by filters/);
  const applied = find(Agenda({ ...filtered, view: 'week' }), ofType(ui.AppliedFilters))!;
  assert.deepEqual(applied.props!.filters.map((filter: { id: string; value: string }) => [filter.id, filter.value]), [['channel', 'Instagram'], ['googleHidden', 'Hidden']]);
  applied.props!.onRemove('channel'); applied.props!.onClear();
  assert.deepEqual(changes, [{ googleHidden: true }, {}]);
  const element = Agenda({ ...props, view: 'week' });
  const select = (label: string) => find(element, node => node.type === ui.Field && node.props?.label === label)!;
  assert.deepEqual(find(select('Channel'), ofType(ui.Select))!.props!.options.map((option: { value: string }) => option.value), ['', 'facebook', 'instagram']);
  assert.deepEqual(find(select('Status'), ofType(ui.Select))!.props!.options.map((option: { label: string }) => option.label), ['All statuses', 'Draft', 'Scheduled']);
  assert.deepEqual(find(select('Campaign'), ofType(ui.Select))!.props!.options.map((option: { label: string }) => option.label), ['All campaigns', 'Autumn launch']);
  find(select('Status'), ofType(ui.Select))!.props!.onChange({ target: { value: 'draft' } });
  find(element, ofType(ui.Switch))!.props!.onCheckedChange(false);
  assert.deepEqual(changes.slice(2), [{ status: 'draft' }, { googleHidden: true }]);
  assert.equal(find(Agenda({ ...props, onFiltersChange: undefined, view: 'week' }), ofType(ui.AppliedFilters)), undefined, 'Filters need the app handler.');
});

test('#139: a published post without a planned time is placed on its publish time and counted as published', () => {
  const selected: unknown[] = [], sample = { id: 'sample', status: 'published', content: 'Sample caption', platforms: ['instagram'], publishedAt: new Date(2099, 9, 15, 9).toISOString() };
  const planned = entry('planned', at(16, 9), { status: 'published', publishedAt: at(14, 9) });
  const props = { ...base, posts: [planned], records: [sample, planned.post, { id: 'undated', status: 'draft' }], onMonthChange() {}, onSelect: (post: unknown) => selected.push(post) };
  const grid = find(Agenda({ ...props, view: 'month' }), ofType(ui.CalendarMonth))!;
  assert.deepEqual([...grid.props!.days.keys()].sort(), ['2099-10-15', '2099-10-16'], 'A post that already has a schedule entry is not added twice.');
  assert.match(grid.props!.days.get('2099-10-15')[0].label, /^Instagram · Sample caption · Published$/);
  grid.props!.days.get('2099-10-15')[0].onSelect(); assert.equal(selected[0], sample);
  const list = find(Agenda(props), ofType(ui.PublishingAgenda))!;
  assert.deepEqual(list.props!.entries.map((item: { id: string; dateTime: string }) => [item.id, item.dateTime]), [['post:sample', sample.publishedAt], ['post:planned', planned.scheduledAt]]);
  assert.match(html({ ...props, view: 'month' }), /<strong[^>]*>2<\/strong> published/);
});

test('#140: a dated post not yet submitted to a provider is Planned, not Scheduled, and lists every destination', () => {
  const draft = entry('draft', at(27, 9), { externalId: undefined, platforms: ['instagram', 'linkedin', 'twitter'] }), submitted = entry('submitted', at(28, 9));
  draft.platform = 'instagram';
  const changes: unknown[] = [], props = { ...base, posts: [draft, submitted], view: 'month', onMonthChange() {}, onFiltersChange: (filters: unknown) => changes.push(filters) };
  const grid = find(Agenda(props), ofType(ui.CalendarMonth))!;
  assert.equal(grid.props!.days.get('2099-10-27')[0].label, 'Instagram, LinkedIn, X · draft caption · Planned');
  assert.equal(grid.props!.days.get('2099-10-28')[0].label, 'Facebook · submitted caption · Scheduled');
  const markup = html(props);
  assert.match(markup, /<strong[^>]*>1<\/strong> planned/); assert.match(markup, /<strong[^>]*>1<\/strong> scheduled/);
  const list = find(Agenda({ ...props, view: 'list' }), ofType(ui.PublishingAgenda))!;
  assert.equal(text(list.props!.entries[0].status), 'Planned'); assert.equal(list.props!.entries[0].details, 'Instagram, LinkedIn, X');
  const week = find(Agenda({ ...props, view: 'week', weekStart: '2099-10-26', postApprovals: { draft: 'Awaiting approval' } }), node => node.type === ui.Badge && Boolean(node.props?.dot))!;
  assert.deepEqual([text(week), week.props!.tone], ['Planned · Awaiting approval', 'warning']);
  const select = (label: string) => find(Agenda(props), node => node.type === ui.Field && node.props?.label === label)!;
  assert.deepEqual(find(select('Status'), ofType(ui.Select))!.props!.options.map((option: { value: string }) => option.value), ['', 'planned', 'scheduled']);
  assert.deepEqual(find(select('Channel'), ofType(ui.Select))!.props!.options.map((option: { value: string }) => option.value), ['', 'facebook', 'instagram', 'linkedin', 'twitter']);
  const filtered = (filters: Record<string, string>) => [...find(Agenda({ ...props, filters }), ofType(ui.CalendarMonth))!.props!.days.keys()];
  assert.deepEqual(filtered({ status: 'planned' }), ['2099-10-27']); assert.deepEqual(filtered({ channel: 'linkedin' }), ['2099-10-27']); assert.deepEqual(filtered({ status: 'scheduled' }), ['2099-10-28']);
});

test('#185: field activity is on the calendar without Google Calendar, labelled as field activity, and its Google copy is not shown twice', () => {
  const roadshow = { id: 'road', name: 'Mall of the Emirates roadshow', type: 'roadshow', status: 'planned', location: 'Mall of the Emirates', campaignId: 'c1', startAt: at(26, 10), endAt: at(26, 16) };
  const doors = { id: 'doors', name: 'Marina door-to-door', type: 'door_to_door', status: 'completed', location: 'Dubai Marina', startAt: at(22, 9), endAt: at(22, 12) };
  const cancelled = { id: 'gone', name: 'Cancelled sampling', type: 'sampling', status: 'cancelled', location: 'JBR', startAt: at(23, 9), endAt: at(23, 12) };
  const props = { ...base, posts: [], activations: [roadshow, doors, cancelled], campaigns: [{ id: 'c1', name: 'Autumn launch' }], weekStart: '2099-10-26', onMonthChange() {} };
  const week = Agenda({ ...props, view: 'week' }), weekMarkup = html({ ...props, view: 'week' });
  assert.match(String(days(week)[0].props!['aria-label']), /^Monday, October 26, 2099, 1 entry$/);
  assert.match(weekMarkup, /Field activity · Mall of the Emirates roadshow/); assert.doesNotMatch(weekMarkup, /Marina|Cancelled sampling/, 'The week shows only its own days.');
  assert.deepEqual(findAll(week, node => node.type === ui.Badge && Boolean(node.props?.dot)).map(badge => [text(badge), badge.props!.tone]), [['Planned', 'info']]);
  const grid = find(Agenda({ ...props, view: 'month' }), ofType(ui.CalendarMonth))!;
  assert.deepEqual([...grid.props!.days.keys()].sort(), ['2099-10-22', '2099-10-26'], 'A cancelled activation is left off, as in the Google plan.');
  assert.equal(grid.props!.days.get('2099-10-22')[0].label, 'Field activity · Marina door-to-door · Completed');
  const list = find(Agenda({ ...props, view: 'list' }), ofType(ui.PublishingAgenda))!;
  assert.deepEqual(list.props!.entries.map((item: { id: string; title: string; details: string }) => [item.id, item.title, item.details]), [['activation:doors', 'Field activity · Marina door-to-door', 'Dubai Marina'], ['activation:road', 'Field activity · Mall of the Emirates roadshow', 'Mall of the Emirates · Autumn launch']]);
  assert.equal(text(list.props!.entries[0].status), 'Completed');
  const copy = { id: 'g-road', summary: 'Field · Mall of the Emirates roadshow', managed: true, plan: { collection: 'activations', recordId: 'road' }, start: { dateTime: roadshow.startAt }, end: { dateTime: roadshow.endAt } };
  const synced = find(Agenda({ ...props, googleEvents: [copy], view: 'list' }), ofType(ui.PublishingAgenda))!;
  assert.deepEqual(synced.props!.entries.map((item: { id: string }) => item.id), ['activation:doors', 'activation:road'], 'With Google Calendar connected the published copy is not listed again.');
});

test('#200: the week entry button carries the week-entry class and the stylesheet stacks it at phone width', async () => {
  // A multi-platform entry like the one the issue describes: one post to Instagram, LinkedIn and X.
  const entry200 = entry('sunday', at(25, 9), { platforms: ['instagram', 'linkedin', 'x'] });
  const props = { ...base, posts: [entry200], view: 'week', weekStart: '2099-10-19' };
  const button = find(Agenda(props), node => node.type === ui.Button && text(node).includes('sunday caption'))!;
  assert.ok(button, 'The week entry is a button.');
  assert.equal(button.props!.className, 'week-entry', 'The post entry button carries the week-entry class the mobile layout hooks onto.');
  // The stylesheet stacks the parts at the kit's mobile width and ellipsizes the caption; desktop keeps the row.
  const css = await readFile(new URL('../src/PublishingAgenda.css', import.meta.url), 'utf8');
  const mobile = css.match(/@media \(max-width: 760px\)\s*{([\s\S]*)/)!;
  assert.match(mobile[1], /\.week-entry\s*{[^}]*flex-direction:\s*column/, 'At phone width the entry stacks its parts.');
  assert.match(mobile[1], /\.week-entry > \.t98-truncate\s*{[^}]*inline-size:\s*100%/, 'The caption takes the full width and ellipsizes instead of wrapping per character.');
  assert.doesNotMatch(css.slice(0, mobile.index), /week-entry/, 'Outside the mobile breakpoint the entry is untouched, so desktop keeps its single row.');
});
