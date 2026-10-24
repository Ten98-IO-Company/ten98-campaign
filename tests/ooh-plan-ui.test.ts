import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import * as ui from '@ten98/ui';
import { assertNoMarkup, readText } from './read-text.ts';

type Row = Record<string, any>;
const library = ui as unknown as Record<string, any>;
const { Button, DataTable, EmbedHost, Fieldset, MetricGrid, Tabs } = library;
const read = (name: string) => readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
const [mapSource, providerSource, mainSource] = await Promise.all([read('OohMap.tsx'), read('OohProviders.tsx'), read('main.tsx')]);
const compile = async (source: string, file: string) => (await transformWithOxc(source.replace(/^import .+;\r?\n/gm, '').replace(/^export (default )?/gm, ''), file, { jsx: { runtime: 'classic' } })).code;
const [mapCode, providerCode] = await Promise.all([compile(mapSource, 'OohMap.tsx'), compile(providerSource, 'OohProviders.tsx')]);

// Hooks are mocked by call order so a test can put the component in a state its effects would reach in a browser.
function hooks(states: unknown[]) {
  const refs: { current: unknown }[] = []; let stateIndex = 0, refIndex = 0;
  return {
    reset() { stateIndex = 0; refIndex = 0; },
    useState: (initial: unknown) => { const index = stateIndex++; if (!(index in states)) states[index] = initial; return [states[index], (value: any) => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; },
    useRef: (initial: unknown) => refs[refIndex++] ||= { current: initial },
    useEffect: () => {}
  };
}
const elements = (node: any): any[] => Array.isArray(node) ? node.flatMap(elements)
  : React.isValidElement(node) ? [node, ...elements((node.props as Row).children), ...elements((node.props as Row).actions), ...((node.props as Row).items || []).flatMap((item: Row) => elements(item.content)),
    ...(node.type === DataTable ? elements((node.props as Row).rows.flatMap((row: Row) => [...(node.props as Row).columns.map((column: Row) => column.render?.(row)), (node.props as Row).rowActions?.(row)])) : [])] : [];
// Visible text read by splitting on tags in one pass (not a sanitiser).
const text = (node: any): string => readText(renderToStaticMarkup(React.createElement(React.Fragment, null, node)));

function oohMap(states: unknown[]) {
  const mock = hooks(states);
  const module = new Function('React', 'useEffect', 'useRef', 'useState', 'ui', `const {${Object.keys(library).join(',')}} = ui;` + mapCode + '; return { OohMap, BookingFields };')(React, mock.useEffect, mock.useRef, mock.useState, library);
  return { ...module, render: (props: Row) => { mock.reset(); return module.OohMap(props); } };
}
const placements = [
  { id: 'p1', name: 'Marina screen', type: 'digital', status: 'live', location: 'Dubai Marina', latitude: 25.08, longitude: 55.14, providerId: 'v1', startDate: '2026-11-01', endDate: '2026-11-30', cost: 4200, currency: 'AED', proofUrl: 'https://proof.example.test/p1' },
  { id: 'p2', name: 'Mall face', type: 'billboard', status: 'booked', location: 'Mall road', latitude: null, longitude: null, source: 'broadsign', startDate: '2026-12-01', endDate: '2026-12-10', cost: null }
];
const props = (extra: Row = {}) => ({ projectId: 'p', request: async () => ({}), locations: placements, placements, visible: placements, partners: [{ id: 'v1', name: 'Gulf Outdoor' }], canWrite: true, canManageMaps: false,
  formatCost: (value: unknown, currency = 'AED') => value == null ? '—' : `${currency} ${value}`, formatDate: (value: string) => value || 'Not set', onSelect() {}, onOpen() {}, ...extra });

test('the bookings view leads with its stats, then the list, and shows no map placeholder when Maps is off', () => {
  // States in call order: config, error, ready.
  const off = oohMap([{ configured: false }, '', false]), tree = off.render(props()), nodes = elements(tree);
  const order = nodes.map(node => node.type);
  assert.ok(order.indexOf(MetricGrid) >= 0 && order.indexOf(MetricGrid) < order.indexOf(DataTable), 'Stats sit above the list.');
  assert.match(text(nodes.find(node => node.type === MetricGrid)), /Live placements 1 .*Media partners 1 .*Locations 2/);
  assert.equal(nodes.some(node => node.type === EmbedHost), false, 'No empty map card.');
  assert.doesNotMatch(text(tree), /Put your placements on the map|Google Maps/, 'Members who cannot enable Maps see no setup hint.');
  assert.match(text(off.render(props({ canManageMaps: true }))), /Google Maps is off/, 'One hint for whoever can enable it.');
  const loading = oohMap([null, '', false]);
  assert.equal(elements(loading.render(props())).some(node => node.type === EmbedHost), false, 'The map appears only once Maps is known to be configured.');
});

test('with Maps configured the list and map share the row, and a failed map falls back to the list with an admin-only reason', () => {
  const on = oohMap([{ configured: true, browserKey: 'k' }, '', true]), nodes = elements(on.render(props()));
  const host = nodes.find(node => node.type === EmbedHost);
  assert.ok(host); assert.match(text(on.render(props())), /1 on map · 1 not on map/);
  const failed = oohMap([{ configured: true }, 'Google Maps could not authorize this site.', false]);
  assert.equal(elements(failed.render(props())).some(node => node.type === EmbedHost), false, 'A broken map is never rendered.');
  assert.doesNotMatch(text(failed.render(props())), /could not authorize/);
  assert.match(text(failed.render(props({ canManageMaps: true }))), /could not authorize/);
});

test('each booking row shows status, dates and cost, and opens the booking it names', () => {
  const view = oohMap([{ configured: false }, '', false]), opened: Row[] = [];
  const nodes = elements(view.render(props({ onOpen: (row: Row) => opened.push(row) })));
  const table = nodes.find(node => node.type === DataTable);
  assert.equal(table.props.ariaLabel, 'OOH bookings'); assert.deepEqual(table.props.rows, placements);
  const row = text(table.props.columns.map((column: Row) => column.render(placements[0])));
  for (const value of ['Marina screen', 'Digital', 'Gulf Outdoor', 'Dubai Marina', 'Live', '2026-11-01 – 2026-11-30', 'AED 4200']) assert.ok(row.includes(value), value);
  assert.match(text(table.props.columns.map((column: Row) => column.render(placements[1]))), /Not reported/, 'An unknown provider cost is not shown as 0.');
  const buttons = nodes.filter(node => node.type === Button);
  assert.deepEqual(buttons.map(node => node.props['aria-label']), ['Edit booking for Marina screen', 'View booking for Mall face'], 'Provider-managed bookings open read-only.');
  buttons[1].props.onClick(); assert.deepEqual(opened, [placements[1]]);
  table.props.onRowActivate(placements[0]); assert.deepEqual(opened, [placements[1], placements[0]]);
  assert.match(text(table.props.rowActions(placements[0])), /Proof/);
  assert.deepEqual(elements(view.render(props({ canWrite: false }))).filter(node => node.type === Button).map(node => node.props.children), ['View booking', 'View booking']);
  const empty = elements(view.render(props({ visible: [] }))).find(node => node.type === DataTable);
  assert.match(text(empty.props.emptyState), /No placements match this search/);
  assert.match(text(elements(view.render(props({ placements: [], visible: [], locations: [] }))).find(node => node.type === DataTable).props.emptyState), /No OOH placements/);
});

test('the booking form is grouped, shows at most 8 fields before More, and submits the same fields as before', () => {
  const { BookingFields } = oohMap([]);
  const fields = (item?: Row) => React.createElement(BookingFields, { item, partners: [{ id: 'v1', name: 'Gulf Outdoor' }], campaigns: [{ id: 'c1', name: 'Launch' }] });
  const html = renderToStaticMarkup(fields());
  const legends = [...html.matchAll(/<legend[^>]*>(.*?)<\/legend>/g)].map(match => readText(match[1], ''));
  for (const legend of legends) assertNoMarkup(legend, 'Legend text still contains markup.');
  assert.deepEqual(legends.filter(legend => legend !== 'Booking dates'), ['Placement', 'Where', 'When &amp; cost', 'Campaign &amp; status']);
  const names = [...html.matchAll(/name="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual([...new Set(names)].sort(), ['campaignId', 'cost', 'currency', 'endDate', 'latitude', 'location', 'longitude', 'name', 'notes', 'proofUrl', 'providerId', 'startDate', 'status', 'type']);
  // Fields shown before More: every labelled control outside the two disclosures, with the date range as one field.
  const beforeMore = html.slice(0, html.indexOf('>More<')).replace(/<details[\s\S]*?<\/details>/g, '').replace(/<fieldset class="t98-date-range"[\s\S]*?<\/fieldset>/, '<input data-range=""/>');
  const visible = (beforeMore.match(/<(input|select|textarea)\b(?![^>]*type="hidden")/g) || []).length;
  assert.ok(visible <= 8, `${visible} fields before More`);
  assert.match(html, /<summary[^>]*>(<span[^>]*>)?Set exact position</); assert.ok(html.indexOf('name="latitude"') > html.indexOf('Set exact position'));
  assert.ok(html.indexOf('name="proofUrl"') > html.indexOf('>More<') && html.indexOf('name="notes"') > html.indexOf('>More<'));
  const status = html.match(/<input[^>]*name="status"[^>]*>/)?.[0] || '';
  assert.match(status, /type="hidden"/); assert.match(status, /value="draft"/, 'New bookings start as Draft, as before.');
  // From a campaign page: the campaign is preselected and the booking is still new (Draft).
  const preset = renderToStaticMarkup(React.createElement(BookingFields, { partners: [], campaigns: [{ id: 'c1', name: 'Launch' }], defaultCampaignId: 'c1' }));
  assert.match(preset, /<option value="c1" selected="">Launch<\/option>/); assert.match(preset, /name="status"[^>]*value="draft"|value="draft"[^>]*name="status"/);
  const saved = { id: 'p1', name: 'Marina screen', type: 'digital', status: 'live', location: 'Dubai Marina', latitude: 25.08, longitude: 55.14, providerId: 'v1', campaignId: 'c1', startDate: '2026-11-01T00:00:00.000Z', endDate: '2026-11-30', cost: 4200, currency: 'USD', proofUrl: 'https://proof.example.test/p1', notes: 'Night slot' };
  const edit = renderToStaticMarkup(fields(saved));
  for (const value of ['value="Marina screen"', 'value="Dubai Marina"', 'value="25.08"', 'value="55.14"', 'value="4200"', 'value="2026-11-01"', 'value="2026-11-30"', 'value="https://proof.example.test/p1"', 'Night slot']) assert.ok(edit.includes(value), value);
  for (const [name, value] of [['type', 'digital'], ['providerId', 'v1'], ['campaignId', 'c1'], ['currency', 'USD'], ['status', 'live']]) assert.match(edit, new RegExp(`name="${name}"[\\s\\S]*?<option value="${value}" selected=""`), name);
  assert.match(renderToStaticMarkup(fields({ ...saved, source: 'broadsign', cost: null })), /name="cost"[^>]*value=""/, 'An unreported provider cost stays empty, not 0.');
  assert.match(html, /name="cost"[^>]*value="0"|value="0"[^>]*name="cost"/);
});

function oohProviders(states: unknown[]) {
  const mock = hooks(states);
  const Component = new Function('React', 'adSpendBlock', 'AdSpendNotice', 'useEffect', 'useRef', 'useState', 'ui', `const {${Object.keys(library).join(',')}} = ui;` + providerCode + '; return OohProviders;')(React, () => null, () => null, mock.useEffect, mock.useRef, mock.useState, library);
  return (extra: Row = {}) => { mock.reset(); return Component({ projectId: 'p', role: 'editor', isOperator: false, request: async () => ({}), bookings: React.createElement(library.Text, null, 'Bookings view'), ...extra }); };
}

test('the OOH page shows Bookings and Inventory tabs only when Broadsign is connected, and inventory leads with dates and budget', () => {
  const status = { configured: true, environment: 'sandbox', connection: { clientName: 'Exact client', screenIds: [101, 202] } };
  const inventory = [{ id: 101, name: 'North face', location: 'Airport road', latitude: null, longitude: null }, { id: 202, name: 'South face', latitude: null, longitude: null }];
  // States in call order: status, inventory, bookings, selected, busy, error, notice, availability, refreshRequired, spendBlock, view.
  const render = oohProviders([status, inventory, [], [202], false, '', '', {}, false, null, 'bookings']), tree = render(), nodes = elements(tree);
  const tabs = nodes.find(node => node.type === Tabs);
  assert.ok(tabs); assert.deepEqual(tabs.props.items.map((item: Row) => item.label), ['Bookings', 'Inventory']);
  assert.equal(text(tabs.props.items[0].content).trim(), 'Bookings view');
  const inventoryTab = elements(tabs.props.items[1].content), order = inventoryTab.map(node => node.type);
  const dates = inventoryTab.find(node => node.type === Fieldset && node.props.legend === 'Dates and budget');
  assert.ok(dates, 'Dates and budget come first.'); assert.ok(order.indexOf(Fieldset) < order.indexOf(DataTable));
  assert.match(text(dates), /Start date.*End date.*Provider quote/);
  assert.match(text(tabs.props.items[1].content), /1 of 2 screens selected/, 'The selection total is shown with the list.');
  const save = inventoryTab.find(node => node.type === Button && node.props.type === 'submit' && /Save provider proposal/.test(text(node.props.children)));
  assert.ok(save); assert.equal(save.props.disabled, false);
  const none = elements(oohProviders([status, inventory, [], [], false, '', '', {}, false, null, 'bookings'])());
  assert.equal(none.find(node => node.type === Button && node.props.type === 'submit').props.disabled, true, 'Nothing selected, nothing to save.');
  const unconnected = oohProviders([{ configured: true, environment: 'sandbox', connection: null }, [], [], [], false, '', '', {}, false, null, 'bookings']);
  assert.equal(elements(unconnected()).some(node => node.type === Tabs), false, 'Without Broadsign the page is the bookings view alone.');
  assert.match(text(unconnected()), /Bookings view/); assert.doesNotMatch(text(unconnected()), /Sync provider inventory|Broadsign/);
  assert.match(text(unconnected({ role: 'admin', isOperator: true })), /Broadsign/, 'Whoever can map inventory is told where to connect it.');
  assert.doesNotMatch(text(oohProviders([null, [], [], [], false, '', '', {}, false, null, 'bookings'])()), /Bookings view/, 'The bookings view mounts once, after the provider status is known.');
  assert.match(text(oohProviders([null, [], [], [], false, 'Load failed', '', {}, false, null, 'bookings'])()), /Load failed.*Bookings view/);
});

test('main wires the OOH page through the plan view and the grouped booking form', () => {
  assert.match(mainSource, /<OohProviders onOpenIntegrations=\{\(\) => setPage\('Integrations'\)\}[^\r\n]*?bookings=\{<OohMap /);
  // A booking started from a campaign page preselects that campaign; editing keeps the booking's own.
  assert.match(mainSource, /\{modal\.type === 'placement' && <BookingFields item=\{modal\.item\} partners=\{state\.providers\} campaigns=\{state\.campaigns\} defaultCampaignId=\{modal\.campaignId\}\/>\}/);
  assert.doesNotMatch(mainSource, /label="Latitude"|<Stat label="Live placements"/, 'The page and form no longer live in main.');
});

test('the OOH views use @ten98/ui only', () => {
  for (const [source, code] of [[mapSource, mapCode], [providerSource, providerCode]]) {
    assert.doesNotMatch(source, /className=|style=/);
    assert.doesNotMatch(code, /React\.createElement\("/, 'No raw HTML elements.');
  }
});
