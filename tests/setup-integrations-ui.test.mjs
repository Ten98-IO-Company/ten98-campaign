import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import * as ui from '@ten98/ui';

const sources = Object.fromEntries(await Promise.all(['GoogleCalendar', 'UnifiedInbox', 'IntegrationSettings'].map(async name => {
  const source = await readFile(new URL('../src/' + name + '.tsx', import.meta.url), 'utf8');
  const { code } = await transformWithOxc(source.replace(/^import .*;\r?$/gm, '').replace('export default function', 'function'), name + '.tsx', { jsx: { runtime: 'classic' } });
  return [name, code];
})));
const elements = node => Array.isArray(node) ? node.flatMap(elements) : React.isValidElement(node) ? [node, ...elements(node.props.children)] : [];
const text = node => Array.isArray(node) ? node.map(text).join('') : React.isValidElement(node) ? text(node.props.children) : node == null || typeof node === 'boolean' ? '' : String(node);
const button = (tree, label) => { const found = elements(tree).find(node => [ui.Button, 'button'].includes(node.type) && text(node.props.children) === label); assert.ok(found, label); return found; };
const card = (tree, id) => { const found = elements(tree).find(node => node.props?.id === 'integration-' + id); assert.ok(found, id); return found; };
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
  const Component = new Function('React', 'useEffect', 'useRef', 'useState', 'loadGoogleMaps', 'ZernioWebhooks', 'window', ...Object.keys(ui), sources[sourceName] + '; return ' + name + ';')(React, useEffect, useRef, useState, () => { throw new Error('Maps must not load.'); }, () => null, window, ...Object.values(ui));
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

// GoogleCalendar places shared controls in Card actions as well as children.
const calendarElements = node => Array.isArray(node) ? node.flatMap(calendarElements) : React.isValidElement(node) ? [node, ...calendarElements(node.props.children), ...calendarElements(node.props.actions)] : [];
const calendarButton = (tree, label) => { const found = calendarElements(tree).find(node => node.type === ui.Button && text(node.props.children) === label); assert.ok(found, label); return found; };

test('Calendar retains event workflows and navigates to Integrations without a second mapping form', async () => {
  for (const connected of [false, true]) {
    const h = mount('GoogleCalendar'), calls = [];
    let opened = 0;
    const options = { projectId: 'project-a', canWrite: true, onOpenIntegrations: () => opened++, request: async (...args) => { calls.push(args); return { configured: connected, mapped: connected, calendarId: 'shared@example.test' }; } };
    h.render(options); h.flush(); await settle();
    const tree = h.render(options), html = renderToStaticMarkup(tree);
    assert.doesNotMatch(html, /Save calendar connection|Shared calendar ID|service account|type="password"/);
    assert.equal(elements(tree).filter(node => node.type === 'input' && node.props.name === 'calendarId').length, 0);
    calendarButton(tree, 'Open Connections').props.onClick(); assert.equal(opened, 1);
    assert.deepEqual(calls, [['/projects/project-a/calendar/status']]);
    if (connected) { calendarButton(tree, 'Load Google events'); calendarButton(tree, 'Review campaign plan for Google'); assert.match(html, /Create a Google event/); }
    else assert.match(html, /Connect this project’s Google Calendar in Settings › Connections/);
    assert.doesNotMatch(renderToStaticMarkup(h.render({ ...options, onOpenIntegrations: undefined })), /Open Connections/i);
    h.unmount();
  }
});

test('Calendar renders the agenda without a Google connection and offers Edit and Delete only for this project’s managed events to writers', async () => {
  const agendaCalls = [], agenda = eventActions => { agendaCalls.push(eventActions); return React.createElement('div', null, 'Publishing agenda'); };
  const disconnected = mount('GoogleCalendar'), offline = { projectId: 'project-a', canWrite: true, agenda, request: async () => ({ configured: false, mapped: false }) };
  disconnected.render(offline); disconnected.flush(); await settle();
  const offlineHtml = renderToStaticMarkup(disconnected.render(offline));
  assert.match(offlineHtml, /^<div>Publishing agenda<\/div>/, 'The agenda renders first, even before Google is connected.');
  assert.match(offlineHtml, /Connect this project’s Google Calendar in Settings › Connections/);
  assert.doesNotMatch(offlineHtml, /Load Google events/);
  disconnected.unmount();

  const at = hour => ({ start: { dateTime: `2026-10-03T${hour}:00:00Z` }, end: { dateTime: `2026-10-03T${hour}:30:00Z` } });
  const managed = { id: 'managed', etag: 'e1', summary: 'Plan event', managed: true, projectId: 'project-a', htmlLink: 'https://calendar.google.com/event?eid=managed', ...at('09') };
  const otherProject = { ...managed, id: 'other', projectId: 'project-b', ...at('10') }, external = { id: 'external', summary: 'Team sync', htmlLink: 'javascript:alert(1)', ...at('11') };
  const request = async path => path.endsWith('/status') ? { configured: true, mapped: true, calendarId: 'shared@example.test' } : { events: [managed, otherProject, external] };
  for (const canWrite of [true, false]) {
    const h = mount('GoogleCalendar'), options = { projectId: 'project-a', canWrite, agenda, request, fromDate: '2026-10-01', toDate: '2026-10-31' };
    h.render(options); h.flush(); await settle();
    await calendarButton(h.render(options), 'Load Google events').props.onClick(); await settle();
    h.render(options);
    const eventActions = agendaCalls.at(-1), labels = event => calendarElements(eventActions(event)).filter(node => [ui.Button, ui.Link].includes(node.type)).map(node => text(node.props.children));
    assert.deepEqual(labels(managed), canWrite ? ['Open in Google', 'Edit', 'Delete'] : ['Open in Google']);
    assert.deepEqual(labels(otherProject), ['Open in Google'], 'Events managed by another project stay read-only.');
    assert.deepEqual(labels(external), [], 'Unsafe provider links are not rendered.');
    if (canWrite) {
      calendarButton(eventActions(managed), 'Delete').props.onClick();
      const dialog = calendarElements(h.render(options)).find(node => node.type === ui.ConfirmDialog);
      assert.equal(dialog.props.open, true); assert.equal(dialog.props.title, 'Delete this Google event?'); assert.equal(dialog.props.confirmLabel, 'Delete this event from Google'); assert.equal(dialog.props.danger, true);
      for (const detail of ['Plan event', 'Shared calendar: shared@example.test', 'Event ID: managed']) assert.ok(dialog.props.description.includes(detail), detail);
      dialog.props.onOpenChange(false);
      assert.equal(calendarElements(h.render(options)).find(node => node.type === ui.ConfirmDialog).props.open, false, 'Closing the dialog clears the pending deletion.');
      calendarButton(eventActions(managed), 'Edit').props.onClick();
      const form = calendarElements(h.render(options)).find(node => node.type === ui.Disclosure);
      assert.equal(form.props.summary, 'Edit project event'); assert.equal(form.props.defaultOpen, true);
    }
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
  button(tree, 'Refresh SMS replies'); button(tree, 'Open Connections').props.onClick(); assert.equal(opened, 1);
  h.unmount();
});

test('Integrations has one Google credential form, preserves unrelated drafts and tests each Google service independently', async () => {
  const h = mount('IntegrationSettings'), calls = [];
  const options = props(settingsRequest(calls, async () => ({ callbackUrl: 'https://campaign.example.test/inbound/a', publicCallbacks: true })));
  h.render(options); h.flush(); await settle();
  let tree = h.render(options);
  const inputs = elements(tree).filter(node => [ui.Input, ui.Textarea].includes(node.type));
  assert.deepEqual(inputs.filter(node => node.props.name?.endsWith('-serviceAccountEmail')).map(node => node.props.name), ['googleDrive-serviceAccountEmail']);
  assert.deepEqual(inputs.filter(node => node.props.name?.endsWith('-privateKey')).map(node => node.props.name), ['googleDrive-privateKey']);
  assert.equal(elements(card(tree, 'googleCalendar')).filter(node => String(node.props?.name || '').startsWith('googleCalendar-')).length, 0, 'Calendar has no credential form of its own; its card holds only the project calendar mapping.');
  assert.equal(elements(card(tree, 'googleCalendar')).filter(node => node.props?.as === 'form').length, 1);
  const change = (name, value) => elements(tree).find(node => node.props.name === name).props.onChange({ target: { value } });
  change('openrouter-model', 'keep/unsaved');
  change('googleDrive-serviceAccountEmail', 'replacement@example.test');
  change('googleDrive-privateKey', 'exact\nprivate-key\n');
  tree = h.render(options);
  assert.equal(button(card(tree, 'googleCalendar'), 'Test connection').props.disabled, true);
  await elements(card(tree, 'googleDrive')).find(node => node.props?.as === 'form').props.onSubmit({ preventDefault() {} });
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

test('each provider card holds its own project mapping and host sections, and saves only its own field', async () => {
  const h = mount('IntegrationSettings'), calls = [], Section = () => null;
  const options = { ...props(settingsRequest(calls, async () => ({ callbackUrl: 'https://campaign.example.test/inbound/a', publicCallbacks: true }))), sections: { googleAdsNative: React.createElement(Section, { id: 'google' }), zernio: React.createElement(Section, { id: 'zernio' }) }, extraCards: [{ id: 'chatgptAds', title: 'ChatGPT advertising', description: 'Connect.', body: React.createElement(Section, { id: 'chatgpt' }) }] };
  h.render(options); h.flush(); await settle();
  let tree = h.render(options);
  assert.equal(elements(card(tree, 'googleAdsNative')).some(node => node.type === Section && node.props.id === 'google'), true);
  assert.equal(elements(card(tree, 'zernio')).some(node => node.type === Section && node.props.id === 'zernio'), true);
  assert.equal(elements(card(tree, 'chatgptAds')).some(node => node.type === Section && node.props.id === 'chatgpt'), true);
  const field = (id, label) => elements(card(tree, id)).find(node => node.type === ui.Field && node.props.label === label);
  field('zernio', 'Zernio profile ID').props.children.props.onChange({ target: { value: ' profile-z ' } });
  tree = h.render(options);
  field('googleDrive', 'Google Drive folder ID').props.children.props.onChange({ target: { value: 'folder-d' } });
  tree = h.render(options);
  const mappingForm = (id, label) => elements(card(tree, id)).find(node => node.props?.as === 'form' && elements(node).some(child => child.type === ui.Field && child.props.label === label));
  await mappingForm('zernio', 'Zernio profile ID').props.onSubmit({ preventDefault() {} });
  tree = h.render(options);
  await mappingForm('googleDrive', 'Google Drive folder ID').props.onSubmit({ preventDefault() {} });
  assert.deepEqual(calls.filter(call => call[1] === 'PATCH'), [['/projects/project-a', 'PATCH', { zernioProfileId: 'profile-z' }], ['/projects/project-a', 'PATCH', { driveFolderId: 'folder-d' }]]);
  h.unmount();
  const viewer = mount('IntegrationSettings'), viewerCalls = [], viewerProps = { ...props(settingsRequest(viewerCalls, async () => ({}))), isOperator: false, canManageProject: false };
  viewer.render(viewerProps); viewer.flush(); await settle();
  const viewerTree = viewer.render(viewerProps);
  assert.equal(viewerCalls.some(call => call[0] === '/settings/integrations'), false, 'Non-operators never read credentials.');
  assert.ok(card(viewerTree, 'zernio') && card(viewerTree, 'googleDrive'), 'Non-operators still see each provider card with its project connection.');
  assert.equal(elements(card(viewerTree, 'zernio')).some(node => node.type === ui.Button && node.props.type === 'submit'), false, 'Mapping changes stay operator-only.');
  viewer.unmount();
});

test('Amazon SES settings take regions only from the server, never prefill the secret and save the email provider choice', async () => {
  // The region list is deliberately not the runtime's order, so a client copy would not match.
  const ses = { id: 'amazonSes', label: 'Amazon SES email', configured: true, source: 'saved', fields: { emailProvider: '', region: 'eu-west-1', accessKeyId: 'AKIAEXAMPLEEXAMPLE00', fromAddress: 'receipts@example.test', fromName: '', replyToAddress: '', configurationSet: 'feedback', snsTopicArn: '' }, secretFields: { secretAccessKey: { configured: true, source: 'saved' } }, options: { region: ['eu-west-1', 'ap-south-1'] } };
  async function open(provider) {
    const h = mount('IntegrationSettings'), calls = [];
    const options = props(async (...args) => {
      calls.push(args); const [path, method] = args;
      if (path === '/settings/integrations') return { providers: [structuredClone(provider)] };
      if (path.endsWith('/calendar/status')) return { calendarId: '' };
      if (path.endsWith('/sms-inbox/status')) return { callbackUrl: 'https://campaign.example.test/inbound/a', publicCallbacks: true };
      // Stubbed: the real SES test signs AWS reads, which must not run here.
      if (path === '/settings/integrations/amazonSes/test' && method === 'POST') return { ok: true, status: 'connected', message: 'Synthetic SES check.' };
      if (path === '/settings/integrations/amazonSes' && method === 'PUT') return {};
      throw new Error('Unexpected synthetic request: ' + args.join(' '));
    });
    h.render(options); h.flush(); await settle();
    return { h, calls, tree: () => h.render(options) };
  }
  const named = (tree, name) => elements(card(tree, 'amazonSes')).find(node => node.props?.name === 'amazonSes-' + name);
  const fieldOf = (tree, name) => elements(card(tree, 'amazonSes')).find(node => node.type === ui.Field && node.props.children?.props?.name === 'amazonSes-' + name);
  const submit = tree => elements(card(tree, 'amazonSes')).find(node => node.props?.as === 'form').props.onSubmit({ preventDefault() {} });

  const view = await open(ses); let tree = view.tree();
  assert.match(renderToStaticMarkup(tree), /Amazon SES email/);
  const region = named(tree, 'region');
  assert.equal(region.type, ui.Select); assert.equal(region.props.value, 'eu-west-1'); assert.equal(region.props.disabled, false);
  assert.deepEqual(region.props.options.map(option => option.value), ['', 'eu-west-1', 'ap-south-1']);
  const secret = named(tree, 'secretAccessKey');
  assert.equal(secret.type, ui.Input); assert.equal(secret.props.type, 'password'); assert.equal(secret.props.value, ''); assert.equal(secret.props.placeholder, 'Configured — leave blank to keep');
  const choice = named(tree, 'emailProvider');
  assert.equal(choice.type, ui.Select); assert.equal(fieldOf(tree, 'emailProvider').props.label, 'Send email campaigns with');
  assert.deepEqual(choice.props.options, [{ value: '', label: 'Automatic' }, { value: 'cloudflare', label: 'Cloudflare' }, { value: 'ses', label: 'Amazon SES' }]);
  assert.match(fieldOf(tree, 'emailProvider').props.description, /When both are configured, choose one/);
  choice.props.onChange({ target: { value: 'ses' } }); tree = view.tree();
  named(tree, 'region').props.onChange({ target: { value: 'ap-south-1' } }); tree = view.tree();
  await submit(tree);
  assert.deepEqual(view.calls.find(call => call[1] === 'PUT'), ['/settings/integrations/amazonSes', 'PUT', { fields: { emailProvider: 'ses', region: 'ap-south-1' } }], 'The blank secret is not sent.');
  tree = view.tree();
  await button(card(tree, 'amazonSes'), 'Test connection').props.onClick();
  assert.deepEqual(view.calls.filter(call => call[0].endsWith('/test')), [['/settings/integrations/amazonSes/test', 'POST', { projectId: 'project-a' }]]);
  view.h.unmount();

  const automatic = await open({ ...ses, fields: { ...ses.fields, emailProvider: 'cloudflare' } }); tree = automatic.tree();
  named(tree, 'emailProvider').props.onChange({ target: { value: '' } }); tree = automatic.tree();
  await submit(tree);
  assert.deepEqual(automatic.calls.find(call => call[1] === 'PUT')[2], { fields: { emailProvider: '' } }, 'Automatic saves an empty choice.');
  automatic.h.unmount();

  const unlisted = await open({ ...ses, options: undefined }); tree = unlisted.tree();
  assert.equal(named(tree, 'region').type, ui.Select); assert.equal(named(tree, 'region').props.disabled, true);
  assert.deepEqual(named(tree, 'region').props.options.map(option => option.value), [''], 'Without the server list there is no region to choose.');
  assert.match(fieldOf(tree, 'region').props.description, /does not list Amazon SES regions/);
  unlisted.h.unmount();
});
