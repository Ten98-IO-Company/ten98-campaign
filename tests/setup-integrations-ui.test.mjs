import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import { ReviewSummary } from '@ten98/ui';

const sources = Object.fromEntries(await Promise.all(['GoogleCalendar', 'UnifiedInbox', 'IntegrationSettings'].map(async name => {
  const source = await readFile(new URL('../src/' + name + '.tsx', import.meta.url), 'utf8');
  const { code } = await transformWithOxc(source.replace(/^import .*;\r?$/gm, '').replace('export default function', 'function'), name + '.tsx', { jsx: { runtime: 'classic' } });
  return [name, code];
})));
const elements = node => Array.isArray(node) ? node.flatMap(elements) : React.isValidElement(node) ? [node, ...elements(node.props.children)] : [];
const text = node => Array.isArray(node) ? node.map(text).join('') : React.isValidElement(node) ? text(node.props.children) : node == null || typeof node === 'boolean' ? '' : String(node);
const button = (tree, label) => { const found = elements(tree).find(node => node.type === 'button' && text(node.props.children) === label); assert.ok(found, label); return found; };
const card = (tree, id) => { const found = elements(tree).find(node => node.type === 'section' && node.props['aria-labelledby'] === 'integration-' + id); assert.ok(found, id); return found; };
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

// Execute the actual component with deterministic hook lifecycles, without a browser or providers.
function mount(sourceName, name = sourceName) {
  const states = [], refs = [], effects = [], updates = [];
  let stateIndex, refIndex, effectIndex;
  const useState = initial => {
    const index = stateIndex++;
    if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
    return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; updates.push(index); }];
  };
  const useRef = initial => refs[refIndex++] ||= { current: initial };
  const useEffect = (callback, deps) => {
    const index = effectIndex++, previous = effects[index];
    if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) effects[index] = { deps, callback, cleanup: previous?.cleanup };
  };
  const window = { addEventListener() {}, removeEventListener() {}, setInterval: () => 1, clearInterval() {}, confirm: () => true, location: { origin: 'https://campaign.example.test' } };
  const Component = new Function('React', 'useEffect', 'useRef', 'useState', 'ReviewSummary', 'loadGoogleMaps', 'ZernioWebhooks', 'window', sources[sourceName] + '; return ' + name + ';')(React, useEffect, useRef, useState, ReviewSummary, () => { throw new Error('Maps must not load.'); }, () => null, window);
  return {
    updates,
    render(props) { stateIndex = refIndex = effectIndex = 0; return Component(props); },
    flush() { for (const effect of effects) if (effect.callback) { effect.cleanup?.(); effect.cleanup = effect.callback(); effect.callback = null; } },
    unmount() { effects.forEach(effect => effect.cleanup?.()); },
  };
}

const provider = id => ({ id, label: { googleDrive: 'Google Drive', googleCalendar: 'Google Calendar', twilio: 'Twilio', openrouter: 'OpenRouter' }[id], configured: true, source: 'saved', fields: { serviceAccountEmail: 'saved@example.test', model: 'saved/model' }, secretFields: { privateKey: { configured: true, source: 'saved' } } });
const providers = ['googleDrive', 'googleCalendar', 'twilio', 'openrouter'].map(provider);
const props = request => ({ project: { id: 'project-a' }, isOperator: true, canManageProject: true, request });
function settingsRequest(calls, sms) {
  return async (...args) => {
    calls.push(args);
    const [path, method] = args;
    if (path === '/settings/integrations') return { providers: structuredClone(providers) };
    if (path.endsWith('/calendar/status')) return { calendarId: 'shared@example.test' };
    if (path.endsWith('/sms-inbox/status')) return sms(path);
    if (path.endsWith('/test') && method === 'POST') return { ok: true, status: 'connected', message: 'Synthetic connection check.' };
    if (path === '/settings/integrations/googleDrive' && ['PUT', 'DELETE'].includes(method)) return {};
    throw new Error('Unexpected synthetic request: ' + args.join(' '));
  };
}

test('Calendar retains event workflows and navigates to Integrations without a second mapping form', async () => {
  for (const connected of [false, true]) {
    const h = mount('GoogleCalendar'), calls = [];
    let opened = 0;
    const options = { projectId: 'project-a', canWrite: true, onOpenIntegrations: () => opened++, request: async (...args) => { calls.push(args); return { configured: connected, mapped: connected, calendarId: 'shared@example.test' }; } };
    h.render(options); h.flush(); await settle();
    const tree = h.render(options), html = renderToStaticMarkup(tree);
    assert.doesNotMatch(html, /Save calendar connection|Shared calendar ID|service account|type="password"/);
    assert.equal(elements(tree).filter(node => node.type === 'input' && node.props.name === 'calendarId').length, 0);
    button(tree, 'Open Integrations').props.onClick(); assert.equal(opened, 1);
    assert.deepEqual(calls, [['/projects/project-a/calendar/status']]);
    if (connected) { button(tree, 'Load Google events'); button(tree, 'Review campaign plan for Google'); assert.match(html, /Create a Google event/); }
    else assert.match(html, /Connect this project’s Google Calendar in Integrations/);
    assert.doesNotMatch(renderToStaticMarkup(h.render({ ...options, onOpenIntegrations: undefined })), /Open Integrations/);
    h.unmount();
  }
});

test('SMS inbox keeps consent and STOP guidance, history and setup navigation without exposing a webhook', async () => {
  const h = mount('UnifiedInbox', 'SmsInbox');
  let opened = 0;
  const options = { projectId: 'project-a', readOnly: true, onDraftChange() {}, onSwitch() {}, onOpenIntegrations: () => opened++, request: async path => path.endsWith('/status') ? { configured: false, callbackUrl: 'https://private.example.test/must-stay-in-integrations' } : { conversations: [], pagination: {} } };
  h.render(options); h.flush(); await settle();
  const tree = h.render(options), html = renderToStaticMarkup(tree);
  assert.match(html, /Replies do not grant marketing permission\. STOP opt-outs block further replies\./);
  assert.match(html, /Previously received messages remain available/);
  assert.doesNotMatch(html, /Incoming-message webhook|must-stay-in-integrations|Configure the Twilio/);
  button(tree, 'Refresh SMS replies'); button(tree, 'Open Integrations').props.onClick(); assert.equal(opened, 1);
  h.unmount();
});

test('Integrations has one Google credential form, preserves unrelated drafts and tests each Google service independently', async () => {
  const h = mount('IntegrationSettings'), calls = [];
  const options = props(settingsRequest(calls, async () => ({ callbackUrl: 'https://campaign.example.test/inbound/a', publicCallbacks: true })));
  h.render(options); h.flush(); await settle();
  let tree = h.render(options);
  const inputs = elements(tree).filter(node => ['input', 'textarea'].includes(node.type));
  assert.deepEqual(inputs.filter(node => node.props.name?.endsWith('-serviceAccountEmail')).map(node => node.props.name), ['googleDrive-serviceAccountEmail']);
  assert.deepEqual(inputs.filter(node => node.props.name?.endsWith('-privateKey')).map(node => node.props.name), ['googleDrive-privateKey']);
  assert.equal(elements(card(tree, 'googleCalendar')).filter(node => node.type === 'form').length, 0);
  const change = (name, value) => elements(tree).find(node => node.props.name === name).props.onChange({ target: { value } });
  change('openrouter-model', 'keep/unsaved');
  change('googleDrive-serviceAccountEmail', 'replacement@example.test');
  change('googleDrive-privateKey', 'exact\nprivate-key\n');
  tree = h.render(options);
  assert.equal(button(card(tree, 'googleCalendar'), 'Test connection').props.disabled, true);
  await elements(card(tree, 'googleDrive')).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.deepEqual(calls.find(call => call[1] === 'PUT'), ['/settings/integrations/googleDrive', 'PUT', { fields: { serviceAccountEmail: 'replacement@example.test', privateKey: 'exact\nprivate-key\n' } }]);
  tree = h.render(options);
  assert.equal(elements(tree).find(node => node.props.name === 'openrouter-model').props.value, 'keep/unsaved');
  for (const id of ['googleDrive', 'googleCalendar']) {
    tree = h.render(options);
    const testButton = button(card(tree, id), 'Test connection'); assert.equal(testButton.props.disabled, false);
    await testButton.props.onClick();
  }
  assert.deepEqual(calls.filter(call => call[0].endsWith('/test')), [
    ['/settings/integrations/googleDrive/test', 'POST', { projectId: 'project-a' }],
    ['/settings/integrations/googleCalendar/test', 'POST', { projectId: 'project-a' }],
  ]);
  h.unmount();
});

test('Integrations SMS setup rejects late project responses and hides an old URL before effects run', async () => {
  const h = mount('IntegrationSettings'), calls = [], a = deferred(), b = deferred(), c = deferred();
  const request = settingsRequest(calls, path => path.includes('/project-a/') ? a.promise : path.includes('/project-b/') ? b.promise : c.promise);
  const aProps = props(request), bProps = { ...aProps, project: { id: 'project-b' } }, cProps = { ...aProps, project: { id: 'project-c' } };
  h.render(aProps); h.flush(); await settle();
  h.render(bProps); h.flush(); await settle();
  b.resolve({ callbackUrl: 'https://campaign.example.test/inbound/project-b', publicCallbacks: true }); await settle();
  assert.match(renderToStaticMarkup(h.render(bProps)), /inbound\/project-b/);
  a.resolve({ callbackUrl: 'https://campaign.example.test/inbound/project-a', publicCallbacks: true }); await settle();
  assert.doesNotMatch(renderToStaticMarkup(h.render(bProps)), /inbound\/project-a/);
  assert.doesNotMatch(renderToStaticMarkup(h.render(cProps)), /inbound\/project-b/, 'Project scope must hide the old URL even before cleanup runs.');
  h.flush();
  const count = h.updates.length; h.unmount();
  c.resolve({ callbackUrl: 'https://campaign.example.test/inbound/project-c', publicCallbacks: true }); await settle();
  assert.equal(h.updates.length, count);
  assert.deepEqual(calls.filter(call => call[0].endsWith('/sms-inbox/status')).map(call => call[0]), ['/projects/project-a/sms-inbox/status', '/projects/project-b/sms-inbox/status', '/projects/project-c/sms-inbox/status']);
});

test('SMS webhook setup requires operator and project management access and handles unavailable or local setup', async () => {
  for (const permissions of [{ isOperator: false, canManageProject: true }, { isOperator: true, canManageProject: false }]) {
    const h = mount('IntegrationSettings'), calls = [], options = { ...props(settingsRequest(calls, () => { throw new Error('Must not read SMS setup.'); })), ...permissions };
    h.render(options); h.flush(); await settle();
    assert.equal(calls.some(call => call[0].endsWith('/sms-inbox/status')), false);
    assert.doesNotMatch(renderToStaticMarkup(h.render(options)), /Incoming SMS webhook/); h.unmount();
  }
  const late = deferred(), revoked = mount('IntegrationSettings');
  const authorized = props(settingsRequest([], () => late.promise)), readOnly = { ...authorized, canManageProject: false };
  revoked.render(authorized); revoked.flush(); await settle();
  revoked.render(readOnly); revoked.flush();
  late.resolve({ callbackUrl: 'https://campaign.example.test/inbound/revoked-project', publicCallbacks: true }); await settle();
  assert.doesNotMatch(renderToStaticMarkup(revoked.render(readOnly)), /Incoming SMS webhook|revoked-project/);
  revoked.unmount();
  for (const response of [{ callbackUrl: 'http://localhost:3320/inbound/project-a', publicCallbacks: false }, {}, { callbackUrl: 'https://campaign.example.test/inbound/project-a', publicHttps: true }]) {
    const h = mount('IntegrationSettings'), options = props(settingsRequest([], async () => response));
    h.render(options); h.flush(); await settle();
    const html = renderToStaticMarkup(h.render(options));
    if (response.publicCallbacks === false) { assert.match(html, /http:\/\/localhost:3320\/inbound\/project-a/); assert.match(html, /Use a public HTTPS app address/); }
    else { assert.match(html, /SMS webhook settings could not be read/); assert.doesNotMatch(html, /Incoming-message webhook URL/); }
    h.unmount();
  }
});
