import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import { AppField } from '@ten98/ui/app';

const source = name => readFile(new URL('../src/' + name, import.meta.url), 'utf8');

test('Campaign imports shared suite components and styles instead of defining duplicate primitives', async () => {
  const [main, composer, details, styles] = await Promise.all(['main.tsx', 'AdComposer.tsx', 'AdDetails.tsx', 'styles.css'].map(source));
  assert.match(main, /AppIcon as Icon, AppBrand as Brand, AppField as Field, AppBadge, AppEmpty as Empty, AppStat as Stat, AppSelect.*from '@ten98\/ui\/app'/);
  assert.doesNotMatch(main, /^function (?:Icon|Empty|Stat|Field)\(/m);
  assert.match(composer, /import \{ AppField as Field \} from '@ten98\/ui\/app'/);
  assert.doesNotMatch(composer, /^function Field\(/m);
  assert.match(details, /import \{ AppField \} from '@ten98\/ui\/app'/);
  assert.match(styles, /@import '@ten98\/ui\/app-tokens\.css';/);
  assert.match(styles, /@import '@ten98\/ui\/app\.css';/);
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


test('native integration and empty-state copy keeps light colors and readable dark roles', async () => {
  const tokenUrl = new URL(import.meta.resolve('@ten98/ui/app-tokens.css'));
  const [styles, aliases, tokens] = await Promise.all([source('styles.css'), readFile(tokenUrl, 'utf8'), readFile(new URL('./tokens.css', tokenUrl), 'utf8')]);
  const dark = tokens.match(/\[data-theme=['"]dark['"]\]\s*\{([^{}]+)\}/)?.[1];
  assert.ok(dark, 'installed dark theme');
  const colors = Object.fromEntries([...dark.matchAll(/(--[\w-]+):\s*(#[\da-f]{6})/gi)].map(([, name, value]) => [name, value]));
  const roleColor = role => {
    const name = aliases.match(new RegExp(role + '\\s*:\\s*var\\((--[\\w-]+)\\)'))?.[1];
    assert.ok(colors[name], role + ' resolves to an installed dark color');
    return colors[name];
  };
  const luminance = hex => {
    const [r, g, b] = hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return .2126 * r + .7152 * g + .0722 * b;
  };
  // Use the installed surface roles observed in the authenticated browser.
  for (const [selector, light, background, minimum] of [
    ['.integration-header h2', '#725e7f', '--color-surface', 4.5], ['.integration-header p', '#6f6278', '--color-surface', 4.5],
    ['.empty h3', '#725e81', '--color-canvas', 4.5], ['.empty p', '#6c6075', '--color-canvas', 4.5],
    ['.empty-icon', '#73608a', '--color-accent-subtle', 3],
    ['.post-copy', '#725f7e', '--color-surface', 4.5], ['.post-meta', '#6e6178', '--color-surface', 4.5],
  ]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const values = [...styles.matchAll(new RegExp(escaped + '\\{([^{}]*)\\}', 'g'))].flatMap(([, body]) => [...body.matchAll(/(?:^|;)color:([^;]+)/g)].map(([, value]) => value));
    assert.equal(values.length, 1, selector + ' has one native foreground owner');
    const branch = values[0].match(/^light-dark\((#[\da-f]{6}),var\((--[\w-]+)\)\)$/i);
    assert.ok(branch, selector + ' follows semantic colors in explicit, system and nested themes');
    assert.equal(branch[1], light, selector + ' preserves its light color');
    const fg = luminance(roleColor(branch[2])), bg = luminance(background.startsWith('--') ? roleColor(background) : background);
    const contrast = (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05);
    assert.ok(contrast >= minimum, selector + ' dark contrast is ' + contrast.toFixed(3));
  }
  // Native feedback pairs keep their light paint and geometry while sharing dark roles.
  const themedPaint = (value, light, label) => {
    const branch = value?.match(/^light-dark\((#[\da-f]{3,6}),var\((--[\w-]+)\)\)$/i);
    assert.ok(branch, label + ' uses a semantic dark role');
    assert.equal(branch[1], light, label + ' preserves its light color');
    return roleColor(branch[2]);
  };
  for (const [selector, lightBackground, lightBorder, lightForeground, geometry] of [
    [".ad-details-discard", "#faf3e8", "#efdec4", null, "border-radius:7px;padding:16px;margin-bottom:20px;font-size:13px;line-height:1.6"],
    [".alert", "#faf3e8", "#efdec4", "#78613f", "display:flex;align-items:center;justify-content:space-between;gap:10px;border-radius:7px;padding:13px 15px;font-size:13px;margin-bottom:20px;line-height:1.6"],
    [".alert.error", "#fff0f4", "#f4d7e1", "#8d5469", ""],
    [".toast", "#fff", "#dfd3ed", "#775c87", "position:fixed;right:28px;bottom:25px;max-width:calc(100% - 32px);border-radius:8px;padding:15px 20px;font-size:13px;box-shadow:0 6px 30px #31144e14;display:flex;gap:10px;align-items:center;z-index:100"],
  ]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const bodies = [...styles.matchAll(new RegExp(escaped + '\\{([^{}]*)\\}', 'g'))].map(([, body]) => body).filter(body => body.includes('background:'));
    assert.equal(bodies.length, 1, selector + ' has one native feedback surface owner');
    const props = Object.fromEntries(bodies[0].split(';').map(part => { const colon = part.indexOf(':'); return [part.slice(0, colon), part.slice(colon + 1)]; }));
    assert.equal(Object.entries(props).filter(([key]) => !['background', 'border', 'border-color', 'color'].includes(key)).map(([key, value]) => key + ':' + value).join(';'), geometry, selector + ' geometry is unchanged');
    if (props.border) assert.match(props.border, /^1px solid /, selector + ' border width/style is unchanged');
    themedPaint((props['border-color'] || props.border).replace(/^1px solid /, ''), lightBorder, selector + ' border');
    const background = themedPaint(props.background, lightBackground, selector + ' background');
    let foreground;
    if (lightForeground) foreground = themedPaint(props.color, lightForeground, selector + ' foreground');
    else {
      assert.equal(props.color, undefined, 'discard confirmation retains its inherited semantic foreground');
      assert.match(styles, /:root\{[^}]*color:var\(--color-text\)/);
      foreground = roleColor('--color-text');
    }
    const fg = luminance(foreground), bg = luminance(background);
    const contrast = (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05);
    assert.ok(contrast >= 4.5, selector + ' dark text contrast is ' + contrast.toFixed(3));
  }

  // This native block is shared by Overview, Analytics summary and Campaigns rows.
  // Removing only the dark branches must reproduce every original light paint and layout declaration.
  const overview = styles.slice(styles.indexOf('.sample-banner{'), styles.indexOf('.list-toolbar{'));
  const lightOverview = overview.replace(/light-dark\((#[\da-f]{3,6}|white),var\(--[\w-]+\)\)/gi, '$1');
  assert.equal(createHash('sha256').update(lightOverview).digest('hex'), '2e27291466aed00d0f956c3fcd01a0a3692211b6620c9eba35c5fccdae8cd399', 'all Overview light colors, selectors and geometry are preserved');
  const paint = (selector, property, sheet = styles) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const values = [...sheet.matchAll(new RegExp(escaped + '\\{([^{}]*)\\}', 'g'))].flatMap(([, body]) => body.split(';').filter(part => part.startsWith(property + ':')).map(part => part.slice(property.length + 1)));
    assert.ok(values.length, selector + ' owns ' + property);
    return values.at(-1);
  };
  const pairedRole = (value, label) => {
    const branch = value.match(/^light-dark\((?:#[\da-f]{3,8}|white),var\((--[\w-]+)\)\)$/i);
    assert.ok(branch, label + ' has one semantic dark branch');
    roleColor(branch[1]);
    return branch[1];
  };
  const contrast = (foreground, background) => {
    const fg = luminance(roleColor(foreground)), bg = luminance(roleColor(background));
    return (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05);
  };
  const mapSurface = pairedRole(paint('.map-location-list>button', 'background'), 'native map location surface');
  assert.equal(paint('.map-location-list>button', 'background'), 'light-dark(#faf9fd,var(--color-surface-subtle))');
  for (const foreground of ['--color-text', '--color-text-muted']) assert.ok(contrast(foreground, mapSurface) >= 4.5, 'native map location names and inherited helper text stay readable');
  assert.equal(paint('.placement-location', 'background'), 'light-dark(#f8f9fc,var(--color-surface-subtle))');
  assert.equal(paint('.placement-location', 'color'), 'var(--text)', 'placement location retains its semantic foreground');
  assert.ok(contrast('--color-text', pairedRole(paint('.placement-location', 'background'), 'placement location surface')) >= 4.5, 'placement location text and surface stay paired');
  assert.equal(paint('.agent-proposal', 'background'), 'light-dark(#fbf9ff,var(--color-surface-subtle))');
  assert.equal(paint('.agent-proposal', 'border'), '1px solid light-dark(#e3d9f0,var(--color-border))');
  const proposalSurface = pairedRole(paint('.agent-proposal', 'background'), 'draft proposal surface');
  for (const foreground of ['--color-text', '--color-text-muted']) assert.ok(contrast(foreground, proposalSurface) >= 4.5, 'draft proposal names and inherited labels stay readable');
  assert.equal(paint('.ooh-map', 'background'), '#f2f0f8', 'map artwork and its existing canvas remain unchanged');
  const lightMap = styles.slice(styles.indexOf('.ooh-map{'), styles.indexOf('.google-event{')).replace(/light-dark\((#[\da-f]{3,8}),var\(--[\w-]+\)\)/gi, '$1').replace(/\r\n/g, '\n');
  assert.equal(createHash('sha256').update(lightMap).digest('hex'), '87916b290a63064e100b06e3f46ab197b8ea6df3feca232976967d337d8665a1', 'all native map-list light colors and geometry are preserved');
  for (const [selector, light, foreground, surface] of [
    ['.map-location-list small', '#71657d', '--color-text-muted', '--color-surface-subtle'],
    ['.asset-info>strong', '#735c7f', '--color-text', '--color-surface'],
    ['.asset-info>div:not(.tag-list)', '#71627b', '--color-text-muted', '--color-surface'],
    ['.agent-model', '#766d81', '--color-text-muted', '--color-surface'],
    ['.placement-body h3', '#755d83', '--color-text', '--color-surface'],
    ['.placement-body p', '#71607b', '--color-text-muted', '--color-surface'],
    ['.placement-details', '#73607e', '--color-text', '--color-surface'],
    ['.placement-details small', '#6e6076', '--color-text-muted', '--color-surface'],
    ['.agent-proposal p', '#5f526c', '--color-text', '--color-surface-subtle'],
    ['.agent-proposal dt', '#776483', '--color-text-muted', '--color-surface-subtle'],
    ['.agent-proposal dd', '#42354d', '--color-text', '--color-surface-subtle'],
    ['.agent-receipt', '#74667e', '--color-text-muted', '--color-surface'],
  ]) {
    assert.equal(paint(selector, 'color'), `light-dark(${light},var(${foreground}))`, selector + ' preserves its light paint and owns the appropriate dark text role');
    assert.ok(contrast(pairedRole(paint(selector, 'color'), selector), surface) >= 4.5, selector + ' dark text stays readable');
  }
  // The image overlay retains its translucent light fill but owns a complete opaque dark pair.
  assert.equal(paint('.asset-type', 'background'), 'light-dark(#ffffffad,var(--color-surface-raised))');
  assert.equal(paint('.asset-type', 'color'), 'light-dark(#71607b,var(--color-text))');
  assert.ok(contrast(pairedRole(paint('.asset-type', 'color'), 'asset kind text'), pairedRole(paint('.asset-type', 'background'), 'asset kind surface')) >= 4.5, 'asset kind badge remains readable independently of the media behind it');
  for (const [selectors, expected, label] of [
    [['.asset-type', '.asset-info>strong', '.asset-info>div:not(.tag-list)', '.agent-model'], '541371ca1ee7feedd21fce52c5c869c903e898a603ad0b558304741be3234759', 'asset and model'],
    [['.placement-location', '.placement-body h3', '.placement-body p', '.placement-details', '.placement-details small', '.agent-proposal', '.agent-proposal p', '.agent-proposal dt', '.agent-proposal dd', '.agent-receipt'], '0bccb0cf720bbbd30065749238572367b162c96b4747d20afe13277d4252c7bd', 'placement and proposal'],
  ]) {
    const lightNativeOwners = selectors.map(selector => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const body = [...styles.matchAll(new RegExp(escaped + '\\{([^{}]*)\\}', 'g'))].map(([, value]) => value).find(value => /(?:^|;)(?:color|background):/.test(value));
      assert.ok(body, selector + ' has a native paint owner');
      return selector + '{' + body + '}';
    }).join('\n').replace(/light-dark\((#[\da-f]{3,8}),var\(--[\w-]+\)\)/gi, '$1');
    assert.equal(createHash('sha256').update(lightNativeOwners).digest('hex'), expected, label + ' light paint, transparency and geometry are preserved');
  }
  const broadsign = '.integration-settings-icon.broadsign';
  const broadsignForeground = themedPaint(paint(broadsign, 'color'), '#825208', 'Broadsign foreground');
  const broadsignBackground = themedPaint(paint(broadsign, 'background'), '#fcf6e9', 'Broadsign background');
  themedPaint(paint(broadsign, 'border-color'), '#f0e7d5', 'Broadsign border');
  assert.ok(Math.min(...[['#825208', '#fcf6e9'], [broadsignForeground, broadsignBackground]].map(([foreground, background]) => {
    const fg = luminance(foreground), bg = luminance(background);
    return (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05);
  })) >= 4.5, 'Broadsign B at 15px stays readable in both themes');
  for (const selector of [
    '.performance-legend', '.chart-row>div:first-child', '.chart-row strong', '.chart-footer', '.chart-footer span',
    '.channel-breakdown>div', '.channel-breakdown strong', '.channel-breakdown small', '.count', '.campaign-name strong', '.campaign-name small',
    '.channel-label', '.budget-cell strong', '.budget-cell strong>span', '.date-tile', '.upcoming-row>div:nth-child(2)>strong', '.upcoming-row>div:nth-child(2)>span', '.upcoming-row>svg',
    '.activity-row p', '.activity-row small', '.page-footer', '.page-footer>span:first-child',
  ]) {
    const foreground = pairedRole(paint(selector, 'color'), selector);
    for (const surface of ['--color-surface', '--color-canvas']) assert.ok(contrast(foreground, surface) >= 4.5, selector + ' dark text stays readable on ' + surface);
  }
  for (const selector of ['.sample-banner', '.sample-pill', '.mix-empty', '.campaign-avatar', '.campaign-avatar.social', '.campaign-avatar.paid', '.campaign-avatar.ooh', '.activity-icon']) {
    const foreground = pairedRole(paint(selector, 'color'), selector + ' foreground');
    const background = pairedRole(paint(selector, 'background'), selector + ' surface');
    assert.ok(contrast(foreground, background) >= 4.5, selector + ' pairs readable text with a dark surface');
  }
  assert.equal(paint('.mix-empty', 'background'), 'light-dark(#f5f1fa,var(--color-surface-subtle))', 'empty channel visualization withdraws its pale light panel in dark mode');
  assert.doesNotMatch(styles, /\.avatar(?:\.mini)?\{[^}]*\b(?:color|background):/, 'shared avatar owns its foreground and surface together');
  const avatarSheet = await readFile(new URL(import.meta.resolve('@ten98/ui/app.css')), 'utf8');
  assert.equal(paint('.avatar', 'color', avatarSheet), 'var(--color-text-muted)');
  const avatarSurface = paint('.avatar', 'background', avatarSheet).match(/^light-dark\((#[\da-f]{6}),var\((--[\w-]+)\)\)$/i);
  assert.ok(avatarSurface, 'installed avatar pairs its light and dark surfaces');
  const lightTheme = tokens.match(/\[data-theme=['"]light['"]\][^{]*\{([^{}]+)\}/)?.[1];
  assert.ok(lightTheme);
  const lightColors = Object.fromEntries([...lightTheme.matchAll(/(--[\w-]+):\s*(#[\da-f]{6})/gi)].map(([, name, value]) => [name, value]));
  const avatarTextAlias = aliases.match(/--color-text-muted\s*:\s*var\((--[\w-]+)\)/)?.[1];
  assert.ok(lightColors[avatarTextAlias]);
  const avatarLightFg = luminance(lightColors[avatarTextAlias]), avatarLightBg = luminance(avatarSurface[1]);
  assert.ok((Math.max(avatarLightFg, avatarLightBg) + .05) / (Math.min(avatarLightFg, avatarLightBg) + .05) >= 4.5, 'installed avatar text passes in light mode');
  assert.ok(contrast('--color-text-muted', avatarSurface[2]) >= 4.5, 'installed avatar text passes in dark mode');
  assert.equal(paint('.sample-banner button', 'color'), 'light-dark(#715c93,var(--color-accent))');
  for (const [selector, surface] of [['.band-0', '--color-accent'], ['.band-1', '--color-chart-2'], ['.band-2', '--color-chart-3'], ['.band-3', '--color-chart-4']]) {
    const foreground = pairedRole(paint(selector, 'color'), selector + ' count');
    // The grouped compatibility rule also owns bands 1–3 and must stay paired.
    assert.ok(contrast(foreground, surface) >= 4.5, selector + ' dark count contrast');
  }
  assert.equal(paint('.band-0', 'color'), 'light-dark(white,var(--color-on-accent))');
  assert.equal(paint('.band-1,.band-2,.band-3', 'color'), 'light-dark(#352346,var(--color-on-accent))');
  for (const selector of ['.legend-dot.purple', '.legend-dot.pale', '.mix-dot-0', '.mix-dot-1', '.mix-dot-2', '.mix-dot-3', '.chart-track>span', '.chart-row:nth-child(2) .chart-track>span', '.chart-row:nth-child(3) .chart-track>span', '.chart-row:nth-child(4) .chart-track>span', '.progress', '.progress>span']) pairedRole(paint(selector, 'background'), selector);
  assert.equal(paint('.chart-track', 'background'), 'repeating-linear-gradient(90deg,light-dark(#f3effa,var(--color-border-control)) 0,light-dark(#f3effa,var(--color-border-control)) calc(25% - 1px),light-dark(#fff,var(--color-surface)) calc(25% - 1px),light-dark(#fff,var(--color-surface)) 25%)');
  for (const [selector, property] of [['.sample-banner', 'border'], ['.chart-footer', 'border-top'], ['.upcoming-row', 'border-top'], ['.date-tile', 'border']]) pairedRole(paint(selector, property).replace(/^1px solid /, ''), selector + ' border');
  for (const [file, lightHash, selectors] of [
    ['inbox.css', 'dad771b504b2ee08bd03dab216771fa6b656091e466dbdde7e704700719b19c8', ['.inbox-conversation', '.inbox-conversation:hover,.inbox-conversation.selected', '.inbox-contact', '.inbox-message', '.inbox-message.outgoing', '.inbox-review blockquote']],
    ['direct-campaigns.css', 'ff69defeea5a8b4411dd1cb767f8710a4894c696970cb3766065752a152176f7', ['.direct-message-preview', '.direct-counts>span', '.direct-confirmation', '.direct-import-results']],
  ]) {
    const sheet = await source(file), light = sheet.replace(/light-dark\((#[\da-f]{3,8}|white),var\(--[\w-]+\)\)/gi, '$1').replace(/\r\n/g, '\n');
    assert.equal(createHash('sha256').update(light).digest('hex'), lightHash, file + ' preserves every original light color and layout declaration');
    for (const selector of selectors) {
      const surface = pairedRole(paint(selector, 'background', sheet), file + ' ' + selector);
      for (const foreground of ['--color-text', '--color-text-muted']) assert.ok(contrast(foreground, surface) >= 4.5, selector + ' keeps inherited message and helper text readable');
    }
    if (file === 'inbox.css') {
      for (const selector of ['.inbox-notice,.inbox-provider-note', '.inbox-provider-note', '.inbox-avatar']) assert.ok(contrast(pairedRole(paint(selector, 'color', sheet), selector), pairedRole(paint(selector, 'background', sheet), selector)) >= 4.5, selector + ' owns a readable feedback pair');
      const author = pairedRole(paint('.inbox-message>strong', 'color', sheet), 'message author');
      for (const selector of ['.inbox-message', '.inbox-message.outgoing']) assert.ok(contrast(author, pairedRole(paint(selector, 'background', sheet), selector)) >= 4.5, 'message author stays readable');
    }
    if (file === 'direct-campaigns.css') {
      for (const selector of ['.direct-audience legend,.direct-consent-fields legend', '.direct-consented', '.direct-suppressed']) assert.ok(contrast(pairedRole(paint(selector, 'color', sheet), selector), '--color-surface') >= 4.5, selector + ' stays readable');
      for (const selector of ['.direct-notice', '.direct-policy,.direct-provider-note', '.direct-provider-note']) assert.ok(contrast(pairedRole(paint(selector, 'color', sheet), selector), pairedRole(paint(selector, 'background', sheet), selector)) >= 4.5, selector + ' keeps its notice text and surface paired');
    }
  }
});
