import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import { AuthStory, FirstUserSetupFlow, OidcProviderButtons, SignInFlow } from '@ten98/ui';
import { AppBrand } from '@ten98/ui/app';

// Evaluate Campaign's real adapter against the shared flows.
const source = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
const start = source.indexOf('function Auth({'), end = source.indexOf('\n}\n', start) + 2;
const { code } = await transformWithOxc(source.slice(start, end), 'Auth.tsx', { jsx: { runtime: 'classic' } });
const Auth = new Function('React', 'Brand', 'AuthStory', 'FirstUserSetupFlow', 'OidcProviderButtons', 'SignInFlow', code + '; return Auth;')(React, AppBrand, AuthStory, FirstUserSetupFlow, OidcProviderButtons, SignInFlow);

test('owner setup keeps the host token, password policy and sample opt-in and submits only the setup fields', () => {
  let submitted;
  const screen = Auth({ session: { setupRequired: true, oidcEnabled: true }, error: '', busy: false, onSubmit: values => { submitted = values; } });
  assert.equal(screen.type, FirstUserSetupFlow);
  const html = renderToStaticMarkup(screen);
  assert.match(html, /<h1[^>]*>Create owner account<\/h1>/);
  assert.match(html, /name="token"[^>]*type="password"|type="password"[^>]*name="token"/);
  assert.match(html, /minLength="32"|minlength="32"/i); assert.match(html, /maxLength="512"|maxlength="512"/i);
  assert.match(html, /name="sample"[^>]*checked|checked[^>]*name="sample"/);
  assert.doesNotMatch(html, /Organization single sign-on/, 'Identity sign-in is unavailable before the owner exists.');
  screen.props.onSubmit({ name: 'Owner', token: 't'.repeat(32), email: 'owner@example.test', password: 'p'.repeat(12), sample: false, workspaceName: 'ignored' });
  assert.deepEqual(submitted, { name: 'Owner', token: 't'.repeat(32), email: 'owner@example.test', password: 'p'.repeat(12), sample: false });
});

test('sign-in submits credentials and keeps the invitation on the single sign-on link', () => {
  let submitted;
  const screen = Auth({ session: { setupRequired: false, oidcEnabled: true }, inviteToken: 'A'.repeat(43), error: 'Email or password is incorrect.', busy: false, onSubmit: values => { submitted = values; } });
  assert.equal(screen.type, SignInFlow);
  const html = renderToStaticMarkup(screen);
  assert.match(html, /<h1[^>]*>Sign in<\/h1>/); assert.match(html, /role="alert"[^>]*>[^<]*Email or password is incorrect\.|Email or password is incorrect\./);
  assert.match(html, new RegExp('href="/api/auth/oidc/start\\?invite=' + 'A'.repeat(43) + '"'));
  assert.match(html, /Organization single sign-on/);
  screen.props.onSubmit({ email: 'member@example.test', password: 'secret' });
  assert.deepEqual(submitted, { email: 'member@example.test', password: 'secret' });
  assert.doesNotMatch(renderToStaticMarkup(Auth({ session: { setupRequired: false, oidcEnabled: false }, error: '', busy: false, onSubmit() {} })), /single sign-on/);
});
