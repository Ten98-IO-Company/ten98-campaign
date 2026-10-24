import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

// Evaluate the real useFocusReturn hook with React's hooks mocked by call order and a minimal document.
const hookSource = await readFile(new URL('../src/focus-return.ts', import.meta.url), 'utf8');
const hookCode = stripTypeScriptTypes(hookSource.replace(/^import .*?;\r?\n/gm, '').replaceAll('export function', 'function'));

class FakeElement { isConnected = true; focused = 0; focus() { this.focused++; document.activeElement = this; } }
const document = { body: new FakeElement(), activeElement: null as FakeElement | null };

function mount() {
  const refs: { current: unknown }[] = [], effects: { deps: unknown[]; run: () => void }[] = [];
  let refIndex = 0, effectIndex = 0;
  const useRef = (value: unknown) => refs[refIndex++] ||= { current: value };
  const useEffect = (run: () => void, deps: unknown[]) => { const index = effectIndex++, previous = effects[index]; if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) { effects[index] = { deps, run }; run(); } };
  const useFocusReturn = new Function('useRef', 'useEffect', 'document', 'HTMLElement', hookCode + '; return useFocusReturn;')(useRef, useEffect, document, FakeElement);
  return (busy: unknown): () => void => { refIndex = 0; effectIndex = 0; return useFocusReturn(busy); };
}

test('a busy action returns focus to the control that started it once busy clears', () => {
  const render = mount(), button = new FakeElement();
  document.activeElement = button; render('')();
  render('Checking audience'); document.activeElement = document.body; // The disabled button drops focus to <body>.
  assert.equal(button.focused, 0, 'Focus is not moved while the action is busy.');
  render(''); assert.equal(button.focused, 1); assert.equal(document.activeElement, button);
  render('Again'); render(''); assert.equal(button.focused, 1, 'The target is used once.');
});

test('focus is left alone when the person moved it, the control is gone, or nothing was focused', () => {
  const moved = mount(), button = new FakeElement(), elsewhere = new FakeElement();
  document.activeElement = button; moved('')(); moved('Saving'); document.activeElement = elsewhere; moved('');
  assert.equal(button.focused, 0); assert.equal(document.activeElement, elsewhere);
  const removed = mount(), row = new FakeElement();
  document.activeElement = row; removed('')(); removed('Removing'); row.isConnected = false; document.activeElement = document.body; removed('');
  assert.equal(row.focused, 0);
  const nothing = mount();
  document.activeElement = document.body; nothing('')(); nothing('Refreshing'); nothing('');
  assert.equal(document.body.focused, 0, 'Focus on <body> at the start is not a target.');
});

test('when the control that started an action is gone, focus goes to the fallback given when it was remembered (#151)', () => {
  const render = mount(), button = new FakeElement(), card = new FakeElement();
  document.activeElement = button; (render('') as (fallback?: FakeElement) => void)(card);
  render('Saving review'); button.isConnected = false; document.activeElement = document.body; // The reviewed card drops its buttons.
  render(''); assert.equal(card.focused, 1); assert.equal(document.activeElement, card);
  const kept = mount(), stays = new FakeElement(), unused = new FakeElement();
  document.activeElement = stays; (kept('') as (fallback?: FakeElement) => void)(unused); kept('Saving'); document.activeElement = document.body; kept('');
  assert.deepEqual([stays.focused, unused.focused], [1, 0], 'A control that is still there keeps priority over the fallback.');
});

// ten98-campaign#151: Approvals and first-run sign-in return focus after their busy actions.
test('Approvals remembers the focused control once per accepted action, with its review card as the fallback', async () => {
  const source = await readFile(new URL('../src/ContentApprovals.tsx', import.meta.url), 'utf8');
  const owner = source.indexOf('export default function ContentApprovals('), from = source.indexOf('async function action(', owner), body = source.slice(from, source.indexOf('  async function review(', from));
  assert.match(source.slice(owner, from), /const rememberFocus = useFocusReturn\(busy\);/);
  const remembered: unknown[] = [], card = { id: 'review-post-1' };
  const context = { busy: '', active: { current: true }, readVersion: { current: 0 }, setBusy() {}, setError() {}, setNotice() {}, noteRestrictions() {}, advance: { current: null }, document: { getElementById: (id: string) => id === card.id ? card : null }, rememberFocus: (fallback: unknown) => { remembered.push(fallback); } };
  const action = new Function(...Object.keys(context), `return (${stripTypeScriptTypes(body)});`)(...Object.values(context));
  await action('post-1', async () => {}); await action('refresh', async () => {});
  assert.deepEqual(remembered, [card, null]);
  const refused = new Function(...Object.keys(context), `return (${stripTypeScriptTypes(body)});`)(...Object.values({ ...context, busy: 'post-1' }));
  await refused('post-2', async () => {}); assert.equal(remembered.length, 2, 'A refused repeat does not replace the remembered control.');
});

test('a failed owner setup or sign-in returns focus to the control that submitted it', async () => {
  const source = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8'), app = source.indexOf('function App() {');
  assert.match(source, /^import \{ useFocusReturn \} from '\.\/focus-return';$/m);
  const hook = source.indexOf('  const rememberFocus = useFocusReturn(busy);', app);
  assert.ok(hook > app && hook < source.indexOf('  if (!session) return', app), 'The hook runs before the App returns early.');
  assert.match(source, / onSubmit=\{async values => \{ rememberFocus\(\); await run\(async \(\) => \{ await api\('\/auth\/' \+ \(session\.setupRequired \? 'setup' : 'login'\), 'POST', values\);/);
});

// The three reported surfaces remember focus inside their single-flight lock, after a repeat is refused.
for (const [file, component, start, end] of [['DirectCampaigns', 'export default function DirectCampaigns(', 'async function action(', '  function acceptCampaign('], ['UnifiedInbox', 'function ZernioInbox(', 'async function action(', '  async function write('], ['TeamSettings', 'export default function TeamSettings(', 'async function act(', '  const invite =']] as const) {
  test(`${file} remembers the focused control once per accepted action`, async () => {
    const source = await readFile(new URL(`../src/${file}.tsx`, import.meta.url), 'utf8');
    const owner = source.indexOf(component), from = source.indexOf(start, owner), body = source.slice(from, source.indexOf(end, from));
    assert.match(source.slice(owner, from), /const rememberFocus = useFocusReturn\(busy\);/);
    assert.ok(from > 0, file);
    let remembered = 0; const pending = { current: false };
    const context = { pending, version: { current: 1 }, actionVersion: { current: 0 }, revision: { current: 0 }, readVersion: { current: 0 }, busy: false, setBusy() {}, setError() {}, setNotice() {}, emailProviderChoice: '', load: async () => {}, window: {}, rememberFocus: () => { remembered++; } };
    const action = new Function(...Object.keys(context), `return (${stripTypeScriptTypes(body)});`)(...Object.values(context));
    await (file === 'TeamSettings' ? action(async () => ({}), 'Done') : action('Working', async () => {}));
    assert.equal(remembered, 1);
    if (file !== 'TeamSettings') { pending.current = true; await action('Repeat', async () => {}); assert.equal(remembered, 1, 'A refused repeat does not replace the remembered control.'); }
  });
}

// ten98-campaign#138: a row action that opens a panel elsewhere scrolls it into view and focuses its first field.
function mountReveal(panels: Record<string, unknown>) {
  const effects: { deps: unknown[] }[] = [];
  let effectIndex = 0;
  const useEffect = (run: () => void, deps: unknown[]) => { const index = effectIndex++, previous = effects[index]; if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) { effects[index] = { deps }; run(); } };
  const fakeDocument = { getElementById: (id: string) => panels[id] || null };
  const useRevealPanel = new Function('useRef', 'useEffect', 'document', 'HTMLElement', hookCode + '; return useRevealPanel;')(() => ({ current: null }), useEffect, fakeDocument, FakeElement);
  return (trigger: number, id: string) => { effectIndex = 0; useRevealPanel(trigger, id); };
}
test('a revealed panel scrolls into view and its first enabled field takes focus, once per trigger', () => {
  const field = new FakeElement(), scrolls: unknown[] = [], selectors: string[] = [];
  const panel = { scrollIntoView: (options: unknown) => scrolls.push(options), querySelector: (selector: string) => { selectors.push(selector); return field; } };
  const render = mountReveal({ 'contact-suppression': panel });
  render(0, ''); assert.deepEqual(scrolls, [], 'Nothing happens before a row action.');
  render(1, 'contact-suppression'); assert.deepEqual(scrolls, [{ block: 'start' }]); assert.equal(field.focused, 1);
  assert.match(selectors[0], /input:not\(\[disabled\]\)/);
  render(1, 'contact-suppression'); assert.equal(field.focused, 1, 'A re-render without a new action does not steal focus.');
  render(2, 'contact-suppression'); assert.equal(field.focused, 2, 'Clicking the action again brings the panel back.');
  assert.doesNotThrow(() => render(3, 'missing-panel'));
});

test('Contacts row actions name their contact and reveal the panel they open', async () => {
  const source = await readFile(new URL('../src/DirectCampaigns.tsx', import.meta.url), 'utf8');
  assert.match(source, /useRevealPanel\(reveal\.tick, reveal\.panel\);/);
  assert.match(source, /aria-label=\{`Edit \$\{contactName\(person\)\}`\} onClick=\{\(\) => \{ editContact\(person\); revealPanel\('contact-form'\); \}\}/);
  assert.match(source, /aria-label=\{`Suppress \$\{contactName\(person\)\}`\} onClick=\{\(\) => \{ setSuppression\(\{ id: person\.id, channel: 'email', reason: '' \}\); revealPanel\('contact-suppression'\); \}\}/);
  assert.match(source, /<Card as="section" id="contact-form" /); assert.match(source, /<Card as="section" id="contact-suppression" /);
});
