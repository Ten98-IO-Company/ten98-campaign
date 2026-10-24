import type { IncomingMessage } from 'node:http';
import { readJsonBody } from '@ten98/runtime';

// Node adapter for the runtime's readJsonBody (ten98-code-system#76, #72): the request's headers become a Headers object
// and its body a pull-based web stream. Readable.toWeb is not used because, once readJsonBody cancels a refused body,
// draining the request would push data into the closed stream and throw. Cancelling here only stops the iterator
// (destroyOnReturn: false), and a refused body is drained so the response can still go out on the same connection.
// Refusals keep the runtime's `status` (400, 413 or 415); callers word the message.
export async function readRequestJson(req: IncomingMessage, maxBytes: number, allowEmpty = false): Promise<unknown> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  const chunks = req.iterator({ destroyOnReturn: false });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) { const { value, done } = await chunks.next(); if (done) controller.close(); else controller.enqueue(new Uint8Array(value)); },
    async cancel() { await chunks.return?.(); },
  });
  try { return await readJsonBody(body, headers, { maxBytes, allowEmpty }); }
  catch (error) { req.resume(); throw error; }
}
