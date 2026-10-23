import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React, { useEffect, useRef, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import * as ui from '@ten98/ui';
import { ACTIVATION_TYPES, ACTIVATION_TYPE_LABELS } from '../shared/offline-activations.ts';

type Row = Record<string, any>;
const source = await readFile(new URL('../src/OfflineActivations.tsx', import.meta.url), 'utf8');
const { code } = await transformWithOxc(source.replace(/^import .+;\r?\n/gm, '').replace(/^export (default )?/gm, ''), 'OfflineActivations.tsx', { jsx: { runtime: 'classic' } });
const library = ui as unknown as Record<string, unknown>;
const module = new Function('React', 'useEffect', 'useRef', 'useState', 'ACTIVATION_TYPES', 'ACTIVATION_TYPE_LABELS', ...Object.keys(library), code + '; return { OfflineActivations, activationBody, draftFrom, blankDraft };')(React, useEffect, useRef, useState, ACTIVATION_TYPES, ACTIVATION_TYPE_LABELS, ...Object.values(library));
const html = (props: Row) => renderToStaticMarkup(React.createElement(module.OfflineActivations, { projectId: 'p1', campaigns: [], activations: [], request: async () => ({}), onChanged() {}, ...props }));
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

test('the page is built from @ten98/ui only', () => {
  assert.doesNotMatch(source, /className=|style=/, 'No app CSS or inline style.');
  assert.doesNotMatch(code, /createElement\("/, 'No raw HTML elements.');
});
