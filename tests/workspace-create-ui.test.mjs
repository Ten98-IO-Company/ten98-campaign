import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import { WorkspaceCreateFlow } from '@ten98/ui';

// Evaluate the real creation element from the editor dialog in src/main.tsx and render the shared flow.
const source = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
const start = source.indexOf('<WorkspaceCreateFlow mode="create"'), end = source.indexOf('/> : <>', start) + 2;
const { code } = await transformWithOxc('const render = () => (' + source.slice(start, end) + ');', 'CreateFlow.tsx', { jsx: { runtime: 'classic' } });

function render(type, saved = []) {
  const context = { React, WorkspaceCreateFlow, modal: { type }, busy: false, error: 'Name already used.', saveEditor: values => { saved.push(values); }, closeEditor: () => saved.push('closed') };
  return new Function(...Object.keys(context), code + '; return render();')(...Object.values(context));
}

test('workspace and project creation use the shared name flow with the editor save and cancel', () => {
  for (const [type, heading, label, submit] of [['workspace', 'New workspace', 'Workspace name', 'Create workspace'], ['project', 'New project', 'Project name', 'Create project']]) {
    const saved = [], element = render(type, saved), html = renderToStaticMarkup(element);
    assert.equal(element.type, WorkspaceCreateFlow);
    assert.match(html, new RegExp(`<h2[^>]*>${heading}</h2>`)); assert.match(html, new RegExp(`>${label}<`)); assert.match(html, new RegExp(`>${submit}<`));
    assert.match(html, /Name already used\./); assert.doesNotMatch(html, /name="origin"/);
    element.props.onSubmit({ name: 'Acme' }); element.props.cancel.onClick('');
    assert.deepEqual(saved, [{ name: 'Acme' }, 'closed']);
  }
});
