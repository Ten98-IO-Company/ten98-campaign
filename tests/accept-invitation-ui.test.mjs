import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { transformWithOxc } from 'vite';
import { InvitationAcceptFlow } from '@ten98/ui';
import { AppBrand } from '@ten98/ui/app';

// Evaluate Campaign's real AcceptInvitation adapter with hooks mocked by call order.
const source = await readFile(new URL('../src/AcceptInvitation.tsx', import.meta.url), 'utf8');
const { code } = await transformWithOxc(source.replace(/^import .*?;\r?\n/gm, '').replace('export default function', 'function'), 'AcceptInvitation.tsx', { jsx: { runtime: 'classic' } });

function view(props) {
  const state = [], refs = [], effects = []; let index = 0, refIndex = 0;
  const useState = value => { const slot = index++; if (!(slot in state)) state[slot] = value; return [state[slot], next => { state[slot] = typeof next === 'function' ? next(state[slot]) : next; }]; };
  const useRef = value => { const slot = refIndex++; if (!(slot in refs)) refs[slot] = { current: value }; return refs[slot]; };
  const AcceptInvitation = new Function('React', 'useState', 'useRef', 'useEffect', 'InvitationAcceptFlow', 'Brand', code + '; return AcceptInvitation;')(React, useState, useRef, effect => { effects.push(effect); }, InvitationAcceptFlow, AppBrand);
  const render = () => { index = 0; refIndex = 0; return AcceptInvitation(props); };
  return { render, effects };
}

test('the invitation screen inspects and accepts with the token in POST bodies, never in a request path', async () => {
  const token = 'Ab_-'.repeat(10) + 'xyz', calls = [], accepted = [];
  const request = async (path, method, body) => {
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
