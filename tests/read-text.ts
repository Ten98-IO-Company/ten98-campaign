import assert from 'node:assert/strict';

// Reads the visible text of server-rendered test markup. This is a test reader, not a sanitiser: never use it on
// untrusted input. Splitting on tags in one pass (instead of an iterated replace) is what CodeQL accepts, and
// tests/no-tag-strip.test.ts keeps new tests from going back to `.replace(/<[^>]*>/g, …)`.
export function readText(html: string, separator = ' '): string {
  const text = html.split(/<[^>]*>/).join(separator);
  return separator === ' ' ? text.replace(/\s+/g, ' ') : text;
}

export function assertNoMarkup(text: string, message = 'Text still contains markup: ' + text): void {
  assert.ok(!text.includes('<'), message);
}
