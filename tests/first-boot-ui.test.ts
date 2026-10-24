import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import * as ui from '@ten98/ui';
import { AccountMenu, AppShell, AppTopbar, Button, PageHeader, WorkspaceOnboarding } from '@ten98/ui';
import { AppBrand } from '@ten98/ui/app';
import { readText } from './read-text.ts';

const source = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
const slice = (from: string, to: string) => { const start = source.indexOf(from); assert.ok(start > -1, `${from} is missing`); return source.slice(start, source.indexOf(to, start)); };

// Home's real setup checklist, so the no-project state is checked against the checklist it reuses.
const homeSource = (await readFile(new URL('../src/HomeSetup.tsx', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace(/^export type .*;\r?\n/m, '').replace('export default function', 'function');
const { code: homeCode } = await transformWithOxc(homeSource, 'HomeSetup.tsx', { jsx: { runtime: 'classic' }, lang: 'tsx' });
const HomeSetup = new Function('React', 'useState', 'globalThis', 'Badge', 'Button', 'Card', 'Inline', 'List', 'ListItem', 'Progress', 'Stack', 'Text', homeCode + '; return HomeSetup;')(React, React.useState, { localStorage: undefined }, ui.Badge, ui.Button, ui.Card, ui.Inline, ui.List, ui.ListItem, ui.Progress, ui.Stack, ui.Text);

// FirstProject with its one useState replaced, so each test chooses the skipped state and sees the requested change.
const { code: firstProjectCode } = await transformWithOxc(slice('function FirstProject(', '\n// The story panel beside'), 'FirstProject.tsx', { jsx: { runtime: 'classic' } });
const story = React.createElement(ui.AuthStory, { eyebrow: 'STORY', title: 'Story panel', lead: 'Lead line.', footnote: 'Footnote' });
function firstProject(skipped: boolean) {
  const changes: boolean[] = [], created: unknown[] = []; let signedOut = 0;
  const FirstProject = new Function('React', 'useState', 'Brand', 'WorkspaceOnboarding', 'Button', 'AppShell', 'AppTopbar', 'AccountMenu', 'PageHeader', 'HomeSetup', 'authStory', firstProjectCode + '; return FirstProject;')(
    React, () => [skipped, (next: boolean) => { changes.push(next); }], AppBrand, WorkspaceOnboarding, Button, AppShell, AppTopbar, AccountMenu, PageHeader, HomeSetup, story);
  const element = FirstProject({ workspaceName: 'My workspace', user: { id: 'u1', name: 'Owner', email: 'owner@example.test' }, busy: false, onCreate: (values: unknown) => { created.push(values); }, onSignOut: () => { signedOut++; } });
  return { element, changes, created, signedOut: () => signedOut };
}

test('after the first sign-up an owner or administrator without projects lands on the first-project step', () => {
  const expression = /const firstProjectWorkspace = (.+?);\n/.exec(source)?.[1];
  assert.ok(expression, 'The app routes a workspace without projects to the first-project step.');
  const pick = new Function('state', `return ${expression};`);
  const owner = { id: 'w1', name: 'Owner team', role: 'owner' };
  assert.equal(pick({ projects: [], workspaces: [owner] }), owner);
  assert.equal(pick({ projects: [], workspaces: [{ id: 'w2', name: 'Shared', role: 'editor' }, { ...owner, role: 'admin' }] }).id, 'w1');
  assert.ok(!pick({ projects: [], workspaces: [{ id: 'w2', name: 'Shared', role: 'editor' }] }), 'Members who cannot add the sample keep workspace onboarding.');
  assert.ok(!pick({ projects: [{ id: 'p1' }], workspaces: [owner] }));
  assert.ok(source.indexOf('if (firstProjectWorkspace)') < source.indexOf('if (!state.projectId || !project) return <WorkspaceOnboarding'));
});

test('the first-project step is one project name, the sample opt-in and Skip for now', () => {
  const { element, changes, created } = firstProject(false);
  assert.equal(element.type, WorkspaceOnboarding);
  assert.equal(element.props.aside, story, 'The step keeps the story panel from the sign-up screen, as Discover does.');
  assert.equal(element.props.subheading, 'Create your first project'); assert.equal(element.props.nameLabel, 'Project name'); assert.equal(element.props.submitLabel, 'Create project');
  assert.deepEqual(element.props.sampleOptIn, { label: 'Add sample data' });
  assert.equal(element.props.help, undefined, 'No extra explanation text.'); assert.equal(element.props.signOut, undefined);
  const html = renderToStaticMarkup(element), text = readText(html);
  assert.match(html, /<form[^>]*>[\s\S]*name="sample"[\s\S]*<\/form>/, 'The sample opt-in is inside the form.');
  assert.equal((html.match(/<input[^>]*name="name"/g) || []).length, 1, 'One project name field.');
  for (const label of ['Project name', 'Add sample data', 'Create project', 'Skip for now']) assert.ok(text.includes(label), label);
  element.props.onSubmit({ name: 'Spring launch', sample: true }); element.props.onSubmit({ name: 'Own work' });
  assert.deepEqual(created, [{ name: 'Spring launch', sample: true }, { name: 'Own work', sample: false }]);
  // The library's own Skip action (@ten98/ui 0.25.0), not a stand-in Button passed as children.
  assert.equal(element.props.children, undefined); assert.equal(element.props.skipLabel, 'Skip for now');
  assert.match(html, /<button[^>]*type="button"[^>]*>Skip for now<\/button>/);
  element.props.onSkip(); assert.deepEqual(changes, [true]);
});

test('skipping lands on Home with no project, where the setup checklist starts with Create your first project', () => {
  const { element, changes, signedOut } = firstProject(true);
  assert.equal(element.type, AppShell);
  const html = renderToStaticMarkup(element), text = readText(html);
  assert.match(html, /<h1[^>]*>Home<\/h1>/);
  for (const label of ['Set up Campaign', '0 of 1 done', 'Create your first project', 'Create project']) assert.ok(text.includes(label), label);
  const children = React.Children.toArray(element.props.children) as any[];
  const checklist = children.find(child => child.type === HomeSetup), header = children.find(child => child.type === PageHeader);
  assert.deepEqual(checklist.props.steps.map((step: { id: string; done: boolean }) => [step.id, step.done]), [['project', false]]);
  checklist.props.steps[0].onAction(); header.props.actions.props.onClick();
  assert.deepEqual(changes, [false, false], 'Create project returns to the first-project step.');
  element.props.topbar.props.actions.props.items.find((item: { id: string }) => item.id === 'sign-out').onSelect(); assert.equal(signedOut(), 1);
});

test('creating the first project posts the opt-in to the workspace and opens the new project once', async () => {
  const calls: unknown[][] = [], opened: string[] = [], pendingWork = { current: 0 };
  const context = { pendingWork, run: async (work: () => Promise<unknown>) => { pendingWork.current++; try { return await work(); } finally { pendingWork.current--; } }, api: async (...args: unknown[]) => { calls.push(args); return { project: { id: 'project-1' } }; }, reload: async (id: string) => { opened.push(id); } };
  const create = new Function(...Object.keys(context), `return (${stripTypeScriptTypes(slice('async function createFirstProject(', '  async function createWorkspace('))});`)(...Object.values(context));
  await create('workspace-1', { name: 'Spring launch', sample: true });
  assert.deepEqual(calls, [['/projects', 'POST', { workspaceId: 'workspace-1', name: 'Spring launch', sample: true }]]);
  assert.deepEqual(opened, ['project-1']);
  pendingWork.current = 1; await create('workspace-1', { name: 'Spring launch', sample: true });
  assert.equal(calls.length, 1, 'An in-flight action must not create a second project.');
});
