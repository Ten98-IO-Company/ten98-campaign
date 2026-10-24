import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { transformWithOxc } from 'vite';

const source = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
const start = source.indexOf("{page === 'Integrations' && project && settingsFrame(<IntegrationSettings"), composition = source.slice(source.indexOf('<IntegrationSettings', start), source.indexOf("}] : []}/>)}", start) + "}] : []}/>".length);
assert.ok(start > 0 && composition.endsWith('/>'), 'The central connection composition must remain available.');
const elements = node => Array.isArray(node) ? node.flatMap(elements) : React.isValidElement(node) ? [node, ...elements(node.props.children), ...elements(Object.values(node.props.sections || {}))] : [];
const IntegrationSettings = () => null, NativeGoogleAds = () => null, MicrosoftAds = () => null, OohProviders = () => null, stub = () => null;
const { code } = await transformWithOxc(`const render = (context) => { const { project, state, activeProject, connectionRevision, workspace, canMap, canWrite, canAdmin, connected, api, setConnectionRevision, setRemote, setCalendarEvents, setOohInventory, reload, integrate, setModal, run, loadRemote } = context; return (<>${composition}</>); };`, 'IntegrationConnections.tsx', { jsx: { runtime: 'classic' } });
const render = new Function('React', 'Suspense', 'IntegrationSettings', 'NativeGoogleAds', 'MicrosoftAds', 'OohProviders', 'StatusLine', 'FormActions', 'Button', 'ZernioTeam', 'ZernioAdmin', 'ZernioAccounts', 'OpenAIConnection', code + '; return render;')(React, React.Suspense, IntegrationSettings, NativeGoogleAds, MicrosoftAds, OohProviders, stub, stub, stub, stub, stub, stub, stub);
function setup(reload = async () => {}) {
  const calls = [], context = {
    project: { id: 'project-a' }, state: { projectId: 'project-a', user: { id: 'operator', isOperator: true } }, activeProject: { current: 'project-a' }, connectionRevision: 0, workspace: { role: 'owner' }, canMap: true, canWrite: true, canAdmin: true, connected: true, api() {}, setModal() {}, run() {}, loadRemote() {},
    setConnectionRevision(update) { context.connectionRevision = update(context.connectionRevision); },
    setRemote(value) { calls.push(['remote', value]); }, setCalendarEvents(value) { calls.push(['calendar', value]); }, setOohInventory(value) { calls.push(['inventory', value]); }, reload,
    async integrate(path) { calls.push(['integrate', path]); return { configured: true }; },
  };
  const nodes = () => elements(render(context));
  return { context, calls, nodes, changed: () => nodes().find(node => node.type === IntegrationSettings).props.onChanged() };
}
const connections = nodes => nodes.filter(node => [NativeGoogleAds, MicrosoftAds, OohProviders].includes(node.type));

test('saving or resetting credentials remounts every central provider connection with the same project and permissions', async () => {
  const h = setup(), before = connections(h.nodes());
  assert.equal(before.length, 3);
  for (let action = 0; action < 2; action++) {
    const previous = connections(h.nodes());
    await h.changed();
    const refreshed = connections(h.nodes());
    assert.equal(h.context.connectionRevision, action + 1);
    for (let index = 0; index < refreshed.length; index++) {
      assert.notEqual(refreshed[index].key, previous[index].key, 'A saved credential must invalidate the previous mounted status snapshot.');
      assert.equal(refreshed[index].type, previous[index].type);
      assert.deepEqual(refreshed[index].props, previous[index].props, 'Project, mode, authority and request contracts remain unchanged.');
    }
  }
  assert.equal(h.calls.filter(([kind]) => kind === 'integrate').length, 2);
});

test('a departed project cannot refresh connection state or accept an old integration-status completion', async () => {
  const old = setup(); old.context.activeProject.current = 'project-b';
  await old.changed(); assert.equal(old.context.connectionRevision, 0); assert.deepEqual(old.calls, []);
  let finish;
  const current = setup(() => new Promise(resolve => { finish = resolve; }));
  const pending = current.changed(); current.context.activeProject.current = 'project-b'; finish(); await pending;
  assert.equal(current.calls.some(([kind]) => kind === 'integrate'), false);
  assert.equal(current.calls.some(([kind, value]) => kind === 'remote' && value.status), false);
});
