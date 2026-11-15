import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import * as ui from '@ten98/ui';
import viteConfig from '../vite.config.mjs';
import { themeStorageKey as key } from '../shared/theme.ts';

// The CSS parser is vite's own postcss dependency: Campaign's architecture declaration does not list postcss, and
// pnpm does not hoist a dependency's dependencies to the root.
const postcss = createRequire(import.meta.resolve('vite'))('postcss');

const [accountSource, mainSource, html] = await Promise.all(['../src/AccountSettings.tsx', '../src/main.tsx', '../index.html'].map(path => readFile(new URL(path, import.meta.url), 'utf8')));
const tags = viteConfig.plugins.find(plugin => plugin.name === 'ten98-theme-script').transformIndexHtml();
const boot = tags[0].children;
const { code } = await transformWithOxc(accountSource.replace(/^import .*?;\r?\n/gm, '').replace('export default function AccountSettings', 'function AccountSettings'), 'AccountSettings.tsx', { jsx: { runtime: 'classic' } });
function start(saved, blocked = false) {
  const document = { documentElement: { dataset: { theme: 'dark' } } };
  const context = { document, localStorage: { getItem(name) { assert.equal(name, key); if (blocked) throw new Error('Storage blocked'); return saved; } }, matchMedia() { assert.fail('CSS owns the system preference'); } };
  runInNewContext(boot, context);
  return document;
}
// AccountSettings receives the shell's useTheme state; `remembered` is what setTheme resolves (false when storage is blocked).
function accountUi(initial = 'system', remembered = true) {
  const values = [], applied = []; let cursor = 0;
  const account = { user: { email: 'member@example.test', name: 'Member' }, localPassword: true, activeSessions: 1 };
  const appearance = { theme: initial, resolvedTheme: 'light', setTheme: async theme => { applied.push(theme); appearance.theme = theme; return remembered; } };
  const Component = new Function('useEffect', 'useState', 'React', ...Object.keys(ui), code + '; return AccountSettings;')(() => {}, initialValue => {
    const index = cursor++; if (!(index in values)) values[index] = typeof initialValue === 'function' ? initialValue() : initialValue;
    return [values[index], value => { values[index] = typeof value === 'function' ? value(values[index]) : value; }];
  }, React, ...Object.values(ui));
  const request = async (path, method) => { assert.equal(method, undefined, 'Appearance alone does not write the account'); assert.equal(path, '/account'); return account; };
  let tree;
  function paint() { cursor = 0; tree = Component({ request, appearance: { ...appearance }, onChanged() { assert.fail('Appearance does not change account data'); } }); return tree; }
  function nodes(node = tree) { return !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(child => nodes(child))]; }
  paint(); values[0] = account; paint();
  const profile = () => nodes().find(node => node.type === ui.AccountProfileFlow);
  return { applied, paint, profile, choose: async theme => { await profile().props.onSubmit({ name: 'Member', theme }); paint(); }, html: () => renderToStaticMarkup(tree) };
}

test('the inline theme boot is the shared script under Campaign\'s key, in the head, with no separate file', () => {
  assert.equal(tags.length, 1); assert.equal(tags[0].tag, 'script'); assert.equal(tags[0].injectTo, 'head-prepend');
  assert.equal(boot, ui.createThemeScript(key)); assert.equal(key, 'ten98-campaign-theme', 'Existing saved choices keep working.');
  assert.doesNotMatch(html, /theme\.js/);
});

test('the theme boot accepts only saved modes and defaults to System without resolving the device preference', () => {
  for (const [saved, expected] of [[null, 'system'], ['system', 'system'], ['light', 'light'], ['dark', 'dark'], ['', 'system'], ['DARK', 'system'], ['dark; color:red', 'system']]) assert.equal(start(saved).documentElement.dataset.theme, expected, String(saved));
});

test('the theme boot tolerates unavailable storage and still applies System', () => {
  assert.equal(start('dark', true).documentElement.dataset.theme, 'system');
  const document = { documentElement: { dataset: {} } }, context = { document };
  Object.defineProperty(context, 'localStorage', { get() { throw new Error('Access denied'); } });
  runInNewContext(boot, context);
  assert.equal(document.documentElement.dataset.theme, 'system');
});

test('the shell calls useTheme once with the shared key and gives every AccountSettings that state', () => {
  assert.equal(mainSource.match(/useTheme\(/g).length, 1);
  assert.match(mainSource, /const appearance = useTheme\(\{ storageKey: themeStorageKey \}\);/);
  assert.equal(mainSource.split('<AccountSettings ').length - 1, 3, 'three mounts: the account dialog, Profile and Security');
  assert.equal(mainSource.split('<AccountSettings appearance={appearance} ').length - 1, 3, 'every mount receives the shell state');
  assert.doesNotMatch(accountSource, /localStorage|dataset\.theme/, 'Settings changes the theme only through the shared state.');
});

test('actual AccountSettings profile flow offers the theme and applies each mode through the shared state', async () => {
  const settings = accountUi();
  assert.equal(settings.profile().props.defaultValues.theme, 'system');
  assert.equal(settings.profile().props.localeOptions, undefined); assert.equal(settings.profile().props.timeZones, undefined);
  const page = settings.html();
  assert.match(page, /name="theme"[^>]*value="system"|value="system"[^>]*name="theme"/); assert.doesNotMatch(page, /name="locale"|name="timeZone"/);
  for (const mode of ['dark', 'light', 'system']) {
    await settings.choose(mode);
    assert.equal(settings.applied.at(-1), mode);
    assert.equal(settings.profile().props.defaultValues.theme, mode);
  }
  assert.match(settings.html(), /Appearance saved for this browser/);
});

test('actual Appearance change rejects unknown modes and reports a tab-only choice when storage is blocked', async () => {
  const settings = accountUi('light', false);
  await settings.choose('dark');
  assert.deepEqual(settings.applied, ['dark']);
  assert.match(settings.html(), /Appearance changed for this tab. Your browser could not save this preference/);
  await settings.choose('unknown');
  assert.deepEqual(settings.applied, ['dark'], 'An unknown mode never reaches setTheme.');
});

test('System mode delegates live device changes to the installed theme CSS', async () => {
  const css = postcss.parse(await readFile(new URL(import.meta.resolve('@ten98/ui/tokens.css')), 'utf8'));
  let systemDark;
  css.walkAtRules('media', rule => { if (rule.params === '(prefers-color-scheme: dark)') systemDark = rule; });
  assert.ok(systemDark);
  const rules = systemDark.nodes.filter(node => node.type === 'rule');
  assert.deepEqual(rules.map(rule => rule.selector), ["[data-theme='system']"]);
  assert.ok(rules[0].nodes.some(decl => decl.prop === 'color-scheme' && decl.value === 'dark'));
  assert.doesNotMatch(boot + accountSource, /matchMedia|prefers-color-scheme/);
  assert.equal(start('system').documentElement.dataset.theme, 'system');
});
