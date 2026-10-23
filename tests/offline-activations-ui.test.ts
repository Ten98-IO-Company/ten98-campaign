import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React, { useEffect, useRef, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import * as ui from '@ten98/ui';
import { ACTIVATION_TYPES, ACTIVATION_TYPE_LABELS, CONSENT_CHANNELS, CONSENT_LABELS, consentPrompt } from '../shared/offline-activations.ts';

type Row = Record<string, any>;
const source = await readFile(new URL('../src/OfflineActivations.tsx', import.meta.url), 'utf8');
const { code } = await transformWithOxc(source.replace(/^import .+;\r?\n/gm, '').replace(/^export (default )?/gm, ''), 'OfflineActivations.tsx', { jsx: { runtime: 'classic' } });
const library = ui as unknown as Record<string, unknown>;
const module = new Function('React', 'useEffect', 'useRef', 'useState', 'ACTIVATION_TYPES', 'ACTIVATION_TYPE_LABELS', 'CONSENT_CHANNELS', 'CONSENT_LABELS', 'consentPrompt', ...Object.keys(library), code + '; return { OfflineActivations, activationBody, draftFrom, blankDraft, trackingDestination, TrackingLink, leadBody, LeadCapture, rollUp, ResultsSummary };')(React, useEffect, useRef, useState, ACTIVATION_TYPES, ACTIVATION_TYPE_LABELS, CONSENT_CHANNELS, CONSENT_LABELS, consentPrompt, ...Object.values(library));
const html = (props: Row) => renderToStaticMarkup(React.createElement(module.OfflineActivations, { projectId: 'p1', brand: 'Brand launch', campaigns: [], activations: [], request: async () => ({}), onChanged() {}, ...props }));
const campaigns = [{ id: 'c1', name: 'Winter field push', currency: 'GBP' }, { id: 'c2', name: 'Spring sampling', currency: 'AED' }];
const activation = (id: string, startAt: string, extra: Row = {}) => ({ id, name: id, type: 'roadshow', campaignId: 'c1', status: 'planned', startAt, endAt: new Date(Date.parse(startAt) + 8 * 3600000).toISOString(), location: 'City Centre Mall', budget: 1200, spent: 300, reached: 0, materials: [], teamIds: [], ...extra });

test('the editor turns local times into instants and amounts into numbers, and refuses incomplete plans', () => {
  const draft = { ...module.blankDraft('c1'), name: 'Mall stop', startAt: '2026-11-07T10:00', endAt: '2026-11-07T18:00', location: 'Atrium', budget: '1200', spent: '', reached: '40', promoCode: ' MALL10 ' };
  const body = module.activationBody(draft);
  assert.equal(body.startAt, new Date('2026-11-07T10:00').toISOString());
  assert.deepEqual([body.budget, body.spent, body.reached, body.promoCode], [1200, 0, 40, 'MALL10']);
  assert.throws(() => module.activationBody({ ...draft, endAt: '' }), /starts and ends/);
  assert.throws(() => module.activationBody({ ...draft, reached: '2.5' }), /People reached must be a whole number/);
  assert.throws(() => module.activationBody({ ...draft, spent: '-3' }), /Actual spend/);
  const again = module.draftFrom({ ...body, id: 'a1' });
  assert.deepEqual([again.startAt, again.endAt, again.budget, again.reached], ['2026-11-07T10:00', '2026-11-07T18:00', '1200', '40'], 'Saved activations reopen in local time.');
});

test('the list explains what to do first, sorts by start, and shows type, campaign, spend and status', () => {
  const empty = html({});
  assert.match(empty, /Create a campaign first/); assert.match(empty, /<button[^>]*disabled=""[^>]*>New activation/, 'No campaign means nothing to plan against.');
  assert.match(html({ campaigns }), /No field activity planned/);
  const markup = html({ campaigns, activations: [activation('Later stop', '2026-11-14T10:00:00Z', { type: 'door_to_door', status: 'completed' }), activation('First stop', '2026-11-07T10:00:00Z')] });
  assert.ok(markup.indexOf('First stop') < markup.indexOf('Later stop'), 'Earliest first.');
  assert.match(markup, /Door-to-door area · Winter field push/);
  assert.match(markup, /£300 of £1,200/, 'Spend is shown in the campaign currency against the plan.');
  assert.match(markup, /Completed/); assert.match(markup, /aria-label="Edit First stop"/);
  const viewer = html({ campaigns, activations: [activation('First stop', '2026-11-07T10:00:00Z')], readOnly: true });
  assert.doesNotMatch(viewer, /New activation/); assert.match(viewer, /aria-label="View First stop"/);
});

test('each activation gets a tagged landing page, and its link shows the short address, QR code and counts', () => {
  const stopRow = activation('Mall stop', '2026-11-07T10:00:00Z');
  const url = new URL(module.trackingDestination(' https://shop.example.com/winter?ref=1 ', stopRow, 'Winter field push'));
  assert.deepEqual(Object.fromEntries(url.searchParams), { ref: '1', utm_source: 'roadshow', utm_medium: 'offline', utm_campaign: 'Winter field push', utm_content: 'Mall stop' });
  for (const bad of ['shop.example.com', 'http://shop.example.com', 'https://user:secret@shop.example.com']) assert.throws(() => module.trackingDestination(bad, stopRow, ''), /landing page|HTTPS/);
  const markup = renderToStaticMarkup(React.createElement(module.TrackingLink, { link: { name: 'Mall stop', shortUrl: 'https://go.example.com/s/abc', qrSvgUrl: '/api/projects/p1/links/l1/qr.svg', clicks: 1200, qrScans: 85 } }));
  assert.match(markup, /src="\/api\/projects\/p1\/links\/l1\/qr.svg"/); assert.match(markup, /alt="QR code for Mall stop"/);
  assert.match(markup, /https:\/\/go.example.com\/s\/abc/); assert.match(markup, /1,200 link visits · 85 QR scans/); assert.match(markup, /download="Mall stop QR.svg"/);
});

test('lead capture shows the consent wording first, starts unticked, and sends only what was given', () => {
  assert.throws(() => module.leadBody({ name: 'Pat', email: 'pat@example.test', phone: '', channels: [] }), /Without an opt-in nothing is saved/);
  assert.deepEqual(module.leadBody({ name: ' Pat ', email: 'pat@example.test', phone: '', channels: ['email'] }), { name: 'Pat', email: 'pat@example.test', consents: { email: true, sms: false, whatsapp: false } });
  const markup = renderToStaticMarkup(React.createElement(module.LeadCapture, { brand: 'Brand launch', activation: { id: 'a1', name: 'Mall stop' }, request: async () => ({}), path: '/projects/p1/activations', onClose() {} }));
  assert.match(markup, /Ask first: “Yes, Brand launch may send me news and offers by…”/);
  assert.equal((markup.match(/type="checkbox"/g) || []).length, 3); assert.doesNotMatch(markup, /checked=""/, 'Every channel starts unticked.');
  assert.ok(markup.indexOf('Ask first') < markup.indexOf('Mobile number'), 'Consent comes before personal details.');
  assert.match(html({ campaigns, activations: [activation('First stop', '2026-11-07T10:00:00Z'), activation('Called off', '2026-11-08T10:00:00Z', { status: 'cancelled' })] }), /aria-label="Capture leads at First stop"/);
  assert.doesNotMatch(html({ campaigns, activations: [activation('Called off', '2026-11-08T10:00:00Z', { status: 'cancelled' })] }), /Capture leads/, 'Cancelled activations take no leads.');
});

test('results roll up reached, leads, visits, spend and cost per lead, and never add up mixed currencies', () => {
  const rows = [activation('A', '2026-11-07T10:00:00Z', { reached: 300, spent: 400, budget: 1000 }), activation('B', '2026-11-08T10:00:00Z', { reached: 50, spent: 200, budget: 500 })];
  const results = { A: { leads: 10, clicks: 40, qrScans: 12 }, B: { leads: 2, clicks: 0, qrScans: 3 } };
  assert.deepEqual(module.rollUp(rows, results), { reached: 350, leads: 12, visits: 55, budget: 1500, spent: 600, costPerLead: 50 });
  assert.equal(module.rollUp(rows, {}).costPerLead, null);
  const markup = renderToStaticMarkup(React.createElement(module.ResultsSummary, { rows, results, currency: 'GBP' }));
  for (const text of ['350', '12', '55', '£600', 'of £1,500 planned', '£50']) assert.ok(markup.includes(text), text);
  const mixed = renderToStaticMarkup(React.createElement(module.ResultsSummary, { rows, results, currency: null }));
  assert.match(mixed, /Choose one campaign/); assert.doesNotMatch(mixed, /£|AED/);
  assert.match(renderToStaticMarkup(React.createElement(module.ResultsSummary, { rows, results: null, currency: 'GBP' })), /Loading/, 'Leads are never shown as 0 while loading.');
});

test('the page is built from @ten98/ui only', () => {
  assert.doesNotMatch(source, /className=|style=/, 'No app CSS or inline style.');
  assert.doesNotMatch(code, /createElement\("/, 'No raw HTML elements.');
});
