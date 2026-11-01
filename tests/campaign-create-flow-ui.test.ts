import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { transformWithOxc } from 'vite';
import * as ui from '@ten98/ui';
import { hooks, nodes } from './hook-recorder.ts';
import { campaignCreationChoices, campaignCreationDestination, campaignCreationRoute, type CampaignCreationKind } from '../src/campaign-creation.ts';

const source = await readFile(new URL('../src/CampaignCreateFlow.tsx', import.meta.url), 'utf8');
const { code } = await transformWithOxc(source.replace(/^import .+;\r?\n/gm, '').replace('export default ', ''), 'CampaignCreateFlow.tsx', { jsx: { runtime: 'classic' } });
function mount(initialKind: CampaignCreationKind = 'plan', campaignName?: string) {
  const recorder = hooks(), choices: string[] = [], cancelled: boolean[] = [];
  const Flow = new Function('React', 'useState', 'campaignCreationChoices', 'campaignCreationDestination', ...Object.keys(ui), code + '; return CampaignCreateFlow;')(React, recorder.useState, campaignCreationChoices, campaignCreationDestination, ...Object.values(ui));
  const props = { initialKind, campaignName, onContinue: (value: string) => choices.push(value), onCancel: () => cancelled.push(true) };
  const render = () => recorder.render(Flow, props) as any;
  return { choices, cancelled, render, submit() { render().props.onSubmit({ preventDefault() {} }); } };
}

test('all campaign types share one entry and selection alone performs no creation', () => {
  const expected: Record<CampaignCreationKind, string> = { plan: 'plan', social: 'post', advertising: 'ad', email: 'email', sms: 'sms', whatsapp: 'whatsapp', billboards: 'placement', field: 'activation' };
  assert.deepEqual(campaignCreationChoices.map(choice => choice.value), Object.keys(expected));
  for (const [kind, destination] of Object.entries(expected)) {
    const flow = mount(kind as CampaignCreationKind);
    const group = nodes(flow.render()).find(node => node.type === ui.RadioGroup && node.props.legend === 'Campaign type');
    assert.equal(group.props.value, kind);
    assert.deepEqual(flow.choices, [], 'Rendering and choosing a type do not write anything.');
    flow.submit(); assert.deepEqual(flow.choices, [destination]);
  }
});

test('advertising and billboards reach every maintained provider path', () => {
  for (const [kind, legend, options] of [
    ['advertising', 'Ad service', ['connected', 'google-shopping', 'microsoft-search']],
    ['billboards', 'Booking type', ['manual', 'broadsign']],
  ] as const) {
    const flow = mount(kind);
    for (const value of options) {
      nodes(flow.render()).find(node => node.type === ui.RadioGroup && node.props.legend === legend).props.onValueChange(value);
      assert.deepEqual(flow.choices, [], 'Changing a service does not contact that provider.');
    }
    flow.submit(); assert.deepEqual(flow.choices, [options.at(-1)]);
  }
  assert.deepEqual(campaignCreationRoute('google-shopping'), { page: 'Ads manager', section: 'shopping' });
  assert.deepEqual(campaignCreationRoute('microsoft-search'), { page: 'Ads manager', section: 'microsoft' });
  assert.deepEqual(campaignCreationRoute('broadsign'), { page: 'OOH media', section: '' });
});

test('cancelling creates nothing and unsupported plan association is disclosed', () => {
  const flow = mount('advertising', 'Autumn launch');
  const cancel = nodes(flow.render()).find(node => node.type === ui.Button && node.props.children === 'Cancel');
  cancel.props.onClick(); assert.deepEqual(flow.cancelled, [true]); assert.deepEqual(flow.choices, []);
  const alert = nodes(flow.render()).find(node => node.type === ui.Alert);
  assert.match(alert.props.children, /will not be linked automatically/);
  assert.match(alert.props.children, /Autumn launch/);
});
