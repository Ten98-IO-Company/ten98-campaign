import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import * as ui from '@ten98/ui';

// Home's setup checklist with controlled hook state and browser storage; no request leaves the test.
const source = (await readFile(new URL('../src/HomeSetup.tsx', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace(/^export type .*;\r?\n/m, '').replace('export default function', 'function');
const { code } = await transformWithOxc(source, 'HomeSetup.tsx', { jsx: { runtime: 'classic' }, lang: 'tsx' });
type Storage = { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void };
type Step = { id: string; title: string; detail: string; done: boolean; action?: string; onAction?: () => void };
function load(storage: Storage) {
  let hidden: unknown; const setters: unknown[] = [];
  const useState = (initial: unknown) => { hidden ??= typeof initial === 'function' ? initial() : initial; return [hidden, (value: unknown) => { hidden = value; setters.push(value); }]; };
  const globalThis = { localStorage: storage };
  const HomeSetup = new Function('React', 'useState', 'globalThis', 'Badge', 'Button', 'Card', 'Inline', 'List', 'ListItem', 'Progress', 'Stack', 'Text', code + '; return HomeSetup;')(React, useState, globalThis, ui.Badge, ui.Button, ui.Card, ui.Inline, ui.List, ui.ListItem, ui.Progress, ui.Stack, ui.Text);
  return { render: (props: { projectId: string; steps: Step[] }) => HomeSetup(props), setters };
}
const store = (initial: Record<string, string> = {}) => { const data: Record<string, string> = { ...initial }; return { data, getItem: (key: string) => data[key] ?? null, setItem: (key: string, value: string) => { data[key] = value; } }; };
const steps = (done = [false, false]): Step[] => [
  { id: 'accounts', title: 'Connect your social and ad accounts', detail: 'Publish posts and run ads from one place.', done: done[0], action: 'Connect accounts', onAction: () => {} },
  { id: 'campaign', title: 'Create your first campaign', detail: 'Keep a launch together.', done: done[1], action: 'New campaign', onAction: () => {} },
];
const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : !React.isValidElement(node) ? [] : [node, ...Object.values(node.props as Record<string, unknown>).flatMap(value => Array.isArray(value) || React.isValidElement(value) ? nodes(value) : [])];

test('the checklist shows progress, a Done badge or one action per step, and never a second primary button', () => {
  const tree = load(store()).render({ projectId: 'p', steps: steps([true, false]) }), html = renderToStaticMarkup(tree);
  assert.match(html, /Set up Campaign/); assert.match(html, /1 of 2 done/); assert.match(html, /Done/); assert.match(html, /New campaign/);
  assert.doesNotMatch(html, />Connect accounts</, 'A finished step offers no action.');
  assert.ok(nodes(tree).filter(node => node.type === ui.Button).every(node => node.props.variant !== 'primary'), 'Home keeps its one primary action in the page header.');
});

test('the checklist disappears when every step is done, and Hide is remembered per project in this browser', () => {
  assert.equal(load(store()).render({ projectId: 'p', steps: steps([true, true]) }), null);
  const storage = store(), view = load(storage), tree = view.render({ projectId: 'project-a', steps: steps() });
  nodes(tree).find(node => node.type === ui.Button && node.props.children === 'Hide').props.onClick();
  assert.deepEqual(view.setters, [true]); assert.equal(storage.data['ten98-campaign-setup-hidden:project-a'], '1');
  assert.equal(load(storage).render({ projectId: 'project-a', steps: steps() }), null, 'Hidden for this project after a reload.');
  assert.notEqual(load(storage).render({ projectId: 'project-b', steps: steps() }), null, 'Other projects still show their checklist.');
  const blocked: Storage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.notEqual(load(blocked).render({ projectId: 'p', steps: steps() }), null, 'Blocked storage still renders the checklist.');
});

test('a step that belongs to an administrator says Ask your admin instead of offering a button', () => {
  const view = load(store()), tree = view.render({ projectId: 'p', steps: [{ id: 'accounts', title: 'Connect your social accounts', detail: 'Your Campaign administrator turns this on once for everyone.', done: false }, ...steps()] });
  const html = renderToStaticMarkup(tree);
  assert.match(html, /Connect your social accounts[\s\S]*Ask your admin/);
  assert.equal(nodes(tree).filter(node => node.type === ui.Button && node.props.children !== 'Hide').length, 2, 'Only the two steps with an action have a button.');
});
