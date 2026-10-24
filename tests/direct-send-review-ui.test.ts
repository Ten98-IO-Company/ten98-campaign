// Journey 3 (QA round 3): from a new email to the final send confirmation without a separate "Save and check audience"
// step. DirectCampaigns runs with recorded hooks and an in-memory request; nothing is sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { transformWithOxc } from 'vite';
import * as ui from '@ten98/ui';
import { hooks, nodes } from './hook-recorder.ts';

type Row = Record<string, any>;
const strip = (text: string) => text.replace(/^import .+;\r?\n/gm, '').replace(/^export (default )?/gm, '');
const compile = async (file: string) => (await transformWithOxc(strip(await readFile(new URL('../src/' + file, import.meta.url), 'utf8')), file, { jsx: { runtime: 'classic' } })).code;
// The recorded hooks are not React's, so the library's useFocusReturn (React hooks inside) is replaced by a no-op.
const library: Record<string, unknown> = { ...ui, useFocusReturn: () => () => {} };
const templateCode = await compile('WhatsAppTemplate.tsx'), directCode = await compile('DirectCampaigns.tsx');
const template = new Function('React', ...Object.keys(library), templateCode + '; return { WhatsAppTemplate, templateRestriction, templatePreviewText, templateMissing };')(React, ...Object.values(library));
const tick = () => new Promise(resolve => setImmediate(resolve));
const text = (node: any): string => Array.isArray(node) ? node.map(text).join('') : React.isValidElement(node) ? text((node.props as Row).children) : node == null || node === false ? '' : String(node);

test('Review and send saves the draft, checks the audience and opens the final confirmation, sending nothing', async () => {
  const h = hooks(), calls: [string, string | undefined][] = [];
  const { DirectCampaigns } = new Function('React', 'useEffect', 'useRef', 'useState', 'WhatsAppTemplate', 'templateRestriction', 'templatePreviewText', 'templateMissing', 'useRevealPanel', ...Object.keys(library), directCode + '; return { DirectCampaigns };')(
    React, h.useEffect, h.useRef, h.useState, template.WhatsAppTemplate, template.templateRestriction, template.templatePreviewText, template.templateMissing, () => {}, ...Object.values(library));
  const saved = { id: 'm1', name: 'Your receipt', channel: 'email', status: 'draft', subject: 'Your receipt', text: 'Thanks', html: '', emailPurpose: 'transactional', contactIds: [], tags: [] };
  const request = async (path: string, method?: string) => {
    calls.push([path, method]);
    if (path.endsWith('/status')) return { providers: { email: true, sms: true, whatsapp: false }, emailProvider: 'ses', marketingAvailable: true, publicCallbacks: true, accounts: [] };
    if (path.endsWith('/campaigns') && !method) return { campaigns: [] };
    if (path.endsWith('/contacts') && !method) return { contacts: [{ id: 'c1', name: 'Ana', email: 'ana@example.com', consents: { email: true } }] };
    if (path.endsWith('/campaigns') && method === 'POST') return { campaign: saved };
    if (path.endsWith('/campaigns/m1/preview')) return { campaign: saved, previewToken: 'review-1', audience: { total: 1, eligible: 1, excluded: 0 } };
    throw new Error('Unexpected request ' + method + ' ' + path);
  };
  const props = { projectId: 'p1', request };
  const settle = async () => { for (let round = 0; round < 6; round++) { h.render(DirectCampaigns, props); h.flush(); await tick(); } return nodes(h.render(DirectCampaigns, props)); };
  let tree = await settle();
  nodes(tree.find(node => node.type === ui.Popover && nodes(node.props.children).some(item => item.type === ui.Button && text(item.props.children).includes('SMS'))).props.children)
    .find(item => item.type === ui.Button && text(item.props.children).includes('Email')).props.onClick();
  tree = await settle();
  tree.find(node => node.type === ui.Input && node.props.maxLength === 200 && 'value' in node.props).props.onChange({ target: { value: 'Your receipt' } });
  tree = await settle();
  tree.find(node => node.type === ui.Textarea && node.props.maxLength === 100000).props.onChange({ target: { value: 'Thanks' } });
  tree = await settle();
  // Stand in for the DOM form the browser would validate.
  tree.find(node => node.type === ui.Form && node.props.ref).props.ref.current = { reportValidity: () => true };
  assert.equal(tree.some(node => node.type === ui.Button && text(node.props.children) === 'Save and check audience' && node.props.disabled), false);
  const primary = tree.find(node => node.type === ui.Button && text(node.props.children) === 'Review and send');
  assert.ok(primary, 'With only the audience check missing, the primary button reads Review and send.'); assert.equal(primary.props.disabled, false);
  primary.props.onClick();
  tree = await settle();
  assert.deepEqual(calls.filter(([, method]) => method === 'POST').map(([path]) => path), ['/projects/p1/direct/campaigns', '/projects/p1/direct/campaigns/m1/preview'], 'It saves the draft (named by its subject) and checks the audience.');
  assert.ok(tree.some(node => node.type === ui.ReviewConfirm), 'The existing final confirmation opens.');
  assert.equal(calls.some(([path]) => /\/(send|schedule)$/.test(path)), false, 'Nothing is sent before that confirmation.');
});
