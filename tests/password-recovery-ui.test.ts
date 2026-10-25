import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { transformWithOxc } from 'vite';
import { AuthStory, PasswordRecoveryFlow } from '@ten98/ui';
import { AppBrand } from '@ten98/ui/app';

// Campaign's PasswordRecovery adapter (#284), evaluated with hooks mocked by call order, and the #password-reset= reader.
const source = await readFile(new URL('../src/PasswordRecovery.tsx', import.meta.url), 'utf8');
const { code } = await transformWithOxc(source.replace(/^import .*?;\r?\n/gm, '').replace('export default function', 'function').replace(/^export type .*$/m, ''), 'PasswordRecovery.tsx', { jsx: { runtime: 'classic' } });
const story = React.createElement(AuthStory, { eyebrow: 'Campaign management', title: 'Plan. Publish.', lead: 'Lead line.', footnote: 'ten98 Campaign' });
const settle = async () => { for (let tick = 0; tick < 3; tick++) await new Promise(resolve => setImmediate(resolve)); };

function view(props: Record<string, unknown>) {
  const state: unknown[] = [], refs: { current: unknown }[] = [], effects: (() => void)[] = []; let index = 0, refIndex = 0;
  const useState = (value: unknown) => { const slot = index++; if (!(slot in state)) state[slot] = value; return [state[slot], (next: unknown) => { state[slot] = typeof next === 'function' ? (next as (value: unknown) => unknown)(state[slot]) : next; }]; };
  const useRef = (value: unknown) => { const slot = refIndex++; if (!(slot in refs)) refs[slot] = { current: value }; return refs[slot]; };
  const PasswordRecovery = new Function('React', 'useState', 'useRef', 'useEffect', 'PasswordRecoveryFlow', 'Brand', 'authStory', code + '; return PasswordRecovery;')(React, useState, useRef, (effect: () => void) => { effects.push(effect); }, PasswordRecoveryFlow, AppBrand, story);
  return { render: (): React.ReactElement<any> => { index = 0; refIndex = 0; return PasswordRecovery(props); }, effects };
}

test('the request stage checks availability, sends the trimmed email and confirms without saying whether it exists', async () => {
  const calls: unknown[][] = [];
  const request = async (path: string, method?: string, body?: unknown) => { calls.push([path, method, body]); return path === '/auth/password-reset-status' ? { configured: true } : { ok: true }; };
  const ui = view({ value: { kind: 'request' }, initialEmail: 'me@example.test', request, onRequest() {}, onSignIn() {} });
  assert.equal(ui.render().props.availability, 'loading');
  ui.effects.forEach(effect => effect()); await settle();
  let tree = ui.render();
  assert.equal(tree.type, PasswordRecoveryFlow); assert.equal(tree.props.stage, 'request'); assert.equal(tree.props.availability, 'enabled');
  assert.equal(tree.props.aside, story); assert.deepEqual(tree.props.defaultValues, { email: 'me@example.test' });
  await tree.props.onSubmit({ email: '  me@example.test ' });
  assert.deepEqual(calls.at(-1), ['/auth/request-password-reset', 'POST', { email: 'me@example.test' }]);
  tree = ui.render(); assert.equal(tree.props.sent, true); assert.match(tree.props.messages.sent, /If an account with a password matches/);
});

test('without email the request stage says to ask an administrator', async () => {
  const ui = view({ value: { kind: 'request' }, initialEmail: '', request: async () => ({ configured: false }), onRequest() {}, onSignIn() {} });
  ui.render(); ui.effects.forEach(effect => effect()); await settle();
  const tree = ui.render(); assert.equal(tree.props.availability, 'disabled'); assert.match(tree.props.messages.disabled, /Ask your administrator/);
});

test('the reset stage posts the token once, signs in on success and explains a used or expired link', async () => {
  const token = 'A'.repeat(43), calls: unknown[][] = [], signIns: unknown[] = [];
  let answer: () => Promise<unknown> = async () => ({ ok: true });
  const ui = view({ value: { kind: 'reset', token }, initialEmail: '', request: async (path: string, method?: string, body?: unknown) => { calls.push([path, method, body]); return answer(); }, onRequest() {}, onSignIn: (changed?: boolean) => signIns.push(changed) });
  ui.render(); ui.effects.forEach(effect => effect());
  let tree = ui.render(); assert.equal(tree.props.stage, 'reset'); assert.equal(tree.props.invalid, false);
  await tree.props.onSubmit({ password: 'short', confirmation: 'short' }); assert.equal(calls.length, 0, 'The policy is checked before any request.');
  await tree.props.onSubmit({ password: 'a brand new password', confirmation: 'a brand new password' });
  assert.deepEqual(calls, [['/auth/reset-password', 'POST', { token, newPassword: 'a brand new password' }]]); assert.deepEqual(signIns, [true]);
  answer = async () => { throw Object.assign(new Error('used'), { status: 400 }); };
  tree = ui.render(); await tree.props.onSubmit({ password: 'a brand new password', confirmation: 'a brand new password' });
  tree = ui.render(); assert.equal(tree.props.invalid, true); assert.match(tree.props.messages.invalid, /invalid, expired or already used/);
  const incomplete = view({ value: { kind: 'reset', token: null }, initialEmail: '', request: async () => ({}), onRequest() {}, onSignIn() {} }).render();
  assert.equal(incomplete.props.invalid, true, 'A malformed link shows no form.');
});

test('a #password-reset= link leaves the address and opens the reset step; sign-in offers Forgot password', async () => {
  const main = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
  const start = main.indexOf('function takeReset('), end = main.indexOf('\n}\n', start) + 2;
  const { code: readerCode } = await transformWithOxc(main.slice(start, end), 'takeReset.ts');
  const takeReset = new Function(readerCode + '; return takeReset;')();
  const replaced: string[] = [], history = { state: null, replaceState: (_: unknown, __: string, url: string) => { replaced.push(url); } };
  assert.deepEqual(takeReset({ pathname: '/', search: '?view=overview', hash: '#password-reset=' + 'B'.repeat(43) }, history), { kind: 'reset', token: 'B'.repeat(43) });
  assert.deepEqual(replaced, ['/?view=overview'], 'The token leaves the address bar.');
  assert.deepEqual(takeReset({ pathname: '/', search: '', hash: '#password-reset=short' }, history), { kind: 'reset', token: null });
  assert.equal(takeReset({ pathname: '/', search: '', hash: '#invite=abc' }, history), null);
  assert.match(main, /forgotPassword=\{onForgotPassword \? \{ onClick: onForgotPassword \} : undefined\}/);
});
