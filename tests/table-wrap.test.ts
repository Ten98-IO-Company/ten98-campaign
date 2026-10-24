import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// QA #148: with @ten98/ui 0.23.0, wrapping table cells used `overflow-wrap: anywhere`, which lets a column's minimum
// width shrink to one character, so Links at 320 px and Invitations at 1024 px wrapped a letter per line. 0.24.0
// (DS #76) wraps at word boundaries instead, so a column keeps the width of its longest word and the table scrolls.
const ui = (file: string) => readFile(new URL(`../node_modules/@ten98/ui/dist/${file}`, import.meta.url), 'utf8');

test('wrapping table cells keep a word-width minimum instead of collapsing to one letter per line (QA #148)', async () => {
  for (const file of ['patterns.css', 'styles.css']) {
    const css = await ui(file), rule = /\.t98-table \.t98-table-cell--wrap\s*\{([^}]*)\}/.exec(css)?.[1];
    assert.ok(rule, `${file} styles wrapping cells`);
    assert.match(rule, /overflow-wrap:\s*break-word/, `${file} wraps at word boundaries`);
    assert.doesNotMatch(rule, /anywhere/, `${file} no longer lets cells shrink to one character`);
    assert.match(css, /\.t98-table-scroll\s*\{[^}]*overflow-x:\s*auto/, `${file} lets a wide table scroll`);
  }
  const links = await readFile(new URL('../src/CampaignLinks.tsx', import.meta.url), 'utf8');
  assert.match(links, /\{ key: 'link', header: 'Link', wrap: true,/, 'The Links table uses the library wrap that 0.24.0 fixed.');
});
