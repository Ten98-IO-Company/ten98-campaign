import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import * as ui from '@ten98/ui';

// Evaluate Campaign's real AccountSettings adapter with controlled state and requests, then render the shared flows.
const source = await readFile(new URL('../src/AccountSettings.tsx', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('const appearanceOptions')).replace('export default function', 'function');
const { code } = await transformWithOxc(body, 'AccountSettings.tsx', { jsx: { runtime: 'classic' } });
const names = ['Alert', 'Button', 'Card', 'Field', 'Input', 'PasswordChangeFlow', 'RadioGroup', 'Stack', 'StatusLine', 'Text'];

function view(account, request) {
  const state = [];
  let index = 0;
  const useState = value => { const slot = index++; if (!(slot in state)) state[slot] = typeof value === 'function' ? value() : value; return [state[slot], next => { state[slot] = typeof next === 'function' ? next(state[slot]) : next; }]; };
  const document = { documentElement: { dataset: {} } };
  const AccountSettings = new Function('React', 'useState', 'useEffect', 'document', 'localStorage', ...names, code + '; return AccountSettings;')(React, useState, () => {}, document, {}, ...names.map(name => ui[name]));
  const render = () => { index = 0; return AccountSettings({ request, onChanged() {} }); };
  render(); state[0] = account;
  return render;
}
const find = (node, type) => { if (!node || typeof node !== 'object') return; if (Array.isArray(node)) { for (const child of node) { const hit = find(child, type); if (hit) return hit; } return; } if (node.type === type) return node; return find(node.props?.children, type); };

test('password change uses the shared flow, posts only the password fields and reports the outcome', async () => {
  const calls = [];
  const account = { user: { email: 'member@example.test', name: 'Member' }, localPassword: true, activeSessions: 1 };
  const render = view(account, async (path, method, body) => { calls.push([path, method, body]); if (path === '/account/password' && calls.length > 2) throw new Error('Current password is incorrect.'); return account; });
  let tree = render(), html = renderToStaticMarkup(tree);
  assert.match(html, /member@example\.test · 1 active sessions/);
  assert.match(html, /name="currentPassword"/); assert.match(html, /<input[^>]*minLength="12"[^>]*name="newPassword"/); assert.match(html, /maxLength="128"|maxlength="128"/i);
  assert.match(html, /disabled="">Sign out other sessions/, 'A single session has nothing to sign out.');
  const flow = find(tree, ui.PasswordChangeFlow);
  await flow.props.onSubmit({ currentPassword: 'current password value', newPassword: 'new password value!' });
  assert.deepEqual(calls[0], ['/account/password', 'POST', { currentPassword: 'current password value', newPassword: 'new password value!' }]);
  tree = render();
  assert.notEqual(find(tree, ui.PasswordChangeFlow).key, flow.key, 'The password form is cleared after a change.');
  assert.match(renderToStaticMarkup(tree), /Password changed\. Other sessions have been signed out\./);
  await find(tree, ui.PasswordChangeFlow).props.onSubmit({ currentPassword: 'wrong', newPassword: 'new password value!' });
  assert.match(renderToStaticMarkup(render()), /Current password is incorrect\./);
});

test('accounts without a local password see the provider note instead of the form', () => {
  const html = renderToStaticMarkup(view({ user: { email: 'sso@example.test', name: 'SSO' }, localPassword: false, activeSessions: 3 }, async () => ({}))());
  assert.match(html, /Your identity provider manages your password\./);
  assert.doesNotMatch(html, /name="currentPassword"/);
  assert.doesNotMatch(html, /disabled="">Sign out other sessions/);
});
