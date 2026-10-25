import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import { AuthFrameProvider, AuthStory, FirstUserSetupFlow, OidcProviderButtons, SignInFlow } from '@ten98/ui';
import { AppBrand } from '@ten98/ui/app';

// Evaluate Campaign's real adapter against the shared flows.
const source = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
const start = source.indexOf('function Auth({'), end = source.indexOf('\n}\n', start) + 2;
const { code } = await transformWithOxc(source.slice(start, end), 'Auth.tsx', { jsx: { runtime: 'classic' } });
// The shared story panel from src/auth-story.tsx, evaluated the same way.
const storySource = await readFile(new URL('../src/auth-story.tsx', import.meta.url), 'utf8');
const { code: storyCode } = await transformWithOxc(storySource.replace(/^import .*?;\r?\n/gm, '').replace('export const', 'const'), 'auth-story.tsx', { jsx: { runtime: 'classic' } });
const authStory = new Function('React', 'AuthStory', storyCode + '; return authStory;')(React, AuthStory);
// startupAuthError is the module-level message read once from ?auth_error at startup.
const load = (startupAuthError = '') => new Function('React', 'Brand', 'authStory', 'FirstUserSetupFlow', 'OidcProviderButtons', 'SignInFlow', 'startupAuthError', code + '; return Auth;')(React, AppBrand, authStory, FirstUserSetupFlow, OidcProviderButtons, SignInFlow, startupAuthError);
const Auth = load();
// The app mounts one AuthFrameProvider at the root (DS #157); screens render inside the same frame here.
const framed = element => React.createElement(AuthFrameProvider, { brand: React.createElement(AppBrand, { product: 'Campaign' }), aside: authStory, passwordPolicy: { minLength: 12, maxLength: 128 } }, element);

test('first boot is one screen: name, email, password, a prefilled workspace name and one Create owner account button', () => {
  let submitted;
  const screen = Auth({ session: { setupRequired: true, oidcEnabled: true }, error: '', busy: false, onSubmit: values => { submitted = values; } });
  assert.equal(screen.type, FirstUserSetupFlow);
  assert.equal(screen.props.setupToken, false, 'Token-less first sign-up (@ten98/ui 0.24.0).'); assert.equal(screen.props.workspaceName, true); assert.equal(screen.props.workspaceNameRequired, false, 'A cleared name becomes "My workspace" on the server (@ten98/ui 0.25.0).'); assert.deepEqual(screen.props.defaultValues, { workspaceName: 'My workspace' });
  for (const absent of ['eyebrow', 'sampleOptIn', 'signInInstead', 'tokenHint', 'surface']) assert.equal(screen.props[absent], undefined, `No ${absent} on the first-boot screen.`);
  // Discover's wording (#265): who the first account becomes. No custom hint, so the library's policy hint shows here
  // as on the invitation screen (#273).
  assert.equal(screen.props.description, 'The first account becomes the owner of this installation and its workspace. You can rename the workspace later.');
  // Brand, story panel and password policy come from the root AuthFrameProvider, as in Discover; the landmark is 'Account access'.
  for (const prop of ['brand', 'aside', 'passwordPolicy', 'busyLabel']) assert.equal(screen.props[prop], undefined, prop);
  assert.equal(screen.props.label, 'Account access');
  const html = renderToStaticMarkup(framed(screen));
  assert.match(html, /auth-split/); assert.match(html, /Plan\. Publish\./); assert.doesNotMatch(html, /t98-auth-layout--card/);
  assert.match(html, /<h1[^>]*>Create owner account<\/h1>/);
  for (const field of ['name', 'email', 'password']) assert.match(html, new RegExp(`<input[^>]*required[^>]*name="${field}"|<input[^>]*name="${field}"[^>]*required`), `${field} is required`);
  assert.match(html, /name="workspaceName"[^>]*value="My workspace"|value="My workspace"[^>]*name="workspaceName"/);
  assert.doesNotMatch(html.match(/<input[^>]*name="workspaceName"[^>]*>/)?.[0] || '', /required/, 'The workspace name may be left blank.');
  assert.match(html, /name="password"[^>]*minLength="12"|minLength="12"[^>]*name="password"/i);
  assert.equal(html.match(/<button[^>]*type="submit"[^>]*>/g)?.length, 1, 'One button.'); assert.match(html, /<button[^>]*type="submit"[^>]*>Create owner account<\/button>/);
  assert.doesNotMatch(html, /<button[^>]*type="button"/, 'No other actions.');
  assert.doesNotMatch(html, /name="token"|Setup token/, 'No setup token field.');
  assert.equal((html.match(/<input[^>]*name="/g) || []).length, 4, 'Exactly name, email, password and workspace name.');
  assert.doesNotMatch(html, /name="sample"/, 'The sample opt-in moved to the first-project step.');
  assert.doesNotMatch(html, /Organization single sign-on/, 'No single sign-on before the owner exists.');
  screen.props.onSubmit({ name: 'Owner', token: 'typed anyway', email: 'owner@example.test', password: 'p'.repeat(12), sample: true, workspaceName: 'Northwind' });
  assert.deepEqual(submitted, { name: 'Owner', email: 'owner@example.test', password: 'p'.repeat(12), workspaceName: 'Northwind' });
});

test('sign-in submits credentials, and invitation single sign-on starts through the app instead of a link carrying the token', () => {
  let submitted, started = 0;
  const screen = Auth({ session: { setupRequired: false, oidcEnabled: true }, inviteToken: 'A'.repeat(43), error: 'Email or password is incorrect.', busy: false, onSubmit: values => { submitted = values; }, onOidcStart: () => { started++; } });
  assert.equal(screen.type, SignInFlow);
  // Sign-in and first boot share one story panel and the default split layout, as in Discover.
  const setup = Auth({ session: { setupRequired: true }, error: '', busy: false, onSubmit() {} });
  assert.equal(screen.props.aside, undefined); assert.equal(setup.props.aside, undefined); assert.equal(screen.props.label, 'Account access'); assert.equal(screen.props.surface, undefined); assert.equal(screen.props.eyebrow, undefined, 'No eyebrow above the form, as in Discover (#265).');
  const html = renderToStaticMarkup(screen);
  assert.match(html, /<h1[^>]*>Sign in to join<\/h1>/); assert.match(html, /role="alert"[^>]*>[^<]*Email or password is incorrect\.|Email or password is incorrect\./);
  assert.match(html, /Organization single sign-on/);
  assert.match(renderToStaticMarkup(Auth({ session: { oidcEnabled: false }, error: '', busy: false, onSubmit() {} })), /<h1[^>]*>Sign in<\/h1>/, 'Plain sign-in keeps its title.');
  assert.equal(html.includes('A'.repeat(43)), false, 'The invitation token is not rendered into the page.'); assert.doesNotMatch(html, /href="\/api\/auth\/oidc\/start/);
  const providers = screen.props.providers;
  assert.equal(providers.type, OidcProviderButtons); assert.deepEqual(providers.props.providers, [{ id: 'sso', name: 'Organization single sign-on' }]);
  providers.props.onStart('sso'); assert.equal(started, 1);
  screen.props.onSubmit({ email: 'member@example.test', password: 'secret' });
  assert.deepEqual(submitted, { email: 'member@example.test', password: 'secret' });
  assert.match(renderToStaticMarkup(Auth({ session: { setupRequired: false, oidcEnabled: true }, error: '', busy: false, onSubmit() {} })), /href="\/api\/auth\/oidc\/start"/, 'Plain single sign-on stays a link.');
  assert.doesNotMatch(renderToStaticMarkup(Auth({ session: { setupRequired: false, oidcEnabled: false }, error: '', busy: false, onSubmit() {} })), /single sign-on/);
});

test('Sign in instead keeps the invitation context: it names the invitation, prefills the invited email and leads back', () => {
  let back = 0;
  const screen = Auth({ session: { oidcEnabled: false }, inviteToken: 'A'.repeat(43), inviteEmail: 'invited@example.test', onBackToInvitation: () => { back++; }, error: '', busy: false, onSubmit() {} });
  assert.equal(screen.type, SignInFlow);
  assert.equal(screen.props.title, 'Sign in to join'); assert.equal(screen.props.description, 'Sign in as invited@example.test to accept your workspace invitation.');
  assert.deepEqual(screen.props.defaultValues, { email: 'invited@example.test' });
  const html = renderToStaticMarkup(screen);
  assert.match(html, /value="invited@example\.test"/); assert.match(html, /Back to invitation/); assert.equal(html.includes('A'.repeat(43)), false);
  screen.props.cancel.onClick(); assert.equal(back, 1);
  const unknown = Auth({ session: { oidcEnabled: false }, inviteToken: 'A'.repeat(43), error: '', busy: false, onSubmit() {} });
  assert.equal(unknown.props.description, 'Sign in with the invited email to accept your workspace invitation.'); assert.equal(unknown.props.defaultValues, undefined);
  // The App keeps the token in memory: Sign in instead stores the invited email, Back clears it, and a signed-in session shows the invitation again.
  assert.match(source, /onSignIn=\{email => \{ setInviteSignIn\(\{ email \}\);/);
  assert.match(source, /<Auth session=\{session\} inviteToken=\{inviteToken\} inviteEmail=\{inviteSignIn\?\.email\} onBackToInvitation=\{\(\) => \{ setError\(''\); setInviteSignIn\(null\); \}\}/);
  assert.match(source, /if \(inviteToken && !\(inviteSignIn && !session\.user\)\) return <AcceptInvitation /);
});

// The real startup invitation reader from main.tsx.
const inviteStart = source.indexOf('function takeInvite('), inviteEnd = source.indexOf('\n}\n', inviteStart) + 2;
const takeInvite = inviteStart < 0 ? undefined : new Function((await transformWithOxc(source.slice(inviteStart, inviteEnd), 'TakeInvite.ts')).code + '; return takeInvite;')();
function openLink(search, hash = '') {
  const calls = [], history = { state: { campaignIndex: 2 }, replaceState: (...args) => calls.push(args) };
  return { token: takeInvite({ pathname: '/', search, hash }, history), calls };
}

test('the startup reader takes the invitation from #invite= or an older ?invite= link and removes it from the address and history entry', () => {
  assert.equal(typeof takeInvite, 'function');
  const invite = 'Ab_-'.repeat(10) + 'xyz';
  assert.deepEqual(openLink('', '#invite=' + invite), { token: invite, calls: [[{ campaignIndex: 2 }, '', '/']] });
  assert.deepEqual(openLink('?invite=' + invite), { token: invite, calls: [[{ campaignIndex: 2 }, '', '/']] }, 'Older query links keep working.');
  assert.deepEqual(openLink('?project=p1&invite=' + invite), { token: invite, calls: [[{ campaignIndex: 2 }, '', '/?project=p1']] });
  assert.deepEqual(openLink('?invite=' + 'B'.repeat(43), '#invite=' + invite), { token: invite, calls: [[{ campaignIndex: 2 }, '', '/']] }, 'The fragment wins, and both copies are removed.');
  assert.deepEqual(openLink('?project=p1', '#top'), { token: '', calls: [] }, 'Without an invitation the address is left alone.');
  assert.equal((source.match(/takeInvite\(window\.location, window\.history\)/g) || []).length, 1, 'The invitation reader runs once at startup; a pasted link is read by watchInvite.');
  assert.doesNotMatch(source, /get\('invite'\) \|\| ''/, 'The app does not read the invitation from the address again.');
  assert.ok(source.indexOf('let startupAuthError = takeAuthError(') < source.indexOf('const startupInvite = takeInvite('), 'An identity error is read first, so a returned #invite= survives until the invitation reader takes it.');
});

// The real hash-change reader from main.tsx, run against a fake window.
const watchStart = source.indexOf('function watchInvite('), watchEnd = source.indexOf('\n}\n', watchStart) + 2;
const watchInvite = watchStart < 0 ? undefined : new Function('takeInvite', (await transformWithOxc(source.slice(watchStart, watchEnd), 'WatchInvite.ts')).code + '; return watchInvite;')(takeInvite);

test('an invitation link pasted into an open tab is read on hashchange, once, and removed from the address', () => {
  assert.equal(typeof watchInvite, 'function');
  const invite = 'Ab_-'.repeat(10) + 'xyz', listeners = new Map(), calls = [], tokens = [];
  const target = {
    location: { pathname: '/', search: '?project=p1', hash: '' },
    history: { state: { campaignIndex: 4 }, replaceState: (...args) => { calls.push(args); target.location.hash = ''; } },
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type, listener) => { if (listeners.get(type) === listener) listeners.delete(type); },
  };
  const stop = watchInvite(target, token => tokens.push(token));
  target.location.hash = '#top'; listeners.get('hashchange')();
  assert.deepEqual([tokens, calls], [[], []], 'Other fragments are left alone.');
  target.location.hash = '#invite=' + invite; listeners.get('hashchange')();
  assert.deepEqual(tokens, [invite]); assert.deepEqual(calls, [[{ campaignIndex: 4 }, '', '/?project=p1']]);
  stop(); assert.equal(listeners.has('hashchange'), false, 'The listener is removed on unmount.');
  assert.match(source, /useEffect\(\(\) => watchInvite\(window, token => \{ setInviteSignIn\(null\); setInviteToken\(token\); \}\), \[\]\);/, 'The App shows the new invitation instead of Sign in.');
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
  assert.deepEqual(returnTo('?auth_error=OIDC_INVITE_EMAIL_MISMATCH', '#invite=' + invite).calls, [[{ campaignIndex: 3 }, '', '/#invite=' + invite]]);
  assert.deepEqual(returnTo(`?project=p1&auth_error=X&auth_error=Y&invite=${invite}`, '#top').calls, [[{ campaignIndex: 3 }, '', `/?project=p1&invite=${invite}#top`]]);
  assert.equal((source.match(/takeAuthError\(window\.location, window\.history\)/g) || []).length, 1, 'auth_error is read once, at startup.');
  assert.match(source, /\[inviteSignIn, setInviteSignIn\] = useState<\{ email\?: string \} \| null>\(startupAuthError \? \{\} : null\)/, 'A returned invitation opens the sign-in screen so the error is visible.');
});

test('the sign-in screen shows the startup error through SignInFlow, keeps the session notice and clears it on the next attempt', () => {
  const message = oidcSignInErrors.OIDC_NOT_PROVISIONED, WithError = load(message);
  const screen = WithError({ session: { setupRequired: false, oidcEnabled: true, sessionEnded: true }, inviteToken: 'A'.repeat(43), error: '', busy: false, onSubmit() {} });
  assert.equal(screen.type, SignInFlow); assert.equal(screen.props.error, message);
  // An ended session (expired, or a 401 while signed in) is a notice beside the form, not a form error.
  assert.deepEqual(screen.props.notice, { tone: 'warning', text: 'Your session ended. Sign in again.' });
  // A session that ended with an unsaved editor or inbox draft says those changes were not saved.
  assert.deepEqual(WithError({ session: { sessionEnded: true, unsavedChangesLost: true }, error: '', busy: false, onSubmit() {} }).props.notice, { tone: 'warning', text: 'Your session ended before your changes were saved. Sign in again, then make those changes again.' });
  const html = renderToStaticMarkup(screen); assert.ok(html.includes(message.replace(/'/g, '&#x27;'))); assert.match(html, /Your session ended\. Sign in again\./);
  assert.equal(WithError({ session: { oidcEnabled: true }, error: '', busy: false, onSubmit() {} }).props.description, 'Use your account to access your workspaces.');
  assert.equal(WithError({ session: { oidcEnabled: true }, error: '', busy: false, onSubmit() {} }).props.notice, undefined);
  assert.equal(WithError({ session: { oidcEnabled: true }, error: 'Email or password is incorrect.', busy: false, onSubmit() {} }).props.error, 'Email or password is incorrect.');
  let submitted; WithError({ session: { oidcEnabled: true }, error: '', busy: false, onSubmit: values => { submitted = values; } }).props.onSubmit({ email: 'member@example.test', password: 'secret' });
  assert.deepEqual(submitted, { email: 'member@example.test', password: 'secret' });
  assert.equal(WithError({ session: { oidcEnabled: true }, error: '', busy: true, onSubmit() {} }).props.error, undefined, 'A new attempt replaces the earlier identity error.');
});

// #272: when owner setup finds the installation already claimed (409), the screen offers Sign in instead, which opens
// sign-in with the typed email. The story eyebrow is sentence case, as in Discover.
test('a claimed installation offers Sign in instead, which carries the typed email to sign-in', () => {
  const signedIn = [];
  const before = Auth({ session: { setupRequired: true }, error: '', busy: false, onSubmit() {}, onSignInInstead: email => signedIn.push(email) });
  assert.equal(before.props.signInInstead, undefined, 'Nothing to offer before the server says the owner exists.');
  const claimed = Auth({ session: { setupRequired: true }, error: 'This installation already has an owner.', busy: false, onSubmit() {}, signInInstead: { offered: true, email: 'me@example.test' }, onSignInInstead: email => signedIn.push(email) });
  claimed.props.signInInstead.onClick('me@example.test'); assert.deepEqual(signedIn, ['me@example.test']);
  const signIn = Auth({ session: { setupRequired: false }, error: '', busy: false, onSubmit() {}, signInInstead: { offered: false, email: 'me@example.test' } });
  assert.equal(signIn.type, SignInFlow); assert.deepEqual(signIn.props.defaultValues, { email: 'me@example.test' });
  assert.equal(authStory.props.eyebrow, 'Campaign management');
});

test('the 409 path and the startup retry are wired in the app', () => {
  assert.match(source, /\.catch\(\(err: any\) => \{ if \(session\.setupRequired && err\?\.status === 409\) setSignInInstead\(\{ offered: true, email: values\.email \|\| '' \}\);/);
  assert.match(source, /message=\{error \|\| 'Loading Campaign…'\} onRetry=\{error \? \(\) => \{ setError\(''\); loadSession\(\); \} : undefined\}/);
});

// A sign-in or owner setup with no HTTP answer is unconfirmed, as in Discover: the screen says so instead of an error.
test('an unconfirmed sign-in or setup shows the unconfirmed notice instead of an error', () => {
  for (const setupRequired of [false, true]) {
    const screen = Auth({ session: { setupRequired }, error: 'Failed to fetch', busy: false, onSubmit() {}, unconfirmed: 'Could not be confirmed.' });
    assert.equal(screen.props.unconfirmed, 'Could not be confirmed.');
  }
  assert.equal(Auth({ session: { setupRequired: false }, error: 'Failed to fetch', busy: false, onSubmit() {}, unconfirmed: 'Could not be confirmed.' }).props.error, undefined, 'Sign-in shows only the unconfirmed notice.');
  assert.match(source, /if \(err\?\.status === undefined && err\?\.name !== 'AbortError'\) setAuthUnconfirmed\(/);
});
