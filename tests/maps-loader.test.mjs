import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

async function harness() {
  const source = await readFile(new URL('../src/OohMap.tsx', import.meta.url), 'utf8');
  const helper = source.slice(source.indexOf('let loader:'), source.indexOf('export default function OohMap'))
    .replace('let loader: Promise<any> | undefined', 'let loader').replace('export function loadGoogleMaps(key: string)', 'function loadGoogleMaps(key)').replace('document.querySelector<HTMLScriptElement>', 'document.querySelector');
  const scripts = [], events = [], timers = new Map(), maps = { fixtureMaps: true }; let timerId = 0, hiddenNonceReads = 0;
  const window = { google: { maps }, dispatchEvent(event) { events.push(event); } };
  const document = { createElement(tag) { assert.equal(tag, 'script'); return {}; }, querySelector(selector) { assert.equal(selector, 'script[nonce]'); return { nonce: 'actual-csp-nonce', getAttribute() { hiddenNonceReads++; return ''; } }; }, head: { append(script) { scripts.push(script); } } };
  const load = runInNewContext(`(() => { ${helper}; return loadGoogleMaps; })()`, { window, document, URLSearchParams, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } }, setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); } });
  return { load, scripts, events, timers, maps, window, hiddenNonceReads: () => hiddenNonceReads };
}

test('the actual Maps loader injects once with its CSP nonce and refuses key changes or late authorization failures', async () => {
  const fixture = await harness(), first = fixture.load('public-browser-key'), same = fixture.load('public-browser-key');
  assert.equal(first, same); assert.equal(fixture.scripts.length, 1);
  const script = fixture.scripts[0], url = new URL(script.src);
  assert.equal(url.origin, 'https://maps.googleapis.com'); assert.equal(url.pathname, '/maps/api/js'); assert.equal(url.searchParams.get('key'), 'public-browser-key');
  assert.equal(url.searchParams.get('libraries'), 'marker'); assert.equal(url.searchParams.get('callback'), '__ten98MapsReady'); assert.equal(url.searchParams.get('auth_referrer_policy'), 'origin');
  assert.equal(script.nonce, 'actual-csp-nonce'); assert.equal(fixture.hiddenNonceReads(), 0); assert.equal(script.async, true); assert.equal(script.referrerPolicy, 'strict-origin-when-cross-origin');
  fixture.window.__ten98MapsReady(); assert.equal(await first, fixture.maps); assert.equal(fixture.timers.size, 0);
  assert.equal(await fixture.load('public-browser-key'), fixture.maps); assert.equal(fixture.scripts.length, 1);
  await assert.rejects(fixture.load('changed-browser-key'), /Reload this page/); assert.equal(fixture.scripts.length, 1);
  fixture.window.gm_authFailure(); assert.equal(fixture.events.length, 1); assert.equal(fixture.events[0].type, 'ten98-maps-error'); assert.match(fixture.events[0].detail, /could not authorize/);
  await assert.rejects(fixture.load('public-browser-key'), /could not authorize/); assert.equal(fixture.scripts.length, 1, 'A previously resolved SDK must not produce a false successful test after a late authorization failure.');
});

test('the Maps loader reports early authorization, network and timeout failures without making network requests in the check', async () => {
  const denied = await harness(), rejected = denied.load('denied-browser-key'); denied.window.gm_authFailure();
  await assert.rejects(rejected, /could not authorize/); await assert.rejects(denied.load('denied-browser-key'), /could not authorize/); assert.equal(denied.scripts.length, 1); assert.equal(denied.timers.size, 0);
  const offline = await harness(), failed = offline.load('offline-browser-key'); offline.scripts[0].onerror();
  await assert.rejects(failed, /could not load/); assert.equal(offline.timers.size, 0);
  const retried = offline.load('offline-browser-key'); assert.equal(offline.scripts.length, 2); offline.window.__ten98MapsReady(); assert.equal(await retried, offline.maps);
  const stalled = await harness(), timedOut = stalled.load('stalled-browser-key'); assert.equal(stalled.timers.size, 1); [...stalled.timers.values()][0]();
  await assert.rejects(timedOut, /did not load/);
});
