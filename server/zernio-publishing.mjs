import { IntegrationError, scopedAccounts, requireAccount } from './integrations.mjs';

const fail = (status, code, message) => { throw new IntegrationError(status, code, message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const token = value => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\s\u0000-\u001f\u007f]/.test(value);
const text = value => value == null || typeof value === 'string' && value.length <= 20000;
const invalid = () => fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned unreadable publishing destinations. Reload the account choices before continuing.');
const resources = { 'pinterest-boards': ['pinterest', 'boards'], 'youtube-playlists': ['youtube', 'playlists'], 'reddit-subreddits': ['reddit', 'subreddits'], 'reddit-rules': ['reddit', 'rules'], 'reddit-flairs': ['reddit', 'flairs'] };

export async function handleZernioPublishing(context, api, profileId, action) {
  const match = /^accounts\/([^/]+)\/([^/]+)$/.exec(action);
  if (!match || !Object.hasOwn(resources, match[2])) return false;
  if (context.req.method !== 'GET') fail(405, 'METHOD_NOT_ALLOWED', 'Publishing destination lookups are read only.');
  let accountId;
  try { accountId = decodeURIComponent(match[1]); } catch { fail(400, 'INVALID_ACCOUNT', 'Choose a valid connected publishing account.'); }
  if (!token(accountId)) fail(400, 'INVALID_ACCOUNT', 'Choose a valid connected publishing account.');
  const account = requireAccount(await scopedAccounts(api, profileId), accountId), [platform, field] = resources[match[2]];
  if (account.platform !== platform || account.isActive === false) fail(422, 'PUBLISHING_LOOKUP_UNSUPPORTED', 'Choose an active account for this publishing platform.');
  const params = context.url.searchParams;
  if ([...params.keys()].some(key => !(['reddit-rules', 'reddit-flairs'].includes(match[2]) && key === 'subreddit'))) fail(400, 'INVALID_PUBLISHING_FILTER', 'Use only the destination filters shown in the composer.');
  let subreddit;
  if (['reddit-rules', 'reddit-flairs'].includes(match[2])) {
    subreddit = params.get('subreddit');
    if (typeof subreddit !== 'string' || !/^[A-Za-z0-9_]{1,21}$/.test(subreddit)) fail(400, 'INVALID_SUBREDDIT', 'Choose a subreddit name without the r/ prefix.');
  }
  const response = await api(`/accounts/${encodeURIComponent(accountId)}/${match[2] === 'reddit-rules' ? `reddit-subreddits/${encodeURIComponent(subreddit)}/rules` : match[2]}`, match[2] === 'reddit-flairs' ? { subreddit } : {});
  if (response.accountId != null && response.accountId !== accountId || response.platform != null && response.platform !== platform || response.profileId != null && String(response.profileId?._id || response.profileId) !== profileId) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio returned destinations for a different publishing account.');
  const rows = response[field];
  if (!Array.isArray(rows) || rows.length > 10000) invalid();
  const result = rows.map(row => {
    if (!object(row)) invalid();
    if (field === 'rules') {
      if (!text(row.shortName) || !text(row.description) || !text(row.violationReason) || !['link', 'comment', 'all'].includes(row.kind) || row.priority != null && (!Number.isSafeInteger(row.priority) || row.priority < 0)) invalid();
      return { kind: row.kind, shortName: row.shortName || '', description: row.description || '', violationReason: row.violationReason || '', ...(row.priority == null ? {} : { priority: row.priority }) };
    }
    if (!token(row.id)) invalid();
    if (field === 'boards') { if (typeof row.name !== 'string' || !row.name || !text(row.name) || !text(row.description) || !text(row.privacy)) invalid(); return { id: row.id, name: row.name, description: row.description || '', privacy: row.privacy || '' }; }
    if (field === 'playlists') { if (typeof row.title !== 'string' || !row.title || !text(row.title) || !text(row.description) || row.privacy != null && !['public', 'private', 'unlisted'].includes(row.privacy) || row.itemCount != null && (!Number.isSafeInteger(row.itemCount) || row.itemCount < 0)) invalid(); return { id: row.id, title: row.title, privacy: row.privacy || '', ...(row.itemCount == null ? {} : { itemCount: row.itemCount }) }; }
    if (field === 'subreddits') { if (typeof row.name !== 'string' || !/^[A-Za-z0-9_]{1,21}$/.test(row.name) || !text(row.title) || row.over18 != null && typeof row.over18 !== 'boolean') invalid(); return { id: row.id, name: row.name, title: row.title || '', over18: row.over18 ?? null }; }
    if (typeof row.text !== 'string' || !text(row.text)) invalid(); return { id: row.id, text: row.text };
  });
  if (field !== 'rules' && new Set(result.map(row => row.id)).size !== result.length) invalid();
  if (field === 'subreddits' && new Set(result.map(row => row.name.toLowerCase())).size !== result.length) invalid();
  const output = { accountId, platform, [field]: result, ...(subreddit ? { subreddit } : {}) };
  if (field === 'rules') {
    if (!Array.isArray(response.siteRules) || response.siteRules.length > 100 || response.siteRules.some(rule => typeof rule !== 'string' || !text(rule))) invalid();
    output.siteRules = response.siteRules;
  }
  if (field === 'playlists' && response.defaultPlaylistId != null && !token(response.defaultPlaylistId) || field === 'subreddits' && response.defaultSubreddit != null && response.defaultSubreddit !== '' && (typeof response.defaultSubreddit !== 'string' || !/^[A-Za-z0-9_]{1,21}$/.test(response.defaultSubreddit))) invalid();
  if (field === 'playlists') output.defaultPlaylistId = response.defaultPlaylistId ?? null;
  if (field === 'subreddits') output.defaultSubreddit = response.defaultSubreddit || '';
  context.send(200, output); return true;
}
