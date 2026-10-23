import test from 'node:test';
import assert from 'node:assert/strict';
import { PLATFORM_RULES, normalizeMediaItems, normalizePostVariants, normalizePostTags, normalizeAccountVariants, assertAccountSchedules, normalizePlatformOptions, resolveVariant, buildPlatformEntry, validatePostForPlatforms, assetDeliveryIssue, providerPostMediaUrls, countCaption, captionLimitForVariant } from '../shared/social-posts.ts';

const image = (extra = {}) => ({ type: 'image', url: 'https://cdn.example.com/creative.jpg', width: 1080, height: 1080, size: 100000, mimeType: 'image/jpeg', ...extra });
const video = (extra = {}) => ({ type: 'video', url: 'https://cdn.example.com/video.mp4', width: 1080, height: 1920, duration: 30, size: 1000000, mimeType: 'video/mp4', ...extra });
const valid = (post, platforms) => validatePostForPlatforms(post, platforms).valid;

test('hosted delivery uses observed file metadata and expires at its own deadline without borrowing Drive metadata', () => {
  const uploaded = Date.parse('2026-10-19T00:00:00Z'), expiry = uploaded + 7 * 86400000;
  const asset = { id: 'hosted', url: 'https://drive.google.com/file/d/original/view', kind: 'video', mimeType: 'video/mp4', filename: 'original.mp4', size: 900000, width: 1920, height: 1080, duration: 90, description: 'Original description', deliveryUrl: 'https://media.zernio.com/temp/hosted.gif', deliverySource: 'zernio', deliveryUploadedAt: new Date(uploaded).toISOString(), deliveryExpiresAt: new Date(expiry).toISOString(), deliveryKind: 'image', deliveryMimeType: 'image/gif', deliverySize: 2000, deliveryFilename: 'replacement.gif' };
  const media = resolveVariant({ assetId: asset.id }, 'facebook', [asset]).mediaItems;
  assert.deepEqual(media, [{ type: 'gif', url: asset.deliveryUrl, mimeType: 'image/gif', filename: 'replacement.gif', size: 2000, altText: asset.description }]);
  assert.equal(assetDeliveryIssue(asset, expiry - 1), ''); assert.match(assetDeliveryIssue(asset, expiry), /expired/); assert.match(assetDeliveryIssue({ ...asset, deliveryExpiresAt: '' }, uploaded), /no verified expiry/);
  assert.equal(assetDeliveryIssue({ ...asset, deliverySource: 'manual' }, expiry), '');
  const post = { content: 'Campaign', assetId: asset.id, scheduledAt: '2027-01-01T00:00:00Z' };
  assert.equal(validatePostForPlatforms(post, ['facebook'], { assets: [asset], now: expiry - 1 }).valid, true, 'Provider scheduling copies the file at submission, before its future posting time.');
  assert.equal(validatePostForPlatforms(post, ['facebook'], { assets: [asset], now: expiry }).valid, false);
  assert.equal(validatePostForPlatforms({ ...post, accountOverrides: { page: { platform: 'facebook', mediaItems: [] } } }, ['facebook'], { assets: [asset], accountId: 'page', now: expiry }).valid, true, 'An unused shared delivery file must not block an overridden account copy.');
  assert.equal(validatePostForPlatforms({ content: 'Copied provider media', mediaItems: [{ type: 'image', url: 'https://media.zernio.com/permanent/copy.gif' }] }, ['facebook'], { assets: [asset], now: expiry }).valid, true);
  assert.equal(validatePostForPlatforms({ content: 'Same expired URL', mediaItems: media }, ['facebook'], { assets: [asset], now: expiry }).valid, false);
  const native = { status: 'scheduled', mediaItems: media, platforms: [{ platform: 'facebook', accountId: 'page' }] }, retained = providerPostMediaUrls(native);
  assert.equal(validatePostForPlatforms(post, ['facebook'], { assets: [asset], now: expiry, providerOwnedMediaUrls: retained }).valid, true, 'Verified provider-owned copies survive the library URL deadline.');
  for (const unretained of [{ ...native, status: 'draft' }, { ...native, isDraft: true }, { ...native, status: 'unknown' }, { ...native, platforms: [{ platform: 'facebook', customMedia: [] }] }]) assert.equal(providerPostMediaUrls(unretained).size, 0);
  assert.deepEqual([...providerPostMediaUrls({ ...native, providerResults: native.platforms, platforms: ['facebook'] })], [asset.deliveryUrl], 'Normalized status readback supports the same display hint.');
  assert.equal(providerPostMediaUrls({ ...native, platforms: [{ platform: 'facebook', customMedia: [] }], providerResults: [{ customMedia: media }] }).size, 0, 'Validated raw destinations take priority over an unrelated extra response field.');
  assert.equal(validatePostForPlatforms(post, ['facebook'], { assets: [{ ...asset, deliveryUrl: 'https://media.zernio.com/temp/new-expired.gif' }], now: expiry, providerOwnedMediaUrls: retained }).valid, false, 'Unchanged native media must never exempt a different expired URL.');
  const threadAsset = { ...asset, deliveryUrl: 'https://media.zernio.com/temp/thread.png', deliveryMimeType: 'image/png' }, threadMedia = [{ type: 'image', url: threadAsset.deliveryUrl, mimeType: 'image/png', size: 2000 }];
  for (const platform of ['twitter', 'threads', 'bluesky']) {
    const thread = { content: 'Thread', platformOverrides: { [platform]: { options: { threadItems: [{ content: 'Attached copy', mediaItems: threadMedia }] } } } };
    assert.equal(validatePostForPlatforms(thread, [platform], { assets: [threadAsset], now: expiry - 1 }).valid, true);
    assert.ok(validatePostForPlatforms(thread, [platform], { assets: [threadAsset], now: expiry }).errors.some(row => /expired/.test(row.message)), 'Thread attachments use the same expiry deadline: ' + platform);
    const retainedThread = providerPostMediaUrls({ status: 'scheduled', platforms: [{ platform, platformSpecificData: { threadItems: [{ mediaItems: threadMedia }] } }] });
    assert.equal(validatePostForPlatforms(thread, [platform], { assets: [threadAsset], now: expiry, providerOwnedMediaUrls: retainedThread }).valid, true);
  }
});

test('same-platform accounts independently inherit or replace caption, media, options and zoned times', () => {
  const assets = [{ id: 'account-asset', kind: 'image', deliveryUrl: 'https://cdn.example.test/account.jpg' }];
  const post = { content: 'Shared', mediaItems: [image()], scheduledAt: '2070-01-01T09:00:00Z', platformOverrides: { facebook: { content: 'Facebook default', mediaItems: [video()], options: { firstComment: 'Default comment' } } }, accountOverrides: {
    first: { platform: 'facebook', content: '', assetId: 'account-asset', options: {}, scheduledAt: '2070-01-02T11:00:00+04:00' },
    second: { platform: 'facebook', content: 'Second account', mediaItems: [], scheduledAt: '' },
  } };
  assert.deepEqual(normalizeAccountVariants(post), post.accountOverrides);
  assert.deepEqual(buildPlatformEntry(post, 'facebook', 'first', assets), { platform: 'facebook', accountId: 'first', customContent: '', customMedia: [{ type: 'image', url: 'https://cdn.example.test/account.jpg' }], platformSpecificData: {}, scheduledFor: '2070-01-02T11:00:00+04:00' });
  assert.deepEqual(buildPlatformEntry(post, 'facebook', 'second', assets), { platform: 'facebook', accountId: 'second', customContent: 'Second account', customMedia: [], platformSpecificData: { firstComment: 'Default comment' } });
  assert.equal(resolveVariant(post, 'facebook', assets).content, 'Facebook default', 'Account changes do not mutate platform defaults.');
  assert.equal(resolveVariant(post, 'facebook', assets, 'first').mediaItems[0].type, 'image', 'An account asset replaces inherited platform media.');
  assert.equal(validatePostForPlatforms(post, ['facebook'], { assets, accountId: 'first' }).valid, true);
  assert.doesNotThrow(() => assertAccountSchedules(post));
  for (const changed of [{ queueId: 'queue' }, { scheduledAt: '' }, { scheduledAt: '2020-01-01T09:00:00Z' }]) assert.throws(() => assertAccountSchedules({ ...post, ...changed }), /future fixed post schedule/);
  assert.throws(() => assertAccountSchedules(post, { publishNow: true }), /Publish now/);
  assert.throws(() => assertAccountSchedules({ ...post, accountOverrides: { first: { platform: 'facebook', scheduledAt: '2020-01-01T09:00:00Z' } } }), /must be in the future/);
});

test('account trust boundary rejects foreign platform shapes and invalid dates without weakening account restriction checks', () => {
  for (const scheduledAt of ['2070-01-01T10:00', 'January 1 2070', '2070-02-31T10:00:00Z']) assert.throws(() => normalizeAccountVariants({ accountOverrides: { first: { platform: 'facebook', scheduledAt } } }), /valid date and time/);
  for (const variant of [{ content: 'Missing platform' }, { platform: 'facebook', caption: 'Unknown' }, { platform: 'facebook', options: { unsupported: true } }]) assert.throws(() => normalizeAccountVariants({ accountOverrides: { first: variant } }));
  assert.throws(() => normalizeAccountVariants({ accountOverrides: JSON.parse('{"__proto__":{"platform":"facebook"}}') }), /account ID/);
  assert.throws(() => buildPlatformEntry({ accountOverrides: { first: { platform: 'twitter', content: 'Mismatch' } } }, 'facebook', 'first'), /does not match/);
  const post = { content: 'A'.repeat(501), accountOverrides: { first: { platform: 'threads', content: 'Valid first copy' }, second: { platform: 'threads', content: 'A'.repeat(501) } } };
  assert.equal(validatePostForPlatforms(post, ['threads'], { accountId: 'first' }).valid, true);
  assert.equal(validatePostForPlatforms(post, ['threads'], { accountId: 'second' }).valid, false);
});

test('Snapchat remains readable as a draft but cannot pass publishing checks while provider access is unavailable', () => {
  const post = { content: 'Saved Snapchat draft', mediaItems: [image()], platformOverrides: { snapchat: { options: { contentType: 'story' } } } };
  assert.equal(PLATFORM_RULES.snapchat.supported, false);
  assert.match(PLATFORM_RULES.snapchat.notice, /not available|unavailable/i);
  assert.doesNotThrow(() => normalizePostVariants(post));
  assert.equal(resolveVariant(post, 'snapchat').content, post.content);
  const checks = validatePostForPlatforms(post, ['snapchat']);
  assert.equal(checks.valid, false);
  assert.ok(checks.errors.some(error => error.platform === 'snapchat' && error.field === 'platform' && /not available|unavailable/i.test(error.message)));
});

test('post variants preserve inheritance, explicit empty values, DAM changes and exact provider wire fields', () => {
  const assets = [{ id: 'base', kind: 'image', deliveryUrl: 'https://cdn.example.com/base.jpg', size: '0' }, { id: 'reel', kind: 'video', deliveryUrl: 'https://cdn.example.com/reel.mp4', size: '123', duration: 30 }];
  const post = { content: 'Shared caption', assetId: 'base', mediaItems: null, platformOverrides: { twitter: { content: '', mediaItems: [] }, instagram: { content: 'Reel caption', assetId: 'reel', options: { shareToFeed: false } } } };
  assert.deepEqual(resolveVariant(post, 'twitter', assets), { platform: 'twitter', content: '', mediaItems: [], options: {} });
  assert.equal(resolveVariant(post, 'facebook', assets).mediaItems[0].url, 'https://cdn.example.com/base.jpg');
  assert.equal(resolveVariant(post, 'facebook', assets).mediaItems[0].size, undefined, 'Unknown zero-byte Drive metadata must not invalidate a creative');
  assert.deepEqual(buildPlatformEntry(post, 'instagram', 'account', assets), { platform: 'instagram', accountId: 'account', customContent: 'Reel caption', customMedia: [{ type: 'video', url: 'https://cdn.example.com/reel.mp4', size: 123 }], platformSpecificData: { shareToFeed: false } });
  assert.deepEqual(buildPlatformEntry(post, 'facebook', 'account', assets), { platform: 'facebook', accountId: 'account' });
  assert.deepEqual(buildPlatformEntry(post, 'twitter', 'account', assets), { platform: 'twitter', accountId: 'account', customContent: '', customMedia: [] });
  assert.equal(resolveVariant({ ...post, mediaItems: [] }, 'facebook', assets).mediaItems.length, 0);
  assert.equal(resolveVariant({ ...post, platformOverrides: { facebook: { assetId: '' } } }, 'facebook', assets).mediaItems.length, 0);
  assert.equal(resolveVariant({ ...post, platformOverrides: { facebook: { assetId: 'reel', mediaItems: [] } } }, 'facebook', assets).mediaItems.length, 0);
});

test('draft schema rejects malformed fields and unsafe URLs, keeps incomplete drafts and normalizes supplied metadata', () => {
  assert.deepEqual(normalizePostVariants({ platformOverrides: { youtube: { content: '', options: {} }, discord: { options: {} } } }), { youtube: { content: '', options: {} }, discord: { options: {} } });
  assert.throws(() => normalizePostVariants({ platformOverrides: { x: { content: 'Wrong provider key' } } }), /Unsupported/);
  assert.throws(() => normalizePostVariants({ platformOverrides: { twitter: { caption: 'Typo' } } }), /unsupported field/);
  assert.throws(() => normalizePostVariants({ platformOverrides: { twitter: { mediaItems: null } } }), /array/);
  assert.throws(() => normalizePostVariants({ platformOverrides: { youtube: { options: { madeforKids: true } } } }), /not a supported option/);
  assert.throws(() => normalizePostVariants({ platformOverrides: { youtube: { options: { madeForKids: 'false' } } } }), /true or false/);
  assert.throws(() => normalizePostVariants({ platformOverrides: { youtube: { options: { visibility: 'friends' } } } }), /unsupported value/);
  assert.throws(() => normalizePostVariants({ platformOverrides: { facebook: { options: { facebookSettings: { carousel: [] } } } } }), /not a supported option/);
  for (const url of ['http://cdn.example.com/a.jpg', 'https://localhost/a.jpg', 'https://127.1/a.jpg', 'https://10.0.0.1/a.jpg', 'https://172.31.0.1/a.jpg', 'https://192.168.0.1/a.jpg', 'https://[::1]/a.jpg', 'https://drive.google.com/file/d/id/view', 'https://docs.google.com/a', 'https://user:pass@example.com/a.jpg']) assert.throws(() => normalizeMediaItems([image({ url })]), /HTTPS|Private/);
  for (const field of ['width', 'height', 'duration', 'size']) for (const value of [NaN, Infinity, -1, 0, '100']) assert.throws(() => normalizeMediaItems([video({ [field]: value })]), /finite positive/);
  assert.equal(normalizeMediaItems([image({ bytes: 200, size: undefined })])[0].size, 200);
  assert.throws(() => normalizeMediaItems([image({ subtitles: [{ url: 'https://cdn.example.com/en.vtt', language: 'en' }, { url: 'https://cdn.example.com/en2.vtt', language: 'EN' }] })]), /unique/);
  const normalized = normalizePostVariants({ platformOverrides: { threads: { options: { threadItems: [{ content: 'Root', mediaItems: [image()] }] } } } });
  assert.equal(normalized.threads.options.threadItems[0].mediaItems[0].width, 1080);
  assert.equal(buildPlatformEntry({ platformOverrides: normalized }, 'threads', 'account').platformSpecificData.threadItems[0].mediaItems[0].width, undefined);
});

test('every supported platform exposes its complete typed options and has a valid minimal post', () => {
  const options = { instagram: { shareToFeed: false }, facebook: { firstComment: 'First' }, linkedin: { disableLinkPreview: true }, tiktok: { privacyLevel: 'PUBLIC_TO_EVERYONE', allowComment: false, allowDuet: false, allowStitch: false, contentPreviewConfirmed: true, expressConsentGiven: true }, twitter: { replySettings: 'following' }, youtube: { title: 'Launch', visibility: 'unlisted', madeForKids: false }, pinterest: { title: 'Launch', boardId: 'board' }, threads: { topic_tag: 'Campaign' }, bluesky: { langs: ['en-US'] }, reddit: { subreddit: 'example', title: 'Launch', nsfw: false }, googlebusiness: { topicType: 'STANDARD' }, telegram: { parseMode: 'HTML' }, discord: { channelId: '123456789012345678' }, slack: { unfurlMedia: false }, snapchat: { contentType: 'story' } };
  for (const [platform, rule] of Object.entries(PLATFORM_RULES)) {
    if (!rule.supported) continue;
    assert.ok(rule.options.length, `${platform} needs option controls`);
    const mediaItems = ['youtube', 'tiktok'].includes(platform) ? [video()] : ['instagram', 'pinterest', 'snapchat'].includes(platform) ? [image()] : [];
    const result = validatePostForPlatforms({ content: 'Launch', mediaItems, platformOverrides: { [platform]: { options: options[platform] } } }, [platform]);
    assert.equal(result.valid, true, `${platform}: ${JSON.stringify(result.errors)}`);
    assert.equal(result.variants[platform].options, options[platform]);
  }
  assert.equal(valid({ content: 'Hello' }, ['whatsapp']), false);
  assert.equal(valid({ content: 'Hello' }, ['instagram']), false);
  assert.equal(valid({ content: 'Hello' }, ['youtube']), false);
  assert.equal(valid({ content: 'Hello' }, ['tiktok']), false);
  assert.equal(valid({ content: 'Hello' }, ['discord']), false, 'Discord channel selection is mandatory');
  assert.equal(valid({ content: 'Hello' }, []), false);
});

test('restriction checks apply to each resolved caption, media set and platform option combination', () => {
  const long = 'A'.repeat(501), shared = { content: long, mediaItems: [image()], platformOverrides: { threads: { content: 'Short Threads copy' }, twitter: { content: 'Short X copy', mediaItems: [] } } };
  assert.equal(valid(shared, ['threads', 'twitter', 'instagram']), true);
  assert.equal(valid({ ...shared, platformOverrides: {} }, ['threads']), false);
  assert.equal(valid({ content: 'A'.repeat(1025), mediaItems: [image()] }, ['telegram']), false);
  assert.equal(valid({ content: 'A'.repeat(4096) }, ['telegram']), true);
  assert.equal(captionLimitForVariant(resolveVariant({ content: '', mediaItems: [image()] }, 'telegram')), 1024);
  assert.equal(captionLimitForVariant(resolveVariant({ content: '', mediaItems: [image()] }, 'tiktok')), 4000);
  assert.equal(valid({ content: 'Images', mediaItems: Array.from({ length: 5 }, () => image()) }, ['twitter']), false);
  assert.equal(valid({ content: 'Mixed', mediaItems: [image(), video()] }, ['facebook']), false);
  assert.equal(valid({ content: 'Mixed carousel', mediaItems: [image(), video()] }, ['instagram']), true);
  assert.equal(valid({ content: 'Reel', mediaItems: [image()], platformOverrides: { facebook: { options: { contentType: 'reel' } } } }, ['facebook']), false);
  assert.equal(valid({ content: 'Reel', mediaItems: [video({ width: 1920, height: 1080 })], platformOverrides: { facebook: { options: { contentType: 'reel' } } } }, ['facebook']), false);
  assert.equal(valid({ content: 'Bad ratio', mediaItems: [image({ width: 3000, height: 1000 })] }, ['instagram']), false);
  assert.equal(valid({ content: 'Too long', mediaItems: [video({ duration: 301 })] }, ['threads']), false);
  assert.equal(valid({ content: 'Large document', mediaItems: [{ type: 'document', url: 'https://cdn.example.com/a.pdf', size: 101 * 1024 * 1024 }] }, ['linkedin']), false);
  assert.equal(valid({ content: 'Incompatible type', mediaItems: [image({ mimeType: 'video/mp4' })] }, ['instagram']), false);
  assert.equal(valid({ content: 'Unsupported format', mediaItems: [image({ mimeType: 'image/webp' })] }, ['threads']), false);
  assert.equal(valid({ content: 'Required event', platformOverrides: { googlebusiness: { options: { topicType: 'EVENT' } } } }, ['googlebusiness']), false);
  assert.equal(valid({ content: 'Invalid topic', platformOverrides: { threads: { options: { topic_tag: 'Bad.Topic' } } } }, ['threads']), false);
  assert.equal(valid({ content: 'Poll', mediaItems: [image()], platformOverrides: { linkedin: { options: { poll: { question: 'Which?', options: ['A', 'B'] } } } } }, ['linkedin']), false);
  assert.equal(valid({ content: 'Bad quote', mediaItems: [image()], platformOverrides: { twitter: { options: { quoteTweetId: '123' } } } }, ['twitter']), false);
  assert.equal(valid({ content: 'Background', mediaItems: [image()], platformOverrides: { facebook: { options: { facebookSettings: { textFormatPresetId: '123' } } } } }, ['facebook']), false);
  assert.equal(valid({ content: 'Tags', mediaItems: [image()], platformOverrides: { instagram: { options: { userTags: [{ username: 'friend' }] } } } }, ['instagram']), false);
  assert.equal(valid({ content: 'Photos', mediaItems: [image()], platformOverrides: { tiktok: { options: { draft: true, photoCoverIndex: 1 } } } }, ['tiktok']), false);
});

test('nested options, threads, weighted counters and unknown metadata remain honest', () => {
  assert.equal(countCaption('Hello https://example.com/very-long-path', 'twitter'), 6 + 23);
  assert.equal(countCaption('😀👨‍👩‍👧‍👦中', 'twitter'), 6);
  assert.equal(countCaption('👨‍👩‍👧‍👦', 'bluesky'), 1);
  const premium = validatePostForPlatforms({ content: 'A'.repeat(281) }, ['twitter']);
  assert.equal(premium.valid, true);
  assert.ok(premium.warnings.some(item => item.message.includes('paid X account')));
  assert.equal(valid({ content: 'A'.repeat(25001) }, ['twitter']), false);
  assert.equal(valid({ content: 'A'.repeat(281), platformOverrides: { twitter: { options: { poll: { options: ['A', 'B'], duration_minutes: 5 } } } } }, ['twitter']), false);
  assert.equal(valid({ content: 'Display only'.repeat(100), platformOverrides: { threads: { options: { threadItems: [{ content: 'First' }, { content: 'Second' }] } } } }, ['threads']), true);
  assert.equal(valid({ content: 'Display only', platformOverrides: { threads: { options: { threadItems: [{ content: 'A'.repeat(501) }] } } } }, ['threads']), false);
  assert.equal(valid({ content: 'Empty thread', platformOverrides: { bluesky: { options: { threadItems: [] } } } }, ['bluesky']), false);
  assert.throws(() => normalizePlatformOptions('twitter', { poll: { options: ['Only one'], duration_minutes: 5 } }, { required: true }), /2–4/);
  assert.throws(() => normalizePlatformOptions('instagram', { audioConfiguration: { audioId: 'track', audioVolume: 101 } }), /invalid number/);
  assert.throws(() => normalizePlatformOptions('googlebusiness', { callToAction: { type: 'LEARN_MORE' } }, { required: true }), /url is required/);
  const unknown = validatePostForPlatforms({ content: 'Unknown file metadata', mediaItems: [{ type: 'image', url: image().url }] }, ['instagram']);
  assert.equal(unknown.valid, true);
  assert.ok(unknown.warnings.some(issue => issue.message.includes('unknown')));
  assert.equal(validatePostForPlatforms({ content: 'Unknown file metadata', mediaItems: [{ type: 'image', url: image().url }] }, ['instagram'], { requireMediaMetadata: true }).valid, false);
  const event = { title: 'Launch', schedule: { startDate: { year: 2026, month: 10, day: 18 }, endDate: { year: 2026, month: 10, day: 19 } } };
  assert.equal(valid({ content: 'Grand opening', platformOverrides: { googlebusiness: { options: { topicType: 'EVENT', event } } } }, ['googlebusiness']), true);
});


test('YouTube keywords normalize shared tags without silent truncation and enforce the provider limits', () => {
  assert.deepEqual(normalizePostTags([' #launch, product ', 'launch', '', 'two words']), ['launch', 'product', 'two words']);
  assert.deepEqual(normalizePostTags(), []);
  const providerTags = [' #launch, product ', 'launch', '', 'two words'];
  assert.deepEqual(normalizePostTags(providerTags, { preserve: true }), providerTags, 'Provider keyword evidence must retain each exact string.');
  assert.throws(() => normalizePostTags(['x'.repeat(100) + ',y'], { preserve: true }), /YouTube keyword/);
  assert.deepEqual(normalizePostTags(['x'.repeat(100), 'y'.repeat(100), 'z'.repeat(100), 'a'.repeat(100), 'b'.repeat(100)]).map(tag => tag.length), [100, 100, 100, 100, 100]);
  for (const value of [null, 'launch', [123], ['x'.repeat(101)], ['bad\u0000tag'], [...Array.from({ length: 5 }, (_, index) => String(index).repeat(100)), 'extra']]) assert.throws(() => normalizePostTags(value), /YouTube keyword/);
  const post = { content: 'Video description', mediaItems: [video()], tags: ['x'.repeat(101)] };
  assert.ok(validatePostForPlatforms(post, ['youtube']).errors.some(issue => issue.field === 'tags'));
  assert.equal(Object.hasOwn(buildPlatformEntry({ ...post, tags: ['launch'] }, 'youtube', 'channel'), 'tags'), false, 'Tags belong to the request root rather than the account target.');
  assert.throws(() => normalizePostVariants({ platformOverrides: { youtube: { options: { tags: ['launch'] } } } }), /not a supported option/);
});

test('generated platform option labels are sentence case and keep acronyms upper case', () => {
  const labelOf = (platform, key) => PLATFORM_RULES[platform].options.find(option => option.key === key)?.label;
  assert.equal(labelOf('instagram', 'muteAudio'), 'Mute audio'); assert.equal(labelOf('instagram', 'commentsEnabled'), 'Comments enabled'); assert.equal(labelOf('instagram', 'firstComment'), 'First comment');
  assert.equal(labelOf('instagram', 'locationId'), 'Location ID'); assert.equal(labelOf('linkedin', 'reshareUrl'), 'Reshare URL'); assert.equal(labelOf('twitter', 'madeWithAi'), 'Made with AI'); assert.equal(labelOf('tiktok', 'isAdsOnly'), 'Only show in ads');
  for (const [platform, rule] of Object.entries(PLATFORM_RULES)) for (const option of rule.options) {
    const words = option.label.split(' ').slice(1).filter(word => /^[A-Z][a-z]/.test(word) && !/^(Reel|Instagram|Facebook|TikTok|LinkedIn|Pinterest|Discord|BCP)$/.test(word));
    assert.deepEqual(words, [], `${platform}.${option.key} label "${option.label}" is sentence case`);
  }
});
