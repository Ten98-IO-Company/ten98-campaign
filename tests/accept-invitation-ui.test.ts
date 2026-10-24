import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { transformWithOxc } from 'vite';
import { AuthStory, InvitationAcceptFlow } from '@ten98/ui';
import { AppBrand } from '@ten98/ui/app';
import { renderToStaticMarkup } from 'react-dom/server';
import { roleLabel } from '../src/workspace-roles.ts';

type Call = [path: string, method?: string, body?: unknown];
type Props = { token: string; signedInEmail?: string; request: (path: string, method?: string, body?: unknown) => Promise<unknown>; onAccepted: (result: unknown) => void; onSignIn: (email?: string) => void; onCancel?: () => void };

// Evaluate Campaign's real AcceptInvitation adapter with hooks mocked by call order.
const source = await readFile(new URL('../src/AcceptInvitation.tsx', import.meta.url), 'utf8');
const { code } = await transformWithOxc(source.replace(/^import .*?;\r?\n/gm, '').replace('export default function', 'function'), 'AcceptInvitation.tsx', { jsx: { runtime: 'classic' } });

const story = React.createElement(AuthStory, { eyebrow: 'Campaign management', title: 'Plan. Publish.', lead: 'Lead line.', footnote: 'ten98 Campaign' });
function view(props: Props) {
  const state: unknown[] = [], refs: { current: unknown }[] = [], effects: (() => void)[] = []; let index = 0, refIndex = 0;
  const useState = (value: unknown) => { const slot = index++; if (!(slot in state)) state[slot] = value; return [state[slot], (next: unknown) => { state[slot] = typeof next === 'function' ? next(state[slot]) : next; }]; };
  const useRef = (value: unknown) => { const slot = refIndex++; if (!(slot in refs)) refs[slot] = { current: value }; return refs[slot]; };
  const AcceptInvitation = new Function('React', 'useState', 'useRef', 'useEffect', 'InvitationAcceptFlow', 'Brand', 'roleLabel', 'authStory', code + '; return AcceptInvitation;')(React, useState, useRef, (effect: () => void) => { effects.push(effect); }, InvitationAcceptFlow, AppBrand, roleLabel, story);
  const render = (): React.ReactElement<any> => { index = 0; refIndex = 0; return AcceptInvitation(props); };
  return { render, effects };
}

test('the invitation screen inspects and accepts with the token in POST bodies, never in a request path', async () => {
  const token = 'Ab_-'.repeat(10) + 'xyz', calls: Call[] = [], accepted: unknown[] = [];
  const request = async (path: string, method?: string, body?: unknown) => {
    calls.push([path, method, body]);
    return path === '/invitations/inspect' ? { invitation: { email: 'new@example.test', role: 'editor', workspaceName: 'Studio', expiresAt: '2026-11-01T00:00:00.000Z' }, accountExists: false, requiresSignIn: false } : { created: true };
  };
  const ui = view({ token, request, onAccepted: result => { accepted.push(result); }, onSignIn() {} });
  assert.equal(ui.render().type, InvitationAcceptFlow);
  ui.effects.forEach(effect => effect()); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [['/invitations/inspect', 'POST', { token }]]);
  const tree = ui.render();
  assert.equal(tree.props.state, 'details'); assert.equal(tree.props.title, 'Join Studio');
  await tree.props.onSubmit({ name: 'New colleague', password: 'a secure personal password' });
  assert.deepEqual(calls[1], ['/invitations/accept', 'POST', { token, name: 'New colleague', password: 'a secure personal password' }]);
  assert.deepEqual(accepted, [{ created: true }]);
  assert.equal(calls.some(([path]) => path.includes(token)), false);
});

test('the invitation shows Campaign\'s role label and the shared flow date, and Sign in instead passes the invited email', async () => {
  const signIns: unknown[] = [];
  const request = async () => ({ invitation: { email: 'new@example.test', role: 'editor', workspaceName: 'Studio', expiresAt: '2026-10-30T00:00:00.000Z' }, accountExists: false, requiresSignIn: false });
  const ui = view({ token: 'T'.repeat(43), request, onAccepted() {}, onSignIn: (email?: string) => { signIns.push(email); } });
  ui.render(); ui.effects.forEach(effect => effect()); await new Promise(resolve => setImmediate(resolve));
  const tree = ui.render(), html = renderToStaticMarkup(tree);
  // The flow's roleLabel prop shows the label Team settings uses; the invitation keeps its role value. Like every
  // signed-out screen it sits beside the shared story panel, in the default split layout (#272).
  assert.equal(tree.props.invitation.role, 'editor'); assert.equal(tree.props.roleLabel, roleLabel); assert.equal(tree.props.aside, story); assert.equal(tree.props.surface, undefined); assert.match(html, />Editor</); assert.doesNotMatch(html, />editor</);
  assert.equal(tree.props.formatDate, undefined, 'The flow keeps its own Intl date format, the same one Team settings shows.');
  assert.match(html, />Oct 30, 2026</); assert.doesNotMatch(html, /10\/30\/2026/);
  tree.props.onSignIn(); assert.deepEqual(signIns, ['new@example.test']);
  assert.equal(roleLabel('custom'), 'custom', 'An unknown role is shown as given.');
});

// QA #265 recheck: as in Discover, someone signed in as another account sees the mismatch notice with Switch account,
// which signs them out and opens sign-in for the invited email; Cancel leaves the invitation. No accept goes out.
test('an invitation opened as another account offers Switch account, and Cancel leaves the invitation', async () => {
  const calls: Call[] = [], signIns: (string | undefined)[] = []; let cancelled = 0;
  const request = async (path: string, method?: string, body?: unknown) => { calls.push([path, method, body]); return { invitation: { email: 'New@Example.test', role: 'viewer', workspaceName: 'Studio', expiresAt: '2026-11-01T00:00:00.000Z' }, accountExists: true, requiresSignIn: false }; };
  const ui = view({ token: 'T'.repeat(43), signedInEmail: 'someone.else@example.test', request, onAccepted() {}, onSignIn: email => signIns.push(email), onCancel: () => { cancelled++; } });
  ui.render(); ui.effects.forEach(effect => effect()); await new Promise(resolve => setImmediate(resolve));
  const tree = ui.render();
  assert.equal(tree.props.state, 'mismatch'); assert.equal(tree.props.signedInEmail, 'someone.else@example.test');
  tree.props.onSwitchAccount(); assert.deepEqual(signIns, ['New@Example.test']);
  await tree.props.onSubmit({}); assert.equal(calls.filter(([path]) => path === '/invitations/accept').length, 0, 'A mismatched session cannot accept.');
  assert.equal(tree.props.cancel.label, 'Cancel'); tree.props.cancel.onClick(); assert.equal(cancelled, 1);
  assert.deepEqual(tree.props.passwordPolicy, { minLength: 12, maxLength: 128 }, 'The library hint, as on owner setup.');
  const same = view({ token: 'T'.repeat(43), signedInEmail: 'new@example.test', request, onAccepted() {}, onSignIn() {} });
  same.render(); same.effects.forEach(effect => effect()); for (let tick = 0; tick < 3; tick++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(same.render().props.state, 'details', 'The invited email in another case is the same account.');
});
