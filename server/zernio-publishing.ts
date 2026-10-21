import type { OperationContext, ProviderRecord, ZernioApi } from './provider-core.ts';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { fail, reportObject as object, IntegrationError, operation, claimFence, releaseFence, scopedAccounts, requireAccount, mediaUrl } from './provider-core.ts';

const token = (value: any) => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\s\u0000-\u001f\u007f]/.test(value);
const text = (value: any) => value == null || typeof value === 'string' && value.length <= 20000;
const invalid = (uncertain = false) => fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned unreadable publishing destinations. Reload the account choices before continuing.', uncertain);
const resources: Record<string, string[]> = { 'pinterest-boards': ['pinterest', 'boards'], 'youtube-playlists': ['youtube', 'playlists'], 'reddit-subreddits': ['reddit', 'subreddits'], 'reddit-rules': ['reddit', 'rules'], 'reddit-flairs': ['reddit', 'flairs'] };
const digest = (value: any) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fields = (value: any, allowed: any) => { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(400, 'INVALID_DESTINATION_FIELDS', 'Use only the destination settings shown in this form.'); };
const label = (value: any, maximum: any, empty = false) => { if (typeof value !== 'string' || value.length > maximum || !empty && !value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(400, 'INVALID_DESTINATION_SETTINGS', 'Complete the destination name, description and privacy settings.'); return empty ? value : value.trim(); };
async function publishingAccount(api: ZernioApi, profileId: any, accountId: any, platform: any) {
  const account = requireAccount(await scopedAccounts(api, profileId), accountId);
  if (account.platform !== platform || account.isActive === false) fail(422, 'PUBLISHING_LOOKUP_UNSUPPORTED', 'Choose an active account for this publishing platform.');
  if (account.platformUserId != null && !token(account.platformUserId)) invalid();
  return account;
}
function lookupScope(response: any, accountId: any, profileId: any, platform: any) {
  if (response.accountId != null && response.accountId !== accountId || response.platform != null && response.platform !== platform || response.profileId != null && String(response.profileId?._id || response.profileId) !== profileId) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio returned destinations for a different publishing account.');
}
function projectLookup(response: any, accountId: any, profileId: any, resource: any, subreddit: any, rich = false) {
  const [platform, field] = resources[resource];

  lookupScope(response, accountId, profileId, platform);
  const rows = response[field];
  if (!Array.isArray(rows) || rows.length > 10000) invalid();
  const result = rows.map((row: any) => {
    if (!object(row)) invalid();
    if (field === 'rules') {
      if (!text(row.shortName) || !text(row.description) || !text(row.violationReason) || !['link', 'comment', 'all'].includes(row.kind) || row.priority != null && (!Number.isSafeInteger(row.priority) || row.priority < 0)) invalid();
      return { kind: row.kind, shortName: row.shortName || '', description: row.description || '', violationReason: row.violationReason || '', ...(row.priority == null ? {} : { priority: row.priority }) };
    }
    if (!token(row.id)) invalid();
    if (field === 'boards') { if (typeof row.name !== 'string' || !row.name || !text(row.name) || !text(row.description) || !text(row.privacy)) invalid(); return { id: row.id, name: row.name, description: row.description || '', privacy: row.privacy || '' }; }
    if (field === 'playlists') { if (typeof row.title !== 'string' || !row.title || !text(row.title) || !text(row.description) || row.privacy != null && !['public', 'private', 'unlisted'].includes(row.privacy) || row.itemCount != null && (!Number.isSafeInteger(row.itemCount) || row.itemCount < 0)) invalid(); return { id: row.id, title: row.title, privacy: row.privacy || '', ...(rich ? { description: row.description ?? null } : {}), ...(row.itemCount == null ? {} : { itemCount: row.itemCount }) }; }
    if (field === 'subreddits') { if (typeof row.name !== 'string' || !/^[A-Za-z0-9_]{1,21}$/.test(row.name) || !text(row.title) || rich && !text(row.url) || row.over18 != null && typeof row.over18 !== 'boolean') invalid(); return { id: row.id, name: row.name, title: row.title || '', over18: row.over18 ?? null, ...(rich ? { url: row.url ?? null } : {}) }; }
    if (typeof row.text !== 'string' || !text(row.text)) invalid(); return { id: row.id, text: row.text };
  });
  if (field !== 'rules' && new Set(result.map((row: any) => row.id)).size !== result.length) invalid();
  if (field === 'subreddits' && new Set(result.map((row: any) => row.name.toLowerCase())).size !== result.length) invalid();
  const output: ProviderRecord = { accountId, platform, [field]: result, ...(subreddit ? { subreddit } : {}) };
  if (field === 'rules') {
    if (!Array.isArray(response.siteRules) || response.siteRules.length > 100 || response.siteRules.some((rule: any) => typeof rule !== 'string' || !text(rule))) invalid();
    output.siteRules = response.siteRules;
  }
  if (field === 'playlists' && response.defaultPlaylistId != null && !token(response.defaultPlaylistId) || field === 'subreddits' && response.defaultSubreddit != null && response.defaultSubreddit !== '' && (typeof response.defaultSubreddit !== 'string' || !/^[A-Za-z0-9_]{1,21}$/.test(response.defaultSubreddit))) invalid();
  if (field === 'playlists') output.defaultPlaylistId = response.defaultPlaylistId ?? null;
  if (field === 'subreddits') output.defaultSubreddit = response.defaultSubreddit || '';
  return output;
}

export async function handleZernioPublishing(context: OperationContext & { body: any }, api: ZernioApi, profileId: any, action: any) {
  const tools = /^accounts\/([^/]+)\/(gmb-locations|instagram-publishing-limit|instagram-audio|instagram-audio-lookup|tiktok-commercial-music|tiktok-locations)$/.exec(action);
  if (tools) return publishingTools(context, api, profileId, tools);
  const library = /^accounts\/([^/]+)\/(posts|external-posts|external-import|external-references|external-remove)$/.exec(action);
  if (library) return postLibrary(context, api, profileId, library);
  const match = /^accounts\/([^/]+)\/([^/]+)(?:\/(create|default|manage))?$/.exec(action);
  if (!match || !Object.hasOwn(resources, match[2])) return false;
  if (match[3]) return manageDestinations(context, api, profileId, match);
  if (context.req.method !== 'GET') fail(405, 'METHOD_NOT_ALLOWED', 'Publishing destination lookups are read only.');
  let accountId: any;
  try { accountId = decodeURIComponent(match[1]); } catch { fail(400, 'INVALID_ACCOUNT', 'Choose a valid connected publishing account.'); }
  if (!token(accountId)) fail(400, 'INVALID_ACCOUNT', 'Choose a valid connected publishing account.');
  const [platform] = resources[match[2]]; await publishingAccount(api, profileId, accountId, platform);
  const params = context.url.searchParams;
  if ([...params.keys()].some(key => !(['reddit-rules', 'reddit-flairs'].includes(match[2]) && key === 'subreddit'))) fail(400, 'INVALID_PUBLISHING_FILTER', 'Use only the destination filters shown in the composer.');
  let subreddit: any;
  if (['reddit-rules', 'reddit-flairs'].includes(match[2])) { subreddit = params.get('subreddit'); if (typeof subreddit !== 'string' || !/^[A-Za-z0-9_]{1,21}$/.test(subreddit)) fail(400, 'INVALID_SUBREDDIT', 'Choose a subreddit name without the r/ prefix.'); }
  const response = await api(`/accounts/${encodeURIComponent(accountId)}/${match[2] === 'reddit-rules' ? `reddit-subreddits/${encodeURIComponent(subreddit)}/rules` : match[2]}`, match[2] === 'reddit-flairs' ? { subreddit } : {});
  context.send(200, projectLookup(response, accountId, profileId, match[2], subreddit)); return true;
}

async function publishingToolsAccess(context: OperationContext & { body: any }, profileId: any) {
  try { await context.assertProjectMapping?.(profileId); await context.assertIntegrationSettings?.(); }
  catch (error: any) { fail([403, 404].includes(error.status) ? 403 : 409, 'PUBLISHING_ACCESS_CHANGED', 'Your project access or connection changed. Refresh the publishing choices.'); }
}
function publishingToolsIdentity(account: any, platform: any): ProviderRecord {
  if (account.needsReconnection != null && typeof account.needsReconnection !== 'boolean') invalid();
  if (account.needsReconnection === true) fail(409, 'PUBLISHING_RECONNECTION_REQUIRED', 'Reconnect this account before loading publishing choices.');
  let loginMethod: any;
  if (platform === 'instagram') {
    if (account.metadata != null && !object(account.metadata) || account.metadata?.loginMethod != null && !['facebook_login', 'instagram_login'].includes(account.metadata.loginMethod)) invalid();
    loginMethod = account.metadata?.loginMethod ?? 'instagram_login';
  }
  return { loginMethod, identity: JSON.stringify([account._id, account.platform, account.platformUserId ?? null, account.username ?? null, account.isActive ?? null, account.needsReconnection ?? null, loginMethod]) };
}
function instagramAudio(row: any) {
  if (!object(row) || typeof row.audioId !== 'string' || !/^\d{1,30}$/.test(row.audioId)) invalid();
  const result: ProviderRecord = { audioId: row.audioId };
  for (const key of ['title', 'displayArtist', 'igUsername']) { if (!text(row[key])) invalid(); result[key] = row[key] ?? null; }
  if (row.audioType != null && !['music', 'original_sound'].includes(row.audioType) || row.durationInMs != null && (!Number.isSafeInteger(row.durationInMs) || row.durationInMs < 0) || row.isAdsEligible != null && typeof row.isAdsEligible !== 'boolean') invalid();
  Object.assign(result, { audioType: row.audioType ?? null, durationInMs: row.durationInMs ?? null, isAdsEligible: row.isAdsEligible ?? null });
  for (const key of ['downloadUrl', 'onPlatformAudioPreviewLink']) {
    if (row[key] == null) result[key] = null;
    else { if (typeof row[key] !== 'string' || row[key].length > 4000) invalid(); try { result[key] = mediaUrl(row[key]); } catch { invalid(); } }
  }
  return result;
}
function tiktokTrack(row: any) {
  if (!object(row) || !token(row.id) || row.commercialMusicId != null && !token(row.commercialMusicId)) invalid();
  const track: ProviderRecord = { id: row.id, commercialMusicId: row.commercialMusicId ?? null };
  for (const key of ['name', 'artist', 'previewUrl', 'thumbnailUrl']) { if (!text(row[key])) invalid(); track[key] = row[key] ?? null; }
  for (const key of ['durationSec', 'rank']) { if (row[key] != null && (!Number.isSafeInteger(row[key]) || row[key] < (key === 'rank' ? 1 : 0))) invalid(); track[key] = row[key] ?? null; }
  if (row.genres != null && (!Array.isArray(row.genres) || row.genres.length > 100 || row.genres.some((genre: any) => typeof genre !== 'string' || !text(genre)))) invalid();
  track.genres = row.genres ?? null;
  if (row.clip != null && (!object(row.clip) || !token(row.clip.id) || row.clip.durationSec != null && (!Number.isSafeInteger(row.clip.durationSec) || row.clip.durationSec < 0) || !text(row.clip.previewUrl))) invalid();
  track.clip = row.clip == null ? null : { id: row.clip.id, durationSec: row.clip.durationSec ?? null, previewUrl: row.clip.previewUrl ?? null };
  return track;
}
async function publishingTools(context: OperationContext & { body: any }, api: ZernioApi, profileId: any, match: any) {
  if (context.req.method !== 'GET') fail(405, 'METHOD_NOT_ALLOWED', 'Publishing choices are read only.');
  let accountId; try { accountId = decodeURIComponent(match[1]); } catch { fail(400, 'INVALID_ACCOUNT', 'Choose a valid connected publishing account.'); }
  if (!token(accountId)) fail(400, 'INVALID_ACCOUNT', 'Choose a valid connected publishing account.');
  const resource = match[2], platform = resource === 'gmb-locations' ? 'googlebusiness' : resource.startsWith('tiktok-') ? 'tiktok' : 'instagram', params = context.url.searchParams;
  const allowed = resource === 'gmb-locations' ? ['search'] : resource === 'instagram-audio' ? ['audioType', 'q'] : resource === 'instagram-audio-lookup' ? ['audioId'] : resource === 'tiktok-commercial-music' ? ['countryCode'] : resource === 'tiktok-locations' ? ['query'] : [];
  if ([...params.keys()].some(key => !allowed.includes(key) || params.getAll(key).length !== 1)) fail(400, 'INVALID_PUBLISHING_FILTER', 'Use only the publishing filters shown in this form.');
  const query: ProviderRecord = resource === 'gmb-locations' ? { limit: 100 } : {};
  for (const key of ['search', 'q']) if (params.has(key)) { const value = params.get(key)!; if (!value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) fail(400, 'INVALID_PUBLISHING_SEARCH', 'Enter a search of 1 to 200 characters.'); query[key] = value; }
  if (resource === 'instagram-audio') { if (!['music', 'original_sound'].includes(params.get('audioType')!)) fail(400, 'INVALID_INSTAGRAM_AUDIO_TYPE', 'Choose music or original sounds.'); query.audioType = params.get('audioType'); }
  const audioId = params.get('audioId');
  if (resource === 'instagram-audio-lookup' && !/^\d{1,30}$/.test(audioId || '')) fail(400, 'INVALID_INSTAGRAM_AUDIO_ID', 'Enter a numeric audio ID of up to 30 digits.');
  if (resource === 'tiktok-commercial-music' && params.has('countryCode')) { if (!/^[A-Za-z]{2}$/.test(params.get('countryCode')!)) fail(400, 'INVALID_TIKTOK_COUNTRY', 'Enter a two-letter country code or leave it empty for the global chart.'); query.countryCode = params.get('countryCode')!.toUpperCase(); }
  if (resource === 'tiktok-locations') { const value = params.get('query'); if (!value?.trim() || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) fail(400, 'INVALID_TIKTOK_LOCATION_QUERY', 'Enter a place search of 1 to 100 characters.'); query.query = value; }
  await publishingToolsAccess(context, profileId);
  const account = await publishingAccount(api, profileId, accountId, platform); await publishingToolsAccess(context, profileId);
  const before: ProviderRecord = publishingToolsIdentity(account, platform);
  if (resource.startsWith('instagram-audio') && before.loginMethod !== 'facebook_login') fail(422, 'INSTAGRAM_AUDIO_REQUIRES_FACEBOOK_LOGIN', 'Reconnect Instagram using Facebook Login to load its audio catalog.');
  const endpoint = resource === 'gmb-locations' ? resource : platform === 'tiktok' ? `tiktok/${resource.slice('tiktok-'.length)}` : resource === 'instagram-audio-lookup' ? `instagram/audio/${audioId}` : `instagram/${resource.slice('instagram-'.length)}`;
  const response = await api(`/accounts/${encodeURIComponent(accountId)}/${endpoint}`, query); await publishingToolsAccess(context, profileId);
  const fresh = await publishingAccount(api, profileId, accountId, platform); await publishingToolsAccess(context, profileId);
  if (publishingToolsIdentity(fresh, platform).identity !== before.identity) fail(409, 'PUBLISHING_ACCOUNT_CHANGED', 'The connected account changed. Reload its publishing choices.');
  if (!object(response)) invalid(); lookupScope(response, accountId, profileId, platform);
  const result: ProviderRecord = { accountId, platform, ...(platform === 'instagram' ? { loginMethod: before.loginMethod } : {}) };
  if (resource === 'gmb-locations') {
    if (!Array.isArray(response.locations) || response.locations.length > 100 || response.hasMore != null && typeof response.hasMore !== 'boolean' || response.cached != null && typeof response.cached !== 'boolean' || response.selectedLocationId != null && !token(response.selectedLocationId)) invalid();
    result.locations = response.locations.map((row: any) => {
      if (!object(row) || !token(row.id) || typeof row.name !== 'string' || !text(row.name) || row.accountId != null && !token(row.accountId)) invalid();
      const location: ProviderRecord = { id: row.id, name: row.name, accountId: row.accountId ?? null };
      for (const key of ['accountName', 'address', 'category', 'storeCode']) { if (!text(row[key])) invalid(); location[key] = row[key] ?? null; }
      return location;
    });
    if (new Set(result.locations.map((row: any) => row.id)).size !== result.locations.length) invalid();
    Object.assign(result, { selectedLocationId: response.selectedLocationId ?? null, hasMore: response.hasMore ?? null, cached: response.cached ?? null });
  } else if (resource === 'tiktok-commercial-music') {
    if (!Array.isArray(response.tracks) || response.tracks.length > 100) invalid();
    result.tracks = response.tracks.map(tiktokTrack);
    if (new Set(result.tracks.map((row: any) => row.id)).size !== result.tracks.length) invalid();
  } else if (resource === 'tiktok-locations') {
    if (!Array.isArray(response.locations) || response.locations.length > 20) invalid();
    result.locations = response.locations.map((row: any) => { if (!object(row) || !token(row.id) || typeof row.name !== 'string' || !row.name.trim() || !text(row.name) || !text(row.address)) invalid(); return { id: row.id, name: row.name, address: row.address ?? null }; });
    if (new Set(result.locations.map((row: any) => row.id)).size !== result.locations.length) invalid();
  } else if (resource === 'instagram-publishing-limit') {
    for (const key of ['quotaUsage', 'quotaTotal', 'quotaDurationSeconds']) { if (!Number.isSafeInteger(response[key]) || response[key] < (key === 'quotaDurationSeconds' ? 1 : 0)) invalid(); result[key] = response[key]; }
  } else if (resource === 'instagram-audio') {
    if (!Array.isArray(response.audio) || response.audio.length > 100) invalid();
    result.audio = response.audio.map(instagramAudio);
    if (new Set(result.audio.map((row: any) => row.audioId)).size !== result.audio.length || result.audio.some((row: any) => row.audioType !== null && row.audioType !== query.audioType)) invalid();
  } else { result.audio = instagramAudio(response.audio); if (result.audio.audioId !== audioId) invalid(); }
  context.send(200, result); return true;
}

const externalPlatforms = ['instagram', 'facebook', 'tiktok', 'youtube', 'twitter', 'threads', 'pinterest', 'reddit', 'bluesky', 'googlebusiness', 'linkedin'];
const postMetrics = ['likes', 'comments', 'shares', 'saves', 'sends', 'clicks', 'views', 'reach', 'impressions', 'engagementRate'];
const libraryInvalid = (uncertain = false) => fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return the expected external posts. Refresh the library before continuing.', uncertain);
function postLink(value: any, uncertain = false) {
  if (value == null || value === '') return '';
  try { const url = new URL(value); if (typeof value !== 'string' || value.length > 8192 || url.protocol !== 'https:' || url.username || url.password) libraryInvalid(uncertain); return url.href; } catch { libraryInvalid(uncertain); }
}
function libraryPost(row: any, account: any, profileId: any, live = false, uncertain = false) {
  if (!object(row) || row.platform !== account.platform || row.accountId != null && String(row.accountId?._id || row.accountId) !== account._id || row.profileId != null && String(row.profileId?._id || row.profileId) !== profileId) libraryInvalid(uncertain);
  const id = live ? row.id : row.platformPostId, content = live ? row.message : row.content, publishedAt = live ? row.createdTime : row.publishedAt;
  if (!token(id) || content != null && (typeof content !== 'string' || content.length > 100000) || publishedAt != null && (typeof publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(publishedAt) || !Number.isFinite(Date.parse(publishedAt))) || row.mediaType != null && (typeof row.mediaType !== 'string' || row.mediaType.length > 100)) libraryInvalid(uncertain);
  const analytics: ProviderRecord = {};
  if (!live && row.analytics != null && !object(row.analytics)) libraryInvalid(uncertain);
  const metrics = live ? { likes: row.likeCount, comments: row.commentCount, shares: row.shareCount } : row.analytics || {};
  for (const key of postMetrics) if (metrics[key] != null) { if (typeof metrics[key] !== 'number' || !Number.isFinite(metrics[key]) || metrics[key] < 0 || key !== 'engagementRate' && !Number.isSafeInteger(metrics[key])) libraryInvalid(uncertain); analytics[key] = metrics[key]; }
  if (metrics.lastUpdated != null) { if (typeof metrics.lastUpdated !== 'string' || !Number.isFinite(Date.parse(metrics.lastUpdated))) libraryInvalid(uncertain); analytics.lastUpdated = metrics.lastUpdated; }
  return { platform: row.platform, platformPostId: id, platformPostUrl: postLink(live ? row.permalink : row.platformPostUrl, uncertain), content: content ?? null, publishedAt: publishedAt ?? null, mediaType: row.mediaType ?? null, thumbnailUrl: postLink(live ? row.picture : row.thumbnailUrl, uncertain), analytics, source: live ? 'platform' : 'external' };
}
async function libraryAccount(api: ZernioApi, profileId: any, accountId: any, active = true) {
  const account = requireAccount(await scopedAccounts(api, profileId), accountId);
  if (!externalPlatforms.includes(account.platform)) fail(422, 'POST_LIBRARY_UNSUPPORTED', 'This connected platform does not support external post imports.');
  if (active && (account.isActive === false || account.needsReconnection === true)) fail(409, 'ACCOUNT_UNAVAILABLE', 'Reconnect this account before reading or importing platform posts.');
  if (account.platformUserId != null && !token(account.platformUserId)) libraryInvalid();
  return account;
}
async function references(context: OperationContext & { body: any }, profileId: any, account: any) {
  // ponytail: show the newest 250 local references per account; paginate this separate local index when projects outgrow it. Provider history is already paginated.
  const rows = (await context.db.execute(sql`SELECT data, campaign_id, updated_at FROM zernio_external_post_references WHERE project_id=${context.project.id} AND profile_id=${profileId} AND account_id=${account._id} AND native_account_id=${account.platformUserId || ''} ORDER BY updated_at DESC, platform_post_id LIMIT 250`)).rows as ProviderRecord[];
  return Promise.all(rows.map(async row => ({ ...row.data, campaignId: row.campaign_id || '', campaignName: row.campaign_id ? (await context.store.get(context.project.id, 'campaigns', row.campaign_id))?.name || '' : '', importedAt: row.updated_at })));
}
async function postLibrary(context: OperationContext & { body: any }, api: ZernioApi, profileId: any, match: any) {
  let accountId; try { accountId = decodeURIComponent(match[1]); } catch { fail(400, 'INVALID_ACCOUNT', 'Choose a valid connected account.'); }
  if (!token(accountId)) fail(400, 'INVALID_ACCOUNT', 'Choose a valid connected account.');
  const task = match[2], write = ['external-import', 'external-remove'].includes(task), params = context.url.searchParams;
  if (context.req.method !== (write ? 'POST' : 'GET')) fail(405, 'METHOD_NOT_ALLOWED', 'Use the available post library controls.');
  if ([...params.keys()].some(key => task !== 'external-posts' || key !== 'page') || [...params.keys()].length !== new Set(params.keys()).size) fail(400, 'INVALID_POST_LIBRARY_FILTER', 'Use the post library page controls without additional provider filters.');
  const page = params.get('page') || '1'; if (!/^[1-9]\d{0,5}$/.test(page)) fail(400, 'INVALID_POST_LIBRARY_PAGE', 'Choose a valid post library page.');
  const account = await libraryAccount(api, profileId, accountId, !['external-references', 'external-remove'].includes(task));
  const envelope = { accountId, platform: account.platform, accountName: account.displayName || account.username || account.platform };
  if (task === 'external-references') { context.send(200, { ...envelope, references: await references(context, profileId, account), limit: 250 }); return true; }
  if (task === 'posts' || task === 'external-posts') {
    if (task === 'posts' && account.platform === 'googlebusiness') fail(422, 'POST_LIST_UNSUPPORTED', 'Use synced history or import a Google Business post by its URL or ID.');
    const live = task === 'posts', response = await api(live ? `/accounts/${encodeURIComponent(accountId)}/posts` : '/posts', live ? {} : { profileId, accountId, source: 'external', page: Number(page), limit: 25 });
    lookupScope(response, accountId, profileId, account.platform);
    if (!Array.isArray(response.posts) || response.posts.length > 25 || live && response.status !== 'success') libraryInvalid();
    const posts = response.posts.map((row: any) => libraryPost(row, account, profileId, live)); if (new Set(posts.map((row: any) => row.platformPostId)).size !== posts.length) libraryInvalid();
    let pagination: any;
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
    const outcome = await operation(context, async () => { await context.assertProjectMapping?.(profileId); await context.db.execute(sql`DELETE FROM zernio_external_post_references WHERE project_id=${context.project.id} AND profile_id=${profileId} AND account_id=${account._id} AND native_account_id=${account.platformUserId || ''} AND platform_post_id=${body.postId}`); return { removed: true, platformPostId: body.postId }; }, ['external-post', accountId, body.postId]); context.send(outcome.status, outcome.data); return true;
  }
  const postUrl = typeof body.url === 'string' ? body.url.trim() : body.url;
  if (Boolean(postUrl) === Boolean(body.postId) || body.postId !== undefined && !token(body.postId) || body.url !== undefined && (typeof body.url !== 'string' || body.url.length > 8192)) fail(400, 'POST_LOCATOR_REQUIRED', 'Provide one post URL or native platform post ID.');
  const locator = body.postId ? { postId: body.postId } : { url: postUrl };
  if (locator.url && !(account.platform === 'linkedin' && /^urn:li:(share|ugcPost):\d+$/.test(locator.url))) { try { const url = new URL(locator.url); if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.') || url.hostname.includes(':') || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/i.test(url.hostname) || /^(172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname) || /\.(local|internal)$/.test(url.hostname)) throw new Error(); } catch { fail(400, 'INVALID_POST_URL', 'Use a public HTTPS post URL, or a LinkedIn share or ugcPost URN.'); } }
  const campaignId = body.campaignId ?? ''; if (typeof campaignId !== 'string' || campaignId && (!token(campaignId) || !await context.store.get(context.project.id, 'campaigns', campaignId))) fail(400, 'CAMPAIGN_OUTSIDE_PROJECT', 'Choose a campaign in this project.');
  const outcome = await operation(context, async key => {
    const before = await libraryAccount(api, profileId, accountId); if ((before.platformUserId || '') !== (account.platformUserId || '') || before.platform !== account.platform) fail(409, 'POST_ACCOUNT_CHANGED', 'The connected publishing account changed. Reload the library.');
    const response = await api('/posts/sync-external', {}, { accountId, ...locator }, key);
    try {
      lookupScope(response, accountId, profileId, account.platform);
      if (!object(response.synced) || ['postsFound', 'postsSynced'].some(name => !Number.isSafeInteger(response.synced[name]) || response.synced[name] < 0) || response.synced.skipped != null && typeof response.synced.skipped !== 'boolean' || typeof response.found !== 'boolean' || !response.found && response.post != null) libraryInvalid(true);
      const post = response.found ? libraryPost(response.post, account, profileId, false, true) : null;
      if (post && locator.postId && post.platformPostId !== locator.postId) libraryInvalid(true);
      const after = await libraryAccount(api, profileId, accountId); if ((after.platformUserId || '') !== (account.platformUserId || '') || after.platform !== account.platform) fail(409, 'POST_ACCOUNT_CHANGED', 'The connected publishing account changed after the import. Review provider outcomes.', true);
      await context.assertProjectMapping?.(profileId);
      let savedCampaignId = campaignId;
      if (post) {
        const nativeAccountId = account.platformUserId || '';
        if (!Object.hasOwn(body, 'campaignId')) savedCampaignId = ((await context.db.execute(sql`SELECT campaign_id FROM zernio_external_post_references WHERE project_id=${context.project.id} AND profile_id=${profileId} AND account_id=${account._id} AND native_account_id=${nativeAccountId} AND platform_post_id=${post.platformPostId}`)).rows[0] as ProviderRecord | undefined)?.campaign_id || '';
        if (savedCampaignId && !await context.store.get(context.project.id, 'campaigns', savedCampaignId)) fail(409, 'CAMPAIGN_CHANGED', 'The campaign was removed while importing. Review the provider outcome and import again without that campaign.', true);
        await context.db.execute(sql`INSERT INTO zernio_external_post_references (project_id, profile_id, account_id, native_account_id, platform_post_id, data, campaign_id, updated_at) VALUES (${context.project.id}, ${profileId}, ${account._id}, ${nativeAccountId}, ${post.platformPostId}, ${JSON.stringify(post)}, ${savedCampaignId || null}, ${new Date().toISOString()}) ON CONFLICT (project_id, profile_id, account_id, native_account_id, platform_post_id) DO UPDATE SET data=excluded.data, campaign_id=excluded.campaign_id, updated_at=excluded.updated_at`);
        await context.store.activity(context.project.id, 'Imported a published platform post as an external campaign reference.');
      }
      return { ...envelope, found: response.found, post, campaignId: savedCampaignId, synced: { postsFound: response.synced.postsFound, postsSynced: response.synced.postsSynced, skipped: response.synced.skipped === true }, imported: Boolean(post) };
    } catch (error: any) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
  }, ['external-post', accountId, locator.postId || locator.url]); context.send(outcome.status, outcome.data); return true;
}

async function managementSnapshot(context: OperationContext & { body: any }, api: ZernioApi, profileId: any, accountId: any, resource: any): Promise<ProviderRecord> {
  const [platform, field] = resources[resource];
  await publishingToolsAccess(context, profileId);
  const account = await publishingAccount(api, profileId, accountId, platform);
  const accountVersion = digest([profileId, publishingToolsIdentity(account, platform).identity]);
  if (platform === 'reddit' && account.isActive !== true) fail(409, 'DESTINATION_ACCOUNT_UNAVAILABLE', 'Choose an active Reddit account before changing its default.');
  const response = await api(`/accounts/${encodeURIComponent(accountId)}/${resource}`);
  if (response.hasMore === true || response.pagination?.hasMore === true) fail(503, 'DESTINATION_CENSUS_INCOMPLETE', 'A complete destination list could not be verified. Use the provider dashboard.');
  const result = projectLookup(response, accountId, profileId, resource, undefined, true), rows = [...result[field]].sort((a, b) => a.id.localeCompare(b.id));
  const fresh = await publishingAccount(api, profileId, accountId, platform);
  await publishingToolsAccess(context, profileId);
  if (digest([profileId, publishingToolsIdentity(fresh, platform).identity]) !== accountVersion) fail(409, 'DESTINATION_ACCOUNT_CHANGED', 'The connected publishing account changed. Reload its destinations.');
  const output: ProviderRecord = { accountId, platform, accountVersion, [field]: rows, ...(platform === 'youtube' ? { defaultPlaylistId: result.defaultPlaylistId, defaultReported: Object.hasOwn(response, 'defaultPlaylistId') } : platform === 'reddit' ? { defaultSubreddit: result.defaultSubreddit, defaultReported: typeof response.defaultSubreddit === 'string' } : { defaultBoardId: null, defaultReported: false }), accountName: account.displayName || account.username || platform };
  return { ...output, version: digest({ profileId, accountId, platform, accountVersion, platformUserId: account.platformUserId ?? null, rows, defaultPlaylistId: output.defaultPlaylistId ?? null, ...(platform === 'reddit' ? { defaultSubreddit: output.defaultSubreddit, defaultPresent: Object.hasOwn(response, 'defaultSubreddit') } : {}), defaultReported: output.defaultReported }), nativeAccountId: account.platformUserId ?? null };
}
async function destinationMutation(context: OperationContext & { body: any }, resource: any, run: any) {
  return operation(context, async key => {
    // One change per destination resource at a time; an unresolved earlier change keeps the fence held.
    const fence = ['zernio_destination_mutations', resource, context.project.id, key] as const;
    if (!await claimFence(context.db, ...fence)) fail(409, 'DESTINATION_PREVIOUS_OUTCOME_UNRESOLVED', 'This new action was not sent. Review the previous destination action in provider outcomes first.');
    try { const result = await run(key); await releaseFence(context.db, ...fence); return result; }
    catch (error: any) { if (error instanceof IntegrationError && !error.uncertain) await releaseFence(context.db, ...fence); throw error; }
  }, ['publishing-destinations', resource]);
}
async function manageDestinations(context: OperationContext & { body: any }, api: ZernioApi, profileId: any, match: any) {
  const resource = match[2], task = match[3], [platform, field] = resources[resource];
  if (!['pinterest', 'youtube', 'reddit'].includes(platform) || platform === 'reddit' && resource !== 'reddit-subreddits') return false;
  if (platform === 'reddit' && task === 'create') fail(422, 'DESTINATION_CREATE_UNSUPPORTED', 'Subreddit creation is unavailable. Choose an existing subreddit for this account.');
  if (context.req.method !== (task === 'manage' ? 'GET' : 'POST')) fail(405, 'METHOD_NOT_ALLOWED', 'Use the available destination management controls.');
  let accountId; try { accountId = decodeURIComponent(match[1]); } catch { fail(400, 'INVALID_ACCOUNT', 'Choose a valid connected publishing account.'); }
  if (!token(accountId) || [...context.url.searchParams].length) fail(400, 'INVALID_DESTINATION_FIELDS', 'Choose an account without additional provider filters.');
  if (task === 'manage') { const result = await managementSnapshot(context, api, profileId, accountId, resource); context.send(200, result); return true; }
  if (!['owner', 'admin'].includes(context.role)) fail(403, 'DESTINATION_ADMIN_REQUIRED', 'A workspace owner or administrator must create destinations or change shared account defaults.');
  const body = context.body || {}; fields(body, ['expectedVersion', 'confirmed', ...(task === 'create' ? ['settings'] : ['destinationId'])]);
  if (body.confirmed !== true) fail(400, 'DESTINATION_REVIEW_REQUIRED', 'Review the selected account and exact destination settings first.');
  // ponytail: serialize all destination writes per provider across projects; verified native IDs plus alias fencing can separate channels if throughput requires it.
  const connected = await publishingAccount(api, profileId, accountId, platform), lock = platform;
  const outcome = await destinationMutation(context, lock, async (key: string) => {
  const before = await managementSnapshot(context, api, profileId, accountId, resource);
  if (before.nativeAccountId !== (connected.platformUserId ?? null) || before.accountVersion !== digest([profileId, publishingToolsIdentity(connected, platform).identity])) fail(409, 'DESTINATION_ACCOUNT_CHANGED', 'The connected channel changed. Reload its destinations before continuing.');
  if (body.expectedVersion !== before.version) fail(409, 'DESTINATION_REVIEW_CHANGED', 'The destination list or saved default changed. Reload and review it again.');
  let payload: any, chosen: any;
  if (task === 'create') {
    fields(body.settings, [platform === 'youtube' ? 'title' : 'name', 'description', 'privacy']);
    const title = platform === 'youtube' ? 'title' : 'name', privacy = body.settings.privacy;
    if (!(platform === 'youtube' ? ['private', 'unlisted', 'public'] : ['PUBLIC', 'PROTECTED', 'SECRET']).includes(privacy)) fail(400, 'INVALID_DESTINATION_PRIVACY', 'Choose an explicit destination privacy setting.');
    payload = { [title]: label(body.settings[title], platform === 'youtube' ? 150 : 180), description: label(body.settings.description ?? '', 5000, true), privacy };
  } else {
    if (!token(body.destinationId)) fail(400, 'INVALID_DESTINATION_ID', 'Choose an existing board, playlist or subreddit. Clearing YouTube and Reddit defaults is not supported.');
    chosen = before[field].find((row: any) => row.id === body.destinationId); if (!chosen) fail(403, 'DESTINATION_OUTSIDE_ACCOUNT', 'Choose a destination from this account’s verified list.');
    payload = platform === 'youtube' ? { defaultPlaylistId: chosen.id, defaultPlaylistName: chosen.title } : platform === 'reddit' ? { defaultSubreddit: chosen.name } : { defaultBoardId: chosen.id, defaultBoardName: chosen.name };
  }
    const current = await managementSnapshot(context, api, profileId, accountId, resource);
    if (current.version !== before.version) fail(409, 'DESTINATION_REVIEW_CHANGED', 'The account or destination settings changed while preparing this action. Reload and review them again.');
    const account = await publishingAccount(api, profileId, accountId, platform); if ((account.platformUserId ?? null) !== before.nativeAccountId || before.accountVersion !== digest([profileId, publishingToolsIdentity(account, platform).identity])) fail(409, 'DESTINATION_ACCOUNT_CHANGED', 'The connected channel changed. Reload its destinations before continuing.');
    await publishingToolsAccess(context, profileId);
    const response = await api(`/accounts/${encodeURIComponent(accountId)}/${resource}`, {}, payload, key, task === 'create' ? 'POST' : 'PUT');
    try {
      lookupScope(response, accountId, profileId, platform);
      const after = await managementSnapshot(context, api, profileId, accountId, resource); if (after.nativeAccountId !== before.nativeAccountId || after.accountVersion !== before.accountVersion) invalid(true);
      if (task === 'create') {
        if (platform === 'youtube' && (after.defaultReported !== before.defaultReported || after.defaultPlaylistId !== before.defaultPlaylistId)) invalid(true);
        const raw = response[platform === 'youtube' ? 'playlist' : 'board'];
        if (!object(raw) || !token(raw.id) || before[field].some((row: any) => row.id === raw.id)) invalid(true);
        const ack = projectLookup({ [field]: [raw] }, accountId, profileId, resource, undefined, true)[field][0], found = after[field].find((row: any) => row.id === raw.id);
        if (!found || Object.entries(payload).some(([name, value]) => ack[name] !== value || found[name] !== value) || platform === 'youtube' && (ack.itemCount !== 0 || found.itemCount !== 0)) invalid(true);
        return { destination: found, snapshot: after, created: true };
      }
      if (platform === 'youtube') { if (response.success !== true || !after.defaultReported || after.defaultPlaylistId !== chosen.id) invalid(true); return { defaultId: chosen.id, accepted: true, readback: true, snapshot: after }; }
      if (platform === 'reddit') { if (response.success !== true || !after.defaultReported || after.defaultSubreddit !== chosen.name || !after[field].some((row: any) => row.id === chosen.id && row.name === chosen.name)) invalid(true); return { defaultId: chosen.id, accepted: true, readback: true, snapshot: after }; }
      const saved = response.account;
      if (!object(saved) || saved._id !== accountId || saved.platform !== platform || saved.profileId !== undefined && String(saved.profileId?._id || saved.profileId) !== profileId || saved.isActive !== true || saved.platformUserId !== undefined && saved.platformUserId !== before.nativeAccountId || !after[field].some((row: any) => row.id === chosen.id && row.name === chosen.name)) invalid(true);
      return { defaultId: chosen.id, accepted: true, readback: false, snapshot: after };
    } catch (error: any) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
  }); context.send(outcome.status, outcome.data); return true;
}
