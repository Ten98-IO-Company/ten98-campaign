import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

// The app's setup area is Settings › Connections; "Integrations" survives only as an internal page and route name (#220, #241).
// Messages shown to people, from the browser or from server errors, point at the place they can find.
const oldPlace = /\b(?:in|under) Integrations\b/;
const dirs = ['src', 'server'].map(dir => new URL(`../${dir}/`, import.meta.url));

test('messages point people at Settings › Connections, not Integrations', async () => {
  const found: string[] = [];
  for (const dir of dirs) {
    for (const file of (await readdir(dir, { recursive: true })).map(name => name.replaceAll('\\', '/')).filter(name => /\.tsx?$/.test(name))) {
      (await readFile(new URL(file, dir), 'utf8')).split(/\r?\n/).forEach((line, index) => {
        if (!line.trimStart().startsWith('//') && oldPlace.test(line)) found.push(`${dir.pathname.split('/').at(-2)}/${file}:${index + 1}`);
      });
    }
  }
  assert.deepEqual(found, [], 'Say "in Settings › Connections" instead:\n' + found.join('\n'));
});

// QA round 5 (#267): phrases that named the integration or "the provider" where people read them.
test('messages name the network or the place, not Zernio or "the provider"', async () => {
  const banned = [/history stored by Zernio/, /sends it to the provider/, /The provider could not read/, /Create provider/];
  const found: string[] = [];
  for (const dir of dirs) {
    for (const file of (await readdir(dir, { recursive: true })).map(name => name.replaceAll('\\', '/')).filter(name => /\.tsx?$/.test(name))) {
      const source = await readFile(new URL(file, dir), 'utf8');
      for (const pattern of banned) if (pattern.test(source)) found.push(`${file}: ${pattern}`);
    }
  }
  assert.deepEqual(found, []);
});
