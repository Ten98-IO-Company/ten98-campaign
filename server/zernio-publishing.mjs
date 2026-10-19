import { createHash } from 'node:crypto';
import { IntegrationError, operation, scopedAccounts, requireAccount } from './integrations.mjs';

const fail = (status, code, message, uncertain = false) => { throw new IntegrationError(status, code, message, uncertain); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const token = value => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\s\u0000-\u001f\u007f]/.test(value);
const text = value => value == null || typeof value === 'string' && value.length <= 20000;
const invalid = (uncertain = false) => fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned unreadable publishing destinations. Reload the account choices before continuing.', uncertain);
const resources = { 'pinterest-boards': ['pinterest', 'boards'], 'youtube-playlists': ['youtube', 'playlists'], 'reddit-subreddits': ['reddit', 'subreddits'], 'reddit-rules': ['reddit', 'rules'], 'reddit-flairs': ['reddit', 'flairs'] };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fields = (value, allowed) => { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(400, 'INVALID_DESTINATION_FIELDS', 'Use only the destination settings shown in this form.'); };
const label = (value, maximum, empty = false) => { if (typeof value !== 'string' || value.length > maximum || !empty && !value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(400, 'INVALID_DESTINATION_SETTINGS', 'Complete the destination name, description and privacy settings.'); return empty ? value : value.trim(); };
async function publishingAccount(api, profileId, accountId, platform) {
  const account = requireAccount(await scopedAccounts(api, profileId), accountId);
  if (account.platform !== platform || account.isActive === false) fail(422, 'PUBLISHING_LOOKUP_UNSUPPORTED', 'Choose an active account for this publishing platform.');
  if (account.platformUserId != null && !token(account.platformUserId)) invalid();
  return account;
}
function lookupScope(response, accountId, profileId, platform) {
  if (response.accountId != null && response.accountId !== accountId || response.platform != null && response.platform !== platform || response.profileId != null && String(response.profileId?._id || response.profileId) !== profileId) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio returned destinations for a different publishing account.');
}
function projectLookup(response, accountId, profileId, resource, subreddit, rich = false) {
  const [platform, field] = resources[resource];

  lookupScope(response, accountId, profileId, platform);
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
    if (field === 'playlists') { if (typeof row.title !== 'string' || !row.title || !text(row.title) || !text(row.description) || row.privacy != null && !['public', 'private', 'unlisted'].includes(row.privacy) || row.itemCount != null && (!Number.isSafeInteger(row.itemCount) || row.itemCount < 0)) invalid(); return { id: row.id, title: row.title, privacy: row.privacy || '', ...(rich ? { description: row.description ?? null } : {}), ...(row.itemCount == null ? {} : { itemCount: row.itemCount }) }; }
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
  return output;
}

export async function handleZernioPublishing(context, api, profileId, action) {
  const library = /^accounts\/([^/]+)\/(posts|external-posts|external-import|external-references|external-remove)$/.exec(action);
  if (library) return postLibrary(context, api, profileId, library);
  const match = /^accounts\/([^/]+)\/([^/]+)(?:\/(create|default|manage))?$/.exec(action);
  if (!match || !Object.hasOwn(resources, match[2])) return false;
  if (match[3]) return manageDestinations(context, api, profileId, match);
  if (context.req.method !== 'GET') fail(405, 'METHOD_NOT_ALLOWED', 'Publishing destination lookups are read only.');
  let accountId;
  try { accountId = decodeURIComponent(match[1]); } catch { fail(400, 'INVALID_ACCOUNT', 'Choose a valid connected publishing account.'); }
  if (!token(accountId)) fail(400, 'INVALID_ACCOUNT', 'Choose a valid connected publishing account.');
  const [platform] = resources[match[2]]; await publishingAccount(api, profileId, accountId, platform);
  const params = context.url.searchParams;
  if ([...params.keys()].some(key => !(['reddit-rules', 'reddit-flairs'].includes(match[2]) && key === 'subreddit'))) fail(400, 'INVALID_PUBLISHING_FILTER', 'Use only the destination filters shown in the composer.');
  let subreddit;
  if (['reddit-rules', 'reddit-flairs'].includes(match[2])) { subreddit = params.get('subreddit'); if (typeof subreddit !== 'string' || !/^[A-Za-z0-9_]{1,21}$/.test(subreddit)) fail(400, 'INVALID_SUBREDDIT', 'Choose a subreddit name without the r/ prefix.'); }
  const response = await api(`/accounts/${encodeURIComponent(accountId)}/${match[2] === 'reddit-rules' ? `reddit-subreddits/${encodeURIComponent(subreddit)}/rules` : match[2]}`, match[2] === 'reddit-flairs' ? { subreddit } : {});
  context.send(200, projectLookup(response, accountId, profileId, match[2], subreddit)); return true;
}

const externalPlatforms = ['instagram', 'facebook', 'tiktok', 'youtube', 'twitter', 'threads', 'pinterest', 'reddit', 'bluesky', 'googlebusiness', 'linkedin'];
const postMetrics = ['likes', 'comments', 'shares', 'saves', 'sends', 'clicks', 'views', 'reach', 'impressions', 'engagementRate'];
const libraryInvalid = (uncertain = false) => fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return the expected external posts. Refresh the library before continuing.', uncertain);
function postLink(value, uncertain = false) {
  if (value == null || value === '') return '';
  try { const url = new URL(value); if (typeof value !== 'string' || value.length > 8192 || url.protocol !== 'https:' || url.username || url.password) libraryInvalid(uncertain); return url.href; } catch { libraryInvalid(uncertain); }
}
function libraryPost(row, account, profileId, live = false, uncertain = false) {
  if (!object(row) || row.platform !== account.platform || row.accountId != null && String(row.accountId?._id || row.accountId) !== account._id || row.profileId != null && String(row.profileId?._id || row.profileId) !== profileId) libraryInvalid(uncertain);
  const id = live ? row.id : row.platformPostId, content = live ? row.message : row.content, publishedAt = live ? row.createdTime : row.publishedAt;
  if (!token(id) || content != null && (typeof content !== 'string' || content.length > 100000) || publishedAt != null && (typeof publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(publishedAt) || !Number.isFinite(Date.parse(publishedAt))) || row.mediaType != null && (typeof row.mediaType !== 'string' || row.mediaType.length > 100)) libraryInvalid(uncertain);
  const analytics = {};
  if (!live && row.analytics != null && !object(row.analytics)) libraryInvalid(uncertain);
  const metrics = live ? { likes: row.likeCount, comments: row.commentCount, shares: row.shareCount } : row.analytics || {};
  for (const key of postMetrics) if (metrics[key] != null) { if (typeof metrics[key] !== 'number' || !Number.isFinite(metrics[key]) || metrics[key] < 0 || key !== 'engagementRate' && !Number.isSafeInteger(metrics[key])) libraryInvalid(uncertain); analytics[key] = metrics[key]; }
  if (metrics.lastUpdated != null) { if (typeof metrics.lastUpdated !== 'string' || !Number.isFinite(Date.parse(metrics.lastUpdated))) libraryInvalid(uncertain); analytics.lastUpdated = metrics.lastUpdated; }
  return { platform: row.platform, platformPostId: id, platformPostUrl: postLink(live ? row.permalink : row.platformPostUrl, uncertain), content: content ?? null, publishedAt: publishedAt ?? null, mediaType: row.mediaType ?? null, thumbnailUrl: postLink(live ? row.picture : row.thumbnailUrl, uncertain), analytics, source: live ? 'platform' : 'external' };
}
async function libraryAccount(api, profileId, accountId, active = true) {
  const account = requireAccount(await scopedAccounts(api, profileId), accountId);
  if (!externalPlatforms.includes(account.platform)) fail(422, 'POST_LIBRARY_UNSUPPORTED', 'This connected platform does not support external post imports.');
  if (active && (account.isActive === false || account.needsReconnection === true)) fail(409, 'ACCOUNT_UNAVAILABLE', 'Reconnect this account before reading or importing platform posts.');
  if (account.platformUserId != null && !token(account.platformUserId)) libraryInvalid();
  return account;
}
function externalTable(db) {
  db.exec('CREATE TABLE IF NOT EXISTS zernio_external_post_references(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,profile_id TEXT NOT NULL,account_id TEXT NOT NULL,native_account_id TEXT NOT NULL,platform_post_id TEXT NOT NULL,data TEXT NOT NULL,campaign_id TEXT REFERENCES records(id) ON DELETE SET NULL,updated_at TEXT NOT NULL,PRIMARY KEY(project_id,profile_id,account_id,native_account_id,platform_post_id))');
}
function referenceScope(context, profileId, account) { return [context.project.id, profileId, account._id, account.platformUserId || '']; }
function references(context, profileId, account) {
  externalTable(context.db);
  // ponytail: show the newest 250 local references per account; paginate this separate local index when projects outgrow it. Provider history is already paginated.
  return context.db.prepare('SELECT data,campaign_id,updated_at FROM zernio_external_post_references WHERE project_id=? AND profile_id=? AND account_id=? AND native_account_id=? ORDER BY updated_at DESC,platform_post_id LIMIT 250').all(...referenceScope(context, profileId, account)).map(row => ({ ...JSON.parse(row.data), campaignId: row.campaign_id || '', campaignName: row.campaign_id ? context.store.get(context.project.id, 'campaigns', row.campaign_id)?.name || '' : '', importedAt: row.updated_at }));
}
async function postLibrary(context, api, profileId, match) {
  let accountId; try { accountId = decodeURIComponent(match[1]); } catch { fail(400, 'INVALID_ACCOUNT', 'Choose a valid connected account.'); }
  if (!token(accountId)) fail(400, 'INVALID_ACCOUNT', 'Choose a valid connected account.');
  const task = match[2], write = ['external-import', 'external-remove'].includes(task), params = context.url.searchParams;
  if (context.req.method !== (write ? 'POST' : 'GET')) fail(405, 'METHOD_NOT_ALLOWED', 'Use the available post library controls.');
  if ([...params.keys()].some(key => task !== 'external-posts' || key !== 'page') || [...params.keys()].length !== new Set(params.keys()).size) fail(400, 'INVALID_POST_LIBRARY_FILTER', 'Use the post library page controls without additional provider filters.');
  const page = params.get('page') || '1'; if (!/^[1-9]\d{0,5}$/.test(page)) fail(400, 'INVALID_POST_LIBRARY_PAGE', 'Choose a valid post library page.');
  const account = await libraryAccount(api, profileId, accountId, !['external-references', 'external-remove'].includes(task));
  const envelope = { accountId, platform: account.platform, accountName: account.displayName || account.username || account.platform };
  if (task === 'external-references') { context.send(200, { ...envelope, references: references(context, profileId, account), limit: 250 }); return true; }
  if (task === 'posts' || task === 'external-posts') {
    if (task === 'posts' && account.platform === 'googlebusiness') fail(422, 'POST_LIST_UNSUPPORTED', 'Use synced history or import a Google Business post by its URL or ID.');
    const live = task === 'posts', response = await api(live ? `/accounts/${encodeURIComponent(accountId)}/posts` : '/posts', live ? {} : { profileId, accountId, source: 'external', page: Number(page), limit: 25 });
    lookupScope(response, accountId, profileId, account.platform);
    if (!Array.isArray(response.posts) || response.posts.length > 25 || live && response.status !== 'success') libraryInvalid();
    const posts = response.posts.map(row => libraryPost(row, account, profileId, live)); if (new Set(posts.map(row => row.platformPostId)).size !== posts.length) libraryInvalid();
    let pagination;
    if (!live) {
      pagination = response.pagination;
      if (!object(pagination) || pagination.page !== Number(page) || pagination.limit !== 25 || !Number.isSafeInteger(pagination.total) || pagination.total < posts.length || !Number.isSafeInteger(pagination.pages) || pagination.pages < 0 || pagination.pages !== Math.ceil(pagination.total / 25) || Number(page) <= pagination.pages && posts.length !== Math.min(25, pagination.total - (Number(page) - 1) * 25) || Number(page) > pagination.pages && posts.length) libraryInvalid();
      pagination = { page: pagination.page, pages: pagination.pages, total: pagination.total, limit: 25 };
    }
    context.send(200, { ...envelope, posts, ...(pagination ? { pagination } : { limit: 25 }), source: live ? 'platform' : 'external', ...(response.lastUpdated == null ? {} : { lastUpdated: typeof response.lastUpdated === 'string' && Number.isFinite(Date.parse(response.lastUpdated)) ? response.lastUpdated : libraryInvalid() }) }); return true;
  }
  const body = context.body || {};
  if (!['owner', 'admin', 'editor'].includes(context.role)) fail(403, 'POST_LIBRARY_WRITE_REQUIRED', 'A workspace editor or administrator must import posts or change their campaign references.');
  if (!object(body) || Object.keys(body).some(key => !(task === 'external-remove' ? ['postId', 'confirmed'] : ['postId', 'url', 'campaignId']).includes(key))) fail(400, 'INVALID_POST_LIBRARY_FIELDS', 'Use only the post URL or ID and campaign shown in this form.');
  if (task === 'external-remove') {
    if (!token(body.postId) || body.confirmed !== true) fail(400, 'POST_REFERENCE_CONFIRMATION_REQUIRED', 'Confirm removal of this local post reference.');
    const outcome = await operation(context, async () => { context.assertProjectMapping?.(profileId); externalTable(context.db); context.db.prepare('DELETE FROM zernio_external_post_references WHERE project_id=? AND profile_id=? AND account_id=? AND native_account_id=? AND platform_post_id=?').run(...referenceScope(context, profileId, account), body.postId); return { removed: true, platformPostId: body.postId }; }, ['external-post', accountId, body.postId]); context.send(outcome.status, outcome.data); return true;
  }
  const postUrl = typeof body.url === 'string' ? body.url.trim() : body.url;
  if (Boolean(postUrl) === Boolean(body.postId) || body.postId !== undefined && !token(body.postId) || body.url !== undefined && (typeof body.url !== 'string' || body.url.length > 8192)) fail(400, 'POST_LOCATOR_REQUIRED', 'Provide one post URL or native platform post ID.');
  const locator = body.postId ? { postId: body.postId } : { url: postUrl };
  if (locator.url && !(account.platform === 'linkedin' && /^urn:li:(share|ugcPost):\d+$/.test(locator.url))) { try { const url = new URL(locator.url); if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.') || url.hostname.includes(':') || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/i.test(url.hostname) || /^(172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname) || /\.(local|internal)$/.test(url.hostname)) throw new Error(); } catch { fail(400, 'INVALID_POST_URL', 'Use a public HTTPS post URL, or a LinkedIn share or ugcPost URN.'); } }
  const campaignId = body.campaignId ?? ''; if (typeof campaignId !== 'string' || campaignId && (!token(campaignId) || !context.store.get(context.project.id, 'campaigns', campaignId))) fail(400, 'CAMPAIGN_OUTSIDE_PROJECT', 'Choose a campaign in this project.');
  const outcome = await operation(context, async key => {
    const before = await libraryAccount(api, profileId, accountId); if ((before.platformUserId || '') !== (account.platformUserId || '') || before.platform !== account.platform) fail(409, 'POST_ACCOUNT_CHANGED', 'The connected publishing account changed. Reload the library.');
    const response = await api('/posts/sync-external', {}, { accountId, ...locator }, key);
    try {
      lookupScope(response, accountId, profileId, account.platform);
      if (!object(response.synced) || ['postsFound', 'postsSynced'].some(name => !Number.isSafeInteger(response.synced[name]) || response.synced[name] < 0) || response.synced.skipped != null && typeof response.synced.skipped !== 'boolean' || typeof response.found !== 'boolean' || !response.found && response.post != null) libraryInvalid(true);
      const post = response.found ? libraryPost(response.post, account, profileId, false, true) : null;
      if (post && locator.postId && post.platformPostId !== locator.postId) libraryInvalid(true);
      const after = await libraryAccount(api, profileId, accountId); if ((after.platformUserId || '') !== (account.platformUserId || '') || after.platform !== account.platform) fail(409, 'POST_ACCOUNT_CHANGED', 'The connected publishing account changed after the import. Review provider outcomes.', true);
      context.assertProjectMapping?.(profileId);
      let savedCampaignId = campaignId;
      if (post) {
        externalTable(context.db);
        if (!Object.hasOwn(body, 'campaignId')) savedCampaignId = context.db.prepare('SELECT campaign_id FROM zernio_external_post_references WHERE project_id=? AND profile_id=? AND account_id=? AND native_account_id=? AND platform_post_id=?').get(...referenceScope(context, profileId, account), post.platformPostId)?.campaign_id || '';
        if (savedCampaignId && !context.store.get(context.project.id, 'campaigns', savedCampaignId)) fail(409, 'CAMPAIGN_CHANGED', 'The campaign was removed while importing. Review the provider outcome and import again without that campaign.', true);
        context.db.prepare('INSERT INTO zernio_external_post_references VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(project_id,profile_id,account_id,native_account_id,platform_post_id) DO UPDATE SET data=excluded.data,campaign_id=excluded.campaign_id,updated_at=excluded.updated_at').run(...referenceScope(context, profileId, account), post.platformPostId, JSON.stringify(post), savedCampaignId || null, new Date().toISOString());
        context.store.activity(context.project.id, 'Imported a published platform post as an external campaign reference.');
      }
      return { ...envelope, found: response.found, post, campaignId: savedCampaignId, synced: { postsFound: response.synced.postsFound, postsSynced: response.synced.postsSynced, skipped: response.synced.skipped === true }, imported: Boolean(post) };
    } catch (error) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
  }, ['external-post', accountId, locator.postId || locator.url]); context.send(outcome.status, outcome.data); return true;
}

async function managementSnapshot(api, profileId, accountId, resource) {
  const [platform, field] = resources[resource], account = await publishingAccount(api, profileId, accountId, platform), response = await api(`/accounts/${encodeURIComponent(accountId)}/${resource}`);
  if (response.hasMore === true || response.pagination?.hasMore === true) fail(503, 'DESTINATION_CENSUS_INCOMPLETE', 'A complete destination list could not be verified. Use the provider dashboard.');
  const result = projectLookup(response, accountId, profileId, resource, undefined, true), rows = [...result[field]].sort((a, b) => a.id.localeCompare(b.id));
  const output = { accountId, platform, [field]: rows, ...(platform === 'youtube' ? { defaultPlaylistId: result.defaultPlaylistId, defaultReported: Object.hasOwn(response, 'defaultPlaylistId') } : { defaultBoardId: null, defaultReported: false }), accountName: account.displayName || account.username || platform };
  return { ...output, version: digest({ profileId, accountId, platform, platformUserId: account.platformUserId ?? null, rows, defaultPlaylistId: output.defaultPlaylistId ?? null, defaultReported: output.defaultReported }), nativeAccountId: account.platformUserId ?? null };
}
async function destinationMutation(context, resource, run) {
  const db = context.db;
  db.exec('CREATE TABLE IF NOT EXISTS zernio_destination_mutations(resource TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_key TEXT NOT NULL)');
  return operation(context, async key => {
    const old = db.prepare('SELECT o.status FROM zernio_destination_mutations m LEFT JOIN integration_operations o ON o.project_id=m.project_id AND o.request_key=m.request_key WHERE m.resource=?').get(resource);
    if (old && (!old.status || ['pending', 'uncertain'].includes(old.status))) fail(409, 'DESTINATION_PREVIOUS_OUTCOME_UNRESOLVED', 'This new action was not sent. Review the previous destination action in provider outcomes first.');
    db.prepare('INSERT INTO zernio_destination_mutations VALUES(?,?,?) ON CONFLICT(resource) DO UPDATE SET project_id=excluded.project_id,request_key=excluded.request_key').run(resource, context.project.id, key);
    try { const result = await run(key); db.prepare('DELETE FROM zernio_destination_mutations WHERE resource=? AND project_id=? AND request_key=?').run(resource, context.project.id, key); return result; }
    catch (error) { if (error instanceof IntegrationError && !error.uncertain) db.prepare('DELETE FROM zernio_destination_mutations WHERE resource=? AND project_id=? AND request_key=?').run(resource, context.project.id, key); throw error; }
  }, ['publishing-destinations', resource]);
}
async function manageDestinations(context, api, profileId, match) {
  const resource = match[2], task = match[3], [platform, field] = resources[resource];
  if (!['pinterest', 'youtube'].includes(platform)) return false;
  if (context.req.method !== (task === 'manage' ? 'GET' : 'POST')) fail(405, 'METHOD_NOT_ALLOWED', 'Use the available destination management controls.');
  let accountId; try { accountId = decodeURIComponent(match[1]); } catch { fail(400, 'INVALID_ACCOUNT', 'Choose a valid connected publishing account.'); }
  if (!token(accountId) || [...context.url.searchParams].length) fail(400, 'INVALID_DESTINATION_FIELDS', 'Choose an account without additional provider filters.');
  if (task === 'manage') { const result = await managementSnapshot(api, profileId, accountId, resource); context.send(200, result); return true; }
  if (!['owner', 'admin'].includes(context.role)) fail(403, 'DESTINATION_ADMIN_REQUIRED', 'A workspace owner or administrator must create destinations or change shared account defaults.');
  const body = context.body || {}; fields(body, ['expectedVersion', 'confirmed', ...(task === 'create' ? ['settings'] : ['destinationId'])]);
  if (body.confirmed !== true) fail(400, 'DESTINATION_REVIEW_REQUIRED', 'Review the selected account and exact destination settings first.');
  // ponytail: serialize all destination writes per provider across projects; verified native IDs plus alias fencing can separate channels if throughput requires it.
  const connected = await publishingAccount(api, profileId, accountId, platform), lock = platform;
  const outcome = await destinationMutation(context, lock, async key => {
  const before = await managementSnapshot(api, profileId, accountId, resource);
  if (before.nativeAccountId !== (connected.platformUserId ?? null)) fail(409, 'DESTINATION_ACCOUNT_CHANGED', 'The connected channel changed. Reload its destinations before continuing.');
  if (body.expectedVersion !== before.version) fail(409, 'DESTINATION_REVIEW_CHANGED', 'The destination list or saved default changed. Reload and review it again.');
  let payload, chosen;
  if (task === 'create') {
    fields(body.settings, [platform === 'youtube' ? 'title' : 'name', 'description', 'privacy']);
    const title = platform === 'youtube' ? 'title' : 'name', privacy = body.settings.privacy;
    if (!(platform === 'youtube' ? ['private', 'unlisted', 'public'] : ['PUBLIC', 'PROTECTED', 'SECRET']).includes(privacy)) fail(400, 'INVALID_DESTINATION_PRIVACY', 'Choose an explicit destination privacy setting.');
    payload = { [title]: label(body.settings[title], platform === 'youtube' ? 150 : 180), description: label(body.settings.description ?? '', 5000, true), privacy };
  } else {
    if (!token(body.destinationId)) fail(400, 'INVALID_DESTINATION_ID', 'Choose an existing board or playlist. Clearing a YouTube default is not supported.');
    chosen = before[field].find(row => row.id === body.destinationId); if (!chosen) fail(403, 'DESTINATION_OUTSIDE_ACCOUNT', 'Choose a destination from this account’s verified list.');
    payload = platform === 'youtube' ? { defaultPlaylistId: chosen.id, defaultPlaylistName: chosen.title } : { defaultBoardId: chosen.id, defaultBoardName: chosen.name };
  }
    const current = await managementSnapshot(api, profileId, accountId, resource);
    if (current.version !== before.version) fail(409, 'DESTINATION_REVIEW_CHANGED', 'The account or destination settings changed while preparing this action. Reload and review them again.');
    const account = await publishingAccount(api, profileId, accountId, platform); if ((account.platformUserId ?? null) !== before.nativeAccountId) fail(409, 'DESTINATION_ACCOUNT_CHANGED', 'The connected channel changed. Reload its destinations before continuing.');
    const response = await api(`/accounts/${encodeURIComponent(accountId)}/${resource}`, {}, payload, key, task === 'create' ? 'POST' : 'PUT');
    try {
      lookupScope(response, accountId, profileId, platform);
      const after = await managementSnapshot(api, profileId, accountId, resource); if (after.nativeAccountId !== before.nativeAccountId) invalid(true);
      if (task === 'create') {
        if (platform === 'youtube' && (after.defaultReported !== before.defaultReported || after.defaultPlaylistId !== before.defaultPlaylistId)) invalid(true);
        const raw = response[platform === 'youtube' ? 'playlist' : 'board'];
        if (!object(raw) || !token(raw.id) || before[field].some(row => row.id === raw.id)) invalid(true);
        const ack = projectLookup({ [field]: [raw] }, accountId, profileId, resource, undefined, true)[field][0], found = after[field].find(row => row.id === raw.id);
        if (!found || Object.entries(payload).some(([name, value]) => ack[name] !== value || found[name] !== value) || platform === 'youtube' && (ack.itemCount !== 0 || found.itemCount !== 0)) invalid(true);
        return { destination: found, snapshot: after, created: true };
      }
      if (platform === 'youtube') { if (response.success !== true || !after.defaultReported || after.defaultPlaylistId !== chosen.id) invalid(true); return { defaultId: chosen.id, accepted: true, readback: true, snapshot: after }; }
      const saved = response.account;
      if (!object(saved) || saved._id !== accountId || saved.platform !== platform || saved.profileId !== undefined && String(saved.profileId?._id || saved.profileId) !== profileId || saved.isActive !== true || saved.platformUserId !== undefined && saved.platformUserId !== before.nativeAccountId || !after[field].some(row => row.id === chosen.id && row.name === chosen.name)) invalid(true);
      return { defaultId: chosen.id, accepted: true, readback: false, snapshot: after };
    } catch (error) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
  }); context.send(outcome.status, outcome.data); return true;
}
