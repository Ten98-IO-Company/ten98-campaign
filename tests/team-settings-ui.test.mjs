import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import { TeamFlow } from '@ten98/ui';

// Evaluate Campaign's real TeamSettings adapter with loaded state, then render the shared TeamFlow.
const source = await readFile(new URL('../src/TeamSettings.tsx', import.meta.url), 'utf8');
const { code } = await transformWithOxc(source.replace(/^import .*?;\r?\n/gm, '').replace('export default function', 'function'), 'TeamSettings.tsx', { jsx: { runtime: 'classic' } });
const members = [{ id: 'owner-1', name: 'Olive Owner', email: 'olive@example.test', role: 'owner' }, { id: 'admin-1', name: 'Ada Admin', email: 'ada@example.test', role: 'admin' }, { id: 'editor-1', name: 'Eli Editor', email: 'eli@example.test', role: 'editor' }];
const invitations = [{ id: 'invite-1', email: 'new@example.test', role: 'viewer', expiresAt: '2026-10-28T00:00:00.000Z', status: 'pending' }];

function view(role, currentUserId, calls = []) {
  const state = [members, invitations]; let index = 0;
  const useState = value => { const slot = index++; if (!(slot in state)) state[slot] = value; return [state[slot], next => { state[slot] = typeof next === 'function' ? next(state[slot]) : next; }]; };
  const TeamSettings = new Function('React', 'useState', 'useRef', 'useEffect', 'TeamFlow', code + '; return TeamSettings;')(React, useState, value => ({ current: value }), () => {}, TeamFlow);
  const request = async (path, method, body) => { calls.push([path, method, body]); return method === 'POST' ? { invitation: { id: 'invite-2' }, url: 'https://campaign.example.test/?invite=token' } : path.endsWith('/members') ? { members } : { invitations }; };
  const render = () => { index = 0; return TeamSettings({ workspaceId: 'workspace-1', role, currentUserId, request }); };
  return { render, state, calls };
}

test('owners manage every role and invite by link; there is no direct add-account form', async () => {
  const ui = view('owner', 'owner-1'), tree = ui.render(), html = renderToStaticMarkup(tree);
  assert.equal(tree.type, TeamFlow);
  assert.doesNotMatch(html, /Add existing account|Existing account email/);
  assert.match(html, /<h2[^>]*>Team access<\/h2>/); assert.match(html, /Create invitation link/);
  assert.deepEqual(tree.props.roles.map(option => option.value), ['owner', 'admin', 'editor', 'viewer']);
  assert.equal(tree.props.defaultInviteRole, 'editor');
  assert.deepEqual(members.map(member => tree.props.assignableRoles(member).length), [4, 4, 4]);
  await tree.props.onInvite({ email: 'new@example.test', role: 'admin' });
  assert.deepEqual(ui.calls[0], ['/workspaces/workspace-1/invitations', 'POST', { email: 'new@example.test', role: 'admin' }]);
  assert.deepEqual(ui.render().props.inviteLink, { id: 'invite-2', url: 'https://campaign.example.test/?invite=token' });
});

test('administrators only invite and manage editors and viewers', () => {
  const tree = view('admin', 'admin-1').render();
  assert.deepEqual(tree.props.roles.map(option => option.value), ['editor', 'viewer']);
  assert.deepEqual(members.map(member => tree.props.assignableRoles(member)), [[], [], ['editor', 'viewer']]);
  const html = renderToStaticMarkup(tree);
  assert.match(html, /aria-label="Role for Eli Editor"/); assert.doesNotMatch(html, /aria-label="Role for Olive Owner"/);
  assert.doesNotMatch(html, /<option value="owner"/);
});
