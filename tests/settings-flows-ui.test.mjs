import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import { stripTypeScriptTypes } from 'node:module';
import { DangerZoneFlow, ProjectCreateFlow, WorkspaceCreateFlow } from '@ten98/ui';

// Evaluate the real creation element from the editor dialog in src/main.tsx and render the shared flow.
const source = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
const start = source.indexOf("modal.type === 'project' ? <ProjectCreateFlow"), end = source.indexOf('/> : <>', start) + 2;
const { code } = await transformWithOxc('const render = () => (' + source.slice(start, end) + ');', 'CreateFlow.tsx', { jsx: { runtime: 'classic' } });

function render(type, saved = []) {
  const context = { React, ProjectCreateFlow, WorkspaceCreateFlow, modal: { type }, busy: false, error: 'Name already used.', saveEditor: values => { saved.push(values); }, closeEditor: () => saved.push('closed') };
  return new Function(...Object.keys(context), code + '; return render();')(...Object.values(context));
}

test('workspace and project creation use the shared name flow with the editor save and cancel', () => {
  // The editor Dialog titles the creation ("New workspace"); the flow heading names the step.
  for (const [type, heading, label, submit] of [['workspace', 'Name your workspace', 'Workspace name', 'Create workspace'], ['project', 'Name your project', 'Project name', 'Create project']]) {
    const saved = [], element = render(type, saved), html = renderToStaticMarkup(element);
    assert.equal(element.type, type === 'project' ? ProjectCreateFlow : WorkspaceCreateFlow);
    assert.match(html, new RegExp(`<h2[^>]*>${heading}</h2>`)); assert.match(html, new RegExp(`>${label}<`)); assert.match(html, new RegExp(`>${submit}<`));
    assert.match(html, /Name already used\./); assert.doesNotMatch(html, /name="origin"/);
    element.props.onSubmit({ name: 'Acme' }); element.props.cancel.onClick('');
    assert.deepEqual(saved, [{ name: 'Acme' }, 'closed']);
  }
});

test('sample data removal is one confirmed danger action that calls the project delete without a browser prompt', async () => {
  const at = source.indexOf('{canAdmin && sample && <DangerZoneFlow'), close = source.indexOf('/>}', at) + 2;
  const { code: zone } = await transformWithOxc('const render = () => (' + source.slice(at + 1, close) + ');', 'DangerZone.tsx', { jsx: { runtime: 'classic' } });
  const handler = source.slice(source.indexOf('async function clearSampleData('), source.indexOf('  async function uploadAsset('));
  const calls = [], context = { state: { projectId: 'project-a' }, activeProject: { current: 'project-a' }, run: work => work(), api: async (path, method) => { calls.push([path, method]); return { removed: 3 }; }, setRemote: () => calls.push('cleared'), reload: async id => calls.push(['reload', id]), setNotice: text => calls.push(text), window: { confirm: () => assert.fail('The shared flow confirms the action.') } };
  const clearSampleData = new Function(...Object.keys(context), `return (${stripTypeScriptTypes(handler)});`)(...Object.values(context));
  const element = new Function('React', 'DangerZoneFlow', 'canAdmin', 'sample', 'busy', 'clearSampleData', zone + '; return render();')(React, DangerZoneFlow, true, true, false, clearSampleData);
  assert.equal(element.type, DangerZoneFlow);
  assert.deepEqual(element.props.actions.map(action => [action.id, action.confirmLabel]), [['sample-data', 'Remove sample data']]);
  assert.match(renderToStaticMarkup(element), /Remove sample data/);
  await element.props.onConfirm({ id: 'sample-data' });
  assert.deepEqual(calls, [['/projects/project-a/sample-data', 'DELETE'], 'cleared', ['reload', 'project-a'], 'Removed 3 sample records.']);
  assert.equal(new Function('React', 'DangerZoneFlow', 'canAdmin', 'sample', 'busy', 'clearSampleData', zone + '; return render();')(React, DangerZoneFlow, true, false, false, clearSampleData), false, 'Hidden once the project has no sample data.');
});
