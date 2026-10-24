import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

// CodeQL reports `.replace(/<[^>]*>/g, …)` as incomplete multi-character sanitisation and has blocked releases
// (#181, #212). Tests read rendered text with readText from tests/read-text.ts instead.
const tagStrip = /\.replace\(\s*\/<\[\^>\][*+]>\//;
const root = new URL('./', import.meta.url);

test('tests read rendered text with readText instead of a tag-stripping replace', async () => {
  const files = (await readdir(root, { recursive: true }))
    .map(file => file.replaceAll('\\', '/'))
    .filter(file => /\.(ts|mjs)$/.test(file) && !file.split('/').includes('node_modules') && file !== 'read-text.ts' && file !== 'no-tag-strip.test.ts');
  assert.ok(files.length > 0, 'No test files were scanned.');
  const found: string[] = [];
  for (const file of files) {
    (await readFile(new URL(file, root), 'utf8')).split(/\r?\n/).forEach((line, index) => {
      if (tagStrip.test(line)) found.push(`tests/${file}:${index + 1}`);
    });
  }
  assert.deepEqual(found, [], 'Use readText from tests/read-text.ts instead of a tag-stripping .replace(/<[^>]*>/g, …):\n' + found.join('\n'));
});
