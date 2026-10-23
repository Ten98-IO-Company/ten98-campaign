import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

// ten98-campaign#33: every value placed in a provider request path is either encoded into one segment (pathSegment,
// encodeURIComponent or a module's `encoded` helper) or reviewed below with the validation that bounds it. A new
// interpolation fails this test until it is encoded or reviewed. The audit covers template literals that build a
// provider path: ones starting with a path ('/x...'), a provider origin, or a provider base URL.

const encoders = /^(pathSegment|encodeURIComponent|encoded)\(/;
// file: expression → why the value cannot leave its segment.
const reviewed: Record<string, string> = {
  'direct-providers.ts: env.TWILIO_ACCOUNT_SID': 'checked against ^AC[a-fA-F0-9]{32}$ by twilio() before use',
  'direct-providers.ts: env.CLOUDFLARE_ACCOUNT_ID': 'checked against ^[a-fA-F0-9]{32}$ by cloudflare() before use',
  'direct-providers.ts: api.base': 'the fixed Twilio account base built above',
  'direct-providers.ts: providerId': 'checked as a Twilio message SID (SM + 32 hex) before the read',
  'integration-settings.ts: current.TWILIO_ACCOUNT_SID': 'checked against ^AC[a-fA-F0-9]{32}$ before the connection test',
  'integration-settings.ts: current.CLOUDFLARE_ZONE_ID': 'checked against ^[a-fA-F0-9]{32}$ before the connection test',
  'inbox.ts: kind': 'callers pass the literals conversations, comments, reviews or mentions',
  'integrations.ts: connectionPlatform': 'from the SOCIAL_CONNECT / ADS_CONNECT allowlists, or their fixed ads aliases',
  "integrations.ts: kind === 'ads' ? '/ads' : ''": 'a fixed suffix',
  'google-ads.ts: body.mode === \'ideas\' ? \'ideas\' : \'historical-metrics\'': 'one of two fixed segments',
  'native-google-ads.ts: BASE': 'the fixed Google Ads API base',
  'native-google-ads.ts: originalCustomer': 'the mapped customer ID, stored only after ^\\d{10}$ validation',
  'native-google-ads.ts: endpoint': 'callers pass fixed service names such as googleAds:search or campaigns:mutate',
  'native-google-ads.ts: customerId(target)': 'customerId() refuses anything but ten digits',
  'ooh.ts: booking.proposalId': 'a provider proposal ID accepted only as a safe integer',
  'ooh.ts: booking.lineItemId': 'a provider line item ID accepted only as a safe integer',
  'ooh.ts: claimed.lineItemId': 'a provider line item ID accepted only as a safe integer',
  'ooh.ts: id': 'approved screen IDs, stored only after integer validation',
  'zernio-accounts.ts: account.platform': 'used only after socialReconnect.has(account.platform)',
  'zernio-accounts.ts: platform': 'a value of the fixed adsReconnect map',
  'zernio-connections.ts: platform': 'limited to the store and credential platform allowlists before the request',
  'zernio-contacts.ts: contactId': 'matched as a 24-hex Zernio ID by the route and by providerId()',
  'zernio-contacts.ts: contact.id': 'a contact read back and checked with providerId() (24 hex)',
  "zernio-contacts.ts: definition ? `/fields/${definition.slug}` : ''": 'the slug is matched by ^[a-z][a-z0-9_]{0,99}$',
  'zernio-google-conversions.ts: campaignId': 'id() accepts digits only',
  'zernio-google-conversions.ts: actionId': 'id() accepts digits only',
  'zernio-google-conversions.ts: goalId': 'id() accepts digits only',
  "zernio-insights.ts: tiktok ? 'tiktok/account-insights' : 'linkedin/org-aggregate-analytics'": 'one of two fixed paths',
  'zernio-insights.ts: account.platform': 'demographics is offered only for allowlisted platforms by reports()',
  "zernio-measurement.ts: account.platform === 'redditads' ? 'conversion-destinations' : 'tracking-tags'": 'one of two fixed segments',
  'zernio-whatsapp-templates.ts: templateId': 'matched by the route as ^\\d{1,40}$',
  "google-ads.ts: action === 'negatives' ? 'negative-keywords' : action": "action is one of 'negatives', 'targeting' or 'bidding'",
  'inbox.ts: index': 'a numeric attachment index from the loop',
  'integration-settings.ts: base': 'the fixed Broadsign base for the configured environment',
  'integrations.ts: file.id': 'a Drive view link returned to the browser, not a provider request',
  "integrations.ts: path === 'ads/ad-status' ? '/status' : ''": 'a fixed suffix',
  'sms-inbox.ts: accountSid': 'an expected-prefix comparison for a media URL, not a provider request',
  'sms-inbox.ts: providerId': 'an expected-prefix comparison for a media URL, not a provider request',
  'sms-inbox.ts: entry.account_sid': 'an expected-prefix comparison for a media URL, not a provider request',
  'sms-inbox.ts: entry.provider_id': 'an expected-prefix comparison for a media URL, not a provider request',
  'zernio-blogs.ts: blogId': 'numeric() checked before use',
  'zernio-blogs.ts: articleId': 'numeric() checked before use',
  'zernio-contacts.ts: definition.slug': 'matched by the route as ^[a-z][a-z0-9_]{0,99}$',
  "zernio-products.ts: id === undefined ? '' : '/' + encodeURIComponent(id)": 'empty or one encoded segment',
  "zernio-products.ts: productId === undefined ? '' : '/' + encodeURIComponent(productId)": 'empty or one encoded segment',
  "zernio-publishing.ts: match[2] === 'reddit-rules' ? `reddit-subreddits/${encodeURIComponent(subreddit)}/rules` : match[2]": 'a key of the fixed resources map, or an encoded subreddit',
  'zernio-publishing.ts: endpoint': 'built from a key of the fixed resources map; the Instagram audio ID is checked as ^\\d{1,30}$',
  'zernio-publishing.ts: resource': 'a key of the fixed resources map',
};

// The top-level ${...} expressions of each template literal, with nested templates and braces kept whole.
function templates(source: string): { text: string; expressions: string[] }[] {
  const found: { text: string; expressions: string[] }[] = [];
  const scan = (start: number): number => {
    let index = start + 1, text = '';
    const expressions: string[] = [];
    while (index < source.length && source[index] !== '`') {
      if (source[index] === '\\') { text += source.slice(index, index + 2); index += 2; continue; }
      if (source[index] === '$' && source[index + 1] === '{') {
        let depth = 1, cursor = index + 2;
        while (cursor < source.length && depth) {
          if (source[cursor] === '`') { cursor = scan(cursor); continue; }
          if (source[cursor] === '{') depth++; else if (source[cursor] === '}') depth--;
          cursor++;
        }
        expressions.push(source.slice(index + 2, cursor - 1).trim()); text += '${}'; index = cursor; continue;
      }
      text += source[index++];
    }
    found.push({ text, expressions });
    return index + 1;
  };
  let inString: string | null = null, previous = '';
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (inString) { if (char === '\\') index++; else if (char === inString) { inString = null; previous = char; } continue; }
    if (char === '/' && source[index + 1] === '/') { index = source.indexOf('\n', index); if (index < 0) break; continue; }
    if (char === '/' && source[index + 1] === '*') { index = source.indexOf('*/', index + 2) + 1; if (index <= 0) break; continue; }
    // A regex literal can hold quotes or backticks, so skip it whole: a '/' where an expression starts begins one.
    if (char === '/' && (!previous || /[(,=:[!&|?{};+\-*%<>~^]/.test(previous) || /\b(return|typeof|case|in|of)$/.test(source.slice(Math.max(0, index - 8), index).trimEnd()))) {
      let cursor = index + 1, inClass = false;
      for (; cursor < source.length && source[cursor] !== '\n'; cursor++) {
        if (source[cursor] === '\\') { cursor++; continue; }
        if (source[cursor] === '[') inClass = true; else if (source[cursor] === ']') inClass = false; else if (source[cursor] === '/' && !inClass) break;
      }
      index = cursor; previous = '/'; continue;
    }
    if (char === "'" || char === '"') { inString = char; continue; }
    if (char === '`') { index = scan(index) - 1; previous = '`'; continue; }
    if (!/\s/.test(char)) previous = char;
  }
  return found;
}
const providerPath = (text: string, first: string | undefined) =>
  /^\/[a-z0-9]/i.test(text) && !/^\/api\/(projects|webhooks|direct)\b/.test(text) || /^https:\/\/[a-z0-9.-]+\.(com|net)\//i.test(text) || text.startsWith('${}/') && ['BASE', 'base', 'api.base'].includes(first || '');

test('every value interpolated into a provider path is encoded or reviewed', async () => {
  const directory = new URL('../server/', import.meta.url), unreviewed: string[] = [], seen = new Set<string>();
  for (const file of (await readdir(directory)).filter(name => name.endsWith('.ts')).sort()) {
    for (const literal of templates(await readFile(new URL(file, directory), 'utf8'))) {
      if (!providerPath(literal.text, literal.expressions[0])) continue;
      for (const expression of literal.expressions) {
        if (encoders.test(expression)) continue;
        const key = `${file}: ${expression}`; seen.add(key);
        if (!Object.hasOwn(reviewed, key)) unreviewed.push(key);
      }
    }
  }
  assert.deepEqual(unreviewed, [], 'Encode these path values with pathSegment() or review them in this test.');
  assert.deepEqual(Object.keys(reviewed).filter(key => !seen.has(key)), [], 'Remove reviewed entries that no longer occur.');
});
