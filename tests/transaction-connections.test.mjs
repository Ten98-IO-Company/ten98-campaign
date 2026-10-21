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
// Helpers that default their executor to the pool (`ex: Executor = db`) read the pool unless a call passes the
// transaction. The scan is lexical: it follows same-file helpers by name, not calls into other modules.
const poolDefault = /(?:function\s+(\w+)|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?)\s*\(([^)]*:\s*Executor\s*=\s*db\b[^)]*)\)/g;

async function sources() {
  const directory = new URL('../server/', import.meta.url), files = (await readdir(directory)).filter(name => name.endsWith('.ts'));
  return Promise.all(files.map(async file => ({ file, source: await readFile(new URL(file, directory), 'utf8') })));
}
function lineOf(source, index) { return source.slice(0, index).split('\n').length; }
// The text between the parenthesis at `open` and its match.
function argumentsAt(source, open) {
  let depth = 1, end = open + 1;
  while (depth && end < source.length) { const char = source[end++]; if (char === '(') depth++; else if (char === ')') depth--; }
  return source.slice(open + 1, end - 1);
}

export function scan(files) {
  const offenders = [];
  for (const { file, source } of files) {
    const helpers = [...source.matchAll(poolDefault)].map(match => match[1] || match[2]);
    for (const match of source.matchAll(/\.transaction\(\s*async\s*\(?\s*(\w+)[^)]*\)?\s*=>\s*\{/g)) {
      let depth = 1, end = match.index + match[0].length; const start = end, tx = new RegExp(`\\b${match[1]}\\b`);
      while (depth && end < source.length) { const char = source[end++]; if (char === '{') depth++; else if (char === '}') depth--; }
      const body = source.slice(start, end - 1), report = (index, text, reason) => offenders.push(`${file}:${lineOf(source, start + index)} ${text} (${reason})`);
      for (const [pattern, reason, allowed] of rules) {
        if (allowed?.(body)) continue;
        for (const hit of body.matchAll(pattern)) report(hit.index, hit[0], reason);
      }
      for (const name of helpers) for (const hit of body.matchAll(new RegExp(`(?<![\\w.$])${name}\\(`, 'g'))) {
        if (!tx.test(argumentsAt(body, hit.index + hit[0].length - 1))) report(hit.index, `${name}()`, 'a pool-default helper without the transaction');
      }
    }
  }
  return offenders;
}

test('no transaction reaches for a second pool connection', async () => {
  assert.deepEqual(scan(await sources()), []);
});

test('the scan catches pool use inside a transaction and allows a store or helper bound to it', () => {
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
    'const read = async (id: string, ex: Executor = db) => ex.execute(id);',
    'async function preview(campaign: any, ex: Executor = db) { return read(campaign, ex); }',
    'const later = (pool: any) => pool.transaction(async (tx: any) => {',
    '  await preview(one); await preview(two, tx); await read(three, tx);',
    '});',
  ].join('\n') }]);
  assert.deepEqual(offenders, [
    'fixture.ts:3 store.activity (the outer store)',
    'fixture.ts:4 context.assertIntegrationSettings (the request context)',
    'fixture.ts:5 checkMapping(assertMapping) (a guard passed without the transaction)',
    'fixture.ts:6 (context, (a helper given the request context)',
    'fixture.ts:14 preview() (a pool-default helper without the transaction)',
  ]);
});
