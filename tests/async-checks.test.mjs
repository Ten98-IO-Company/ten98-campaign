import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

// Request guards are async on PostgreSQL. A call without `await` returns a promise nobody checks, so the guard
// silently stops guarding (publishing approval, project mapping, credential revision). Guards are discovered:
// every async function or property in server/ named assert* or prepare*, plus the named guards below.
const named = ['assertProjectMapping', 'assertIntegrationSettings', 'assertDriveMapping', 'assertPublishingApproval', 'assertProviderPostEdit', 'prepareDraft', 'persistNativeRefreshToken'];
const declaration = /async function ((?:assert|prepare)\w*)|\b((?:assert|prepare)\w*)\s*[:=]\s*async\b/g;

async function sources() {
  const directory = new URL('../server/', import.meta.url), files = (await readdir(directory)).filter(name => name.endsWith('.ts'));
  return Promise.all(files.map(async file => ({ file, source: await readFile(new URL(file, directory), 'utf8') })));
}
// `name` is awaited, or handed on as a callback (`() => name(...)`), or is itself being declared.
function unawaited(source, index, name) {
  const before = source.slice(Math.max(0, index - 60), index);
  return !/(?:await\s*\(?|=>|function\s+|async\s+)\s*$/.test(before) && !new RegExp(`\\b${name}\\s*[:=]\\s*async\\s*$`).test(before);
}
function lineOf(source, index) { return source.slice(0, index).split('\n').length; }

export async function scan(files) {
  const declared = new Map(), offenders = [];
  for (const { file, source } of files) for (const match of source.matchAll(declaration)) { const name = match[1] || match[2]; (declared.get(name) ?? declared.set(name, new Set()).get(name)).add(file); }
  const contextGuards = new Set([...named, ...declared.keys()]);
  for (const { file, source } of files) {
    // Direct calls: names declared async in this file, or imported from a file that declares them async.
    const imported = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/([\w-]+\.ts)'/g)].flatMap(([, names, from]) => names.split(',').map(part => part.trim().split(/\s+as\s+/).pop()).filter(name => declared.get(name)?.has(from)));
    const local = [...declared].filter(([, owners]) => owners.has(file)).map(([name]) => name);
    for (const name of new Set([...local, ...imported])) for (const match of source.matchAll(new RegExp(`(?<![.\\w$])${name}\\(`, 'g'))) if (unawaited(source, match.index, name)) offenders.push(`${file}:${lineOf(source, match.index)} ${name}()`);
    for (const match of source.matchAll(new RegExp(`\\b(?:context|ctx)\\.(${[...contextGuards].join('|')})\\?*\\.?\\(`, 'g'))) if (unawaited(source, match.index, match[1])) offenders.push(`${file}:${lineOf(source, match.index)} context.${match[1]}()`);
  }
  return { declared: new Set(declared.keys()), offenders };
}

test('every async request guard is awaited, so no check is skipped by a floating promise', async () => {
  const { offenders } = await scan(await sources());
  assert.deepEqual(offenders, []);
});

test('guard discovery still finds every named guard that follows the assert*/prepare* convention', async () => {
  const { declared } = await scan(await sources());
  for (const name of named.filter(name => /^(?:assert|prepare)/.test(name))) assert.ok(declared.has(name), `${name} is no longer declared async under the discovered convention`);
});

test('the scan catches an un-awaited guard, direct or through the request context', async () => {
  const { offenders } = await scan([
    { file: 'fixture-guard.ts', source: 'export async function assertFixtureOwner(id: string) {}\n' },
    { file: 'fixture-caller.ts', source: "import { assertFixtureOwner } from './fixture-guard.ts';\nasync function run(context: any) {\n  assertFixtureOwner('a');\n  await assertFixtureOwner('b');\n  context.assertProjectMapping?.('p');\n  await context.assertProjectMapping?.('q');\n  return () => assertFixtureOwner('c');\n}\n" },
  ]);
  assert.deepEqual(offenders, ['fixture-caller.ts:3 assertFixtureOwner()', 'fixture-caller.ts:5 context.assertProjectMapping()']);
});
