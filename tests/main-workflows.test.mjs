import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';

const source = () => readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');

test('calendar dates stay on their intended day while timestamps follow the browser timezone', () => {
  const declaration = source().match(/^const date = .+;$/m)?.[0];
  assert.ok(declaration, 'Exercise the date formatter used by campaign and OOH cards.');
  const script = `${declaration.replace('(value: string)', '(value)')}\nconsole.log(JSON.stringify([date('2026-10-18'), date('2026-10-18T00:00:00Z'), date('')]));`;
  const west = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, TZ: 'America/Los_Angeles' } });
  assert.equal(west.status, 0, west.stderr);
  assert.deepEqual(JSON.parse(west.stdout.trim()), ['18 Oct', '17 Oct', 'Not set']);
  const east = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, TZ: 'Asia/Dubai' } });
  assert.equal(east.status, 0, east.stderr);
  assert.deepEqual(JSON.parse(east.stdout.trim()), ['18 Oct', '18 Oct', 'Not set']);
});

test('upcoming posts exclude past and completed work and sort by instant without changing the source list', () => {
  const declaration = source().match(/^function upcomingPosts\(posts: Row\[\], now = Date\.now\(\)\) \{[^\r\n]+\}$/m)?.[0];
  assert.ok(declaration, 'Keep the upcoming-post selector available for this regression check.');
  const upcoming = runInNewContext(declaration.replace('(posts: Row[], now', '(posts, now') + '; upcomingPosts');
  const now = Date.parse('2026-10-18T10:00:00Z');
  const posts = [
    { id: 'latest', status: 'scheduled', scheduledAt: '2026-10-18T13:00:00Z' },
    { id: 'published', status: 'published', scheduledAt: '2026-10-18T11:00:00Z' },
    { id: 'cancelled', status: 'cancelled', scheduledAt: '2026-10-18T11:00:00Z' },
    { id: 'failed', status: 'failed', scheduledAt: '2026-10-18T11:00:00Z' },
    { id: 'past', status: 'scheduled', scheduledAt: '2026-10-18T09:00:00Z' },
    { id: 'exactly-now', status: 'scheduled', scheduledAt: '2026-10-18T10:00:00Z' },
    { id: 'invalid', status: 'scheduled', scheduledAt: 'not-a-date' },
    { id: 'undated', status: 'draft' },
    { id: 'offset-earliest', status: 'draft', scheduledAt: '2026-10-18T15:00:00+04:00' },
    { id: 'submitted', status: 'submitted', scheduledAt: '2026-10-18T12:00:00Z' },
  ];
  const before = structuredClone(posts), result = upcoming(posts, now);
  assert.deepEqual(Array.from(result, row => row.id), ['offset-earliest', 'submitted', 'latest']);
  assert.deepEqual(posts, before);
  assert.equal(upcoming([], now).length, 0);
});

test('clearing every visible publishing destination is saved while unopened account controls preserve prior choices', () => {
  const appSource = source(), start = appSource.indexOf("      if (kind === 'post') {"), end = appSource.indexOf("      if (kind === 'asset')", start);
  assert.ok(start > -1 && end > start, 'Exercise the production post form normalization block.');
  const normalize = new Function('values', 'form', 'FormData', `const kind = 'post'; ${appSource.slice(start, end)} return values;`);
  class FormDataStub { constructor(form) { this.form = form; } getAll(name) { return name === 'platforms' ? this.form.platforms : this.form.accounts; } }
  function form(controlsRendered, accounts = [], platforms = ['facebook']) { return { accounts, platforms, querySelector(selector) { assert.equal(selector, 'input[name="accounts"]'); return controlsRendered ? {} : null; } }; }
  const saved = { content: 'Existing draft', accounts: ['previous-account'] };
  const clear = normalize({ content: saved.content, scheduledAt: '' }, form(true), FormDataStub);
  assert.deepEqual(clear.accounts, []); assert.deepEqual({ ...saved, ...clear }.accounts, [], 'PATCH must receive [] to clear the previously saved destinations.');
  const untouched = normalize({ content: saved.content }, form(false), FormDataStub);
  assert.equal(Object.hasOwn(untouched, 'accounts'), false); assert.deepEqual({ ...saved, ...untouched }.accounts, saved.accounts, 'Editing without loaded channel controls must retain saved recipients.');
  const selected = normalize({ content: saved.content, scheduledAt: '2070-01-01T10:00:00Z' }, form(true, ['new-account']), FormDataStub);
  assert.deepEqual(selected.accounts, ['new-account']); assert.equal(selected.status, 'scheduled'); assert.equal(selected.scheduledAt, '2070-01-01T10:00:00.000Z');
  assert.equal(clear.status, 'draft'); assert.equal(clear.scheduledAt, '');
  assert.throws(() => normalize({ content: saved.content }, form(true, [], []), FormDataStub), /Choose at least one social channel/);
});

test('asset previews select safe actual media and fall back after a thumbnail fails', () => {
  const appSource = source(), start = appSource.indexOf('function AssetPreview('), body = appSource.indexOf('\n', start), end = appSource.indexOf('\n  return preview ?', body);
  assert.ok(start > -1 && end > body, 'Exercise the production preview selection before its JSX rendering.');
  const select = runInNewContext(`(item, useState) => { ${appSource.slice(body, end).replace('useState<string[]>([])', 'useState([])')} return preview; }`, { URL });
  const choose = (item, failed = []) => select(item, () => [failed, () => {}]);
  const thumbnailUrl = 'https://cdn.example.com/thumb.jpg', deliveryUrl = 'https://cdn.example.com/publish.jpg', original = 'https://drive.google.com/file/d/original/view';
  const image = { kind: 'image', thumbnailUrl, deliveryUrl, url: original };
  assert.equal(choose(image), thumbnailUrl);
  assert.equal(choose(image, [thumbnailUrl]), deliveryUrl, 'A failed thumbnail must use the public delivery media.');
  assert.equal(choose(image, [thumbnailUrl, deliveryUrl]), undefined, 'Failed media should become a placeholder instead of requesting forever.');
  assert.equal(choose({ ...image, thumbnailUrl: '', deliveryUrl: 'https://cdn.example.com/replacement.jpg' }, [deliveryUrl]), 'https://cdn.example.com/replacement.jpg', 'Changing a failed URL makes the new media eligible.');
  assert.equal(choose({ kind: 'image', deliveryUrl, url: original }), deliveryUrl);
  assert.equal(choose({ kind: 'image', url: 'https://cdn.example.com/original.jpg' }), 'https://cdn.example.com/original.jpg');
  assert.equal(choose({ kind: 'video', thumbnailUrl, url: 'https://cdn.example.com/movie.mp4' }), thumbnailUrl);
  assert.equal(choose({ kind: 'video', url: 'https://cdn.example.com/movie.mp4' }), undefined);
  for (const unsafe of ['http://cdn.example.com/a.jpg', 'javascript:alert(1)', 'https://user:secret@cdn.example.com/a.jpg', original, 'https://docs.google.com/document/d/private', 'https://localhost/a.jpg', 'https://127.1/a.jpg', 'https://0x7f000001/a.jpg', 'https://10.0.0.1/a.jpg', 'https://172.16.0.1/a.jpg', 'https://172.31.255.255/a.jpg', 'https://192.168.0.1/a.jpg', 'https://169.254.1.1/a.jpg', 'https://0.0.0.0/a.jpg', 'https://[::1]/a.jpg', 'https://media.local/a.jpg', 'https://media.internal/a.jpg']) {
    assert.equal(choose({ kind: 'image', thumbnailUrl: unsafe, url: unsafe, deliveryUrl: unsafe }), undefined, unsafe);
    assert.equal(choose({ ...image, thumbnailUrl: unsafe }), deliveryUrl, `An unsafe thumbnail must not hide safe delivery media: ${unsafe}`);
  }
  for (const publicUrl of ['https://172.15.0.1/a.jpg', 'https://172.32.0.1/a.jpg']) assert.equal(choose({ kind: 'image', url: publicUrl }), publicUrl, 'The 172.16/12 block must not cover neighboring public addresses.');
});
