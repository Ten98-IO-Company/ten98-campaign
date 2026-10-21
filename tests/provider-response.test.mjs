import test from 'node:test';
import assert from 'node:assert/strict';
import { providerRequest, operation } from '../server/provider-core.ts';
import { postgresSkip, testDatabase } from './postgres.mjs';

const encoder = new TextEncoder(), maxBytes = 8 * 1024 * 1024;
const invalidUtf8 = () => new Uint8Array([...encoder.encode('{"value":"'), 255, ...encoder.encode('"}')]);
function streamed(chunks) {
  let index = 0, cancellations = 0;
  const response = new Response(new ReadableStream({
    pull(controller) { if (index < chunks.length) controller.enqueue(chunks[index++]); else controller.close(); },
    cancel() { cancellations++; },
  }, { highWaterMark: 0 }));
  return { response, cancelled: () => cancellations };
}

test('provider JSON rejects malformed UTF-8 and oversized bytes, cancels unread data and releases readers', async t => {
  let fixture;
  t.mock.method(globalThis, 'fetch', async () => fixture.response);
  for (const bytes of [invalidUtf8(), new Uint8Array(maxBytes + 1).fill(32)]) {
    fixture = streamed([bytes]);
    await assert.rejects(providerRequest('https://zernio.com/api/v1/posts', { method: 'POST' }), error => error.code === 'INVALID_PROVIDER_RESPONSE' && error.uncertain === true);
    assert.equal(fixture.cancelled(), 1);
    assert.equal(fixture.response.body.locked, false);
  }
  fixture = streamed([encoder.encode('{"value":"' + 'a'.repeat(maxBytes - 12) + '"}')]);
  assert.equal((await providerRequest('https://zernio.com/api/v1/profiles')).value.length, maxBytes - 12);
  assert.equal(fixture.response.body.locked, false);
});

test('the existing 20-second and 180-second deadlines also cancel stalled provider bodies', async t => {
  const timeout = AbortSignal.timeout, durations = [];
  t.mock.method(AbortSignal, 'timeout', milliseconds => { durations.push(milliseconds); return timeout(20); });
  let response, controller, cancellations = 0;
  t.mock.method(globalThis, 'fetch', async () => response);
  for (const path of ['/posts', '/ads/create', '/ads/boost']) {
    response = new Response(new ReadableStream({ start(value) { controller = value; }, cancel() { cancellations++; } }));
    let guard;
    try {
      await assert.rejects(Promise.race([
        providerRequest('https://zernio.com/api/v1' + path, { method: 'POST' }),
        new Promise((_, reject) => { guard = setTimeout(() => reject(new Error('Provider body exceeded the shared request deadline.')), 500); }),
      ]), error => error.code === 'INVALID_PROVIDER_RESPONSE' && error.uncertain === true);
      assert.equal(response.body.locked, false);
    } finally { clearTimeout(guard); try { controller.close(); } catch {} }
  }
  assert.deepEqual(durations, [20000, 180000, 180000]);
  assert.equal(cancellations, 3);
});

test('only documented empty 200 acknowledgements and the existing 204 fast path are accepted', async t => {
  let response;
  t.mock.method(globalThis, 'fetch', async () => response);
  for (const [path, method, status] of [['/posts/one', 'DELETE', 204], ['/accounts/one/telegram-commands', 'PUT', 200], ['/accounts/one/telegram-commands', 'DELETE', 200], ['/accounts/one/slack-settings', 'PATCH', 200]]) {
    response = new Response(null, { status });
    assert.deepEqual(await providerRequest('https://zernio.com/api/v1' + path, { method }), {});
  }
  for (const [path, method, body] of [['/profiles', 'GET', ''], ['/accounts/one/telegram-commands', 'POST', ''], ['/accounts/one/slack-settings', 'PATCH', ' '], ['/accounts/one/slack-settings', 'PATCH', '\ufeff'], ['/profiles', 'GET', '\ufeff{}'], ['/profiles', 'GET', 'null'], ['/profiles', 'GET', '[]']]) {
    response = new Response(body);
    await assert.rejects(providerRequest('https://zernio.com/api/v1' + path, { method }), error => error.code === 'INVALID_PROVIDER_RESPONSE' && Boolean(error.uncertain) === (method !== 'GET'));
  }
});

test('Twilio rejection codes and private-reply consumption evidence remain sanitized and intact', async t => {
  let response;
  t.mock.method(globalThis, 'fetch', async () => response);
  response = Response.json({ code: 21610, message: 'PRIVATE_PROVIDER_BODY' }, { status: 400 });
  await assert.rejects(providerRequest('https://api.twilio.com/Messages.json', { method: 'POST' }, 'Twilio'), error => error.providerCode === 21610 && error.providerStatus === 400 && !error.uncertain && !error.message.includes('PRIVATE'));
  for (const [body, status, consumed, unknown] of [[{ details: { privateReplyConsumed: true } }, 400, true, undefined], [{ details: { privateReplyOutcome: 'unknown' } }, 502, undefined, 'unknown']]) {
    response = Response.json(body, { status });
    await assert.rejects(providerRequest('https://zernio.com/api/v1/inbox/comments/account/comment/private-reply', { method: 'POST' }), error => error.privateReplyConsumed === consumed && error.privateReplyOutcome === unknown && Boolean(error.uncertain) === (status >= 500));
  }
});

test('unreadable successful paid writes retain an uncertain receipt and never dispatch a retry', { skip: postgresSkip }, async t => {
  const { db, sql } = await testDatabase(t); let dispatches = 0;
  t.mock.method(globalThis, 'fetch', async () => { dispatches++; return new Response(invalidUtf8()); });
  const context = { db, project: { id: 'response-project' }, req: { method: 'POST', headers: { 'idempotency-key': 'response-receipt' } }, url: new URL('https://app.example.test/api/projects/response-project/integrations/ads/create'), body: { reviewed: true } };
  const send = () => operation(context, () => providerRequest('https://zernio.com/api/v1/ads/create', { method: 'POST' }));
  const result = await send();
  assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain');
  assert.equal((await sql.get('SELECT status FROM integration_operations')).status, 'uncertain');
  await assert.rejects(send, error => error.code === 'OPERATION_UNCERTAIN');
  assert.equal(dispatches, 1);
});
