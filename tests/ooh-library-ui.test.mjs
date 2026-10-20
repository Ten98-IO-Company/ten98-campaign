import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import { ResourceCard, ReviewSummary } from '@ten98/ui';

const source = await readFile(new URL('../src/OohProviders.tsx', import.meta.url), 'utf8');
const { code } = await transformWithOxc(source.replace(/^import .*;\r?$/gm, '').replace('export default function', 'function'), 'OohProviders.tsx', { jsx: { runtime: 'classic' } });
const elements = node => Array.isArray(node) ? node.flatMap(elements) : React.isValidElement(node) ? [node, ...elements(node.props.children), ...elements(node.props.actions)] : [];

test('OOH shared reviews render and submit only their exact booking while native guards and uncertain cancellation keys remain intact', async () => {
  const status = { configured: true, environment: 'sandbox', connection: { domainId: 17, clientId: 'client-exact', clientName: 'Exact client', screenIds: [101, 202, 303] } };
  const draft = { id: 'review / draft', name: 'Draft exact', proposalId: 41, lineItemId: 42, screenIds: [101, 202], startDate: '2030-01-01', endDate: '2030-01-03', inventoryType: 'digital', slotDuration: 10, price: 450, stage: 'draft', providerStatus: 1 };
  const live = { ...draft, id: 'review / live', name: 'Live exact', proposalId: 71, lineItemId: 72, screenIds: [202], startDate: '2030-02-01', endDate: '2030-02-04', inventoryType: 'static', slotDuration: 20, price: 900, stage: 'submitted', providerStatus: 11 };
  const inventory = [{ id: 303, name: 'Unrelated selected screen', latitude: null, longitude: null }], bookings = [draft, live], states = [status, inventory, bookings, [303], false, '', '', {}, false], refs = [], calls = [];
  let stateIndex, refIndex, cancellationFails = false;
  const request = async (path, method, body, key) => {
    calls.push({ path, method, body, key });
    if (method === 'POST') {
      if (path.endsWith('/cancel') && cancellationFails) throw Object.assign(new Error('Cancellation outcome uncertain. Reconcile Broadsign.'), { operation: { status: 'uncertain' } });
      return { cancellation: { confirmed: false } };
    }
    if (path.endsWith('/status')) return status;
    if (path.endsWith('/inventory')) return { inventory };
    if (path.endsWith('/bookings')) return { bookings };
    throw new Error('Unexpected synthetic request: ' + path);
  };
  const Component = new Function('React', 'useEffect', 'useRef', 'useState', 'ResourceCard', 'ReviewSummary', code + '; return OohProviders;')(React, () => {}, initial => { const index = refIndex++; return refs[index] ||= { current: initial }; }, initial => { const index = stateIndex++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; }, ResourceCard, ReviewSummary);
  const props = { projectId: 'project / exact', role: 'editor', isOperator: false, request };
  function render(extra = {}) { stateIndex = 0; refIndex = 0; return Component({ ...props, ...extra }); }
  const tree = render(), nodes = elements(tree), html = renderToStaticMarkup(tree);
  assert.doesNotMatch(html, /Broadsign connection|Approve project inventory|Credentials configured/); assert.match(html, /Exact client · sandbox/);
  let opened = 0;
  const linked = elements(render({ onOpenIntegrations: () => opened++ }));
  linked.find(node => node.type === 'button' && node.props.children === 'Open integrations').props.onClick();
  assert.equal(opened, 1); assert.equal(calls.length, 0, 'Opening setup must not perform a provider action.');
  const setupTree = render({ mode: 'connection', role: 'admin', isOperator: true }), setup = elements(setupTree), setupHtml = renderToStaticMarkup(setupTree);
  assert.match(setupHtml, /Broadsign connection/); assert.match(setupHtml, /Domain 17 · Exact client · Client client-exact/);
  assert.match(setupHtml, /Approve project inventory/); assert.doesNotMatch(setupHtml, /Review paid booking|Review cancellation request|Sync provider inventory|Create a provider proposal/);
  assert.equal(setup.find(node => node.type === 'button' && node.props.children === 'Approve inventory mapping').props.disabled, true, 'Existing bookings still lock the mapping in its central location.');
  assert.doesNotMatch(renderToStaticMarkup(render({ mode: 'connection', role: 'viewer', isOperator: true })), /Approve project inventory/);
  assert.equal((html.match(/class="t98-card t98-review-summary"/g) || []).length, 2);
  assert.match(html, /Cancellation can incur charges and does not guarantee a refund/);
  const selection = nodes.find(node => node.type === 'input' && node.props['aria-label'] === 'Select Unrelated selected screen');
  assert.equal(selection.props.checked, true); assert.equal(selection.props.disabled, false);
  selection.props.onChange({ target: { checked: false } }); assert.deepEqual(states[3], []);
  for (const [title, booking, endpoint] of [['Review paid booking', draft, 'submit'], ['Review cancellation request', live, 'cancel']]) {
    const form = nodes.find(node => node.type === 'form' && elements(node.props.children).some(child => child.type === ReviewSummary && child.props.title === title));
    const review = elements(form).find(node => node.type === ReviewSummary), rendered = renderToStaticMarkup(review);
    for (const identity of [booking.name, `Booking ${booking.id}`, `Proposal ${booking.proposalId}`, `Line item ${booking.lineItemId}`, `Project ${props.projectId}`, booking.startDate, booking.endDate, `Screen IDs ${booking.screenIds.join(', ')}`, `Quote ${booking.price} in account currency`]) assert.ok(rendered.includes(identity), identity);
    assert.ok(!rendered.includes('Screen IDs 303'), 'A review must use the saved booking scope, not current inventory selection.');
    const approval = elements(review).find(node => node.type === 'input'); assert.equal(approval.props.type, 'checkbox'); assert.equal(approval.props.required, true);
    const start = calls.length; await form.props.onSubmit({ preventDefault() {} });
    assert.deepEqual(calls[start], { path: `/projects/project%20%2F%20exact/ooh/bookings/${encodeURIComponent(booking.id)}/${endpoint}`, method: 'POST', body: endpoint === 'submit' ? { confirmBooking: true } : { confirmCancellation: true }, key: calls[start].key });
    assert.ok(calls[start].key); assert.equal(refs[2].current.size, 0, 'A successful readback releases the existing operation key.');
  }
  assert.match(states[6], /Delivery may continue until Broadsign confirms it/);
  const cancellationForm = elements(render()).find(node => node.type === 'form' && elements(node).some(child => child.type === ReviewSummary && child.props.title === 'Review cancellation request'));
  cancellationFails = true;
  for (let attempt = 0; attempt < 2; attempt++) await cancellationForm.props.onSubmit({ preventDefault() {} });
  const cancelled = calls.filter(call => call.method === 'POST' && call.path.endsWith('/cancel'));
  assert.equal(cancelled.at(-1).key, cancelled.at(-2).key); assert.equal(refs[2].current.size, 1);
  assert.match(states[5], /Cancellation outcome uncertain/); assert.equal(states[6], '');
  states[4] = true; const busy = elements(render());
  assert.ok(busy.filter(node => node.type === 'fieldset').slice(1).every(node => node.props.disabled));
  const writes = calls.filter(call => call.method === 'POST').length;
  await busy.find(node => node.type === 'form' && elements(node).some(child => child.type === ReviewSummary)).props.onSubmit({ preventDefault() {} });
  assert.equal(calls.filter(call => call.method === 'POST').length, writes, 'The original action guard blocks a busy review handler.');
  states[4] = false; assert.equal(elements(render({ role: 'viewer' })).filter(node => node.type === ReviewSummary).length, 0);
  states[8] = true; assert.equal(elements(render()).find(node => node.type === 'fieldset').props.disabled, true);
});
