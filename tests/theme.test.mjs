import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import postcss from 'postcss';
import * as ui from '@ten98/ui';

const [boot, accountSource, html] = await Promise.all(['../public/theme.js', '../src/AccountSettings.tsx', '../index.html'].map(path => readFile(new URL(path, import.meta.url), 'utf8')));
const key = 'ten98-campaign-theme';
const { code } = await transformWithOxc(accountSource.replace(/^import .*?;\r?\n/gm, '').replace('export default function AccountSettings', 'function AccountSettings'), 'AccountSettings.tsx', { jsx: { runtime: 'classic' } });
function start(saved, blocked = false) {
  const document = { documentElement: { dataset: { theme: 'dark' } } };
  const context = { document, localStorage: { getItem(name) { assert.equal(name, key); if (blocked) throw new Error('Storage blocked'); return saved; } }, matchMedia() { assert.fail('CSS owns the system preference'); } };
  runInNewContext(boot, context);
  return document;
}
function accountUi(document, blocked = false) {
  const values = [], writes = []; let cursor = 0;
  const account = { user: { email: 'member@example.test', name: 'Member' }, localPassword: true, activeSessions: 1 };
  const storage = { setItem(name, value) { assert.equal(document.documentElement.dataset.theme, value, 'theme applies before persistence'); if (blocked) throw new Error('Storage blocked'); writes.push([name, value]); } };
  const Component = new Function('useEffect', 'useState', 'React', 'document', 'localStorage', ...Object.keys(ui), code + '; return AccountSettings;')(() => {}, initial => {
    const index = cursor++; if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial;
    return [values[index], value => { values[index] = typeof value === 'function' ? value(values[index]) : value; }];
  }, React, document, storage, ...Object.values(ui));
  const request = async (path, method) => { assert.equal(method, undefined, 'Appearance alone does not write the account'); assert.equal(path, '/account'); return account; };
  let tree;
  function paint() { cursor = 0; tree = Component({ request, onChanged() { assert.fail('Appearance does not change account data'); } }); return tree; }
  function nodes(node = tree) { return !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(child => nodes(child))]; }
  paint(); values[0] = account; paint();
  const profile = () => nodes().find(node => node.type === ui.AccountProfileFlow);
  return { writes, paint, profile, choose: async theme => { await profile().props.onSubmit({ name: 'Member', theme }); paint(); }, html: () => renderToStaticMarkup(tree) };
}

test('blocking theme boot accepts only saved modes and defaults to System without resolving the device preference', () => {
  assert.ok(html.indexOf('<script src="/theme.js"></script>') > 0 && html.indexOf('<script src="/theme.js"></script>') < html.indexOf('<script type="module"'), 'saved appearance loads before the application module');
  for (const [saved, expected] of [[null, 'system'], ['system', 'system'], ['light', 'light'], ['dark', 'dark'], ['', 'system'], ['DARK', 'system'], ['dark; color:red', 'system']]) assert.equal(start(saved).documentElement.dataset.theme, expected);
});

test('blocking theme boot tolerates unavailable storage and still applies System', () => {
  assert.equal(start('dark', true).documentElement.dataset.theme, 'system');
  const document = { documentElement: { dataset: {} } }, context = { document };
  Object.defineProperty(context, 'localStorage', { get() { throw new Error('Access denied'); } });
  runInNewContext(boot, context);
  assert.equal(document.documentElement.dataset.theme, 'system');
});

test('actual AccountSettings profile flow offers the theme and persists each mode for the next load', async () => {
  const document = start(null), ui = accountUi(document);
  assert.equal(ui.profile().props.defaultValues.theme, 'system');
  assert.equal(ui.profile().props.localeOptions, undefined); assert.equal(ui.profile().props.timeZones, undefined);
  const html = ui.html();
  assert.match(html, /name="theme"[^>]*value="system"|value="system"[^>]*name="theme"/); assert.doesNotMatch(html, /name="locale"|name="timeZone"/);
  for (const mode of ['dark', 'light', 'system']) {
    await ui.choose(mode);
    assert.equal(document.documentElement.dataset.theme, mode);
    assert.equal(ui.profile().props.defaultValues.theme, mode);
    assert.deepEqual(ui.writes.at(-1), [key, mode]);
    assert.equal(start(ui.writes.at(-1)[1]).documentElement.dataset.theme, mode);
  }
  assert.match(ui.html(), /Appearance saved for this browser/);
});

test('actual Appearance change rejects unknown modes and applies a tab-only choice when storage is blocked', async () => {
  const document = start('light'), ui = accountUi(document, true);
  await ui.choose('dark');
  assert.equal(document.documentElement.dataset.theme, 'dark');
  assert.equal(ui.profile().props.defaultValues.theme, 'dark');
  assert.match(ui.html(), /Appearance changed for this tab. Your browser could not save this preference/);
  await ui.choose('unknown');
  assert.equal(document.documentElement.dataset.theme, 'dark');
  assert.deepEqual(ui.writes, []);
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
