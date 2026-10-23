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
// startupAuthError is the module-level message read once from ?auth_error at startup.
const load = (startupAuthError = '') => new Function('React', 'Brand', 'AuthStory', 'FirstUserSetupFlow', 'OidcProviderButtons', 'SignInFlow', 'startupAuthError', code + '; return Auth;')(React, AppBrand, AuthStory, FirstUserSetupFlow, OidcProviderButtons, SignInFlow, startupAuthError);
const Auth = load();

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

// The real startup reader and code map from main.tsx.
const mapStart = source.indexOf('const oidcSignInErrors'), readerEnd = source.indexOf('\n}\n', source.indexOf('function takeAuthError(')) + 2;
const { code: readerCode } = await transformWithOxc(source.slice(mapStart, readerEnd), 'AuthError.ts');
const { oidcSignInErrors, takeAuthError } = mapStart < 0 ? {} : new Function(readerCode + '; return { oidcSignInErrors, takeAuthError };')();
function returnTo(search, hash = '') {
  const calls = [], history = { state: { campaignIndex: 3 }, replaceState: (...args) => calls.push(args) };
  return { message: takeAuthError({ pathname: '/', search, hash }, history), calls };
}

test('each identity sign-in error code maps to its own readable message, and unknown codes are generic', () => {
  const codes = ['OIDC_INVITE_EMAIL_MISMATCH', 'OIDC_NOT_PROVISIONED', 'OIDC_EMAIL_UNVERIFIED', 'OIDC_ACCOUNT_EXISTS', 'OIDC_RATE_LIMITED', 'OIDC_SIGN_IN_FAILED'];
  const messages = codes.map(code => returnTo('?auth_error=' + code).message);
  assert.equal(new Set(messages).size, codes.length);
  for (const [index, message] of messages.entries()) { assert.ok(message.length > 30, codes[index]); assert.doesNotMatch(message, /OIDC_|auth_error/); }
  assert.match(messages[0], /invitation/i); assert.match(messages[3], /email and password/i); assert.match(messages[4], /try again/i); assert.match(messages[5], /start again/i);
  for (const search of ['?auth_error=%3Cb%3EInjected%3C%2Fb%3E', '?auth_error=', '?auth_error=constructor', '?auth_error=__proto__', '?auth_error=oidc_rate_limited']) assert.equal(returnTo(search).message, oidcSignInErrors.OIDC_SIGN_IN_FAILED, search);
  assert.deepEqual(returnTo('?invite=' + 'A'.repeat(43)), { message: '', calls: [] }, 'Without auth_error the address is left alone.');
});

test('the startup reader removes auth_error from the address and keeps the invitation and other values', () => {
  const invite = 'Ab_-'.repeat(10) + 'xyz';
  assert.deepEqual(returnTo(`?auth_error=OIDC_INVITE_EMAIL_MISMATCH&invite=${invite}`).calls, [[{ campaignIndex: 3 }, '', '/?invite=' + invite]]);
  assert.deepEqual(returnTo('?auth_error=OIDC_RATE_LIMITED').calls, [[{ campaignIndex: 3 }, '', '/']]);
  assert.deepEqual(returnTo(`?project=p1&auth_error=X&auth_error=Y&invite=${invite}`, '#top').calls, [[{ campaignIndex: 3 }, '', `/?project=p1&invite=${invite}#top`]]);
  assert.equal((source.match(/takeAuthError\(window\.location, window\.history\)/g) || []).length, 1, 'auth_error is read once, at startup.');
  assert.match(source, /\[inviteSignIn, setInviteSignIn\] = useState\(Boolean\(startupAuthError\)\)/, 'A returned invitation opens the sign-in screen so the error is visible.');
});

test('the sign-in screen shows the startup error through SignInFlow, keeps the session notice and clears it on the next attempt', () => {
  const message = oidcSignInErrors.OIDC_NOT_PROVISIONED, WithError = load(message);
  const screen = WithError({ session: { setupRequired: false, oidcEnabled: true, sessionEnded: true }, inviteToken: 'A'.repeat(43), error: '', busy: false, onSubmit() {} });
  assert.equal(screen.type, SignInFlow); assert.equal(screen.props.error, message);
  // An ended session (expired, or a 401 while signed in) is a notice beside the form, not a form error.
  assert.deepEqual(screen.props.notice, { tone: 'warning', text: 'Your session ended. Sign in again.' });
  const html = renderToStaticMarkup(screen); assert.ok(html.includes(message.replace(/'/g, '&#x27;'))); assert.match(html, /Your session ended\. Sign in again\./);
  assert.equal(WithError({ session: { oidcEnabled: true }, error: '', busy: false, onSubmit() {} }).props.description, 'Use your account to access your workspaces.');
  assert.equal(WithError({ session: { oidcEnabled: true }, error: '', busy: false, onSubmit() {} }).props.notice, undefined);
  assert.equal(WithError({ session: { oidcEnabled: true }, error: 'Email or password is incorrect.', busy: false, onSubmit() {} }).props.error, 'Email or password is incorrect.');
  let submitted; WithError({ session: { oidcEnabled: true }, error: '', busy: false, onSubmit: values => { submitted = values; } }).props.onSubmit({ email: 'member@example.test', password: 'secret' });
  assert.deepEqual(submitted, { email: 'member@example.test', password: 'secret' });
  assert.equal(WithError({ session: { oidcEnabled: true }, error: '', busy: true, onSubmit() {} }).props.error, undefined, 'A new attempt replaces the earlier identity error.');
});
