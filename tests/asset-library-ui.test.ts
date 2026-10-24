// ten98-campaign#131: the Asset library is one toolbar, a grid or list of assets, drop-anywhere upload and a detail view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React, { Suspense } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import * as ui from '@ten98/ui';
import * as app from '@ten98/ui/app';
import { assetDeliveryIssue } from '../shared/social-posts.ts';

type Row = Record<string, any>;
const library = ui as unknown as Record<string, any>;
const { AssetDetails, Button, DataTable, Dialog, EmptyState, FileField, ResourceCard, Tabs } = library;
const read = (name: string) => readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
const [source, mainSource] = await Promise.all([read('AssetLibrary.tsx'), read('main.tsx')]);
const code = (await transformWithOxc(source.replace(/^import .+;\r?\n/gm, '').replace(/^export (default )?/gm, ''), 'AssetLibrary.tsx', { jsx: { runtime: 'classic' } })).code;

// Hooks are mocked by call order so a test can put the page in a state a browser would reach.
// States in call order: view, selected asset id, upload dialog open, uploads, dragging, detail tab.
function page(states: unknown[] = []) {
  for (const key of ['upload', 'open', 'tab', 'sync', 'drive']) calls[key] = [];
  const refs: { current: unknown }[] = []; let stateIndex = 0, refIndex = 0;
  const useState = (initial: unknown) => { const index = stateIndex++; if (!(index in states)) states[index] = initial; return [states[index], (value: any) => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; };
  const useRef = (initial: unknown) => refs[refIndex++] ||= { current: initial };
  const module = new Function('React', 'Suspense', 'useEffect', 'useRef', 'useState', 'AppBadge', 'Icon', 'assetDeliveryIssue', 'ui', `const {${Object.keys(library).filter(name => name !== 'Icon').join(',')}} = ui;` + code + '; return { AssetLibrary, uploadIssue, assetUses };')(React, Suspense, () => {}, useRef, useState, app.AppBadge, app.AppIcon, assetDeliveryIssue, library);
  return { ...module, states, render: (extra: Row = {}) => { stateIndex = 0; refIndex = 0; return module.AssetLibrary(props(extra)); } };
}
const assets = [
  { id: 'a1', name: 'Hero.jpg', kind: 'image', source: 'google-drive', approval: 'approved', url: 'https://drive.google.com/file/d/x/view', tags: ['brand'], size: 2048, width: 1200, height: 800 },
  { id: 'a2', name: 'Launch film', kind: 'video', source: 'zernio', approval: 'pending', url: 'https://cdn.example.test/film.mp4', deliverySource: 'zernio', deliveryKind: 'video', deliveryUrl: 'https://media.example.test/film.mp4', deliveryUploadedAt: '2026-10-01T00:00:00Z', deliveryExpiresAt: '2026-10-02T00:00:00Z' },
  { id: 's1', name: 'Sample poster', kind: 'image', sample: true, approval: 'approved', url: 'https://example.test/sample.jpg' },
];
const related = {
  campaigns: [{ id: 'c1', name: 'Autumn launch', status: 'active', assetId: 'a1', startDate: '2026-11-01' }],
  posts: [{ id: 'p1', content: 'New season is here', status: 'scheduled', scheduledAt: '2026-11-02T09:00:00Z', platformOverrides: { instagram: { assetId: 'a1' } } }, { id: 'p2', content: 'Unrelated', status: 'draft', assetId: 'a2' }],
  placements: [{ id: 'o1', name: 'Marina screen', status: 'booked', assetId: 'a1' }],
  activations: [],
};
const calls: Row = {};
function props(extra: Row = {}) {
  return { projectId: 'p', assets, visibleAssets: assets, busy: false, canWrite: true, drive: { configured: true, mapped: true }, driveSyncReason: '', connected: true, tab: 'all', related,
    onTabChange: (tab: string) => calls.tab.push(tab), onSync: () => calls.sync.push(true), onUpload: async (files: File[]) => { calls.upload.push(files.map(file => file.name)); }, request: async () => ({}),
    onDeliverySaved() {}, onOpen: (modal: Row) => calls.open.push(modal), onSetUpDrive: () => calls.drive.push(true), preview: (asset: Row) => React.createElement(ui.Text, null, 'preview of ' + asset.name), ...extra };
}
const elements = (node: any): any[] => Array.isArray(node) ? node.flatMap(elements)
  : React.isValidElement(node) ? [node, ...['children', 'actions', 'action', 'status', 'media', 'preview', 'original', 'delivery', 'approvalStatus', 'deliveryStatus', 'deliveryExpiry', 'readOnlyReason', 'issue', 'footer', 'description'].flatMap(key => elements((node.props as Row)[key])),
    ...((node.props as Row).items || []).flatMap((item: Row) => elements(item.content)),
    ...(node.type === DataTable ? elements((node.props as Row).rows.flatMap((row: Row) => [...(node.props as Row).columns.map((column: Row) => column.render?.(row)), (node.props as Row).rowActions?.(row)])) : [])] : [];
// Visible text read by splitting on tags in one pass (not a sanitiser).
const text = (node: any): string => renderToStaticMarkup(React.createElement(React.Fragment, null, node)).split(/<[^>]*>/).join(' ').replace(/\s+/g, ' ');
const buttons = (node: any, label: RegExp) => elements(node).filter(item => item.type === Button && (label.test(text((item.props as Row).children)) || label.test((item.props as Row)['aria-label'] || '')));
const file = (name: string, type: string, size = 10) => ({ name, type, size }) as File;
const drop = (files: File[], defaultPrevented = false) => { let prevented = false; return { event: { defaultPrevented, preventDefault() { prevented = true; }, dataTransfer: { files, types: ['Files'] } }, prevented: () => prevented }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

test('one toolbar holds the type filter, the view switch, Drive sync and the single Upload entry point', () => {
  const view = page(), tree = view.render(), html = text(tree);
  assert.equal(buttons(tree, /^Upload$/).length, 1, 'One primary Upload button.');
  assert.equal((buttons(tree, /^Upload$/)[0].props as Row).variant, 'primary');
  assert.doesNotMatch(html, /Upload a public delivery file|Google Drive assets|Upload to Drive/, 'No second or third way to add media on the page.');
  (buttons(tree, /Sync Drive/)[0].props as Row).onClick(); assert.equal(calls.sync.length, 1);
  assert.match(html, /All assets · 3/); assert.match(html, /Images · 2/);
  const switches = elements(tree).filter(item => item.type === ui.SegmentedControl).map(item => (item.props as Row).label);
  assert.deepEqual(switches, ['Asset type', 'Layout']);
  (buttons(tree, /^Upload$/)[0].props as Row).onClick(); assert.equal(view.states[2], true, 'Upload opens the upload dialog.');
  const dialog = elements(view.render()).find(item => item.type === Dialog && (item.props as Row).title === 'Upload media');
  assert.ok(dialog && (dialog.props as Row).open);
  const field = elements(dialog).find(item => item.type === FileField);
  assert.match(String((field.props as Row).description), /JPG, PNG, WebP, GIF, MP4, PDF or text · up to 5 MB/, 'Accepted types and the size limit are stated before upload.');
  assert.match(text(dialog), /Upload for publishing only/, 'Hosted uploads without Drive stay available inside the one upload entry point.');
});

test('the toolbar explains why Drive cannot sync, and viewers see no Upload button', () => {
  const viewer = page().render({ canWrite: false, driveSyncReason: 'Viewers can review assets but not sync Drive.' });
  assert.equal(buttons(viewer, /^Upload$/).length, 0);
  assert.match(text(viewer), /Viewers can review assets but not sync Drive\./);
  assert.equal((buttons(viewer, /Sync Drive/)[0].props as Row).disabled, true);
  const unmapped = page().render({ drive: { configured: true, mapped: false }, connected: false, driveSyncReason: 'Map a Drive folder to this project in Integrations to sync files.' });
  assert.equal(buttons(unmapped, /^Upload$/).length, 0, 'No Upload button when neither Drive nor hosted upload can accept a file.');
  assert.equal((buttons(unmapped, /Sync Drive/)[0].props as Row).disabled, true);
});

test('cards show the thumbnail, name, approval chip and source, never provider names or delivery files', () => {
  const tree = page().render(), cards = elements(tree).filter(item => item.type === ResourceCard);
  assert.deepEqual(cards.map(card => (card.props as Row).title), ['Hero.jpg', 'Launch film', 'Sample poster']);
  assert.deepEqual(cards.map(card => (card.props as Row).description), ['Image · Drive', 'Video · Uploaded', 'Image · Sample']);
  for (const card of cards) assert.doesNotMatch(text(card), /Zernio|delivery file|Upload delivery/i, (card.props as Row).title);
  assert.match(text((cards[0].props as Row).media), /preview of Hero\.jpg/);
  assert.match(text((cards[0].props as Row).status), /Approved/);
  assert.match(text(cards[1]), /Publishing copy needs renewing/, 'An expired hosted copy is still flagged on its card.');
});

test('View opens the detail view with the preview, details and where the asset is used', () => {
  const view = page(), tree = view.render();
  (buttons(tree, /View Hero\.jpg/)[0].props as Row).onClick();
  assert.equal(view.states[1], 'a1');
  const detail = elements(view.render()).find(item => item.type === Dialog && (item.props as Row).title === 'Hero.jpg');
  assert.ok(detail && (detail.props as Row).open);
  const tabs = elements(detail).find(item => item.type === Tabs), labels = (tabs.props as Row).items.map((item: Row) => text(item.label));
  assert.deepEqual(labels.map((label: string) => label.trim()), ['Details', 'Used in · 3']);
  const details = elements(detail).find(item => item.type === AssetDetails);
  assert.equal((details.props as Row).assetId, 'a1');
  assert.match(text((details.props as Row).preview), /preview of Hero\.jpg/);
  assert.match(text(detail), /Autumn launch/); assert.match(text(detail), /New season is here/); assert.match(text(detail), /Marina screen/);
  assert.doesNotMatch(text(detail), /Unrelated/);
});

test('detail actions reuse the existing editors and keep samples away from providers', () => {
  const view = page([undefined, 'a1']), tree = view.render();
  (buttons(tree, /Prepare for publishing/)[0].props as Row).onClick();
  assert.deepEqual(calls.open, [{ type: 'asset-delivery', item: assets[0] }]); assert.equal(view.states[1], '', 'The detail view closes before the editor opens.');
  const again = page([undefined, 'a1']).render(); (buttons(again, /Edit details/)[0].props as Row).onClick();
  assert.deepEqual(calls.open, [{ type: 'asset', item: assets[0] }]);
  assert.match(text(page([undefined, 'a2']).render()), /Replace publishing copy/);
  const sample = page([undefined, 's1']).render();
  assert.equal(buttons(sample, /Prepare for publishing|Replace publishing copy/).length, 0);
  assert.match(text(sample), /never sent to providers/);
  const viewer = page([undefined, 'a1']).render({ canWrite: false });
  assert.equal(buttons(viewer, /Prepare for publishing|Edit details/).length, 0);
  assert.match(text(viewer), /view-only access/);
  assert.equal(elements(page([undefined, 'gone']).render()).some(item => item.type === Dialog && (item.props as Row).open), false, 'A removed asset closes its detail view.');
});

test('dropping files anywhere on the page uploads each through the existing Drive upload, after the same checks', async () => {
  const view = page(), root = view.render(), zone = elements(root).find(item => (item.props as Row).onDrop);
  assert.ok(zone, 'The page itself is the drop target.');
  const accepted = drop([file('a.png', 'image/png'), file('b.mp3', 'audio/mpeg'), file('c.pdf', 'application/pdf'), file('d.jpg', 'image/jpeg', 6 * 1024 * 1024)]);
  (zone.props as Row).onDrop(accepted.event); await flush();
  assert.ok(accepted.prevented());
  assert.deepEqual(calls.upload, [['a.png'], ['c.pdf']], 'One file per call through the existing upload handler.');
  const tray = view.states[3] as Row[];
  assert.deepEqual(tray.map(item => [item.name, item.status, item.error]), [['b.mp3', 'error', 'Choose a JPG, PNG, WebP, GIF, MP4, PDF, or text file.'], ['d.jpg', 'error', 'Choose a file of at most 5 MB.']], 'Rejected files stay listed with the reason.');
  assert.match(text(view.render()), /b\.mp3/);
  const handled = drop([file('e.png', 'image/png')], true); (zone.props as Row).onDrop(handled.event); await flush();
  assert.deepEqual(calls.upload, [['a.png'], ['c.pdf']], 'A drop the inner drop zone already handled is not uploaded twice.');
  for (const extra of [{ canWrite: false }, { drive: { configured: true, mapped: false } }]) {
    const blocked = elements(page().render(extra)).find(item => (item.props as Row).onDrop), event = drop([file('f.png', 'image/png')]);
    (blocked.props as Row).onDrop(event.event); await flush();
    assert.deepEqual(calls.upload, [], JSON.stringify(extra));
  }
});

test('uploadIssue mirrors the Drive upload rules', () => {
  const { uploadIssue } = page();
  for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'application/pdf', 'text/plain']) assert.equal(uploadIssue(file('x', type)), '', type);
  assert.match(uploadIssue(file('x', 'image/svg+xml')), /Choose a JPG/);
  assert.equal(uploadIssue(file('x', 'image/png', 5 * 1024 * 1024)), '');
  assert.match(uploadIssue(file('x', 'image/png', 5 * 1024 * 1024 + 1)), /at most 5 MB/);
});

test('empty and filtered views say what happened without a stray upload call to action', () => {
  const filtered = page().render({ visibleAssets: [], tab: 'video' }), empty = elements(filtered).find(item => item.type === EmptyState);
  assert.equal((empty.props as Row).title, 'No assets match');
  (buttons(filtered, /Show all types/)[0].props as Row).onClick(); assert.deepEqual(calls.tab, ['all']);
  assert.equal(buttons((empty.props as Row).action, /^Upload/).length, 0);
  const none = page().render({ assets: [], visibleAssets: [] });
  assert.ok(elements(none).some(item => item.type === FileField), 'An empty library shows the drop zone.');
  const unmapped = page().render({ assets: [], visibleAssets: [], drive: { configured: true, mapped: false } });
  (buttons(unmapped, /Choose Drive folder/)[0].props as Row).onClick(); assert.equal(calls.drive.length, 1);
});

test('the list layout shows the same assets in a table', () => {
  const tree = page(['list']).render(), table = elements(tree).find(item => item.type === DataTable);
  assert.ok(table); assert.equal(elements(tree).some(item => item.type === ResourceCard), false);
  assert.match(text(tree), /Hero\.jpg/); assert.match(text(tree), /Approved/);
  assert.equal(buttons(tree, /View Launch film/).length, 1);
});

test('assetUses mirrors the server dependants check', () => {
  const { assetUses } = page();
  assert.deepEqual(assetUses('a1', related).map((use: Row) => use.label), ['Autumn launch', 'New season is here', 'Marina screen']);
  assert.deepEqual(assetUses('missing', related), []);
});

test('the page makes no requests of its own, and main mounts it per project with its related records', () => {
  assert.doesNotMatch(source, /'\/projects|integrate\(|fetch\(/, 'Uploads, sync and saves stay on the existing main.tsx paths.');
  const mount = mainSource.split(/\r?\n/).find(line => line.includes('<AssetLibrary ')) || '';
  assert.match(mount, /^ +\{page === 'Asset library' && <AssetLibrary key=\{state\.projectId\} [^\r\n]*related=\{state\}[^\r\n]*onSetUpDrive=\{\(\) => setPage\('Integrations'\)\}/);
  assert.match(mount, /onUpload=\{uploadAsset\}/);
});
