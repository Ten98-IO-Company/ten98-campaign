// Publishing contract: Zernio OpenAPI 1.291.0 and platform guides, checked 2026-10-18.
// Keep this module browser-safe: no provider requests or media URL downloads here.
export interface MediaItem { type: 'image' | 'video' | 'gif' | 'document'; url: string; width?: number; height?: number; duration?: number; size?: number; bytes?: number; mimeType?: string; altText?: string; title?: string; filename?: string; thumbnail?: string; instagramThumbnail?: string; subtitles?: { url: string; language: string }[] }
export interface PlatformVariant { content?: string; mediaItems?: MediaItem[]; assetId?: string; options?: Record<string, any> }
export interface AccountVariant extends PlatformVariant { platform: string; scheduledAt?: string }
export interface SocialPost { content?: string; mediaItems?: MediaItem[] | null; assetId?: string; platformOverrides?: Record<string, PlatformVariant>; accountOverrides?: Record<string, AccountVariant>; [key: string]: any }
export interface ResolvedVariant { platform: string; content: string; mediaItems: MediaItem[]; options: Record<string, any>; assetId?: string; scheduledAt?: string }
export interface PlatformOption { key: string; label: string; type: 'text' | 'textarea' | 'boolean' | 'number' | 'select' | 'string-list' | 'json'; values?: (string | number)[]; maxLength?: number; min?: number; max?: number; help?: string; schema: Record<string, any> }
export interface PlatformRule { label: string; captionLimit: number; mediaTypes: string[]; minMedia: number; maxMedia: number; supported: boolean; notice?: string; options: PlatformOption[] }
export interface RestrictionIssue { platform: string; field: string; message: string }
interface JsonSchema { type?: string; properties?: Record<string, JsonSchema>; items?: JsonSchema; oneOf?: JsonSchema[]; required?: string[]; enum?: (string | number)[]; const?: unknown; minItems?: number; maxItems?: number; minLength?: number; maxLength?: number; minimum?: number; maximum?: number; pattern?: string; format?: string; description?: string }
const OPTION_SCHEMAS: Record<string, JsonSchema> = {"twitter":{"type":"object","properties":{"article":{"type":"object","required":["title","content_state"],"properties":{"title":{"type":"string","minLength":1},"content_state":{"type":"object","required":["blocks","entities"],"properties":{"blocks":{"type":"array","minItems":1,"items":{"type":"object","required":["type","text"],"properties":{"type":{"type":"string","enum":["unstyled","header-one","header-two","header-three","unordered-list-item","ordered-list-item","blockquote","atomic"]},"text":{"type":"string"},"key":{"type":"string","minLength":1},"data":{"type":"object","properties":{"cashtags":{"type":"array","items":{"type":"object","required":["from_index","to_index","text"],"properties":{"from_index":{"type":"integer","minimum":0},"to_index":{"type":"integer","minimum":0},"text":{"type":"string"}}}},"hashtags":{"type":"array","items":{"type":"object","required":["from_index","to_index","text"],"properties":{"from_index":{"type":"integer","minimum":0},"to_index":{"type":"integer","minimum":0},"text":{"type":"string"}}}},"mentions":{"type":"array","items":{"type":"object","required":["from_index","to_index","text"],"properties":{"from_index":{"type":"integer","minimum":0},"to_index":{"type":"integer","minimum":0},"text":{"type":"string"}}}},"urls":{"type":"array","items":{"type":"object","required":["from_index","to_index","text"],"properties":{"from_index":{"type":"integer","minimum":0},"to_index":{"type":"integer","minimum":0},"text":{"type":"string"}}}}}},"inline_style_ranges":{"type":"array","items":{"type":"object","required":["offset","length","style"],"properties":{"offset":{"type":"integer","minimum":0},"length":{"type":"integer","minimum":0},"style":{"type":"string","enum":["bold","italic","strikethrough"]}}}},"entity_ranges":{"type":"array","items":{"type":"object","required":["key","offset","length"],"properties":{"key":{"type":"integer","minimum":0},"offset":{"type":"integer","minimum":0},"length":{"type":"integer","minimum":0}}}}}}},"entities":{"type":"array","items":{"oneOf":[{"type":"object","required":["key","value"],"properties":{"key":{"type":"string","minLength":1},"value":{"type":"object","required":["type","mutability","data"],"properties":{"type":{"type":"string","const":"post"},"mutability":{"type":"string","enum":["immutable","mutable","segmented"]},"data":{"type":"object","required":["post_id"],"properties":{"post_id":{"type":"string","minLength":1}}}}}}},{"type":"object","required":["key","value"],"properties":{"key":{"type":"string","minLength":1},"value":{"type":"object","required":["type","mutability","data"],"properties":{"type":{"type":"string","const":"link"},"mutability":{"type":"string","enum":["immutable","mutable","segmented"]},"data":{"type":"object","required":["url"],"properties":{"url":{"type":"string","format":"uri"}}}}}}},{"type":"object","required":["key","value"],"properties":{"key":{"type":"string","minLength":1},"value":{"type":"object","required":["type","mutability","data"],"properties":{"type":{"type":"string","const":"image"},"mutability":{"type":"string","enum":["immutable","mutable","segmented"]},"data":{"type":"object","required":["url"],"properties":{"url":{"type":"string","pattern":"^https?://.+\\.(?:[jJ][pP][eE]?[gG]|[pP][nN][gG]|[wW][eE][bB][pP]|[gG][iI][fF]|[mM][pP]4)(?:[?#].*)?$","format":"uri"},"caption":{"type":"string"},"altText":{"type":"string","maxLength":1000}}}}}}},{"type":"object","required":["key","value"],"properties":{"key":{"type":"string","minLength":1},"value":{"type":"object","required":["type","mutability","data"],"properties":{"type":{"type":"string","const":"emoji"},"mutability":{"type":"string","enum":["immutable","mutable","segmented"]},"data":{"type":"object","required":["entity_key"],"properties":{"entity_key":{"type":"string","minLength":1}}}}}}},{"type":"object","required":["key","value"],"properties":{"key":{"type":"string","minLength":1},"value":{"type":"object","required":["type","mutability","data"],"properties":{"type":{"type":"string","const":"markdown"},"mutability":{"type":"string","enum":["immutable","mutable","segmented"]},"data":{"type":"object","required":["markdown"],"properties":{"markdown":{"type":"string"}}}}}}},{"type":"object","required":["key","value"],"properties":{"key":{"type":"string","minLength":1},"value":{"type":"object","required":["type","mutability","data"],"properties":{"type":{"type":"string","enum":["divider","latex"]},"mutability":{"type":"string","enum":["immutable","mutable","segmented"]},"data":{"type":"object"}}}}}]}}}},"mode":{"type":"string","enum":["publish","draft"]},"cover":{"type":"object","required":["url"],"properties":{"url":{"type":"string","pattern":"^https?://.+\\.(?:[jJ][pP][eE]?[gG]|[pP][nN][gG]|[wW][eE][bB][pP])(?:[?#].*)?$","format":"uri"},"altText":{"type":"string","maxLength":1000}}}}},"replyToTweetId":{"type":"string","description":"ID of an existing tweet to reply to"},"quoteTweetId":{"type":"string","description":"ID (or full status URL) of an existing tweet to quote-repost"},"replySettings":{"type":"string","enum":["following","mentionedUsers","subscribers","verified"],"description":"Controls who can reply to the tweet"},"threadItems":{"type":"array","items":{"type":"object","properties":{"content":{"type":"string"},"mediaItems":{"type":"array","items":{"type":"object","properties":{"type":{"type":"string","enum":["image","video","gif","document"]},"url":{"type":"string","format":"uri"},"title":{"type":"string"},"altText":{"type":"string"},"filename":{"type":"string"},"size":{"type":"integer"},"mimeType":{"type":"string"},"thumbnail":{"type":"string","format":"uri"},"instagramThumbnail":{"type":"string","format":"uri"},"subtitles":{"type":"array","maxItems":20,"items":{"type":"object","required":["url","language"],"properties":{"url":{"type":"string","format":"uri"},"language":{"type":"string"}}}},"tiktokProcessed":{"type":"boolean"}}}}}},"description":"Complete sequence of tweets in a thread"},"poll":{"type":"object","required":["options","duration_minutes"],"properties":{"options":{"type":"array","minItems":2,"maxItems":4,"items":{"type":"string","minLength":1,"maxLength":25}},"duration_minutes":{"type":"integer","minimum":5,"maximum":10080}},"description":"Create a poll with this tweet"},"longVideo":{"type":"boolean","description":"Uploads the video with X's amplify_video media category instead of the standard tweet_video"},"geoRestriction":{"type":"object","required":["countries"],"properties":{"countries":{"type":"array","minItems":1,"maxItems":25,"items":{"type":"string","pattern":"^[A-Z]{2}$"}}}},"paidPartnership":{"type":"boolean","description":"When true, the post is labeled by X as a paid partnership / paid promotion"},"madeWithAi":{"type":"boolean","description":"When true, the post is labeled by X as containing AI-generated media"},"sensitiveMedia":{"type":"object","properties":{"adultContent":{"type":"boolean"},"graphicViolence":{"type":"boolean"},"other":{"type":"boolean"}},"description":"Marks attached media with a sensitive-content warning"}}},"threads":{"type":"object","properties":{"topic_tag":{"type":"string","minLength":1,"maxLength":50,"description":"Topic tag for post categorization and discoverability on Threads"},"firstComment":{"type":"string","maxLength":500,"description":"Optional first comment to post immediately after publishing, as a reply to the published post"},"threadItems":{"type":"array","items":{"type":"object","properties":{"content":{"type":"string"},"mediaItems":{"type":"array","items":{"type":"object","properties":{"type":{"type":"string","enum":["image","video","gif","document"]},"url":{"type":"string","format":"uri"},"title":{"type":"string"},"altText":{"type":"string"},"filename":{"type":"string"},"size":{"type":"integer"},"mimeType":{"type":"string"},"thumbnail":{"type":"string","format":"uri"},"instagramThumbnail":{"type":"string","format":"uri"},"subtitles":{"type":"array","maxItems":20,"items":{"type":"object","required":["url","language"],"properties":{"url":{"type":"string","format":"uri"},"language":{"type":"string"}}}},"tiktokProcessed":{"type":"boolean"}}}}}},"description":"Complete sequence of posts in a Threads thread"}}},"facebook":{"type":"object","properties":{"contentType":{"type":"string","enum":["story","reel"],"description":"Set to 'story' for Page Stories (24h ephemeral) or 'reel' for Reels (short vertical video)"},"title":{"type":"string","description":"Reel title (only for contentType=reel)"},"firstComment":{"type":"string","description":"Optional first comment to post immediately after publishing (feed posts and reels, not stories)"},"pageId":{"type":"string","description":"Target Facebook Page ID for multi-page posting"},"geoRestriction":{"type":"object","required":["countries"],"properties":{"countries":{"type":"array","minItems":1,"maxItems":25,"items":{"type":"string","pattern":"^[A-Z]{2}$"}}}},"facebookSettings":{"type":"object","properties":{"draft":{"type":"boolean"},"carouselCards":{"type":"array","minItems":2,"maxItems":10,"items":{"type":"object","required":["link"],"properties":{"link":{"type":"string","format":"uri"},"name":{"type":"string","maxLength":255},"description":{"type":"string","maxLength":255}}}},"carouselLink":{"type":"string","format":"uri"},"textFormatPresetId":{"type":"string","pattern":"^\\d+$"}}}}},"instagram":{"type":"object","properties":{"contentType":{"type":"string","enum":["story"],"description":"Set to 'story' to publish as a Story"},"shareToFeed":{"type":"boolean","description":"For Reels only"},"collaborators":{"type":"array","items":{"type":"string"},"description":"Up to 3 Instagram usernames to invite as collaborators (feed/Reels only)"},"firstComment":{"type":"string","description":"Optional first comment to add after the post is created (not applied to Stories)"},"trialParams":{"type":"object","properties":{"graduationStrategy":{"type":"string","enum":["MANUAL","SS_PERFORMANCE"]}},"description":"Trial Reels configuration"},"userTags":{"type":"array","items":{"type":"object","required":["username"],"properties":{"username":{"type":"string"},"x":{"type":"number","minimum":0,"maximum":1},"y":{"type":"number","minimum":0,"maximum":1},"mediaIndex":{"type":"integer","minimum":0}}},"description":"Tag Instagram users by username"},"audioName":{"type":"string","description":"Custom name for original audio in Reels"},"audioConfiguration":{"type":"object","required":["audioId"],"properties":{"audioId":{"type":"string"},"audioVolume":{"type":"integer","minimum":0,"maximum":100},"videoVolume":{"type":"integer","minimum":0,"maximum":100}},"description":"Attach a licensed music track or original sound from the Instagram audio catalog to a Reel"},"muteAudio":{"type":"boolean","description":"Publish the video without sound"},"thumbOffset":{"type":"integer","minimum":0,"description":"Millisecond offset from video start for the Reel cover frame"},"instagramThumbnail":{"type":"string","format":"uri","description":"Custom cover image URL for Instagram Reels (JPG or PNG, publicly accessible)"},"reelCover":{"type":"string","format":"uri","description":"Alias for instagramThumbnail"},"isAiGenerated":{"type":"boolean","description":"When true, the post is labeled by Instagram as containing AI-generated media"},"isPaidPartnership":{"type":"boolean","description":"When true, Instagram shows the \"Paid partnership\" label on the post"},"brandedContentSponsors":{"type":"array","maxItems":2,"items":{"type":"string"},"description":"Up to 2 brands to tag as sponsors, each an Instagram username (leading @ optional) or a numeric Instagram user ID"},"commentsEnabled":{"type":"boolean","description":"When false, comments are turned off on the post right after it is published (Meta exposes this as comment_enabled on the media object)"},"locationId":{"type":"string","pattern":"^[0-9]+$","description":"Tags the post with a location"}}},"linkedin":{"type":"object","properties":{"documentTitle":{"type":"string","description":"Title displayed on LinkedIn document (PDF/carousel) posts"},"organizationUrn":{"type":"string","description":"Target LinkedIn Organization URN (e.g"},"firstComment":{"type":"string","description":"Optional first comment to add after the post is created"},"disableLinkPreview":{"type":"boolean","description":"Set to true to disable automatic link previews for URLs in the post content (default is false)"},"audience":{"type":"object","properties":{"countries":{"type":"array","maxItems":25,"items":{"type":"string"}},"geoLocations":{"type":"array","items":{"type":"string"}},"interfaceLocales":{"type":"array","items":{"type":"object","required":["language","country"],"properties":{"language":{"type":"string"},"country":{"type":"string"}}}},"industries":{"type":"array","items":{"type":"string"}},"jobFunctions":{"type":"array","items":{"type":"string"}},"seniorities":{"type":"array","items":{"type":"string"}},"staffCountRanges":{"type":"array","items":{"type":"string","enum":["SIZE_1","SIZE_2_TO_10","SIZE_11_TO_50","SIZE_51_TO_200","SIZE_201_TO_500","SIZE_501_TO_1000","SIZE_1001_TO_5000","SIZE_5001_TO_10000","SIZE_10001_OR_MORE"]}},"degrees":{"type":"array","items":{"type":"string"}},"fieldsOfStudy":{"type":"array","items":{"type":"string"}},"organizations":{"type":"array","items":{"type":"string"}}},"description":"Organization pages only"},"reshareUrl":{"type":"string","description":"LinkedIn post link to repost (use the post's \"Copy link to post\" action), or a urn:li:share / urn:li:ugcPost / urn:li:groupPost URN"},"geoRestriction":{"type":"object","required":["countries"],"properties":{"countries":{"type":"array","minItems":1,"maxItems":25,"items":{"type":"string","pattern":"^[A-Z]{2}$"}}}},"poll":{"type":"object","required":["question","options"],"properties":{"question":{"type":"string","minLength":1,"maxLength":140},"options":{"type":"array","minItems":2,"maxItems":4,"items":{"type":"string","minLength":1,"maxLength":30}},"duration":{"type":"string","enum":["ONE_DAY","THREE_DAYS","SEVEN_DAYS","FOURTEEN_DAYS"]}},"description":"Create a LinkedIn poll with this post"}}},"pinterest":{"type":"object","properties":{"title":{"type":"string","maxLength":100,"description":"Pin title"},"boardId":{"type":"string","description":"Target Pinterest board ID"},"boardSectionId":{"type":"string","description":"Target section inside the board"},"link":{"type":"string","format":"uri","description":"Destination link (pin URL)"},"coverImageUrl":{"type":"string","format":"uri","description":"Optional cover image for video pins"},"coverImageKeyFrameTime":{"type":"integer","description":"Optional key frame time in seconds for derived video cover"},"isAiGenerated":{"type":"boolean","description":"When true, the Pin is created with Pinterest's AI_MODIFIED disclosure (ai_disclosures), which shows an \"AI modified\" label"}}},"youtube":{"type":"object","properties":{"title":{"type":"string","maxLength":100,"description":"Video title"},"visibility":{"type":"string","enum":["public","private","unlisted"],"description":"Video visibility: public (default, anyone can watch), unlisted (link only), private (invite only)"},"madeForKids":{"type":"boolean","description":"COPPA compliance flag"},"firstComment":{"type":"string","maxLength":10000,"description":"Optional first comment to post immediately after video upload"},"containsSyntheticMedia":{"type":"boolean","description":"AI-generated content disclosure"},"notifySubscribers":{"type":"boolean","description":"Set false to skip notifying subscribers about this upload (YouTube's notifySubscribers)"},"categoryId":{"type":"string","description":"YouTube video category ID"},"playlistId":{"type":"string","description":"Optional YouTube playlist ID to add the video to after upload (e.g"}}},"googlebusiness":{"type":"object","properties":{"locationId":{"type":"string","description":"Target Google Business Profile location ID (e.g"},"languageCode":{"type":"string","description":"BCP 47 language code (e.g"},"topicType":{"type":"string","enum":["STANDARD","EVENT","OFFER"],"description":"Post type"},"callToAction":{"type":"object","required":["type","url"],"properties":{"type":{"type":"string","enum":["LEARN_MORE","BOOK","ORDER","SHOP","SIGN_UP","CALL"]},"url":{"type":"string","format":"uri"}},"description":"Optional call-to-action button displayed on the post"},"event":{"type":"object","required":["title","schedule"],"properties":{"title":{"type":"string"},"schedule":{"type":"object","required":["startDate","endDate"],"properties":{"startDate":{"type":"object","required":["year","month","day"],"properties":{"year":{"type":"integer"},"month":{"type":"integer","minimum":1,"maximum":12},"day":{"type":"integer","minimum":1,"maximum":31}}},"startTime":{"type":"object","properties":{"hours":{"type":"integer","minimum":0,"maximum":23},"minutes":{"type":"integer","minimum":0,"maximum":59}}},"endDate":{"type":"object","required":["year","month","day"],"properties":{"year":{"type":"integer"},"month":{"type":"integer","minimum":1,"maximum":12},"day":{"type":"integer","minimum":1,"maximum":31}}},"endTime":{"type":"object","properties":{"hours":{"type":"integer","minimum":0,"maximum":23},"minutes":{"type":"integer","minimum":0,"maximum":59}}}}}},"description":"Event details"},"offer":{"type":"object","properties":{"redeemOnlineUrl":{"type":"string","format":"uri"},"termsConditions":{"type":"string"},"couponCode":{"type":"string"}},"description":"Offer details"}}},"tiktok":{"type":"object","properties":{"draft":{"type":"boolean","description":"When true, sends the post to the TikTok Creator Inbox as a draft instead of publishing immediately"},"privacyLevel":{"type":"string","description":"One of the values returned by the TikTok creator info API for the account"},"allowComment":{"type":"boolean","description":"Allow comments on the post"},"allowDuet":{"type":"boolean","description":"Allow duets (required for video posts)"},"allowStitch":{"type":"boolean","description":"Allow stitches (required for video posts)"},"commercialContentType":{"type":"string","enum":["none","brand_organic","brand_content"],"description":"Type of commercial content disclosure"},"brandPartnerPromote":{"type":"boolean","description":"Whether the post promotes a brand partner (branded content / paid partnership)"},"isBrandOrganicPost":{"type":"boolean","description":"Whether the post promotes the creator's own brand (brand organic)"},"contentPreviewConfirmed":{"type":"boolean","description":"User has confirmed they previewed the content"},"expressConsentGiven":{"type":"boolean","description":"User has given express consent for posting"},"mediaType":{"type":"string","enum":["video","photo"],"description":"Optional override"},"videoCoverTimestampMs":{"type":"integer","minimum":0,"description":"Optional for video posts"},"videoCoverImageUrl":{"type":"string","format":"uri","description":"Optional for video posts"},"photoCoverIndex":{"type":"integer","minimum":0,"description":"Optional for photo carousels"},"autoAddMusic":{"type":"boolean","description":"When true, TikTok may add recommended music (photos only)"},"musicSoundInfo":{"type":"object","required":["musicSoundId"],"properties":{"musicSoundId":{"type":"string"},"musicSoundVolume":{"type":"integer","minimum":0,"maximum":100},"musicSoundStart":{"type":"integer","minimum":0},"musicSoundEnd":{"type":"integer","minimum":0}},"description":"Commercial Music Library track to attach"},"videoOriginalSoundVolume":{"type":"integer","minimum":0,"maximum":100,"description":"Volume of the video's own sound when a commercial track is attached (0 to 100)"},"videoMadeWithAi":{"type":"boolean","description":"Set true to disclose AI-generated content"},"locationId":{"type":"string","description":"Location tag to attach, as the id of a result from GET /v1/accounts/{accountId}/tiktok/locations"},"locationName":{"type":"string","description":"Display name of the location tag, as returned next to its id"},"isAdsOnly":{"type":"boolean","description":"Set true to publish the video as an \"Only show in ads\" post: it is kept off the profile and exists to be used as a Spark Ad"},"description":{"type":"string","maxLength":4000,"description":"Optional long-form caption for photo posts (max 4000 chars)"}}},"telegram":{"type":"object","properties":{"parseMode":{"type":"string","enum":["HTML","Markdown","MarkdownV2"],"description":"Text formatting mode for the message (default is HTML)"},"disableWebPagePreview":{"type":"boolean","description":"Disable link preview generation for URLs in the message"},"disableNotification":{"type":"boolean","description":"Send the message silently (users will receive notification without sound)"},"protectContent":{"type":"boolean","description":"Protect message content from forwarding and saving"}}},"snapchat":{"type":"object","properties":{"contentType":{"type":"string","enum":["story","saved_story","spotlight"],"description":"Content type: story (ephemeral 24h, default), saved_story (permanent on Public Profile), spotlight (video feed)"}}},"reddit":{"type":"object","properties":{"subreddit":{"type":"string","description":"Target subreddit name (without \"r/\" prefix)"},"title":{"type":"string","maxLength":300,"description":"Post title"},"url":{"type":"string","format":"uri","description":"URL for link posts"},"forceSelf":{"type":"boolean","description":"When true, creates a text-only self post and skips native media uploads, even when media is provided"},"flairId":{"type":"string","description":"Flair ID for the post"},"flairText":{"type":"string","description":"Custom flair text, for subreddits that allow free-text flair"},"nsfw":{"type":"boolean","description":"Mark the post as NSFW (Not Safe For Work / over 18)."},"spoiler":{"type":"boolean","description":"Mark the post as a spoiler"},"sendreplies":{"type":"boolean","description":"Whether to receive inbox replies for comments on this post"},"nativeVideo":{"type":"boolean","description":"Controls Reddit's native video upload flow"},"videogif":{"type":"boolean","description":"When true (and nativeVideo is active), submits the video as a silent videogif (kind=videogif)"},"videoPosterUrl":{"type":"string","format":"uri","description":"Optional poster/thumbnail image URL for native video posts"}}},"bluesky":{"type":"object","properties":{"langs":{"type":"array","minItems":1,"maxItems":3,"items":{"type":"string"},"description":"Language(s) of the post text as 1-3 BCP-47 codes (e.g"},"threadItems":{"type":"array","items":{"type":"object","properties":{"content":{"type":"string"},"mediaItems":{"type":"array","items":{"type":"object","properties":{"type":{"type":"string","enum":["image","video","gif","document"]},"url":{"type":"string","format":"uri"},"title":{"type":"string"},"altText":{"type":"string"},"filename":{"type":"string"},"size":{"type":"integer"},"mimeType":{"type":"string"},"thumbnail":{"type":"string","format":"uri"},"instagramThumbnail":{"type":"string","format":"uri"},"subtitles":{"type":"array","maxItems":20,"items":{"type":"object","required":["url","language"],"properties":{"url":{"type":"string","format":"uri"},"language":{"type":"string"}}}},"tiktokProcessed":{"type":"boolean"}}}}}},"description":"Complete sequence of posts in a Bluesky thread"}}},"discord":{"type":"object","required":["channelId"],"properties":{"channelId":{"type":"string","description":"Target channel snowflake ID"},"embeds":{"type":"array","maxItems":10,"items":{"type":"object","properties":{"title":{"type":"string"},"description":{"type":"string"},"url":{"type":"string"},"color":{"type":"integer"},"image":{"type":"object","properties":{"url":{"type":"string"}}},"thumbnail":{"type":"object","properties":{"url":{"type":"string"}}},"footer":{"type":"object","properties":{"text":{"type":"string"},"icon_url":{"type":"string"}}},"author":{"type":"object","properties":{"name":{"type":"string"},"url":{"type":"string"},"icon_url":{"type":"string"}}},"fields":{"type":"array","maxItems":25,"items":{"type":"object","required":["name","value"],"properties":{"name":{"type":"string"},"value":{"type":"string"},"inline":{"type":"boolean"}}}}}},"description":"Up to 10 Discord embed objects (combined max 6,000 characters across all embeds)"},"poll":{"type":"object","properties":{"question":{"type":"object","required":["text"],"properties":{"text":{"type":"string"}}},"answers":{"type":"array","maxItems":10,"items":{"type":"object","properties":{"poll_media":{"type":"object","properties":{"text":{"type":"string"}}}}}},"duration":{"type":"integer","minimum":1,"maximum":768},"allow_multiselect":{"type":"boolean"}},"description":"Native Discord poll"},"crosspost":{"type":"boolean","description":"Auto-crosspost to every server following this announcement channel (type 5)"},"forumThreadName":{"type":"string","description":"Thread title for forum channel posts (type 15)"},"forumAppliedTags":{"type":"array","maxItems":5,"items":{"type":"string"},"description":"Tag snowflake IDs to apply to forum posts"},"threadFromMessage":{"type":"object","properties":{"name":{"type":"string"},"autoArchiveDuration":{"type":"integer","enum":[60,1440,4320,10080]},"rateLimitPerUser":{"type":"integer","minimum":0,"maximum":21600}},"description":"Create a follow-up thread under the published message."},"tts":{"type":"boolean","description":"Send as text-to-speech message"},"webhookUsername":{"type":"string","description":"Override the webhook display name for this post only (1-80 chars)"},"webhookAvatarUrl":{"type":"string","description":"Override the webhook avatar URL for this post only"}}},"slack":{"type":"object","properties":{"threadTs":{"type":"string","description":"Parent message ts to post this message as a thread reply (e.g"},"unfurlLinks":{"type":"boolean","description":"Expand links in the message into preview cards"},"unfurlMedia":{"type":"boolean","description":"Expand media links into inline previews"},"username":{"type":"string","description":"Override the bot display name for this message only (requires no setup; shown with an APP badge)"},"iconUrl":{"type":"string","description":"Override the bot avatar image URL for this message only."}}}};
const own = (value: unknown, key: string) => Object.prototype.hasOwnProperty.call(value || {}, key);
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const plain = (value: unknown): value is Record<string, any> => object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function fail(message: string): never { throw new TypeError(message); }
const MB = 1024 * 1024;

const definitions: Record<string, [string, number, string[], number, number?]> = {
  instagram: ['Instagram', 2200, ['image', 'video'], 10, 1],
  facebook: ['Facebook', 63206, ['image', 'video', 'gif'], 10],
  linkedin: ['LinkedIn', 3000, ['image', 'video', 'gif', 'document'], 20],
  tiktok: ['TikTok', 2200, ['image', 'video'], 35, 1],
  twitter: ['X', 280, ['image', 'video', 'gif'], 4],
  youtube: ['YouTube', 5000, ['video'], 1, 1],
  pinterest: ['Pinterest', 800, ['image', 'video'], 1, 1],
  threads: ['Threads', 500, ['image', 'video'], 10],
  bluesky: ['Bluesky', 300, ['image', 'video', 'gif'], 4],
  reddit: ['Reddit', 40000, ['image', 'video', 'gif'], 20],
  googlebusiness: ['Google Business Profile', 1500, ['image'], 1],
  telegram: ['Telegram', 4096, ['image', 'video', 'gif', 'document'], 10],
  discord: ['Discord', 2000, ['image', 'video', 'gif', 'document'], 10],
  slack: ['Slack', 40000, ['image', 'video', 'gif', 'document'], 10],
  snapchat: ['Snapchat', 160, ['image', 'video'], 1, 1],
  whatsapp: ['WhatsApp', 0, [], 0],
};
const optionLabels: Record<string, string> = { contentType: 'Post format', shareToFeed: 'Share Reel to profile feed', madeForKids: 'Made for children', containsSyntheticMedia: 'Disclose synthetic media', isAiGenerated: 'Disclose AI media', videoMadeWithAi: 'Disclose AI media', isPaidPartnership: 'Paid partnership', boardId: 'Pinterest board ID', channelId: 'Discord channel ID', contentPreviewConfirmed: 'I have previewed the TikTok content', expressConsentGiven: 'I consent to posting this content to TikTok', topic_tag: 'Topic tag', langs: 'Post languages (BCP 47)', tts: 'Text to speech', sendreplies: 'Receive comment replies', nsfw: 'Adult content', facebookSettings: 'Facebook draft, carousel and text background', audioConfiguration: 'Instagram audio track', userTags: 'Instagram user tags', trialParams: 'Trial Reel graduation', musicSoundInfo: 'TikTok commercial music track', thumbOffset: 'Reel cover frame offset (ms)', reelCover: 'Reel cover image URL', videoCoverTimestampMs: 'Video cover frame (ms)', coverImageKeyFrameTime: 'Video cover key frame (seconds)', brandPartnerPromote: 'Promotes a brand partner', isBrandOrganicPost: 'Promotes your own brand', isAdsOnly: 'Only show in ads', forceSelf: 'Text-only post', videogif: 'Silent video GIF', threadTs: 'Parent message timestamp' };
const acronyms: Record<string, string> = { ai: 'AI', gif: 'GIF', id: 'ID', ids: 'IDs', url: 'URL', urn: 'URN', ms: '(ms)' };
// Provider keys without a written label read in sentence case, with acronyms kept upper case: firstComment → First comment.
export const sentenceCaseLabel = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replaceAll('_', ' ').toLowerCase().split(' ').map(word => acronyms[word] || word).join(' ').replace(/^./, char => char.toUpperCase());
const label = (key: string) => optionLabels[key] || sentenceCaseLabel(key);
export const PLATFORM_RULES: Record<string, PlatformRule> = Object.fromEntries(Object.entries(definitions).map(([key, [name, captionLimit, mediaTypes, maxMedia, minMedia = 0]]) => [key, {
  label: name, captionLimit, mediaTypes, maxMedia, minMedia,
  supported: !['whatsapp', 'snapchat'].includes(key),
  ...(key === 'snapchat' ? { notice: 'Snapchat publishing is unavailable: Snapchat accounts cannot be connected yet.' } : {}),
  ...(key === 'whatsapp' ? { notice: 'WhatsApp is unavailable for social posts. Remove this destination before publishing.' } : {}),
  options: Object.entries(OPTION_SCHEMAS[key]?.properties || {}).map(([name, schema]): PlatformOption => ({
    key: name, label: label(name), type: schema.enum ? 'select' : schema.type === 'boolean' ? 'boolean' : ['integer', 'number'].includes(schema.type!) ? 'number' : schema.type === 'array' && schema.items?.type === 'string' ? 'string-list' : ['array', 'object'].includes(schema.type!) || schema.oneOf ? 'json' : name === 'firstComment' || name === 'description' ? 'textarea' : 'text',
    ...(schema.enum ? { values: schema.enum } : {}), ...(schema.maxLength ? { maxLength: schema.maxLength } : {}), ...(schema.minimum !== undefined ? { min: schema.minimum } : {}), ...(schema.maximum !== undefined ? { max: schema.maximum } : {}),
    ...(schema.description ? { help: schema.description } : {}), schema,
  })),
}]));

export function publicMediaUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192) fail('Media needs a public HTTPS delivery URL.');
  let url: URL; try { url = new URL(value); } catch { fail('Media needs a valid public HTTPS delivery URL.'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || host.includes(':') || !host.includes('.') || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /\.(local|internal|localhost)$/.test(host) || ['drive.google.com', 'docs.google.com'].includes(host)) fail('Media needs a public HTTPS delivery URL. Private addresses and Drive preview links cannot be published.');
  return url.href;
}

const mediaFields = new Set(['type', 'url', 'title', 'altText', 'filename', 'size', 'bytes', 'mimeType', 'thumbnail', 'instagramThumbnail', 'subtitles', 'width', 'height', 'duration']);
export function normalizeMediaItems(items: unknown): MediaItem[] {
  if (!Array.isArray(items) || items.length > 35) fail('Media must be an array with at most 35 items.');
  return items.map((item, index) => {
    if (!plain(item) || Object.keys(item).some(key => !mediaFields.has(key))) fail(`Media item ${index + 1} has an unsupported field.`);
    if (!['image', 'video', 'gif', 'document'].includes(item.type)) fail(`Media item ${index + 1} needs an image, video, GIF or document type.`);
    const result: Record<string, any> = { type: item.type, url: publicMediaUrl(item.url) };
    for (const field of ['title', 'altText', 'filename', 'mimeType']) if (own(item, field)) {
      if (typeof item[field] !== 'string' || item[field].length > (field === 'altText' ? 10000 : 1000)) fail(`Media ${field} must be a short string.`);
      result[field] = item[field];
    }
    for (const field of ['width', 'height', 'duration', 'size']) {
      const value = item[field] ?? (field === 'size' ? item.bytes : undefined);
      if (value !== undefined) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > (field === 'size' ? 256 * 1024 * MB : field === 'duration' ? 86400 : 100000) || field !== 'duration' && !Number.isInteger(value)) fail(`Media ${field} must be a finite positive ${field === 'duration' ? 'number' : 'integer'} within the media limit.`);
        result[field] = value;
      }
    }
    for (const field of ['thumbnail', 'instagramThumbnail']) if (own(item, field)) result[field] = publicMediaUrl(item[field]);
    if (own(item, 'subtitles')) {
      if (!Array.isArray(item.subtitles) || item.subtitles.length > 20) fail('A video supports at most 20 subtitle tracks.');
      const languages = new Set<string>();
      result.subtitles = item.subtitles.map(track => {
        if (!plain(track) || Object.keys(track).some(key => !['url', 'language'].includes(key)) || typeof track.language !== 'string' || !/^[a-zA-Z]{2}(?:-[a-zA-Z0-9]{2,8})*$/.test(track.language) || languages.has(track.language.toLowerCase())) fail('Subtitle tracks need unique BCP 47 languages and public delivery URLs.');
        languages.add(track.language.toLowerCase());
        return { url: publicMediaUrl(track.url), language: track.language };
      });
    }
    return result as MediaItem;
  });
}

export function wireMediaItems(items: unknown): MediaItem[] {
  return normalizeMediaItems(items).map(({ width, height, duration, ...item }) => item);
}

function checkSchema(value: unknown, schema: JsonSchema, path: string, required: boolean, depth = 0): void {
  if (depth > 16) fail(`${path} is nested too deeply.`);
  if (schema.oneOf) {
    if (!schema.oneOf.some(variant => { try { checkSchema(value, variant, path, required, depth + 1); return true; } catch { return false; } })) fail(`${path} does not match a supported option format.`);
    return;
  }
  const type = schema.type || (schema.properties ? 'object' : undefined);
  if (type === 'object') {
    if (!plain(value)) fail(`${path} must be an object.`);
    for (const key of Object.keys(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key) || !own(schema.properties, key)) fail(`${path}.${key} is not a supported option.`);
      checkSchema(value[key], schema.properties![key]!, `${path}.${key}`, required, depth + 1);
    }
    if (required) for (const key of schema.required || []) if (!own(value, key)) fail(`${path}.${key} is required.`);
  } else if (type === 'array') {
    if (!Array.isArray(value) || value.length > (schema.maxItems ?? 100) || value.length < (required ? schema.minItems ?? 0 : 0)) fail(`${path} must contain ${schema.minItems ?? 0}–${schema.maxItems ?? 100} items.`);
    value.forEach((item, index) => checkSchema(item, schema.items || {}, `${path}[${index}]`, required, depth + 1));
  } else if (type === 'string') {
    if (typeof value !== 'string' || value.length > (schema.maxLength ?? 50000) || required && value.length < (schema.minLength ?? 0) || schema.pattern && !new RegExp(schema.pattern).test(value)) fail(`${path} has an invalid text value${schema.maxLength ? ` (maximum ${schema.maxLength} characters)` : ''}.`);
    if (schema.format === 'uri') publicMediaUrl(value);
  } else if (['integer', 'number'].includes(type!)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || type === 'integer' && !Number.isInteger(value) || value < (schema.minimum ?? -Number.MAX_SAFE_INTEGER) || value > (schema.maximum ?? Number.MAX_SAFE_INTEGER)) fail(`${path} has an invalid number.`);
  } else if (type === 'boolean' && typeof value !== 'boolean') fail(`${path} must be true or false.`);
  if (schema.enum && !schema.enum.includes(value as string | number) || own(schema, 'const') && value !== schema.const) fail(`${path} has an unsupported value.`);
}

export function normalizePlatformOptions(platform: string, options: unknown, { required = false }: { required?: boolean } = {}): Record<string, any> {
  if (!own(PLATFORM_RULES, platform)) fail(`Unsupported platform: ${platform}.`);
  let normalized: any = options, checking: any = options;
  if (Array.isArray((options as any)?.threadItems)) {
    normalized = { ...(options as any), threadItems: (options as any).threadItems.map((item: any) => plain(item) && own(item, 'mediaItems') ? { ...item, mediaItems: normalizeMediaItems(item.mediaItems) } : item) };
    checking = { ...normalized, threadItems: normalized.threadItems.map((item: any) => plain(item) && item.mediaItems ? { ...item, mediaItems: wireMediaItems(item.mediaItems) } : item) };
  }
  checkSchema(checking, OPTION_SCHEMAS[platform] || { type: 'object', properties: {} }, `${platform}.options`, required);
  return JSON.parse(JSON.stringify(normalized));
}

export function normalizePostTags(tags: unknown = [], { preserve = false }: { preserve?: boolean } = {}): string[] {
  if (!Array.isArray(tags) || tags.length > 500 || tags.some(tag => typeof tag !== 'string')) fail('YouTube keyword tags must be a list of text values.');
  const result = preserve ? [...tags] : [...new Set(tags.flatMap(tag => tag.split(',')).map(tag => tag.trim().replace(/^#/, '').trim()).filter(Boolean))];
  if (result.some(tag => tag.length > 100 || /[\u0000-\u001f\u007f]/u.test(tag))) fail('Each YouTube keyword tag must use at most 100 characters without control characters.');
  if (result.reduce((total, tag) => total + tag.length, 0) > 500) fail('YouTube keyword tags must use at most 500 characters combined.');
  return result;
}

export function normalizePostVariants(post: SocialPost, { strict = true }: { strict?: boolean } = {}): Record<string, PlatformVariant> {
  const overrides = post?.platformOverrides;
  if (overrides === undefined) return {};
  if (!plain(overrides) || Object.keys(overrides).length > Object.keys(PLATFORM_RULES).length) fail('Platform customizations must be an object keyed by platform.');
  const result: Record<string, PlatformVariant> = {};
  for (const [platform, variant] of Object.entries(overrides)) {
    if (!own(PLATFORM_RULES, platform)) fail(`Unsupported customization platform: ${platform}.`);
    if (!plain(variant) || strict && Object.keys(variant).some(key => !['content', 'mediaItems', 'options', 'assetId'].includes(key))) fail(`${platform} customization has an unsupported field.`);
    const normalized: PlatformVariant = {};
    if (own(variant, 'content')) {
      if (typeof variant.content !== 'string' || variant.content.length > 100000) fail(`${platform} caption must be text of at most 100,000 characters.`);
      normalized.content = variant.content;
    }
    if (own(variant, 'assetId')) {
      if (typeof variant.assetId !== 'string' || variant.assetId.length > 200) fail(`${platform} asset ID is invalid.`);
      normalized.assetId = variant.assetId;
    }
    if (own(variant, 'mediaItems')) normalized.mediaItems = normalizeMediaItems(variant.mediaItems);
    if (own(variant, 'options')) normalized.options = normalizePlatformOptions(platform, variant.options);
    result[platform] = normalized;
  }
  return result;
}

export const validPostInstant = (value: unknown): boolean => typeof value === 'string' && value.length <= 100 && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value)) && new Date(value.slice(0, 10)).toISOString().slice(0, 10) === value.slice(0, 10);

export function normalizeAccountVariants(post: SocialPost): Record<string, AccountVariant> {
  if (post?.accountOverrides === undefined) return {};
  if (!plain(post.accountOverrides) || Object.keys(post.accountOverrides).length > 50) fail('Account customizations must be an object keyed by connected account ID.');
  return Object.fromEntries(Object.entries(post.accountOverrides).map(([accountId, variant]) => {
    if (!accountId || accountId.length > 500 || /\s|[\u0000-\u001f]/u.test(accountId) || ['__proto__', 'constructor', 'prototype'].includes(accountId)) fail('A customization account ID is invalid.');
    if (!plain(variant) || !own(PLATFORM_RULES, variant.platform) || Object.keys(variant).some(key => !['platform', 'content', 'mediaItems', 'assetId', 'options', 'scheduledAt'].includes(key))) fail('Account customization must include its platform and supported fields only.');
    const { platform, scheduledAt, ...copy } = variant;
    if (own(variant, 'scheduledAt') && scheduledAt !== '' && !validPostInstant(scheduledAt)) fail('An account schedule must be a valid date and time with a timezone.');
    return [accountId, { platform, ...normalizePostVariants({ platformOverrides: { [platform]: copy } })[platform], ...(own(variant, 'scheduledAt') ? { scheduledAt } : {}) }];
  }));
}

export function assertAccountSchedules(post: SocialPost, { publishNow = false, now = Date.now() }: { publishNow?: boolean; now?: number } = {}): void {
  const timed = Object.values(normalizeAccountVariants(post)).filter(variant => variant.scheduledAt);
  if (!timed.length) return;
  if (publishNow || post.queueId || !validPostInstant(post.scheduledAt) || Date.parse(post.scheduledAt) <= now) fail('Separate account times require a future fixed post schedule; they cannot be used with Publish now or a queue.');
  if (timed.some(variant => Date.parse(variant.scheduledAt!) <= now)) fail('Every separate account time must be in the future.');
}

function explicitVariant(post: SocialPost, platform: string, accountId?: string): Partial<AccountVariant> {
  const base: Partial<AccountVariant> = post.platformOverrides?.[platform] || {}, account = accountId ? post.accountOverrides?.[accountId] : undefined;
  if (!account) return base;
  if (account.platform !== platform) fail('An account customization does not match its connected platform.');
  const merged = { ...base, ...account };
  if (own(account, 'assetId') && !own(account, 'mediaItems')) delete merged.mediaItems;
  return merged;
}

export function resolveVariant(post: SocialPost, platform: string, assets: any[] = [], accountId?: string): ResolvedVariant {
  const variant = explicitVariant(post, platform, accountId);
  const assetId = own(variant, 'mediaItems') ? undefined : own(variant, 'assetId') ? variant.assetId : Array.isArray(post.mediaItems) ? undefined : post.assetId;
  const asset = assetId ? assets.find(item => item.id === assetId) : undefined;
  const mediaItems = own(variant, 'mediaItems') ? variant.mediaItems! : own(variant, 'assetId') ? asset ? [assetMedia(asset)] : [] : Array.isArray(post.mediaItems) ? post.mediaItems : asset ? [assetMedia(asset)] : [];
  return { platform, content: own(variant, 'content') ? variant.content! : typeof post.content === 'string' ? post.content : '', mediaItems, options: variant.options || {}, ...(assetId ? { assetId } : {}), ...(variant.scheduledAt ? { scheduledAt: variant.scheduledAt } : {}) };
}
function assetMedia(asset: any): MediaItem {
  const metadata = asset.deliverySource === 'zernio' ? { kind: asset.deliveryKind, mimeType: asset.deliveryMimeType, size: asset.deliverySize, filename: asset.deliveryFilename } : asset;
  return { type: metadata.mimeType?.toLowerCase() === 'image/gif' ? 'gif' : metadata.kind || asset.type, url: asset.deliveryUrl || asset.url,
    ...Object.fromEntries(['mimeType', 'title', 'filename'].filter(key => typeof metadata[key] === 'string' && metadata[key]).map(key => [key, metadata[key]])),
    ...(asset.altText || asset.description ? { altText: asset.altText || asset.description } : {}),
    ...Object.fromEntries(['width', 'height', 'duration', 'size'].filter(key => Number.isFinite(Number(metadata[key])) && Number(metadata[key]) > 0).map(key => [key, Number(metadata[key])])),
  };
}

export function assetDeliveryIssue(asset: any, now: number = Date.now()): string {
  if (asset?.deliverySource !== 'zernio') return '';
  if (!validPostInstant(asset.deliveryUploadedAt) || !validPostInstant(asset.deliveryExpiresAt) || Date.parse(asset.deliveryExpiresAt) <= Date.parse(asset.deliveryUploadedAt)) return 'This hosted delivery file has no verified expiry. Upload it again before publishing.';
  return Date.parse(asset.deliveryExpiresAt) <= now ? 'This hosted delivery file has expired. Upload it again before publishing.' : '';
}

// Callers must obtain this post from their verified provider read, never from submitted form fields.
export function providerPostMediaUrls(post: any): Set<string> {
  if (post?.isDraft === true || !['scheduled', 'published', 'publishing', 'failed', 'partial', 'cancelled'].includes(post?.status)) return new Set();
  const targets: any[] = Array.isArray(post.platforms) && post.platforms.every(plain) ? post.platforms : Array.isArray(post.providerResults) ? post.providerResults : [], media: any[] = Array.isArray(post.mediaItems) ? post.mediaItems : [];
  return new Set(targets.filter(plain).flatMap((target: Record<string, any>) => [...(Array.isArray(target.customMedia) ? target.customMedia : media), ...(Array.isArray(target.platformSpecificData?.threadItems) ? target.platformSpecificData.threadItems.flatMap((item: any) => Array.isArray(item.mediaItems) ? item.mediaItems : []) : [])]).map(item => item?.url).filter(url => typeof url === 'string' && url));
}

export function buildPlatformEntry(post: SocialPost, platform: string, accountId: string, assets: any[] = []): { platform: string; accountId: string; customContent?: string; customMedia?: MediaItem[]; platformSpecificData?: Record<string, any>; scheduledFor?: string } {
  const explicit = explicitVariant(post, platform, accountId), variant = resolveVariant(post, platform, assets, accountId);
  return { platform, accountId,
    ...(own(explicit, 'content') ? { customContent: variant.content } : {}),
    ...(own(explicit, 'mediaItems') || own(explicit, 'assetId') ? { customMedia: wireMediaItems(variant.mediaItems) } : {}),
    ...(Object.keys(variant.options).length || own(post.accountOverrides?.[accountId] || {}, 'options') ? { platformSpecificData: wireOptions(platform, variant.options) } : {}),
    ...(variant.scheduledAt ? { scheduledFor: variant.scheduledAt } : {}),
  };
}
function wireOptions(platform: string, options: Record<string, any>): Record<string, any> {
  const result = normalizePlatformOptions(platform, options);
  if (result.threadItems) result.threadItems = result.threadItems.map((item: any) => ({ ...item, ...(item.mediaItems ? { mediaItems: wireMediaItems(item.mediaItems) } : {}) }));
  return result;
}

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
export function countCaption(content: string, platform: string): number {
  if (platform === 'bluesky') return [...segmenter.segment(content)].length;
  if (platform !== 'twitter') return [...content].length;
  let count = 0, cursor = 0;
  const weighted = (text: string): number => [...segmenter.segment(text)].reduce((total, { segment }) => {
    if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(segment)) return total + 2;
    return total + [...segment].reduce((sum, char) => { const code = char.codePointAt(0)!; return sum + (code <= 0x10ff || code >= 0x2000 && code <= 0x200d || code >= 0x2010 && code <= 0x201f || code >= 0x2032 && code <= 0x2037 ? 1 : 2); }, 0);
  }, 0);
  // ponytail: URL recognition covers explicit HTTP(S) links; Zernio's account-aware dry run is authoritative for X's full URL parsing rules.
  for (const match of content.matchAll(/https?:\/\/[^\s<>]+/giu)) {
    const url = match[0].replace(/[.,!?;:)\]}]+$/, '');
    count += weighted(content.slice(cursor, match.index)) + 23;
    cursor = match.index + url.length;
  }
  return count + weighted(content.slice(cursor));
}

export function captionLimitForVariant(variant: ResolvedVariant): number {
  const { platform, mediaItems = [], options = {} } = variant;
  return platform === 'telegram' && mediaItems.length ? 1024 : platform === 'tiktok' && mediaItems.some(item => item.type === 'image') ? 4000 : platform === 'snapchat' && options.contentType === 'saved_story' ? 45 : PLATFORM_RULES[platform]?.captionLimit || 0;
}

export interface CaptionUsage { platform: string; label: string; count: number; limit: number; tone: 'ok' | 'warning' | 'error'; message?: string }
/** Each network's caption length against its own limit, with the validation message that names why it is over. */
export function captionUsage(post: SocialPost, platforms: string[], assets: any[] = []): CaptionUsage[] {
  return platforms.flatMap((platform): CaptionUsage[] => {
    const rule = PLATFORM_RULES[platform];
    if (!rule?.supported) return [];
    let variant: ResolvedVariant;
    try { variant = resolveVariant(post, platform, assets); } catch { return []; }
    // Threads and articles are counted per entry by the validator, not as one caption.
    if (variant.options.threadItems?.length || variant.options.article) return [];
    const count = countCaption(variant.content, platform), limit = captionLimitForVariant(variant);
    if (count <= limit) return [{ platform, label: rule.label, count, limit, tone: 'ok' }];
    const check = validatePostForPlatforms(post, [platform], { assets }), error = check.errors.find(item => item.field === 'content'), warning = check.warnings.find(item => item.field === 'content');
    return [{ platform, label: rule.label, count, limit, tone: error ? 'error' : 'warning', message: (error || warning)?.message }];
  });
}

export function validatePostForPlatforms(post: SocialPost, platforms: string[], { assets = [], requireMediaMetadata = false, accountId, now = Date.now(), providerOwnedMediaUrls = new Set() }: { assets?: any[]; requireMediaMetadata?: boolean; accountId?: string; now?: number; providerOwnedMediaUrls?: Set<string> } = {}): { valid: boolean; errors: RestrictionIssue[]; warnings: RestrictionIssue[]; variants: Record<string, ResolvedVariant> } {
  const errors: RestrictionIssue[] = [], warnings: RestrictionIssue[] = [], variants: Record<string, ResolvedVariant> = {};
  const issue = (list: RestrictionIssue[], platform: string, field: string, message: string) => list.push({ platform, field, message });
  try { normalizePostTags(post.tags); } catch (error) { issue(errors, 'youtube', 'tags', (error as Error).message); }
  try { normalizePostVariants(post); normalizeAccountVariants(post); } catch (error) { issue(errors, '', 'platformOverrides', (error as Error).message); }
  if (!Array.isArray(platforms) || !platforms.length) issue(errors, '', 'platforms', 'Select at least one publishing platform.');
  for (const platform of new Set(platforms || [])) {
    const rule = PLATFORM_RULES[platform];
    if (!rule || !rule.supported) { issue(errors, platform, 'platform', rule?.notice || 'This platform is not supported for social posting.'); continue; }
    let variant: ResolvedVariant;
    try { variant = resolveVariant(post, platform, assets, accountId); variant.mediaItems = normalizeMediaItems(variant.mediaItems); normalizePlatformOptions(platform, variant.options, { required: true }); }
    catch (error) { issue(errors, platform, 'options', (error as Error).message); continue; }
    variants[platform] = variant;
    const { content, mediaItems: media, options } = variant, videos = media.filter(item => item.type === 'video'), docs = media.filter(item => item.type === 'document'), images = media.filter(item => item.type === 'image');
    const add = (field: string, message: string) => issue(errors, platform, field, message), warn = (field: string, message: string) => issue(warnings, platform, field, message);
    if (variant.assetId && !assets.some(asset => asset.id === variant.assetId)) add('assetId', 'The selected creative asset is unavailable in this project.');
    for (const asset of assets.filter(asset => asset.id === variant.assetId || media.some(item => item.url === asset.deliveryUrl))) {
      const issue = providerOwnedMediaUrls.has(asset.deliveryUrl) ? '' : assetDeliveryIssue(asset, now); if (issue) add('assetId', issue);
    }
    const story = options.contentType === 'story' || options.contentType === 'saved_story';
    const captionLimit = captionLimitForVariant(variant);
    const thread = Array.isArray(options.threadItems) && options.threadItems.length > 0;
    const rich = options.article || options.poll || options.reshareUrl || options.embeds?.length;
    const count = countCaption(content, platform);
    if (!thread && !options.article && platform === 'twitter' && count > 280 && count <= 25000 && !options.poll) warn('content', 'X text exceeds 280 weighted characters. A paid X account is required; the connected account is checked before submission.');
    else if (!thread && !options.article && count > (platform === 'twitter' && !options.poll ? 25000 : captionLimit)) add('content', `Caption has ${count.toLocaleString()} characters; ${rule.label} allows ${(platform === 'twitter' && !options.poll ? 25000 : captionLimit).toLocaleString()}${platform === 'twitter' ? ' weighted characters' : ''}.`);
    if (!thread && !content.trim() && !media.length && !rich) add('content', 'Add a caption, media or supported rich post content.');
    if (media.length < rule.minMedia && !thread) add('mediaItems', `${rule.label} requires media.`);
    if (media.length > rule.maxMedia) add('mediaItems', `${rule.label} supports at most ${rule.maxMedia} media items.`);
    if (media.some(item => !rule.mediaTypes.includes(item.type))) add('mediaItems', `${rule.label} supports ${rule.mediaTypes.join(', ')} media.`);
    if (videos.length && media.length > 1 && !['instagram', 'telegram', 'slack', 'discord'].includes(platform)) add('mediaItems', `${rule.label} videos must be published separately from other media.`);
    if (docs.length && media.length > 1 && !['telegram', 'slack', 'discord'].includes(platform)) add('mediaItems', 'Publish a document as a single attachment.');
    if (platform === 'twitter' && media.some(item => item.type === 'gif') && media.length > 1) add('mediaItems', 'An X GIF takes all image slots and cannot be combined with other attachments.');
    if (story && ['instagram', 'facebook'].includes(platform)) {
      if (media.length !== 1) add('mediaItems', 'A Story requires exactly one image or video.');
      if (content.trim()) warn('content', 'Stories do not show this caption. Use an empty platform caption if you do not want it retained for reference.');
      if (options.firstComment || options.geoRestriction || options.isPaidPartnership || options.brandedContentSponsors?.length || options.locationId || options.facebookSettings?.draft || options.facebookSettings?.carouselCards) add('options', 'Stories do not support first comments, targeting, paid partnership, locations, Facebook drafts or carousels.');
    }
    if (platform === 'facebook') {
      if (options.contentType === 'reel' && (media.length !== 1 || videos.length !== 1)) add('mediaItems', 'A Facebook Reel requires one vertical video.');
      if (options.facebookSettings?.carouselCards && (options.contentType || images.length !== media.length || media.length !== options.facebookSettings.carouselCards.length)) add('options.facebookSettings.carouselCards', 'Carousel cards require one image per card and a feed post.');
      if (options.facebookSettings?.textFormatPresetId && (media.length || options.contentType || options.facebookSettings.carouselCards || !content.trim())) add('options.facebookSettings.textFormatPresetId', 'A colored text background requires a text-only feed post.');
      if (options.facebookSettings?.textFormatPresetId && count > 130) warn('content', 'Facebook may omit the colored text background above approximately 130 characters.');
    }
    if (platform === 'instagram') {
      if ((content.match(/#[\p{L}\p{N}_]+/gu) || []).length > 30) add('content', 'Instagram permits at most 30 hashtags.');
      if (options.collaborators?.length > 3) add('options.collaborators', 'Instagram permits at most three collaborators.');
      if ((options.audioConfiguration || options.trialParams || options.audioName) && (story || media.length !== 1 || videos.length !== 1)) add('options', 'Catalog audio, audio names and Trial Reels require a single video Reel.');
      if (options.muteAudio && media.some(item => item.type === 'video' && item.size! > 200 * MB)) add('options.muteAudio', 'Mute this video before uploading: audio cannot be removed from videos above 200 MB.');
      for (const tag of options.userTags || []) {
        const target = media[tag.mediaIndex ?? 0];
        if (!target) add('options.userTags', 'A user tag refers to a missing media slide.');
        else if (target.type === 'image' && !story && (tag.x === undefined || tag.y === undefined)) add('options.userTags', 'Photo user tags require x and y coordinates from 0 to 1.');
      }
    }
    if (platform === 'tiktok') {
      if (images.length && images.length !== media.length) add('mediaItems', 'TikTok photos and videos cannot be mixed.');
      if (options.contentPreviewConfirmed !== true || options.expressConsentGiven !== true) add('options', 'TikTok uploads need preview confirmation and express posting consent.');
      if (!options.draft && (!options.privacyLevel || typeof options.allowComment !== 'boolean')) add('options', 'TikTok direct posts need a creator-supported privacy level and an explicit comment choice.');
      if (!options.draft && videos.length && (typeof options.allowDuet !== 'boolean' || typeof options.allowStitch !== 'boolean')) add('options', 'Choose whether duets and stitches are allowed for this TikTok video.');
      if ((options.commercialContentType === 'brand_content' || options.brandPartnerPromote) && options.privacyLevel === 'SELF_ONLY') add('options.privacyLevel', 'Branded TikTok content cannot use private SELF_ONLY visibility.');
      if (options.locationId && !options.locationName) add('options.locationName', 'A TikTok location ID requires its location name.');
      if (options.mediaType && options.mediaType !== (videos.length ? 'video' : 'photo')) add('options.mediaType', 'The TikTok media type does not match the selected attachments.');
      if (options.photoCoverIndex !== undefined && options.photoCoverIndex >= images.length) add('options.photoCoverIndex', 'The cover index must refer to an attached photo.');
      if (options.videoOriginalSoundVolume !== undefined && !options.musicSoundInfo) add('options.videoOriginalSoundVolume', 'Original sound volume requires a commercial music track.');
      if (options.musicSoundInfo?.musicSoundEnd !== undefined && options.musicSoundInfo.musicSoundEnd <= (options.musicSoundInfo.musicSoundStart ?? 0)) add('options.musicSoundInfo', 'Music end must be after its start.');
      if (images.length && count > 90) warn('content', 'TikTok photo titles are truncated to 90 characters. Set the separate photo description to preserve the full caption.');
      if (options.draft) warn('options.draft', 'TikTok receives a Creator Inbox draft. The creator must finish posting in TikTok.');
    }
    if (platform === 'pinterest' && options.boardSectionId && !options.boardId) add('options.boardId', 'A Pinterest board section requires its board ID.');
    if (platform === 'threads' && /[.&]/.test(options.topic_tag || '')) add('options.topic_tag', 'A Threads topic tag cannot contain periods or ampersands.');
    if (platform === 'linkedin' && (options.poll && (media.length || options.reshareUrl) || options.reshareUrl && media.length)) add('options', 'LinkedIn polls and reposts cannot be combined with attachments or with each other.');
    if (platform === 'googlebusiness' && options.topicType === 'EVENT' && !options.event) add('options.event', 'An event post needs an event title and schedule.');
    if (platform === 'googlebusiness' && options.topicType === 'OFFER' && !options.offer) add('options.offer', 'An offer post needs its offer details.');
    if (platform === 'twitter') {
      if (options.poll && (media.length || thread || options.quoteTweetId)) add('options.poll', 'X polls cannot be combined with attachments, threads or quote tweets.');
      if (options.quoteTweetId && media.length) add('options.quoteTweetId', 'An X quote tweet cannot include media attachments.');
      if (options.replySettings && options.replyToTweetId) add('options.replySettings', 'X reply controls cannot be combined with a reply-to tweet ID.');
      if (options.article && (media.length || ['threadItems', 'poll', 'quoteTweetId', 'replyToTweetId', 'replySettings', 'sensitiveMedia', 'paidPartnership', 'madeWithAi'].some(key => own(options, key)))) add('options.article', 'X Articles cannot be combined with tweet attachments or tweet-only options.');
      if (options.article) warn('options.article', 'X Articles require an eligible Premium+ account and incur separate X API charges.');
    }
    if (platform === 'discord') {
      if (options.poll && media.length) add('options.poll', 'Discord polls cannot include media attachments.');
      const textLength = (options.embeds || []).reduce((total: number, embed: any) => total + (embed.title?.length || 0) + (embed.description?.length || 0) + (embed.footer?.text?.length || 0) + (embed.author?.name?.length || 0) + (embed.fields || []).reduce((n: number, field: any) => n + (field.name?.length || 0) + (field.value?.length || 0), 0), 0);
      if (textLength > 6000) add('options.embeds', 'Discord embeds allow at most 6,000 characters combined.');
    }
    if (thread) {
      if (!['twitter', 'threads', 'bluesky'].includes(platform)) add('options.threadItems', 'Threads are unsupported for this platform.');
      options.threadItems.forEach((item: any, index: number) => {
        const nested = validatePostForPlatforms({ content: item.content || '', mediaItems: item.mediaItems || [] }, [platform], { assets, requireMediaMetadata, now, providerOwnedMediaUrls });
        for (const error of nested.errors) add(`options.threadItems[${index}].${error.field}`, error.message);
        for (const warning of nested.warnings) warn(`options.threadItems[${index}].${warning.field}`, warning.message);
      });
      warn('content', 'This platform publishes the thread items instead of the main caption and attachments.');
    }
    if (own(options, 'threadItems') && !options.threadItems.length) add('options.threadItems', 'A thread needs at least one item.');
    for (const [index, item] of media.entries()) checkMedia(platform, item, options, index, add, warn, requireMediaMetadata);
    if (rule.notice) warn('platform', rule.notice);
    if (platform === 'slack' && count > 4000) warn('content', 'Slack can publish this text, but its API cannot edit messages longer than 4,000 characters.');
  }
  return { valid: errors.length === 0, errors, warnings, variants };
}

function checkMedia(platform: string, item: MediaItem, options: Record<string, any>, index: number, add: (field: string, message: string) => void, warn: (field: string, message: string) => void, requireMetadata: boolean): void {
  const field = `mediaItems[${index}]`, image = ['image', 'gif'].includes(item.type), video = item.type === 'video', ratio = item.width && item.height ? item.width / item.height : undefined;
  if (requireMetadata && (!item.size || image && (!item.width || !item.height) || video && (!item.width || !item.height || !item.duration))) add(field, 'Inspect this media or provide its size, dimensions and video duration.');
  else if (!item.size || !item.mimeType || (image || video) && (!item.width || !item.height) || video && !item.duration) warn(field, 'Some file size, MIME type, dimensions or duration are unknown. Local checks cover supplied metadata; the provider checks the delivered file.');
  const sizeLimits: Record<string, number> = { twitter: image ? item.type === 'gif' ? 15 : 5 : 512, instagram: image ? 8 : options.contentType === 'story' ? 100 : 300, facebook: image ? 4 : 4096, linkedin: image ? 8 : item.type === 'document' ? 100 : 5120, tiktok: image ? 20 : 4096, youtube: 256 * 1024, pinterest: image ? 32 : 2048, threads: image ? 8 : 1024, bluesky: image ? 1 : 50, googlebusiness: 5, telegram: image ? 10 : 50, discord: 25, slack: 1024, snapchat: image ? 5 : 1024, reddit: image ? 20 : 1024 };
  if (item.size! > sizeLimits[platform]! * MB) {
    if (image && ['instagram', 'bluesky'].includes(platform)) warn(`${field}.size`, `The image exceeds ${sizeLimits[platform]} MB; it may be compressed, changing quality.`);
    else add(`${field}.size`, `File exceeds ${PLATFORM_RULES[platform].label}'s ${sizeLimits[platform]} MB limit.`);
  }
  const durationLimits: Record<string, [number, number]> = { tiktok: [3, 600], facebook: options.contentType === 'reel' ? [3, 60] : options.contentType === 'story' ? [1, 120] : [1, 14400], instagram: options.contentType === 'story' ? [0, 60] : [0, 3600], threads: [0, 300], bluesky: [0, 60], linkedin: [3, 1800], pinterest: [4, 900], youtube: [0, 43200], snapchat: [0, 60] };
  if (video && item.duration && durationLimits[platform] && (item.duration < durationLimits[platform][0] || item.duration > durationLimits[platform][1])) add(`${field}.duration`, `Video duration must be ${durationLimits[platform][0]}–${durationLimits[platform][1]} seconds for this format.`);
  if (video && platform === 'linkedin' && item.duration! > 600 && !options.organizationUrn) warn(`${field}.duration`, 'LinkedIn personal profiles allow 10-minute videos; videos up to 30 minutes require an organization page.');
  if (video && platform === 'youtube' && item.duration! > 900) warn(`${field}.duration`, 'YouTube videos longer than 15 minutes require a verified channel.');
  if (ratio && platform === 'instagram' && image && options.contentType !== 'story' && (ratio < 0.5625 || ratio > 1.91)) add(`${field}.dimensions`, 'Instagram feed images require an aspect ratio between 0.5625 and 1.91.');
  if (ratio && platform === 'facebook' && options.contentType === 'reel' && Math.abs(ratio - 9 / 16) > 0.025) add(`${field}.dimensions`, 'Facebook Reels require a vertical 9:16 video.');
  if (ratio && ['tiktok', 'snapchat'].includes(platform) && Math.abs(ratio - 9 / 16) > 0.05) warn(`${field}.dimensions`, 'A vertical 9:16 creative is recommended for this format.');
  const altLimit = platform === 'twitter' ? 1000 : platform === 'pinterest' ? 500 : 10000;
  if (item.altText?.length! > altLimit) add(`${field}.altText`, `Alternative text exceeds ${altLimit} characters.`);
  if (item.altText && !['instagram', 'facebook', 'threads', 'twitter', 'linkedin', 'bluesky', 'pinterest'].includes(platform)) warn(`${field}.altText`, 'This platform does not accept attachment alternative text.');
  if (item.subtitles?.length && !['youtube', 'facebook', 'linkedin', 'twitter', 'bluesky'].includes(platform)) warn(`${field}.subtitles`, 'This platform does not accept these subtitle tracks.');
  const mime = item.mimeType?.toLowerCase();
  if (mime && (image && !mime.startsWith('image/') || video && !mime.startsWith('video/') || item.type === 'document' && mime.startsWith('image/'))) add(`${field}.mimeType`, 'The MIME type does not match the attachment type.');
  const imageMimes: Record<string, string[]> = { instagram: ['image/jpeg', 'image/png'], facebook: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'], linkedin: ['image/jpeg', 'image/png', 'image/gif'], tiktok: ['image/jpeg', 'image/png', 'image/webp'], twitter: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], pinterest: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], threads: ['image/jpeg', 'image/png'], bluesky: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], reddit: ['image/jpeg', 'image/png', 'image/gif'], googlebusiness: ['image/jpeg', 'image/png'] };
  const videoMimes: Record<string, string[]> = { instagram: ['video/mp4', 'video/quicktime'], facebook: ['video/mp4', 'video/quicktime'], linkedin: ['video/mp4', 'video/quicktime', 'video/avi', 'video/x-msvideo'], tiktok: ['video/mp4', 'video/quicktime', 'video/webm'], twitter: ['video/mp4', 'video/quicktime'], pinterest: ['video/mp4', 'video/quicktime'], threads: ['video/mp4'], bluesky: ['video/mp4'], reddit: ['video/mp4'], youtube: ['video/mp4', 'video/quicktime', 'video/avi', 'video/x-msvideo', 'video/x-ms-wmv', 'video/x-flv', 'video/3gpp', 'video/webm', 'video/mpeg'] };
  const exactMime = image ? imageMimes[platform] : video ? videoMimes[platform] : undefined;
  if (mime && exactMime && !exactMime.includes(mime)) add(`${field}.mimeType`, `This format requires ${exactMime.join(' or ')}.`);
}
