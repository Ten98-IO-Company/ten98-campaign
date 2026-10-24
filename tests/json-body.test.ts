import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readRequestJson } from '../server/json-body.ts';

// server/json-body.ts adapts Node requests to the runtime's readJsonBody (ten98-code-system#76, #72). A refused body is
// drained, so the response still reaches the client, including for a chunked body that runs past the limit.
async function serve(t: test.TestContext, allowEmpty = false) {
  const server = createServer(async (req: IncomingMessage, res) => {
    try { const value = await readRequestJson(req, 64, allowEmpty); res.writeHead(200).end(JSON.stringify({ value: value ?? null })); }
    catch (error) { res.writeHead((error as { status?: number }).status ?? 500).end(String((error as { code?: string }).code)); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  return (headers: Record<string, string>, chunks: string[]) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const sent = request({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, method: 'POST', headers }, response => { let body = ''; response.setEncoding('utf8').on('data', part => { body += part; }).on('end', () => resolve({ status: response.statusCode!, body })); });
    sent.on('error', reject); for (const chunk of chunks) sent.write(chunk); sent.end();
  });
}

test('the JSON body adapter reads valid JSON and refuses the wrong type, size or encoding with the runtime status', async t => {
  const post = await serve(t), json = { 'Content-Type': 'application/json; charset=utf-8' };
  assert.deepEqual(await post(json, ['{"name":', '"Autumn"}']), { status: 200, body: '{"value":{"name":"Autumn"}}' });
  assert.deepEqual(await post({ 'Content-Type': 'text/plain' }, ['{}']), { status: 415, body: 'BODY_MEDIA_TYPE' });
  assert.deepEqual(await post({ ...json, 'Content-Length': '500' }, ['x'.repeat(500)]), { status: 413, body: 'BODY_TOO_LARGE' });
  assert.deepEqual(await post(json, Array.from({ length: 20 }, () => '"aaaaaaaaaa"')), { status: 413, body: 'BODY_TOO_LARGE' }, 'A chunked body past the limit is refused and drained.');
  assert.deepEqual(await post(json, ['{"name":']), { status: 400, body: 'BODY_NOT_JSON' });
  assert.deepEqual(await post(json, ['']), { status: 400, body: 'BODY_EMPTY' });
});

test('with allowEmpty a request without a body reads as nothing', async t => {
  const post = await serve(t, true);
  assert.deepEqual(await post({ 'Content-Length': '0' }, []), { status: 200, body: '{"value":null}' });
});
