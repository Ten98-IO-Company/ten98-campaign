import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

// A transaction holds one pool connection. Anything inside it that reaches for the pool again (the outer db or store,
// a request guard called without the transaction, a helper given the whole request context) needs a second connection:
// under load every connection holds a transaction waiting for another, and each times out. Its writes also commit
// outside the transaction, and its reads run outside the lock. The runtime regressions run on a one-connection pool
// (tests/postgres.mjs singleConnection); this scan covers every transaction callback in server/.
const rules = [
  [/(?<![\w.$])db\.\w+/g, 'the outer db'],
  [/(?<![\w.$])store\.\w+/g, 'the outer store', body => /\b(?:const|let)\s+store\s*=\s*createStore\(/.test(body)],
  [/\bcontext\.(?:db|store|assert\w*)\b/g, 'the request context'],
  [/(?<![\w.$])(?:assert\w*|check|checkMapping)\(\s*\)/g, 'a guard without the transaction'],
  [/\b(?:checkMapping|current)\(\s*(?:assert\w*|check)\s*[,)]/g, 'a guard passed without the transaction'],
  // within(context, tx) is the binder that gives helpers a context on the transaction.
  [/(?<!\bwithin)\(\s*context\s*[,)]/g, 'a helper given the request context'],
];

async function sources() {
  const directory = new URL('../server/', import.meta.url), files = (await readdir(directory)).filter(name => name.endsWith('.ts'));
  return Promise.all(files.map(async file => ({ file, source: await readFile(new URL(file, directory), 'utf8') })));
}
function lineOf(source, index) { return source.slice(0, index).split('\n').length; }

export function scan(files) {
  const offenders = [];
  for (const { file, source } of files) for (const match of source.matchAll(/\.transaction\(\s*async\s*\(?\s*\w+[^)]*\)?\s*=>\s*\{/g)) {
    let depth = 1, end = match.index + match[0].length; const start = end;
    while (depth && end < source.length) { const char = source[end++]; if (char === '{') depth++; else if (char === '}') depth--; }
    const body = source.slice(start, end - 1);
    for (const [pattern, reason, allowed] of rules) {
      if (allowed?.(body)) continue;
      for (const hit of body.matchAll(pattern)) offenders.push(`${file}:${lineOf(source, start + hit.index)} ${hit[0]} (${reason})`);
    }
  }
  return offenders;
}

test('no transaction reaches for a second pool connection', async () => {
  assert.deepEqual(scan(await sources()), []);
});

test('the scan catches pool use inside a transaction and allows a store bound to it', () => {
  const offenders = scan([{ file: 'fixture.ts', source: [
    'async function run(context: any, db: any, store: any) {',
    '  await db.transaction(async (tx: any) => {',
    '    await store.activity("p", "outer store");',
    '    await context.assertIntegrationSettings();',
    '    await checkMapping(assertMapping);',
    '    await postSnapshot(context, post);',
    '    await check(tx); await assertCurrent(tx);',
    '  });',
    '  await db.transaction(async tx => { const store = createStore(tx); await store.list("p", "posts"); });',
    '}',
  ].join('\n') }]);
  assert.deepEqual(offenders, [
    'fixture.ts:3 store.activity (the outer store)',
    'fixture.ts:4 context.assertIntegrationSettings (the request context)',
    'fixture.ts:5 checkMapping(assertMapping) (a guard passed without the transaction)',
    'fixture.ts:6 (context, (a helper given the request context)',
  ]);
});
