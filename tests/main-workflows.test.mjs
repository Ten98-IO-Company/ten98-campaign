import test from 'node:test';
import { postScheduleEntries } from '../shared/post-schedule.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';

const source = () => readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');

test('the shared API client rejects unreadable receipts without treating a potentially accepted write as a known failure', async () => {
  const appSource = source(), start = appSource.indexOf('async function api('), end = appSource.indexOf('\nconst money =', start);
  assert.ok(start > 0 && end > start);
  const client = response => runInNewContext(stripTypeScriptTypes(appSource.slice(start, end)) + '; api', { fetch: async () => response });
  for (const status of [200, 502]) await assert.rejects(client(new Response('<html>upstream error</html>', { status }))('/test', 'POST', { value: 1 }, 'action-key'), error => error.message === 'The server returned an unreadable response.' && error.status === undefined);
  for (const invalid of [null, [], 'saved', 1, true]) await assert.rejects(client(Response.json(invalid))('/test', 'POST', {}, 'action-key'), error => error.message === 'The server returned an unreadable response.' && error.status === undefined);
  await assert.rejects(client(Response.json({ error: { code: 'OPERATION_UNCERTAIN', message: 'Check the provider.' }, operation: { id: 'receipt' } }, { status: 409 }))('/test'), error => error.status === 409 && error.code === 'OPERATION_UNCERTAIN' && error.operation.id === 'receipt');
  assert.equal((await client(Response.json({ saved: true }))('/test')).saved, true);
});

test('dashboard counts daily-campaign spend without adding daily budgets to total allocations or inventing missing metrics', () => {
  const appSource = source(), start = appSource.search(/  const (?:currencyCampaigns|currentCurrency) =/), end = appSource.indexOf('  const activeCampaigns =', start);
  assert.ok(start > 0 && end > start);
  const calculate = runInNewContext(`(state, currency) => { const numeric = value => typeof value === 'number' && Number.isFinite(value), money = value => String(value); ${appSource.slice(start, end)} return { spent, budget, impressions, chartCount: currentCurrency.length, caption: typeof spendCaption === 'undefined' ? '' : spendCaption }; }`);
  const manual = { currency: 'USD', budget: 100, spent: 10, impressions: 100 }, daily = { currency: 'USD', budgetType: 'daily', budget: 25, spent: 31.5, impressions: 1450 }, foreign = { currency: 'EUR', budget: 300, spent: 5, impressions: 50 };
  const totals = calculate({ campaigns: [manual, daily, foreign] }, 'USD');
  assert.equal(totals.spent, 41.5, 'Spend includes daily-budget advertising campaigns.'); assert.equal(totals.budget, 100, 'A daily spend limit cannot be added to a campaign-total allocation.'); assert.equal(totals.chartCount, 1); assert.equal(totals.impressions, 1600);
  assert.match(totals.caption, /daily budgets separate/); assert.doesNotMatch(totals.caption, /%/);
  assert.equal(calculate({ campaigns: [manual, { ...daily, spent: undefined, impressions: undefined }] }, 'USD').spent, undefined);
  assert.equal(calculate({ campaigns: [manual, { ...daily, impressions: null }] }, 'USD').impressions, undefined);
  assert.equal(calculate({ campaigns: [] }, 'USD').spent, 0);
});

test('campaign money and counts preserve fractional amounts and distinguish absent values from zero', () => {
  const appSource = source(), names = ['numeric', 'money', 'compact', 'budgetProgress'];
  const declarations = names.map(name => appSource.match(new RegExp(`^const ${name} = .+;$`, 'm'))?.[0]);
  assert.ok(declarations.every(Boolean));
  const { money, compact, budgetProgress } = runInNewContext(stripTypeScriptTypes(declarations.join('\n')) + '; ({money, compact, budgetProgress})');
  assert.equal(money(0.01, 'USD'), '$0.01'); assert.equal(money(25.75, 'USD'), '$25.75'); assert.equal(money(25, 'USD'), '$25'); assert.equal(money(25.125, 'KWD').includes('25.125'), true);
  for (const missing of [undefined, null, NaN, Infinity, '0']) { assert.equal(money(missing), '—'); assert.equal(compact(missing), '—'); }
  assert.equal(money(0, 'USD'), '$0'); assert.equal(compact(0), '0');
  assert.equal(budgetProgress(0.1, 0.25), 40); assert.equal(budgetProgress(5, 2), 100); assert.equal(budgetProgress(1, 0), 0); assert.equal(budgetProgress(undefined, 25), 0);
  assert.equal((appSource.match(/budgetProgress\(c\.spent, c\.budget\)/g) || []).length, 2, 'Both campaign bars use the shared fractional-budget calculation.');
});

test('post labels show a platform caption when shared content is empty and identify media-only posts', () => {
  const declaration = source().match(/^function postLabel\(post: Row\) \{[^\r\n]+\}$/m)?.[0];
  assert.ok(declaration);
  const label = runInNewContext(stripTypeScriptTypes(declaration) + '; postLabel');
  assert.equal(label({ content: 'Shared caption', platforms: ['twitter'], platformOverrides: { twitter: { content: 'Custom caption' } } }), 'Shared caption');
  assert.equal(label({ content: '', platforms: ['instagram', 'twitter'], platformOverrides: { twitter: { content: 'Custom caption' } } }), 'Custom caption');
  assert.equal(label({ content: '', platforms: ['instagram'], platformOverrides: { instagram: { mediaItems: [] } } }), 'Media post');
  assert.equal(label({ content: '', platforms: ['facebook'], accountOverrides: { page: { platform: 'facebook', content: 'Account-only caption' } } }), 'Account-only caption');
});

test('post cards name only saved recipient IDs using current project names and matching provider metadata', async () => {
  const appSource = source(), composer = readFileSync(new URL('../src/PostComposer.tsx', import.meta.url), 'utf8');
  const declarations = [composer.match(/^const accountId = .+;$/m)?.[0], composer.match(/^export const accountLabel = .+;$/m)?.[0]?.replace('export ', '')];
  assert.ok(declarations.every(Boolean));
  const start = appSource.indexOf('function postRecipients('), end = appSource.indexOf('function calendarOverlayEvents(', start);
  assert.ok(start > 0 && end > start);
  assert.match(appSource, /import PostComposer, \{ accountLabel \} from '\.\/PostComposer'/);
  const recipients = runInNewContext(stripTypeScriptTypes(declarations.join('\n') + '\n' + appSource.slice(start, end)) + '; postRecipients');
  const accounts = [{ _id: 'one', displayName: 'Current page', platform: 'facebook' }, { _id: 'two', username: '@second', platform: 'facebook' }, { id: 'three', name: 'Named account' }];
  const post = { accounts: ['two', 'one', 'reported', 'missing'], platforms: ['facebook'], accountOverrides: { unselected: { platform: 'facebook' } }, providerResults: [{ accountId: { _id: 'one', displayName: 'Old page name' } }, { accountId: 'reported' }, { accountId: { _id: 'reported', displayName: 'Reported page' } }, { accountId: { _id: 'foreign', displayName: 'Unselected page' } }] };
  const before = structuredClone({ post, accounts });
  assert.equal(recipients(post, accounts), '@second (two), Current page (one), Reported page (reported), missing');
  assert.equal(recipients({ accounts: ['one', 'two'] }, [{ _id: 'one', displayName: 'Same page', platform: 'facebook' }, { _id: 'two', displayName: 'Same page', platform: 'facebook' }]), 'Same page (one), Same page (two)', 'Same-platform recipients retain distinct identities.');
  assert.equal(recipients({ accounts: ['three'] }, accounts), 'Named account (three)');
  assert.equal(recipients({ accounts: ['raw'] }, [{ _id: 'raw' }]), 'raw');
  assert.equal(recipients({ accounts: ['id-only'], providerResults: [{ accountId: { id: 'id-only', username: '@reported' } }] }), '@reported (id-only)');
  assert.equal(recipients(post), 'two, Old page name (one), Reported page (reported), missing', 'Unloaded names do not invent current directory data.');
  assert.equal(recipients({ ...post, accounts: [] }, accounts), 'No accounts selected');
  assert.equal(recipients({ platforms: ['facebook'], providerResults: post.providerResults, accountOverrides: post.accountOverrides }, accounts), 'Choose connected accounts');
  assert.deepEqual({ post, accounts }, before, 'Display resolution does not change saved identities or loaded accounts.');
  const markup = appSource.match(/<p className="post-meta"><span>Recipients: \{postRecipients\(p, remote\.accounts\?\.accounts \|\| \[\]\)\}<\/span><\/p>/)?.[0];
  assert.ok(markup, 'Cards render recipient identities visibly.');
  const { code } = await transformWithOxc('const render = (p, remote) => ' + markup, 'PostRecipients.tsx', { jsx: { runtime: 'classic' } });
  const render = new Function('React', 'postRecipients', code + '; return render;')(React, recipients);
  const html = renderToStaticMarkup(render({ accounts: ['<unknown>'] }, {}));
  assert.match(html, /Recipients: &lt;unknown&gt;/); assert.doesNotMatch(html, /<unknown>/);
});

test('post status buttons remain a subordinate pressed group with their actual local filter callbacks', async () => {
  const appSource = source(), start = appSource.indexOf('<div className="button-wrap" role="group" aria-label="Post status">'), end = appSource.indexOf('</div>', start) + 6;
  assert.ok(start > 0 && end > start);
  const { code } = await transformWithOxc('const render = (tab, setTab) => ' + appSource.slice(start, end), 'PostStatus.tsx', { jsx: { runtime: 'classic' } });
  const render = new Function('React', 'title', code + '; return render;')(React, value => value[0].toUpperCase() + value.slice(1));
  const statuses = ['all', 'draft', 'scheduled', 'published', 'failed', 'cancelled']; let selected = 'all';
  for (const status of statuses) {
    const group = render(selected, value => { selected = value; }), buttons = React.Children.toArray(group.props.children);
    assert.equal(group.props.role, 'group'); assert.equal(group.props['aria-label'], 'Post status'); assert.equal(group.props.className, 'button-wrap');
    assert.equal(buttons.length, statuses.length);
    assert.equal(buttons.filter(button => button.props['aria-pressed']).length, 1);
    for (const [index, button] of buttons.entries()) { assert.equal(button.props.type, 'button'); assert.equal(button.props['aria-pressed'], statuses[index] === selected); assert.equal(button.props.className, 'button' + (statuses[index] === selected ? ' primary' : '')); }
    buttons[statuses.indexOf(status)].props.onClick(); assert.equal(selected, status);
  }
  const declaration = appSource.match(/^  const visiblePosts = .+;$/m)?.[0]; assert.ok(declaration);
  const filter = new Function('state', 'tab', 'filtered', declaration + '; return visiblePosts;');
  const posts = statuses.slice(1).map(status => ({ id: status, status }));
  for (const status of statuses) assert.deepEqual(filter({ posts }, status, rows => rows).map(post => post.id), status === 'all' ? statuses.slice(1) : [status]);
  assert.match(appSource, /sections\('Publishing sections', publishingView, /, 'Publishing route navigation stays separate.');
});

test('Overview campaign totals and channel counts use singular only for one campaign', async () => {
  const appSource = source();
  const active = appSource.match(/<span><span className="status-dot green"\/>\{activeCampaigns\}[^\r\n]+?across your project<\/span><\/span>/)?.[0]; assert.ok(active);
  const start = appSource.indexOf('<div className="channel-breakdown">'), end = appSource.indexOf('</div><button className="text-link"', start) + 6;
  assert.ok(start > 0 && end > start);
  const { code } = await transformWithOxc('const active = activeCampaigns => ' + active + '; const renderChannels = state => ' + appSource.slice(start, end), 'CampaignCounts.tsx', { jsx: { runtime: 'classic' } });
  const render = new Function('React', 'channels', code + '; return { active, channels: renderChannels };')(React, { social: 'Social media' });
  for (const count of [0, 1, 2]) {
    const word = count === 1 ? 'campaign' : 'campaigns';
    assert.match(renderToStaticMarkup(render.active(count)), new RegExp(count + ' active ' + word + ' '));
    assert.ok(renderToStaticMarkup(render.channels({ campaigns: Array.from({ length: count }, () => ({ channel: 'social' })) })).includes('<strong>' + count + ' <small>' + word + '</small></strong>'));
  }
});

test('local campaign results distinguish missing metrics from zero and never display NaN rates', () => {
  const appSource = source(), start = appSource.indexOf('<h2>Campaign results</h2>'), row = appSource.slice(start, appSource.indexOf('</tbody>', start));
  const cells = [...row.matchAll(/<td>\{([^{}]+)\}<\/td>/g)].slice(0, 5).map(match => match[1]);
  assert.equal(cells.length, 5);
  const declaration = appSource.match(/^const numeric = .+;$/m)[0].replace('(value: unknown): value is number', '(value)');
  const numeric = runInNewContext(declaration + '; numeric');
  const render = campaign => cells.map(expression => new Function('c', 'numeric', 'compact', 'money', `return (${expression});`)(campaign, numeric, value => String(value), value => `AED ${value}`));
  assert.deepEqual(render({}), ['—', '—', '—', '—', '—']);
  assert.deepEqual(render({ impressions: 100, conversions: 2 }), ['100', '—', '—', 2, '—']);
  assert.deepEqual(render({ impressions: 100, clicks: 0, conversions: 2, spent: 0 }), ['100', '0', '0.00%', 2, 'AED 0']);
  assert.deepEqual(render({ impressions: 0, clicks: 0, conversions: 0, spent: 0 }), ['0', '0', '—', 0, '—']);
  assert.deepEqual(render({ impressions: Infinity, clicks: NaN, conversions: null, spent: undefined }), ['—', '—', '—', '—', '—']);
});

test('calendar dates stay on their intended day while timestamps follow the browser timezone', () => {
  const declaration = source().match(/^const date = .+;$/m)?.[0];
  assert.ok(declaration, 'Exercise the date formatter used by campaign and OOH cards.');
  const script = `${declaration.replace('(value: string)', '(value)')}\nconsole.log(JSON.stringify([date('2026-10-18'), date('2026-10-18T00:00:00Z'), date('')]));`;
  const west = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, TZ: 'America/Los_Angeles' } });
  assert.equal(west.status, 0, west.stderr);
  assert.deepEqual(JSON.parse(west.stdout.trim()), ['18 Oct', '17 Oct', 'Not set']);
  const east = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, TZ: 'Asia/Dubai' } });
  assert.equal(east.status, 0, east.stderr);
  assert.deepEqual(JSON.parse(east.stdout.trim()), ['18 Oct', '18 Oct', 'Not set']);
});

test('upcoming posts exclude past and completed work and sort by instant without changing the source list', () => {
  const declaration = source().match(/^function upcomingPosts\([^\r\n]+\}$/m)?.[0];
  assert.ok(declaration, 'Keep the upcoming-post selector available for this regression check.');
  const upcoming = runInNewContext(stripTypeScriptTypes(declaration) + '; upcomingPosts', { postScheduleEntries });
  const now = Date.parse('2026-10-18T10:00:00Z');
  const posts = [
    { id: 'latest', status: 'scheduled', scheduledAt: '2026-10-18T13:00:00Z' },
    { id: 'published', status: 'published', scheduledAt: '2026-10-18T11:00:00Z' },
    { id: 'cancelled', status: 'cancelled', scheduledAt: '2026-10-18T11:00:00Z' },
    { id: 'failed', status: 'failed', scheduledAt: '2026-10-18T11:00:00Z' },
    { id: 'past', status: 'scheduled', scheduledAt: '2026-10-18T09:00:00Z' },
    { id: 'exactly-now', status: 'scheduled', scheduledAt: '2026-10-18T10:00:00Z' },
    { id: 'invalid', status: 'scheduled', scheduledAt: 'not-a-date' },
    { id: 'undated', status: 'draft' },
    { id: 'offset-earliest', status: 'draft', scheduledAt: '2026-10-18T15:00:00+04:00' },
    { id: 'submitted', status: 'submitted', scheduledAt: '2026-10-18T12:00:00Z' },
  ];
  const before = structuredClone(posts), result = upcoming(posts, now);
  assert.deepEqual(Array.from(result, row => row.id), ['offset-earliest', 'submitted', 'latest']);
  assert.deepEqual(posts, before);
  assert.equal(upcoming([], now).length, 0);
  const copy = { id: 'copies', status: 'scheduled', content: 'Shared', scheduledAt: '2026-10-18T14:00:00Z', platforms: ['facebook'], accounts: ['one', 'two'], accountOverrides: { two: { platform: 'facebook', content: 'Second account', scheduledAt: '2026-10-18T11:30:00Z' } } };
  const copies = upcoming([copy], now); assert.deepEqual(Array.from(copies, row => [row.id, row.content, row.scheduledAt]), [['copies:two', 'Second account', '2026-10-18T11:30:00Z'], ['copies:one', 'Shared', '2026-10-18T14:00:00Z']]); assert.ok(copies.every(row => row.post === copy), 'Calendar and overview entries must open the original post, not a flattened copy.');
});

test('calendar overlay hides only exact verified copies of visible local post entries', () => {
  const declaration = source().match(/^function calendarOverlayEvents\([^\r\n]+\}$/m)?.[0]; assert.ok(declaration);
  const overlay = runInNewContext(stripTypeScriptTypes(declaration) + '; calendarOverlayEvents');
  const post = { id: 'post', platforms: ['facebook'], content: 'Shared', scheduledAt: '2026-10-18T10:00:00Z', accounts: ['one', 'two'], accountOverrides: { two: { platform: 'facebook', content: 'Other caption', scheduledAt: '2026-10-18T11:00:00Z' } } };
  const entries = postScheduleEntries(post), event = { id: 'google', managed: true, projectId: 'project', plan: { collection: 'posts', recordId: 'post', accountId: 'two' }, summary: 'Social · Other caption', start: { dateTime: '2026-10-18T15:00:00+04:00' }, end: { dateTime: '2026-10-18T11:30:00Z' } };
  assert.equal(overlay([event], entries, 'project').length, 0);
  for (const change of [{ managed: false }, { projectId: 'foreign' }, { plan: undefined }, { plan: { ...event.plan, recordId: 'deleted' } }, { plan: { ...event.plan, accountId: 'one' } }, { plan: { ...event.plan, collection: 'campaigns' } }, { summary: 'Manually edited caption' }, { start: { dateTime: '2026-10-18T12:00:00Z' } }, { end: { dateTime: '2026-10-18T12:00:00Z' } }]) assert.equal(overlay([{ ...event, ...change }], entries, 'project').length, 1, JSON.stringify(change));
  assert.equal(overlay([event], [], 'project').length, 1, 'Orphan or currently invisible local entries stay visible.');
  assert.equal(overlay([{ ...event, plan: { collection: 'posts', recordId: 'ordinary' }, summary: 'Social · Ordinary' }], postScheduleEntries({ id: 'ordinary', content: 'Ordinary', scheduledAt: event.start.dateTime }), 'project').length, 0);
  assert.match(source(), /<CampaignPublishingAgenda posts=\{calendarPosts\} googleEvents=\{calendarOverlay\}/, 'The agenda shows local posts and only the unverified Google overlay.');
});

test('asset previews select safe actual media and fall back after a thumbnail fails', () => {
  const appSource = source(), start = appSource.indexOf('function AssetPreview('), body = appSource.indexOf('\n', start), end = appSource.indexOf('\n  return preview ?', body);
  assert.ok(start > -1 && end > body, 'Exercise the production preview selection before its JSX rendering.');
  const select = runInNewContext(`(item, useState) => { ${appSource.slice(body, end).replace('useState<string[]>([])', 'useState([])')} return preview; }`, { URL });
  const choose = (item, failed = []) => select(item, () => [failed, () => {}]);
  const thumbnailUrl = 'https://cdn.example.com/thumb.jpg', deliveryUrl = 'https://cdn.example.com/publish.jpg', original = 'https://drive.google.com/file/d/original/view';
  const image = { kind: 'image', thumbnailUrl, deliveryUrl, url: original };
  assert.equal(choose(image), thumbnailUrl);
  assert.equal(choose(image, [thumbnailUrl]), deliveryUrl, 'A failed thumbnail must use the public delivery media.');
  assert.equal(choose(image, [thumbnailUrl, deliveryUrl]), undefined, 'Failed media should become a placeholder instead of requesting forever.');
  assert.equal(choose({ ...image, thumbnailUrl: '', deliveryUrl: 'https://cdn.example.com/replacement.jpg' }, [deliveryUrl]), 'https://cdn.example.com/replacement.jpg', 'Changing a failed URL makes the new media eligible.');
  assert.equal(choose({ kind: 'image', deliveryUrl, url: original }), deliveryUrl);
  assert.equal(choose({ kind: 'image', url: 'https://cdn.example.com/original.jpg' }), 'https://cdn.example.com/original.jpg');
  assert.equal(choose({ kind: 'video', thumbnailUrl, url: 'https://cdn.example.com/movie.mp4' }), thumbnailUrl);
  assert.equal(choose({ kind: 'video', url: 'https://cdn.example.com/movie.mp4' }), undefined);
  assert.equal(choose({ ...image, deliverySource: 'zernio', deliveryKind: 'video', deliveryUrl: 'https://media.zernio.com/temp/movie.mp4' }), undefined, 'A different delivery kind must not reuse the original Drive thumbnail or render a video as an image.');
  assert.equal(choose({ kind: 'video', thumbnailUrl, url: original, deliverySource: 'zernio', deliveryKind: 'image', deliveryUrl }), deliveryUrl, 'The delivery file preview follows its observed kind, independently of the original.');
  for (const unsafe of ['http://cdn.example.com/a.jpg', 'javascript:alert(1)', 'https://user:secret@cdn.example.com/a.jpg', original, 'https://docs.google.com/document/d/private', 'https://localhost/a.jpg', 'https://127.1/a.jpg', 'https://0x7f000001/a.jpg', 'https://10.0.0.1/a.jpg', 'https://172.16.0.1/a.jpg', 'https://172.31.255.255/a.jpg', 'https://192.168.0.1/a.jpg', 'https://169.254.1.1/a.jpg', 'https://0.0.0.0/a.jpg', 'https://[::1]/a.jpg', 'https://media.local/a.jpg', 'https://media.internal/a.jpg']) {
    assert.equal(choose({ kind: 'image', thumbnailUrl: unsafe, url: unsafe, deliveryUrl: unsafe }), undefined, unsafe);
    assert.equal(choose({ ...image, thumbnailUrl: unsafe }), deliveryUrl, `An unsafe thumbnail must not hide safe delivery media: ${unsafe}`);
  }
  for (const publicUrl of ['https://172.15.0.1/a.jpg', 'https://172.32.0.1/a.jpg']) assert.equal(choose({ kind: 'image', url: publicUrl }), publicUrl, 'The 172.16/12 block must not cover neighboring public addresses.');
});


test('Settings keeps its two existing columns and renders scoped receipt recovery afterward at full width', async () => {
  const appSource = source(), start = appSource.indexOf("{page === 'Settings' && "), end = appSource.indexOf('\n', start);
  assert.ok(start > 0 && end > start);
  const expression = appSource.slice(start + 1, end - 1);
  const { code } = await transformWithOxc('const render = () => (' + expression + ');', 'SettingsComposition.tsx', { jsx: { runtime: 'classic' } });
  const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(nodes)];
  const AccountSettings = () => React.createElement('section', { 'data-account-settings': true });
  const OperationRecovery = ({ projectId }) => React.createElement('section', { 'data-provider-recovery': projectId });
  const TeamSettings = () => React.createElement('section', { 'data-team-settings': true });
  const api = () => assert.fail('Rendering Settings must not submit an operation');
  const activeProject = { current: 'project-a' }, pendingKeys = { current: new Map([['retained', 'key']]) };
  const context = { React, page: 'Settings', project: { id: 'project-a', name: 'Campaign project' }, state: { projectId: 'project-a', user: { id: 'viewer-a', isOperator: true } }, workspace: { id: 'workspace-a', role: 'admin', name: 'Workspace' }, session: { oidcEnabled: false }, canAdmin: true, sample: false, busy: false, activeProject, pendingKeys, api,
    Field: () => React.createElement('input', { name: 'name' }), Icon: () => null, AccountSettings, OperationRecovery, TeamSettings, title: value => value,
    run: () => assert.fail('Rendering must not run an action'), reload: () => assert.fail('Rendering must not reload'), setPage: () => {}, setModal: () => {}, clearSampleData: () => {} };
  const tree = new Function(...Object.keys(context), code + '; return render();')(...Object.values(context));
  assert.equal(tree.type, React.Fragment);
  const children = React.Children.toArray(tree.props.children), [grid, recovery] = children;
  assert.equal(children.length, 2); assert.equal(grid.props.className, 'settings-grid'); assert.equal(recovery.type, OperationRecovery);
  assert.equal(React.Children.toArray(grid.props.children).length, 2, 'Project/account and workspace/access retain their columns.');
  assert.equal(nodes(grid).filter(node => node.type === AccountSettings).length, 1);
  assert.equal(nodes(grid).filter(node => node.type === TeamSettings).length, 1);
  assert.equal(nodes(grid).filter(node => node.type === OperationRecovery).length, 0, 'The receipt table is outside either half-width column.');
  assert.equal(tree.props.children[1].key, 'receipts:project-a', 'The existing recovery instance key is unchanged before React.Children escapes it.');
  assert.equal(recovery.props.projectId, 'project-a'); assert.equal(recovery.props.role, 'admin'); assert.equal(recovery.props.isOperator, true); assert.equal(recovery.props.request, api);
  recovery.props.onReviewed('applied'); assert.equal(pendingKeys.current.size, 1);
  activeProject.current = 'another-project'; recovery.props.onReviewed('not_applied'); assert.equal(pendingKeys.current.size, 1, 'An old recovery callback cannot clear another project action keys.');
  activeProject.current = 'project-a'; recovery.props.onReviewed('not_applied'); assert.equal(pendingKeys.current.size, 0);
  const html = renderToStaticMarkup(tree); assert.match(html, /Project settings/); assert.match(html, /Workspace &amp; access/); assert.ok(html.indexOf('data-provider-recovery') > html.indexOf('data-workspace-invitations'));
});
