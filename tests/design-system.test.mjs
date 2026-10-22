import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import { AppField } from '@ten98/ui/app';

const source = name => readFile(new URL('../src/' + name, import.meta.url), 'utf8');

test('Campaign imports shared suite components and styles instead of defining duplicate primitives', async () => {
  const [main, composer, details] = await Promise.all(['main.tsx', 'AdComposer.tsx', 'AdDetails.tsx'].map(source));
  assert.match(main, /AppIcon as Icon, AppBrand as Brand, AppField as Field, AppBadge, AppStat as Stat, AppSelect.*from '@ten98\/ui\/app'/);
  assert.doesNotMatch(main, /^function (?:Icon|Empty|Stat|Field)\(/m);
  assert.match(composer, /import \{ AppField \} from '@ten98\/ui\/app'/);
  assert.doesNotMatch(composer, /^function Field\(/m);
  assert.match(details, /import \{ AppField \} from '@ten98\/ui\/app'/);
  assert.match(main, /^import '@ten98\/ui\/app-tokens\.css';$/m);
  assert.match(main, /^import '@ten98\/ui\/app\.css';$/m); assert.match(main, /^import '@ten98\/ui\/product\.css';$/m);
});

test('shared Campaign fields retain native labels, required markers and editable textarea defaults', () => {
  const html = renderToStaticMarkup(React.createElement(AppField, { label: 'Ad text', name: 'body', multiline: true, defaultValue: 'First line\nSecond line', required: true, disabled: true, maxLength: 200, placeholder: 'Write an ad' }));
  assert.match(html, /<label class="field"><span>Ad text<span class="required" aria-hidden="true"> \*<\/span><\/span>/);
  assert.match(html, /<textarea[^>]*name="body"/);
  for (const attribute of ['required=""', 'disabled=""', 'maxLength="200"', 'placeholder="Write an ad"']) assert.ok(html.includes(attribute), attribute);
  assert.match(html, />First line\nSecond line<\/textarea>/);
});

test('AdDetails keeps provider values as uncontrolled defaults and preserves number constraints', async () => {
  const details = await source('AdDetails.tsx');
  const start = details.indexOf('function Field('), end = details.indexOf('export default function AdDetails(', start);
  assert.ok(start > 0 && end > start);
  const { code } = await transformWithOxc(details.slice(start, end), 'CampaignField.tsx', { jsx: { runtime: 'classic' } });
  const Field = new Function('React', 'AppField', code + '; return Field;')(React, AppField);
  const number = Field({ label: 'Daily budget', name: 'amount', type: 'number', value: 0, required: true });
  assert.equal(number.type, AppField);
  assert.equal(number.props.defaultValue, 0);
  assert.equal(number.props.value, undefined);
  assert.equal(number.props.min, 0);
  assert.equal(number.props.step, 'any');
  assert.equal(number.props.required, true);
  const multiline = Field({ label: 'Ad text', name: 'body', multiline: true, value: 'Provider text' });
  assert.equal(multiline.props.defaultValue, 'Provider text');
  assert.equal(multiline.props.value, undefined);
  assert.equal(Field({ label: 'Ad text', name: 'body', multiline: true, value: 0 }).props.defaultValue, '');
  assert.equal(Field({ label: 'Missing text', name: 'body' }).props.defaultValue, '');
  const html = renderToStaticMarkup(number);
  assert.match(html, /type="number"/);
  assert.match(html, /value="0"/);
});


test('Campaign ships no stylesheet of its own', async () => {
  // @ten98/ui 0.20 owns the page base, tables, fields and the sign-in card, so the app sheet is gone.
  await assert.rejects(source('styles.css'), { code: 'ENOENT' });
  // The unified inbox and direct campaigns render only @ten98/ui components, so they no longer ship stylesheets of their own.
  await assert.rejects(source('inbox.css'), { code: 'ENOENT' });
  await assert.rejects(source('direct-campaigns.css'), { code: 'ENOENT' });
  // The post composer's actions use the editor Dialog's always-visible footer, so its sticky-footer sheet is gone.
  await assert.rejects(source('post-composer.css'), { code: 'ENOENT' });
});
