// Regression tests for the Links issues found in the v0.21.1 end-to-end user test (#113, #114, #115).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

type Row = Record<string, unknown>;
type Run = (generation: number) => Promise<void>;

const source = await readFile(new URL('../src/CampaignLinks.tsx', import.meta.url), 'utf8');
const section = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
// Evaluates one function from the real component with its hooks and helpers supplied as named values.
const compile = (code: string, context: Record<string, unknown> = {}) => new Function(...Object.keys(context), `return (${stripTypeScriptTypes(code)});`)(...Object.values(context));
const event = { preventDefault() {} }, path = '/projects/project-a/links';
const draft = { name: 'Duplicate test', destination: 'https://shop.example.com/billboard', campaignId: '', utm_source: '', utm_medium: '', utm_campaign: '', utm_content: '', utm_term: '' };

function createWith(links: Row[], response: Row) {
  const notices: string[] = [], selections: string[] = [], cleared: unknown[] = [];
  const DestinationError = compile(source.match(/class DestinationError extends Error \{\}/)![0]);
  const create = compile(section('async function create(', '  async function saveName('), { readOnly: false, draft, links, destinationWithUtm: () => draft.destination, DestinationError, setDestinationError() {}, destinationRef: { current: null }, focusDestination: { current: false }, action: async (_label: string, run: Run) => run(1), requester: { current: async () => response }, path, version: { current: 1 }, acceptLink() {}, setSelected: (value: string) => selections.push(value), setDraft: (value: unknown) => cleared.push(value), blank: () => ({}), setNotice: (value: string) => notices.push(value) });
  return create(event).then(() => ({ notices, selections, cleared: cleared.length }));
}

test('#114 a destination that already has an active link says so, shows that link and keeps the form', async () => {
  const existing = { id: 'old-link', name: 'Billboard Downtown QR' };
  for (const links of [[existing], []]) {
    // The server answers with the link it already has, under that link's name, whether or not this list has loaded it.
    const result = await createWith(links, { link: existing });
    assert.deepEqual(result.selections, ['old-link'], 'The existing link is shown.');
    assert.equal(result.cleared, 0, 'Nothing was created, so the form keeps what was typed.');
    assert.equal(result.notices.length, 1); assert.doesNotMatch(result.notices[0], /Short link created/);
    assert.match(result.notices[0], /already has an active link, “Billboard Downtown QR”\. No new link was created/);
  }
  const created = await createWith([existing], { link: { id: 'new-link', name: 'Duplicate test' } });
  assert.deepEqual([created.selections, created.cleared], [['new-link'], 1]); assert.match(created.notices[0], /^Short link created\./);
});
