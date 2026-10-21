import type { OperationContext, ZernioApi, ProviderRecord } from './provider-core.ts';
import { createHash } from 'node:crypto';
import { fail, reportObject as object, IntegrationError, operation, claimFence, scopedAccounts, requireAccount } from './provider-core.ts';

const numeric = (value: any) => typeof value === 'string' && /^\d{1,100}$/.test(value);
const nativeId = (value: any) => numeric(value) ? String(BigInt(value)) : Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
const text = (value: any, max: any) => typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const nullableText = (value: any, max: any) => value == null || text(value, max);
const instant = (value: any) => value == null || text(value, 100) && Number.isFinite(Date.parse(value));
const offsetInstant = (value: any) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value.slice(0, 10) + 'T00:00:00Z').toISOString().slice(0, 10) === value.slice(0, 10);
const invalid = () => fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned unreadable blog content.');
const hash = (value: any) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity = (account: any) => [account._id, account.platform, String(account.profileId?._id || account.profileId), account.platformUserId ?? null, account.username ?? null, account.displayName ?? null, account.isActive ?? null, account.needsReconnection ?? null];

async function access(context: OperationContext & { body: any }, profileId: any) {
  try { await context.assertProjectMapping?.(profileId); await context.assertIntegrationSettings?.(); }
  catch (error: any) { fail(error.status === 403 ? 403 : 409, error.status === 403 ? 'PROJECT_ACCESS_CHANGED' : 'PROJECT_CONNECTION_CHANGED', 'Your project access or connection changed. Refresh before continuing.'); }
}
function accountRow(account: any) {
  if (!text(account._id, 500) || !account._id || /[\s/?#]/.test(account._id) || account.needsReconnection != null && typeof account.needsReconnection !== 'boolean' || ['platformUserId', 'username', 'displayName'].some(key => !nullableText(account[key], 2000))) invalid();
  return { id: account._id, platform: account.platform, name: account.displayName || account.username || account.platform, isActive: account.isActive !== false, needsReconnection: account.needsReconnection === true };
}
async function accounts(context: OperationContext & { body: any }, api: ZernioApi, profileId: any) {
  await access(context, profileId);
  const rows = await scopedAccounts(api, profileId);
  await access(context, profileId);
  if (rows.length > 10000 || new Set(rows.map(row => row._id)).size !== rows.length) invalid();
  return rows.filter(row => ['shopify', 'wordpress'].includes(row.platform)).map(row => { accountRow(row); return row; });
}
async function selected(context: OperationContext & { body: any }, api: ZernioApi, profileId: any, accountId: any) {
  const account = requireAccount(await accounts(context, api, profileId), accountId);
  if (account.isActive === false || account.needsReconnection === true) fail(409, 'BLOG_ACCOUNT_UNAVAILABLE', 'Reconnect this store or site before reading or creating articles.');
  return account;
}
function scope(value: any, account: any, profileId: any) {
  if (!object(value) || value.platform !== account.platform || value.accountId != null && String(value.accountId?._id || value.accountId) !== account._id || value.profileId != null && String(value.profileId?._id || value.profileId) !== profileId) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio returned blog content outside this project or account.');
}
async function read(context: OperationContext & { body: any }, api: ZernioApi, profileId: any, account: any, path: any, query = {}) {
  await access(context, profileId);
  const response = await api(path, query);
  await access(context, profileId);
  const fresh = await selected(context, api, profileId, account._id);
  if (JSON.stringify(identity(fresh)) !== JSON.stringify(identity(account))) fail(409, 'BLOG_ACCOUNT_CHANGED', 'The connected store or site changed. Load its blogs again.');
  scope(response, account, profileId);
  return response;
}
function blogRow(value: any, account: any, profileId: any, expectedId?: any) {
  scope(value, account, profileId);
  const id = nativeId(value.id);
  if (id === null || expectedId && id !== expectedId || !text(value.title, 10000) || !text(value.handle, 2000)) invalid();
  return { id, platform: value.platform, title: value.title, handle: value.handle };
}
function publicationState(raw: any) {
  if (raw.platform === 'wordpress' && raw.status === 'future' && raw.isPublished === false && raw.publishedAt === null && offsetInstant(raw.publishDate) && Date.parse(raw.publishDate) > Date.now()) return 'scheduled';
  if (raw.publishDate != null || raw.publishedAt != null && Date.parse(raw.publishedAt) > Date.now()) return 'unverified';
  if (raw.isPublished === false && raw.publishedAt === null && (raw.platform !== 'wordpress' || raw.status === 'draft')) return 'draft';
  if (raw.isPublished === true && (raw.platform !== 'wordpress' || raw.status === 'publish')) return 'published';
  return 'unverified';
}
function articleRow(value: any, account: any, profileId: any, blogId: any, expectedId?: any) {
  scope(value, account, profileId);
  const id = nativeId(value.id);
  if (id === null || expectedId && id !== expectedId || nativeId(value.blogId) !== blogId || !text(value.title, 10000) || !nullableText(value.bodyHtml, 1000000) || ['handle', 'author', 'excerpt'].some(key => !nullableText(value[key], key === 'excerpt' ? 1000000 : 10000)) || typeof value.isPublished !== 'boolean' || ['publishedAt', 'publishDate', 'createdAt', 'updatedAt'].some(key => !instant(value[key]))) invalid();
  if (account.platform === 'wordpress' ? !['publish', 'future', 'draft', 'pending', 'private'].includes(value.status) || value.isPublished !== (value.status === 'publish') : value.status != null) invalid();
  if (value.tags != null && (!Array.isArray(value.tags) || value.tags.length > 100 || value.tags.some((tag: any) => !text(tag, 2000) || !tag))) invalid();
  if (value.image != null && (!object(value.image) || !text(value.image.url, 4000) || !nullableText(value.image.altText, 10000))) invalid();
  return { id, blogId, platform: value.platform, title: value.title, bodyHtml: value.bodyHtml ?? null, handle: value.handle ?? null, tags: value.tags || [], author: value.author ?? null, excerpt: value.excerpt ?? null, image: value.image ? { url: value.image.url, altText: value.image.altText ?? null } : null, isPublished: value.isPublished, status: value.status ?? null, publishedAt: value.publishedAt ?? null, publishDate: value.publishDate ?? null, createdAt: value.createdAt ?? null, updatedAt: value.updatedAt ?? null, publicationState: publicationState(value), canEditPublished: value.platform === 'wordpress' && value.status === 'publish' && value.isPublished === true && value.publishDate === null && offsetInstant(value.publishedAt) && Date.parse(value.publishedAt) <= Date.now() };
}
function draft(raw: any, article: any, existing = false) {
  if (!existing && (!article.title.trim() || typeof article.bodyHtml !== 'string') || publicationState(raw) !== 'draft') fail(existing ? 409 : 502, existing ? 'BLOG_EXISTING_DRAFT_REQUIRED' : 'BLOG_DRAFT_NOT_CONFIRMED', existing ? 'Only a verified unscheduled draft can be edited or published. Load its current details again.' : 'The provider did not confirm the content of an unscheduled draft.', !existing);
}
function page(url: any) {
  for (const key of url.searchParams.keys()) if (!['limit', 'cursor'].includes(key) || url.searchParams.getAll(key).length !== 1) fail(400, 'INVALID_BLOG_QUERY', 'Use one page size and the returned blog cursor.');
  const limit = url.searchParams.get('limit') ?? '20', cursor = url.searchParams.get('cursor');
  if (!/^(?:[1-9]|[1-4]\d|50)$/.test(limit) || cursor !== null && (!text(cursor, 4096) || !cursor)) fail(400, 'INVALID_BLOG_QUERY', 'Use a page size from 1 to 50 and an unchanged provider cursor.');
  return { limit: Number(limit), ...(cursor === null ? {} : { cursor }) };
}
function rows(response: any, field: any, query: any, normalize: any): ProviderRecord {
  if (!Array.isArray(response[field]) || response[field].length > query.limit || response.nextCursor !== null && (!text(response.nextCursor, 4096) || !response.nextCursor || response.nextCursor === query.cursor)) invalid();
  const result = response[field].map(normalize);
  if (new Set(result.map((row: any) => row.id)).size !== result.length) invalid();
  return { [field]: result, nextCursor: response.nextCursor };
}
async function snapshot(context: OperationContext & { body: any }, api: ZernioApi, profileId: any, accountId: any, blogId: any, articleId?: any) {
  const account = await selected(context, api, profileId, accountId), response = await read(context, api, profileId, account, `/accounts/${encodeURIComponent(accountId)}/blogs/${blogId}`);
  const blog = blogRow(response.blog, account, profileId, blogId);
  if (articleId !== undefined) {
    const result = await read(context, api, profileId, account, `/accounts/${encodeURIComponent(accountId)}/blogs/${blogId}/articles/${articleId}`), article = articleRow(result.article, account, profileId, blogId, articleId);
    return { account, blog, article, rawArticle: result.article, version: hash([profileId, identity(account), blog, article]) };
  }
  return { account, blog, version: hash([profileId, identity(account), blog]) };
}

export async function handleZernioBlogs(context: OperationContext & { body: any }, api: ZernioApi, profileId: any, action: any) {
  const { req, url, body = {}, role, send, db } = context;
  if (action === 'accounts') {
    if (req.method !== 'GET') fail(405, 'METHOD_NOT_ALLOWED', 'Use the available blog controls.');
    if (url.search) fail(400, 'INVALID_BLOG_QUERY', 'The connected blog accounts do not accept filters.');
    send(200, { accounts: (await accounts(context, api, profileId)).map(accountRow) }); return true;
  }
  const parts = action.split('/'); let [encodedAccountId, blogId, task, articleId, edit] = parts;
  if (parts.some((part: any) => !part) || parts.length > 5 || parts.length >= 3 && !['articles', 'create'].includes(task) || parts.length >= 4 && task !== 'articles' || parts.length === 5 && !['update', 'publish', 'unpublish', 'schedule', 'cancel-schedule'].includes(edit)) return false;
  const create = parts.length === 3 && task === 'create', mutate = parts.length === 5, update = edit === 'update', schedule = edit === 'schedule', cancelSchedule = edit === 'cancel-schedule';
  if (req.method !== (create || mutate ? 'POST' : 'GET')) fail(405, 'METHOD_NOT_ALLOWED', 'Use the reviewed article controls to change a draft or its publication state.');
  if ((create || mutate) && !['owner', 'admin', 'editor'].includes(role)) fail(403, 'WRITE_PERMISSION_REQUIRED', 'Editing permission is required to change a blog article.');
  let accountId; try { accountId = decodeURIComponent(encodedAccountId); } catch { fail(400, 'INVALID_BLOG_ACCOUNT', 'Choose a connected store or site.'); }
  if (!text(accountId, 500) || !accountId || /[\s/?#]/.test(accountId) || blogId !== undefined && !numeric(blogId) || articleId !== undefined && !numeric(articleId)) fail(400, 'INVALID_BLOG_ID', 'Choose the blog and article returned by the connected store or site.');
  if (blogId !== undefined) blogId = nativeId(blogId);
  if (articleId !== undefined) articleId = nativeId(articleId);
  const list = parts.length === 1 || parts.length === 3 && task === 'articles', query = list ? page(url) : {};
  if (!list && url.search) fail(400, 'INVALID_BLOG_QUERY', 'This blog action does not accept filters.');
  if (create) {
    if (!object(body) || Object.keys(body).some(key => !['title', 'bodyHtml', 'version', 'confirmCreate'].includes(key)) || body.confirmCreate !== true || !text(body.title, 500) || !body.title.trim() || /[\r\n\t]/.test(body.title) || !text(body.bodyHtml, 500000) || !/^[a-f0-9]{64}$/.test(body.version || '')) fail(400, 'BLOG_DRAFT_REVIEW_REQUIRED', 'Review the selected blog, title and HTML body, then confirm creation of a draft.');
    await access(context, profileId);
    const outcome = await operation(context, async key => {
      const before = await snapshot(context, api, profileId, accountId, blogId);
      if (before.version !== body.version) fail(409, 'BLOG_CHANGED', 'The connected site or blog changed. Load and review its details again.');
      if (!before.account.platformUserId?.trim()) fail(409, 'BLOG_SITE_IDENTITY_UNAVAILABLE', 'The site identity could not be verified. Refresh or reconnect this account before creating a draft.');
      const resource = JSON.stringify([before.account.platform, before.account.platformUserId, blogId]);
      // One draft creation per native blog at a time; the fence stays held until a later claim finds this receipt resolved.
      if (!await claimFence(db, 'zernio_blog_creates', resource, context.project.id, key)) fail(409, 'BLOG_PREVIOUS_OUTCOME_UNRESOLVED', 'This request was not sent. Review the earlier blog draft outcome before creating another draft.');
      await access(context, profileId);
      const path = `/accounts/${encodeURIComponent(accountId)}/blogs/${blogId}/articles`;
      const response = await api(path, {}, { title: body.title.trim(), bodyHtml: body.bodyHtml, isPublished: false }, key);
      try {
        await access(context, profileId); scope(response, before.account, profileId);
        const receipt = articleRow(response.article, before.account, profileId, blogId); draft(response.article, receipt);
        const result = await read(context, api, profileId, before.account, `${path}/${receipt.id}`), article = articleRow(result.article, before.account, profileId, blogId, receipt.id); draft(result.article, article);
        if (article.title !== receipt.title || article.bodyHtml !== receipt.bodyHtml) fail(502, 'BLOG_DRAFT_NOT_CONFIRMED', 'The created draft changed before its content could be confirmed.', true);
        const after = await snapshot(context, api, profileId, accountId, blogId);
        if (after.version !== before.version) fail(502, 'BLOG_DRAFT_NOT_CONFIRMED', 'The connected site or blog changed after draft creation.', true);
        return { accountId, article, blog: after.blog };
      } catch (error: any) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
    }, `zernio-blog-create:${accountId}:${blogId}`);
    send(outcome.status, outcome.data); return true;
  }
  if (mutate) {
    const confirmation = update ? 'confirmUpdate' : schedule ? 'confirmSchedule' : cancelSchedule ? 'confirmCancelSchedule' : edit === 'publish' ? 'confirmPublish' : 'confirmUnpublish';
    if (!object(body) || Object.keys(body).some(key => ![...(update ? ['title', 'bodyHtml'] : schedule ? ['publishDate'] : []), 'version', confirmation].includes(key)) || body[confirmation] !== true || update && (!text(body.title, 500) || !body.title.trim() || /[\r\n\t]/.test(body.title) || !text(body.bodyHtml, 500000)) || schedule && !offsetInstant(body.publishDate) || !/^[a-f0-9]{64}$/.test(body.version || '')) fail(400, update ? 'BLOG_DRAFT_REVIEW_REQUIRED' : schedule || cancelSchedule ? 'BLOG_SCHEDULE_REVIEW_REQUIRED' : 'BLOG_PUBLICATION_REVIEW_REQUIRED', update ? 'Review this existing article, title and HTML body, then confirm the update.' : schedule ? 'Review this article and a future ISO 8601 publication time with an explicit offset or Z, then confirm scheduling.' : 'Load and review this article, then explicitly confirm the publication change.');
    await access(context, profileId);
    const outcome = await operation(context, async key => {
      const before = await snapshot(context, api, profileId, accountId, blogId, articleId);
      if (before.version !== body.version) fail(409, 'BLOG_ARTICLE_CHANGED', 'The connected site, blog or article changed. Load and review this article again.');
      if ((schedule || cancelSchedule) && before.account.platform !== 'wordpress') fail(409, 'BLOG_SCHEDULING_UNSUPPORTED', 'Native scheduling is available here for WordPress only. Shopify scheduling is not supported.');
      const publishedUpdate = update && before.account.platform === 'wordpress' && before.rawArticle.status === 'publish';
      const verifyBefore = (value: any) => {
        if (schedule) { if (!['draft', 'scheduled'].includes(publicationState(value.rawArticle))) fail(409, 'BLOG_SCHEDULABLE_ARTICLE_REQUIRED', 'Only a verified WordPress draft or scheduled article can be scheduled. Load its current details again.'); }
        else if (cancelSchedule) { if (publicationState(value.rawArticle) !== 'scheduled') fail(409, 'BLOG_SCHEDULED_ARTICLE_REQUIRED', 'Only a verified scheduled WordPress article can have its schedule cancelled. Load its current details again.'); }
        else if (edit === 'unpublish') { if (value.article.publicationState !== 'published') fail(409, 'BLOG_PUBLISHED_ARTICLE_REQUIRED', 'Only a verified published article can be unpublished. Load its current details again.'); }
        else if (publishedUpdate) { if (!value.article.canEditPublished) fail(409, 'BLOG_PUBLISHED_CONTENT_REQUIRED', 'Only a WordPress article with a verified published status and publication time can be edited while public. Load its current details again.'); }
        else draft(value.rawArticle, value.article, true);
      };
      verifyBefore(before);
      if (!before.account.platformUserId?.trim()) fail(409, 'BLOG_SITE_IDENTITY_UNAVAILABLE', 'The site identity could not be verified. Refresh or reconnect this account before changing an article.');
      const resource = JSON.stringify([before.account.platform, before.account.platformUserId, blogId, articleId]);
      const ready = await snapshot(context, api, profileId, accountId, blogId, articleId);
      if (ready.version !== before.version) fail(409, 'BLOG_ARTICLE_CHANGED', 'This article changed before the change could be sent. Load and review it again.');
      verifyBefore(ready);
      await access(context, profileId);
      if (schedule && Date.parse(body.publishDate) <= Date.now()) fail(409, 'BLOG_SCHEDULE_DATE_ELAPSED', 'The reviewed publication time has passed. Review a new future time before scheduling.');
      // One change per native article at a time; the fence stays held until a later claim finds this receipt resolved.
      if (!await claimFence(db, 'zernio_blog_updates', resource, context.project.id, key)) fail(409, 'BLOG_PREVIOUS_OUTCOME_UNRESOLVED', 'This change was not sent. Review the earlier article outcome before changing this article again.');
      const path = `/accounts/${encodeURIComponent(accountId)}/blogs/${blogId}/articles/${articleId}`;
      // Zernio has no atomic conditional article update: external edits after the last read can change reviewed content before this write.
      const response = await api(path, {}, update ? { title: body.title.trim(), bodyHtml: body.bodyHtml } : schedule ? { publishDate: body.publishDate } : { isPublished: edit === 'publish' }, key, 'PATCH');
      try {
        await access(context, profileId); scope(response, before.account, profileId);
        const verifyAfter = (raw: any, article: any) => {
          if (publishedUpdate) { if (!article.canEditPublished || Date.parse(raw.publishedAt) !== Date.parse(before.rawArticle.publishedAt) || !article.title.trim() || typeof article.bodyHtml !== 'string') fail(502, 'BLOG_PUBLISHED_CONTENT_NOT_CONFIRMED', 'The provider did not confirm the updated article with its original publication state and time.', true); }
          else if (update) draft(raw, article);
          else if (article.publicationState !== (schedule ? 'scheduled' : edit === 'publish' ? 'published' : 'draft') || schedule && Date.parse(raw.publishDate) !== Date.parse(body.publishDate)) fail(502, schedule || cancelSchedule ? 'BLOG_SCHEDULE_NOT_CONFIRMED' : 'BLOG_PUBLICATION_NOT_CONFIRMED', 'The provider did not confirm the requested article publication state and time.', true);
        };
        const receipt = articleRow(response.article, before.account, profileId, blogId, articleId); verifyAfter(response.article, receipt);
        const result = await read(context, api, profileId, before.account, path), article = articleRow(result.article, before.account, profileId, blogId, articleId); verifyAfter(result.article, article);
        if (article.title !== receipt.title || article.bodyHtml !== receipt.bodyHtml) fail(502, update ? 'BLOG_DRAFT_NOT_CONFIRMED' : 'BLOG_PUBLICATION_NOT_CONFIRMED', 'The article changed before its content could be confirmed.', true);
        const after = await snapshot(context, api, profileId, accountId, blogId);
        if (after.version !== hash([profileId, identity(before.account), before.blog])) fail(502, 'BLOG_DRAFT_NOT_CONFIRMED', 'The connected site or blog changed after the draft update.', true);
        return { accountId, article, blog: after.blog };
      } catch (error: any) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
    }, `zernio-blog-update:${accountId}:${blogId}:${articleId}`);
    send(outcome.status, outcome.data); return true;
  }
  if (parts.length === 2) {
    const { blog, version } = await snapshot(context, api, profileId, accountId, blogId);
    send(200, { blog, version }); return true;
  }
  if (articleId) {
    const { article, version } = await snapshot(context, api, profileId, accountId, blogId, articleId);
    send(200, { article, version }); return true;
  }
  const account = await selected(context, api, profileId, accountId), path = `/accounts/${encodeURIComponent(accountId)}/blogs`;
  if (parts.length === 1) {
    const result = await read(context, api, profileId, account, path, query), response = rows(result, 'blogs', query, (row: any) => blogRow(row, account, profileId));
    if (account.platform === 'wordpress' && (response.blogs.length !== 1 || response.nextCursor !== null)) invalid();
    send(200, response); return true;
  }
  const result = await read(context, api, profileId, account, `${path}/${blogId}/articles`, query);
  send(200, rows(result, 'articles', query, (row: any) => articleRow(row, account, profileId, blogId)));
  return true;
}
