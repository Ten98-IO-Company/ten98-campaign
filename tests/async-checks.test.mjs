import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

// The request context's guards are async on PostgreSQL. A call without `await` returns a promise that nobody
// checks, so the guard silently stops guarding (publishing approval, project mapping, credential revision).
const guards = /\b(?:context|ctx)\.(?:assertProjectMapping|assertIntegrationSettings|assertDriveMapping|assertPublishingApproval|assertProviderPostEdit|prepareDraft|persistNativeRefreshToken)\?*\.?\(/g;
// Modules still on SQLite (issue #25); each leaves this list when it converts. The list may only shrink.
const unconverted = new Set(['agent.ts', 'calendar.ts', 'inbox.ts', 'native-google-ads.ts', 'native-microsoft-ads.ts']);

test('every async request guard is awaited, so no check is skipped by a floating promise', async () => {
  const offenders = new Map();
  for (const file of (await readdir(new URL('../server/', import.meta.url))).filter(name => name.endsWith('.ts'))) {
    const source = await readFile(new URL(`../server/${file}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(guards)) {
      const before = source.slice(Math.max(0, match.index - 40), match.index);
      // Awaited, or passed on as a callback (`() => context.assertProjectMapping?.(...)`) that its caller awaits.
      if (/await\s*\(?\s*$/.test(before) || /=>\s*$/.test(before)) continue;
      const line = source.slice(0, match.index).split('\n').length;
      (offenders.get(file) ?? offenders.set(file, []).get(file)).push(line);
    }
  }
  for (const [file, lines] of offenders) assert.ok(unconverted.has(file), `${file} calls an async guard without await at line(s) ${lines.join(', ')}`);
  for (const file of unconverted) assert.ok(offenders.has(file), `${file} no longer has un-awaited guards; remove it from the unconverted list`);
});
