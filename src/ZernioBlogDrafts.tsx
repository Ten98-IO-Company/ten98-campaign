import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AppField as Field } from '@ten98/ui/app';

export type BlogAccount = { id: string; platform: 'wordpress' | 'shopify'; name: string; isActive: boolean; needsReconnection: boolean };
export type Blog = { id: string; platform: 'wordpress' | 'shopify'; title: string; handle: string | null };
export type Article = { id: string; blogId: string; platform: string; title: string; bodyHtml: string | null; isPublished: boolean; publicationState: 'draft' | 'published' | 'scheduled' | 'unverified'; status: string | null; publishedAt: string | null; publishDate: string | null; canEditPublished?: boolean; handle?: string | null; tags?: string[]; author?: string | null; excerpt?: string | null; image?: { url: string; altText: string | null } | null; createdAt?: string | null; updatedAt?: string | null };
type Request = (path: string, body?: unknown, validate?: (value: any) => void) => Promise<any>;
type Review = { identity: string; safety: object; revision: number; version: string; title: string; bodyHtml: string; blog: Blog; article?: Article };
type Snapshot = { identity: string; article: Article; version: string };
const supported = (value: unknown) => value === 'wordpress' || value === 'shopify';
const readableBlog = (value: any): value is Blog => !!value && typeof value.id === 'string' && !!value.id && supported(value.platform) && typeof value.title === 'string' && (value.handle === null || typeof value.handle === 'string');
const readableArticle = (value: any): value is Article => !!value && typeof value.id === 'string' && !!value.id && typeof value.blogId === 'string' && supported(value.platform) && typeof value.title === 'string' && (value.bodyHtml === null || typeof value.bodyHtml === 'string') && typeof value.isPublished === 'boolean' && ['draft', 'published', 'scheduled', 'unverified'].includes(value.publicationState) && ['status', 'publishedAt', 'publishDate', 'handle', 'author', 'excerpt', 'createdAt', 'updatedAt'].every(key => value[key] == null || typeof value[key] === 'string') && (value.tags == null || Array.isArray(value.tags) && value.tags.every((tag: unknown) => typeof tag === 'string')) && (value.image == null || typeof value.image.url === 'string' && (value.image.altText == null || typeof value.image.altText === 'string'));
function articleStatus(value: Article) { return value.status || (value.isPublished ? 'Published' : value.publishedAt && Date.parse(value.publishedAt) > Date.now() ? 'Scheduled' : 'Draft'); }
const unpublishedDraft = (value: Article) => value.publicationState === 'draft' && value.isPublished === false && value.publishedAt === null && value.publishDate === null && (value.platform === 'wordpress' ? value.status === 'draft' : value.platform === 'shopify');
const publicationAction = (value: Article) => value.publicationState === 'draft' && unpublishedDraft(value) ? 'publish' : value.publicationState === 'published' && value.isPublished && value.publishDate === null && (value.platform === 'wordpress' ? value.status === 'publish' : value.platform === 'shopify') && (value.publishedAt === null || Number.isFinite(Date.parse(value.publishedAt)) && Date.parse(value.publishedAt) <= Date.now()) ? 'unpublish' : null;
type PublicationAction = 'publish' | 'unpublish' | 'schedule' | 'cancel-schedule';
const scheduleInstant = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === value.slice(0, 10) ? new Date(value).toISOString() : null;
const publishedContent = (value: Article) => value.canEditPublished === true && value.platform === 'wordpress' && value.publicationState === 'published' && value.status === 'publish' && value.isPublished === true && value.publishDate === null && !!scheduleInstant(value.publishedAt) && Date.parse(value.publishedAt!) <= Date.now();
const scheduledProof = (value: Article) => value.platform === 'wordpress' && value.publicationState === 'scheduled' && value.status === 'future' && value.isPublished === false && value.publishedAt === null && !!scheduleInstant(value.publishDate);
const scheduledArticle = (value: Article) => scheduledProof(value) && Date.parse(value.publishDate!) > Date.now();
const canPublication = (value: Article, action: PublicationAction) => action === 'schedule' ? value.platform === 'wordpress' && (unpublishedDraft(value) || scheduledArticle(value)) : action === 'cancel-schedule' ? scheduledArticle(value) : publicationAction(value) === action;
const publicationLabel = (action: PublicationAction, article: Article) => action === 'schedule' ? article.publicationState === 'scheduled' ? 'Reschedule' : 'Schedule' : action === 'cancel-schedule' ? 'Cancel schedule' : action === 'publish' ? 'Publish now' : 'Unpublish';
const localWallTime = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
function localSchedule(value: string, timezone: 'local' | 'utc' = 'local') {
  const date = new Date(timezone === 'utc' ? `${value}Z` : value), valid = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) && Number.isFinite(date.getTime());
  if (!valid || (timezone === 'utc' ? date.toISOString().slice(0, 16) : localWallTime(date)) !== value || date.getTime() <= Date.now()) throw new Error('Choose a valid future publication date and time in the selected timezone.');
  if (timezone === 'local' && [-1, 1].some(day => { const candidate = new Date(date.getTime() + (new Date(date.getTime() + day * 86400000).getTimezoneOffset() - date.getTimezoneOffset()) * 60000); return candidate.getTime() !== date.getTime() && localWallTime(candidate) === value; })) throw new Error('This local time occurs twice because the timezone offset changes. Choose UTC and enter the exact intended time.');
  return date.toISOString();
}
const publicationTime = (value: string) => `${new Date(value).toLocaleString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone}, your local timezone) · UTC ${new Date(value).toISOString()}`;
function validatePublicationReceipt(value: any, account: BlogAccount, blog: Blog, article: Article, action: PublicationAction, publishDate?: string) {
  if (value?.accountId !== account.id || !readableBlog(value?.blog) || value.blog.id !== blog.id || value.blog.platform !== account.platform || !readableArticle(value?.article) || value.article.id !== article.id || value.article.blogId !== blog.id || value.article.platform !== account.platform || !(action === 'schedule' ? scheduledProof(value.article) && scheduleInstant(value.article.publishDate) === publishDate : action === 'publish' ? publicationAction(value.article) === 'unpublish' : unpublishedDraft(value.article)) || value?.operation?.status !== 'complete' || typeof value.operation.id !== 'string' || !value.operation.id) throw new Error('The publication receipt could not be verified. Check the same action before making another article change.');
}
function pageCursor(value: any, used: Set<string>) {
  if (value == null) return '';
  if (typeof value !== 'string' || !value || value.length > 8192 || used.has(value)) throw new Error('The next page could not be verified. Return to the first page.');
  return value;
}
function draftBody(title: string, bodyHtml: string) {
  const trimmed = title.trim();
  if (!trimmed || trimmed.length > 500 || /[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) throw new Error('Enter a title of 1–500 characters without control characters.');
  if (bodyHtml.length > 500000) throw new Error('Article HTML must be 500,000 characters or fewer.');
  return { title: trimmed, bodyHtml };
}
function validateDraftReceipt(value: any, account: BlogAccount, blog: Blog) {
  const article = value?.article;
  if (value?.accountId !== account.id || !readableBlog(value?.blog) || value.blog.id !== blog.id || value.blog.platform !== account.platform || !readableArticle(article) || !/^\d+$/.test(article.id) || article.blogId !== blog.id || article.platform !== account.platform || typeof article.bodyHtml !== 'string' || article.publicationState !== 'draft' || article.isPublished !== false || article.publishedAt !== null || article.publishDate !== null || article.status !== (account.platform === 'wordpress' ? 'draft' : null) || value?.operation?.status !== 'complete' || typeof value.operation.id !== 'string' || !value.operation.id) throw new Error('The draft receipt could not be verified. The same action must be checked before creating another draft.');
}
function validateUpdateReceipt(value: any, account: BlogAccount, blog: Blog, article: Article) {
  if (publishedContent(article)) {
    if (value?.accountId !== account.id || !readableBlog(value?.blog) || value.blog.id !== blog.id || value.blog.platform !== account.platform || !readableArticle(value?.article) || !/^\d+$/.test(value.article.id) || value.article.blogId !== blog.id || value.article.platform !== account.platform || typeof value.article.bodyHtml !== 'string' || !publishedContent(value.article) || scheduleInstant(value.article.publishedAt) !== scheduleInstant(article.publishedAt) || value?.operation?.status !== 'complete' || typeof value.operation.id !== 'string' || !value.operation.id) throw new Error('The published article receipt could not be verified. Check the same article action before editing again.');
  } else if (unpublishedDraft(article)) validateDraftReceipt(value, account, blog);
  else throw new Error('The original article publication state could not be verified.');
  if (value.article.id !== article.id) throw new Error('The updated article receipt could not be verified. Check the same article action before editing again.');
  draftBody(value.article.title, value.article.bodyHtml);
}
function articleSnapshot(value: any, account: BlogAccount, blog: Blog, article: Article, identity: string): Snapshot {
  if (!readableArticle(value?.article) || value.article.id !== article.id || value.article.blogId !== blog.id || value.article.platform !== account.platform || !(unpublishedDraft(article) ? unpublishedDraft(value.article) : publishedContent(article) && publishedContent(value.article) && scheduleInstant(value.article.publishedAt) === scheduleInstant(article.publishedAt)) || typeof value.version !== 'string' || !value.version) throw new Error('The selected article content and original publication state could not be verified.');
  return { identity, article: value.article, version: value.version };
}

export default function ZernioBlogDrafts({ request, onCreate, onEditDraft, canWrite = false }: { request: Request; onCreate?: (selection: { account: BlogAccount; blog: Blog }) => void; onEditDraft?: (account: BlogAccount, blog: Blog, article: Article) => void; canWrite?: boolean }) {
  const [accounts, setAccounts] = useState<BlogAccount[]>([]), [accountId, setAccountId] = useState(''), [blogs, setBlogs] = useState<Blog[]>([]), [blogId, setBlogId] = useState('');
  const [articles, setArticles] = useState<Article[]>([]), [article, setArticle] = useState<Article | null>(null), [nextCursor, setNextCursor] = useState(''), [page, setPage] = useState(1), [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [accountsLoaded, setAccountsLoaded] = useState(false), [retry, setRetry] = useState(0);
  const requester = useRef(request), mounted = useRef(true), reads = useRef(0), cursors = useRef(new Set<string>());
  const identity = JSON.stringify([accountId, blogId]), view = useMemo(() => ({ identity, pending: false }), [identity]), scope = useRef(view);
  useLayoutEffect(() => { scope.current = view; requester.current = request; }, [view, request]);
  const current = () => mounted.current && scope.current === view, account = accounts.find(row => row.id === accountId), blog = blogs.find(row => row.id === blogId);
  const target = `blogs/${encodeURIComponent(accountId)}${blogId ? '/' + encodeURIComponent(blogId) : ''}`;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; reads.current++; }; }, []);
  useEffect(() => {
    let active = true; setAccountsLoaded(false); setError('');
    requester.current('blogs/accounts').then(result => {
      if (!active) return;
      if (!Array.isArray(result?.accounts) || !result.accounts.every((row: any) => typeof row?.id === 'string' && !!row.id && supported(row.platform) && typeof row.name === 'string' && typeof row.isActive === 'boolean' && typeof row.needsReconnection === 'boolean')) throw new Error('Blog accounts could not be read.');
      setAccounts(result.accounts); setAccountsLoaded(true);
    }).catch(failure => { if (active) setError(failure.message || 'Blog accounts could not be read.'); });
    return () => { active = false; };
  }, [retry]);
  useEffect(() => { cursors.current = new Set(); setNextCursor(''); setPage(1); setArticle(null); setLoaded(false); setBusy(false); setError(''); if (accountId) void load(blogId ? 'articles' : 'blogs'); }, [identity]);
  function chooseAccount(id: string) { scope.current = { identity: '', pending: false }; reads.current++; setAccountId(id); setBlogId(''); setBlogs([]); setArticles([]); setArticle(null); }
  function chooseBlog(id: string) { scope.current = { identity: '', pending: false }; reads.current++; setBlogId(id); setArticles([]); setArticle(null); }
  async function load(resource: 'blogs' | 'articles' | 'article', cursor = '', articleId = '') {
    if (!current() || view.pending || !account || resource !== 'blogs' && !blog) return;
    view.pending = true; const read = ++reads.current; setBusy(true); setError(''); if (resource === 'article') setArticle(null);
    try {
      const suffix = resource === 'article' ? `/articles/${encodeURIComponent(articleId)}` : `${resource === 'articles' ? '/articles' : ''}?limit=20${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`;
      const result = await requester.current(target + suffix);
      if (!current() || read !== reads.current) return;
      if (resource === 'article') {
        if (!readableArticle(result?.article) || result.article.id !== articleId || result.article.blogId !== blogId || result.article.platform !== account.platform) throw new Error('The selected article could not be verified.');
        setArticle(result.article);
      } else {
        const rows = result?.[resource];
        if (!Array.isArray(rows) || rows.length > 50 || !rows.every(row => resource === 'blogs' ? readableBlog(row) && row.platform === account.platform : readableArticle(row) && row.blogId === blogId && row.platform === account.platform)) throw new Error('The blog page could not be verified.');
        const used = cursor ? new Set([...cursors.current, cursor]) : new Set<string>(), next = pageCursor(result.nextCursor, used);
        cursors.current = used; setNextCursor(next); setPage(previous => cursor ? previous + 1 : 1); setLoaded(true);
        if (resource === 'blogs') setBlogs(rows); else { setArticles(rows); setArticle(null); }
      }
    } catch (failure) { if (current() && read === reads.current) setError((failure as Error).message || 'The blog request failed.'); }
    finally { if (current() && read === reads.current) { view.pending = false; setBusy(false); } }
  }
  return <section className="panel settings-panel">
    <div className="panel-heading"><div><h2>Blog articles</h2><p>Browse WordPress and Shopify articles, create or edit drafts, and review publication changes.</p></div></div>
    <p className="helper-note">WordPress scheduling and publication changes require a fresh review. Unverified publication states are read-only. Shopify scheduling is unavailable.</p>
    {error && <p className="alert" role="alert">{error}</p>}{busy && <p role="status">Loading blog content…</p>}
    <label className="field"><span>Blog account</span><select value={accountId} onChange={event => chooseAccount(event.target.value)}><option value="">Choose WordPress or Shopify</option>{accounts.map(row => <option key={row.id} value={row.id}>{row.platform === 'wordpress' ? 'WordPress' : 'Shopify'} · {row.name}{!row.isActive || row.needsReconnection ? ' · Reconnection required' : ''}</option>)}</select></label>
    {!accountsLoaded && <button type="button" className="button" onClick={() => setRetry(value => value + 1)}>Reload blog accounts</button>}{accountsLoaded && !accounts.length && <p>No WordPress or Shopify account is connected to this project.</p>}
    {account && <>{(!account.isActive || account.needsReconnection) && <p className="helper-note">Reconnect this account before creating a draft.</p>}<label className="field"><span>Blog</span><select value={blogId} onChange={event => chooseBlog(event.target.value)}><option value="">Choose a blog</option>{blogs.map(row => <option key={row.id} value={row.id}>{row.title || row.id}</option>)}</select></label>
      {blog && <div className="panel-heading"><h3>{blog.title || blog.id}</h3>{onCreate && <button type="button" className="button primary" disabled={!account.isActive || account.needsReconnection} onClick={() => onCreate({ account, blog })}>Create article draft</button>}</div>}
      {blog && articles.length > 0 && <div className="table-scroll"><table><thead><tr><th>Article</th><th>Status</th><th>Action</th></tr></thead><tbody>{articles.map(row => <tr key={row.id}><td>{row.title || row.id}</td><td>{articleStatus(row)}</td><td><button type="button" className="button" disabled={busy} onClick={() => load('article', '', row.id)}>Read {row.title || row.id}</button>{onEditDraft && (unpublishedDraft(row) || publishedContent(row)) && <button type="button" className="button" disabled={busy || !account.isActive || account.needsReconnection} onClick={() => onEditDraft(account, blog, row)}>{`Edit ${publishedContent(row) ? 'published article' : 'draft'} ${row.title || row.id}`}</button>}</td></tr>)}</tbody></table></div>}
      {loaded && !(blog ? articles : blogs).length && <p>No {blog ? 'articles' : 'blogs'} were returned for this page.</p>}
      <div className="button-wrap"><button type="button" className="button" disabled={busy} onClick={() => load(blog ? 'articles' : 'blogs')}>Refresh first page</button>{loaded && <span>Page {page}</span>}{nextCursor && <button type="button" className="button" disabled={busy} onClick={() => load(blog ? 'articles' : 'blogs', nextCursor)}>Next page</button>}</div>
    </>}
    {article && <section className="panel"><h3>{article.title || article.id}</h3><p>Read-only content · {articleStatus(article)} · Article {article.id}</p>{article.author && <p>Author: {article.author}</p>}{article.handle && <p>Handle: {article.handle}</p>}{!!article.tags?.length && <p>Tags: {article.tags.join(', ')}</p>}{article.excerpt && <p>{article.excerpt}</p>}{article.image && <p>Image: {article.image.url}{article.image.altText ? ' · ' + article.image.altText : ''}</p>}{article.publishedAt && <p>Published: {article.publishedAt}</p>}{article.publishDate && <p>Publication date: {article.publishDate}</p>}{article.createdAt && <p>Created: {article.createdAt}</p>}{article.updatedAt && <p>Updated: {article.updatedAt}</p>}<h4>Raw article HTML</h4><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{article.bodyHtml ?? 'No article HTML was returned.'}</pre>{account && blog && <BlogPublicationReview key={JSON.stringify([account.id, blog.id, article.id])} account={account} blog={blog} article={article} canWrite={canWrite} request={request} onChanged={result => { if (current()) { setArticle(result.article); setArticles(rows => rows.map(row => row.id === result.article.id ? result.article : row)); } }}/>}</section>}
  </section>;
}

export function BlogDraftComposer({ account, blog, article, request, onSaved, readOnly = false }: { account: BlogAccount; blog: Blog; article?: Article; request: Request; onSaved?: (result: any) => void | Promise<void>; readOnly?: boolean }) {
  const [title, setTitle] = useState(''), [bodyHtml, setBodyHtml] = useState<string | null>(article ? null : ''), [review, setReview] = useState<Review | null>(null), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [uncertain, setUncertain] = useState(false), [saved, setSaved] = useState<any>(null), [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [closed, setClosed] = useState<{ id?: string; status?: string; notSent?: boolean } | null>(null);
  const requester = useRef(request), mounted = useRef(true), revision = useRef(0), confirmation = useRef<Review | null>(null);
  const resource = JSON.stringify([account.id, account.platform, blog.id, blog.platform, article?.id, article?.blogId, article?.platform]), original = useMemo(() => article, [resource]), published = !!original && publishedContent(original);
  const writable = !readOnly && account.isActive && !account.needsReconnection && supported(account.platform) && blog.platform === account.platform && (!article || readableArticle(article) && article.blogId === blog.id && article.platform === account.platform && (published ? publishedContent(article) && scheduleInstant(article.publishedAt) === scheduleInstant(original?.publishedAt) : !!original && unpublishedDraft(original) && unpublishedDraft(article)));
  const identity = JSON.stringify([resource, readOnly, account.isActive, account.needsReconnection, article?.publicationState, article?.isPublished, article?.status, article?.publishedAt, article?.publishDate, writable]), view = useMemo(() => ({ resource, pending: false, safety: {} }), [resource]), safety = useMemo(() => ({}), [identity]), scope = useRef(view);
  useLayoutEffect(() => { scope.current = view; if (view.safety !== safety) { view.safety = safety; if (!view.pending && !uncertain) { confirmation.current = null; setReview(null); setConfirmed(false); } } requester.current = request; }, [view, safety, request]);
  const sameDestination = () => mounted.current && scope.current === view, current = () => sameDestination() && view.safety === safety, draftRevision = revision.current, target = `blogs/${encodeURIComponent(account.id)}/${encodeURIComponent(blog.id)}`, detailTarget = `${target}/articles/${encodeURIComponent(article?.id || '')}`;
  const ready = !article || snapshot?.identity === identity;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; revision.current++; }; }, []);
  useEffect(() => { confirmation.current = null; setTitle(''); setBodyHtml(article ? null : ''); setSnapshot(null); setReview(null); setConfirmed(false); setBusy(false); setError(''); setUncertain(false); setSaved(null); setClosed(null); if (article && writable) void loadDraft(true); }, [resource]);
  function change(field: 'title' | 'bodyHtml', value: string) { if (!current() || draftRevision !== revision.current || !writable || !ready || view.pending || uncertain || saved) return; revision.current++; confirmation.current = null; setReview(null); setConfirmed(false); setError(''); if (field === 'title') setTitle(value); else setBodyHtml(value); }
  async function loadDraft(initial = false) {
    if (!current() || !article || !original || !writable || view.pending || !initial && (uncertain || saved || ready)) return;
    const read = ++revision.current; view.pending = true; setBusy(true); setError('');
    try {
      const result = articleSnapshot(await requester.current(detailTarget), account, blog, original, identity);
      if (!current() || read !== revision.current) return;
      setSnapshot(result); if (initial || !closed) { setTitle(result.article.title); setBodyHtml(result.article.bodyHtml); }
    } catch (failure) { if (current() && read === revision.current) setError((failure as Error).message || 'The existing article could not be loaded.'); }
    finally { if (sameDestination()) { view.pending = false; setBusy(false); } }
  }
  async function prepare() {
    if (!current() || draftRevision !== revision.current || !writable || !ready || bodyHtml === null || view.pending || uncertain || saved) return;
    const read = ++revision.current; confirmation.current = null; view.pending = true; setBusy(true); setReview(null); setConfirmed(false); setError('');
    try {
      const body = draftBody(title, bodyHtml), [result, detail] = await Promise.all([requester.current(target), article ? requester.current(detailTarget) : undefined]);
      if (!current() || read !== revision.current) return;
      if (!readableBlog(result?.blog) || result.blog.id !== blog.id || result.blog.platform !== account.platform || typeof result.version !== 'string' || !result.version) throw new Error('The destination blog could not be verified. Review it again.');
      if (article) {
        const fresh = articleSnapshot(detail, account, blog, original!, identity);
        if (fresh.version !== snapshot?.version) throw new Error('This article changed on your site. Your edits were kept. Close and reopen the editor to load its current content.');
        setReview({ identity, safety, revision: read, version: fresh.version, ...body, blog: result.blog, article: fresh.article });
      } else setReview({ identity, safety, revision: read, version: result.version, ...body, blog: result.blog });
    } catch (failure) { if (current() && read === revision.current) setError((failure as Error).message || 'The article could not be reviewed.'); }
    finally { if (sameDestination()) { view.pending = false; setBusy(false); } }
  }
  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!current() || !writable || !ready || view.pending || saved || !review || review.identity !== identity || review.revision !== revision.current || !uncertain && review.safety !== safety || confirmation.current !== review || !confirmed) return;
    view.pending = true; setBusy(true); setError('');
    try {
      const body = { ...draftBody(review.title, review.bodyHtml), version: review.version, ...(article ? { confirmUpdate: true } : { confirmCreate: true }) }, validate = (value: any) => review.article ? validateUpdateReceipt(value, account, review.blog, review.article) : validateDraftReceipt(value, account, review.blog);
      const result = await requester.current(article ? detailTarget + '/update' : target + '/create', body, validate); validate(result);
      if (!sameDestination()) return;
      revision.current++; confirmation.current = null; setSaved(result); setReview(null); setConfirmed(false); setUncertain(false);
      try { await onSaved?.(result); } catch { if (current()) setError(`The article was ${article ? 'updated' : 'created'}, but the article list could not be refreshed. Refresh the browser before another article action.`); }
    } catch (failure) {
      if (sameDestination()) { const problem = failure as Error & { status?: number; code?: string; operation?: { id?: string; status?: string } }; setError(problem.message || 'The article action could not be confirmed.'); if (problem.code === 'OPERATION_NOT_SENT' || problem.operation?.status === 'failed' || problem.code === 'OPERATION_REVIEWED') { revision.current++; confirmation.current = null; setClosed({ ...problem.operation, notSent: problem.code !== 'OPERATION_REVIEWED' }); setSnapshot(null); setReview(null); setConfirmed(false); setUncertain(false); } else if (!problem.status || problem.status >= 500 || ['OPERATION_UNCERTAIN', 'OPERATION_PENDING', 'OPERATION_IN_PROGRESS', 'BLOG_PREVIOUS_OUTCOME_UNRESOLVED'].includes(problem.code || '') || ['pending', 'uncertain'].includes(problem.operation?.status || '')) setUncertain(true); else { revision.current++; confirmation.current = null; setReview(null); setConfirmed(false); } }
    } finally { if (sameDestination()) { view.pending = false; setBusy(false); } }
  }
  return <form className="form-stack" onSubmit={create}>
    <p>{account.platform === 'wordpress' ? 'WordPress' : 'Shopify'} · {account.name} · {blog.title || blog.id}{article && ` · Article ${article.id}`}</p><p className="helper-note">{published ? 'Edit this published WordPress article’s title and HTML. Saving changes the public article immediately while preserving its publication time and published state.' : article ? 'Edit this unpublished article’s title and HTML. Review publication separately in Blog articles.' : 'Create a new unpublished article. Review publication separately in Blog articles.'}</p>
    {error && <p className="alert" role="alert">{error}</p>}{!writable && <p className="alert">Editing requires permission to write, a connected matching account and a verified unpublished draft or published WordPress article.</p>}{closed && <p className="helper-note" role="status">{closed.notSent ? 'This request was not sent. Load current content and review a new action.' : 'The prior action is closed after operator review'} · {closed.id ?? 'Operation ID unavailable'} · {closed.status ?? 'Reviewed'}. Its original outcome is retained in Provider outcomes. Your edits are kept. Refresh the current article and review a new action before saving again.</p>}{article && !ready && writable && <><p role="status">{busy ? 'Loading current article…' : 'Load and verify the current article before editing.'}</p><button type="button" className="button" disabled={busy || uncertain || !!saved} onClick={() => loadDraft()}>{closed ? 'Refresh current article review' : published ? 'Reload existing published article' : 'Reload existing draft'}</button></>}
    <fieldset disabled={busy || uncertain || !!saved || !writable || !ready}><Field label="Article title" name="title" required maxLength={500} value={title} onChange={event => change('title', event.target.value)}/>{bodyHtml === null ? <><p className="field-help">No article HTML was returned. Updating requires an explicit replacement; an empty replacement clears the article body.</p><button type="button" className="button" onClick={() => change('bodyHtml', '')}>Replace unavailable article HTML</button></> : <Field label="Article HTML" name="bodyHtml" multiline maxLength={500000} value={bodyHtml} onChange={event => change('bodyHtml', event.target.value)}/>}<p className="field-help">HTML is kept as text for review. It is never rendered here.</p><button type="button" className="button" disabled={bodyHtml === null} onClick={prepare}>{published ? 'Review published article and destination' : 'Review draft and destination'}</button></fieldset>
    {review && review.identity === identity && review.revision === revision.current && (review.safety === safety || uncertain) && <section className="helper-note"><h3>{published ? 'Review published article changes' : article ? 'Review draft changes' : 'Review new draft'}</h3><p>{account.name} · Account {account.id} · {review.blog.title || review.blog.id} · Blog {review.blog.id}</p>{review.article && <><h4>Current article · {review.article.id} · {published ? 'Published' : 'Unpublished draft'}</h4>{published && <p>Publication time: {review.article.publishedAt} · Published state preserved.</p>}<p>Current title: {review.article.title}</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{review.article.bodyHtml ?? 'No article HTML was returned.'}</pre><h4>Changes to save</h4><p>{review.article.title === review.title ? 'Title unchanged.' : 'Replace the title below.'} {review.article.bodyHtml === review.bodyHtml ? 'HTML unchanged.' : 'Replace the article HTML below.'}</p></>}<p>Title: {review.title}</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{review.bodyHtml}</pre><label className="checkbox-label"><input type="checkbox" checked={confirmed} disabled={busy || uncertain || !writable} onChange={event => { if (!current() || !writable || view.pending || uncertain || review.safety !== safety || review.revision !== revision.current) return; confirmation.current = event.target.checked ? review : null; setConfirmed(event.target.checked); }}/>{published ? 'I reviewed this exact account, blog, article and changes. Save these changes to the public article immediately, preserving its publication time and published state.' : article ? 'I reviewed this exact account, blog, article and changes. Save these changes to the unpublished draft.' : 'I reviewed this account, blog and content. Create this article as an unpublished draft.'}</label><button type="submit" className="button primary" disabled={busy || !confirmed || !writable || !ready}>{busy ? 'Checking article…' : uncertain ? published ? 'Check the same article action' : 'Check the same draft action' : published ? 'Save published article changes' : article ? 'Save unpublished draft changes' : 'Create unpublished draft'}</button></section>}
    {uncertain && <p className="alert" role="status">The outcome needs review in provider outcomes. Your content and action key are retained. Check the same {published ? 'article' : 'draft'} action before changing the content; it is never retried automatically.</p>}
    {saved && <section className="helper-note" role="status"><p>{published ? 'Published article updated' : `Unpublished draft ${article ? 'updated' : 'created'}`} · {saved.article.title} · Article {saved.article.id}. This article is now read-only here.</p>{published && <p>Published state preserved · Publication time: {saved.article.publishedAt}</p>}{article && <><h4>Accepted article HTML</h4><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{saved.article.bodyHtml}</pre></>}</section>}
  </form>;
}

export function BlogPublicationReview({ account, blog, article, canWrite, request, onChanged }: { account: BlogAccount; blog: Blog; article: Article; canWrite: boolean; request: Request; onChanged?: (result: any) => void }) {
  type PublicationReview = { resource: string; safety: object; revision: number; version: string; article: Article; blog: Blog; action: PublicationAction; publishDate?: string };
  const [review, setReview] = useState<PublicationReview | null>(null), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState<Article | null>(null), [scheduledAt, setScheduledAt] = useState(''), [timezone, setTimezone] = useState<'local' | 'utc'>('local');
  const resource = JSON.stringify([account.id, account.platform, blog.id, blog.platform, article.id, article.blogId, article.platform]), writable = canWrite && account.isActive && !account.needsReconnection && blog.platform === account.platform && article.blogId === blog.id && article.platform === account.platform, action = publicationAction(article), schedulable = canPublication(article, 'schedule'), cancellable = canPublication(article, 'cancel-schedule');
  const identity = JSON.stringify([resource, writable, account.isActive, account.needsReconnection, article.publicationState, article.isPublished, article.status, article.publishedAt, article.publishDate, article.title, article.bodyHtml, article.updatedAt]), view = useMemo(() => ({ pending: false, safety: {} }), [resource]), safety = useMemo(() => ({}), [identity]), scope = useRef(view), mounted = useRef(true), revision = useRef(0), confirmation = useRef<PublicationReview | null>(null), requester = useRef(request);
  useLayoutEffect(() => { scope.current = view; view.safety = safety; if (!view.pending && !uncertain) { confirmation.current = null; setReview(null); setConfirmed(false); } }, [view, safety]);
  useLayoutEffect(() => { requester.current = request; }, [request]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; revision.current++; }; }, []);
  useEffect(() => { setReview(null); setConfirmed(false); setBusy(false); setUncertain(false); setError(''); setSaved(null); setScheduledAt(''); setTimezone('local'); confirmation.current = null; }, [resource]);
  const current = () => mounted.current && scope.current === view && view.safety === safety, sameDestination = () => mounted.current && scope.current === view, draftRevision = revision.current, target = `blogs/${encodeURIComponent(account.id)}/${encodeURIComponent(blog.id)}`, detailTarget = `${target}/articles/${encodeURIComponent(article.id)}`;
  function changeTiming(value: string, zone = timezone) {
    if (!current() || !writable || view.pending || uncertain) return;
    revision.current++; confirmation.current = null; setScheduledAt(value); setTimezone(zone); setReview(null); setConfirmed(false); setError('');
  }
  async function prepare(selectedAction: PublicationAction) {
    if (!current() || draftRevision !== revision.current || !writable || !canPublication(article, selectedAction) || view.pending || uncertain) return;
    const read = ++revision.current; view.pending = true; confirmation.current = null; setBusy(true); setReview(null); setConfirmed(false); setSaved(null); setError('');
    try {
      const publishDate = selectedAction === 'schedule' ? localSchedule(scheduledAt, timezone) : undefined;
      const [destination, detail] = await Promise.all([requester.current(target), requester.current(detailTarget)]);
      if (!current() || read !== revision.current) return;
      if (publishDate && Date.parse(publishDate) <= Date.now()) throw new Error('The reviewed publication time has passed. Choose a future time and review again.');
      if (!readableBlog(destination?.blog) || destination.blog.id !== blog.id || destination.blog.platform !== account.platform || typeof destination.version !== 'string' || !destination.version || !readableArticle(detail?.article) || detail.article.id !== article.id || detail.article.blogId !== blog.id || detail.article.platform !== account.platform || typeof detail.article.bodyHtml !== 'string' || !canPublication(detail.article, selectedAction) || detail.article.publicationState !== article.publicationState || typeof detail.version !== 'string' || !detail.version) throw new Error('The exact destination, article content and publication state could not be verified. Refresh the article before reviewing again.');
      setReview({ resource, safety, revision: read, version: detail.version, article: detail.article, blog: destination.blog, action: selectedAction, publishDate });
    } catch (failure) { if (current() && read === revision.current) setError((failure as Error).message || 'The publication review could not be loaded.'); }
    finally { if (sameDestination()) { view.pending = false; setBusy(false); } }
  }
  async function apply(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!current() || !writable || view.pending || !review || review.resource !== resource || review.revision !== revision.current || !uncertain && review.safety !== safety || confirmation.current !== review || !confirmed) return;
    if (!uncertain && (!canPublication(review.article, review.action) || review.publishDate && Date.parse(review.publishDate) <= Date.now())) { confirmation.current = null; setReview(null); setConfirmed(false); setError('The reviewed publication time or state is no longer valid. Refresh the article, choose a future time and review again.'); return; }
    view.pending = true; setBusy(true); setError('');
    try {
      const body = { version: review.version, ...(review.action === 'schedule' ? { publishDate: review.publishDate, confirmSchedule: true } : review.action === 'cancel-schedule' ? { confirmCancelSchedule: true } : review.action === 'publish' ? { confirmPublish: true } : { confirmUnpublish: true }) }, validate = (value: any) => validatePublicationReceipt(value, account, review.blog, review.article, review.action, review.publishDate);
      const result = await requester.current(`${detailTarget}/${review.action}`, body, validate); validate(result);
      if (!sameDestination()) return;
      revision.current++; confirmation.current = null; setReview(null); setConfirmed(false); setUncertain(false); setSaved(result.article); try { onChanged?.(result); } catch { setError('The article change was confirmed. Refresh the article list to see its current state.'); }
    } catch (failure) {
      if (sameDestination()) { const problem = failure as Error & { status?: number; code?: string; operation?: { status?: string } }; setError(problem.code === 'OPERATION_NOT_SENT' || problem.operation?.status === 'failed' ? 'This request was not sent. Load a fresh publication review and acknowledge it before a new action.' : problem.message || 'The publication outcome could not be confirmed.'); if (problem.code === 'OPERATION_NOT_SENT' || problem.operation?.status === 'failed' || problem.code === 'OPERATION_REVIEWED') { revision.current++; confirmation.current = null; setReview(null); setConfirmed(false); setUncertain(false); } else if (!problem.status || problem.status >= 500 || ['OPERATION_UNCERTAIN', 'OPERATION_PENDING', 'OPERATION_IN_PROGRESS', 'BLOG_PREVIOUS_OUTCOME_UNRESOLVED'].includes(problem.code || '') || ['pending', 'uncertain'].includes(problem.operation?.status || '')) setUncertain(true); else { revision.current++; confirmation.current = null; setReview(null); setConfirmed(false); } }
    } finally { if (sameDestination()) { view.pending = false; setBusy(false); } }
  }
  return <form className="form-stack" onSubmit={apply}>
    {error && <p className="alert" role="alert">{error}</p>}
    {!writable && <p className="helper-note">Publication controls require permission to write and a connected matching account.</p>}
    {account.platform === 'shopify' && <p className="helper-note">Shopify scheduling is unavailable because an exact scheduled publication time cannot be verified.</p>}
    {writable && !action && !schedulable && <p className="helper-note">This article’s publication state is unverified. Refresh after checking your site.</p>}
    {writable && action && <button type="button" className="button" disabled={busy || uncertain} onClick={() => prepare(action)}>{busy ? 'Loading publication review…' : `Review ${publicationLabel(action, article)}`}</button>}
    {writable && schedulable && <><label className="field"><span>Publication timezone</span><select value={timezone} disabled={busy || uncertain} onChange={event => { if (event.target.value === 'local' || event.target.value === 'utc') changeTiming(scheduledAt, event.target.value); }}><option value="local">Local ({Intl.DateTimeFormat().resolvedOptions().timeZone})</option><option value="utc">UTC</option></select></label><label className="field"><span>Publication time ({timezone === 'local' ? 'your local timezone' : 'UTC'})</span><input type="datetime-local" value={scheduledAt} disabled={busy || uncertain} onChange={event => changeTiming(event.target.value)}/></label><button type="button" className="button" disabled={busy || uncertain} onClick={() => prepare('schedule')}>{`Review ${publicationLabel('schedule', article)}`}</button></>}
    {writable && cancellable && <button type="button" className="button" disabled={busy || uncertain} onClick={() => prepare('cancel-schedule')}>Review Cancel schedule</button>}
    {review && review.revision === revision.current && (review.safety === safety || uncertain) && <section className="helper-note"><h3>{`Review ${publicationLabel(review.action, review.article)}`}</h3><p>{account.platform === 'wordpress' ? 'WordPress' : 'Shopify'} · {account.name} · Account {account.id} · {review.blog.title || review.blog.id} · Blog {review.blog.id} · Article {review.article.id}</p><p>Current state: {review.article.publicationState}. Title: {review.article.title}</p>{review.article.publishDate && scheduleInstant(review.article.publishDate) && <p>Current publication time: {publicationTime(review.article.publishDate)}</p>}{review.publishDate && <p>New publication time: {publicationTime(review.publishDate)}</p>}<h4>Reviewed article HTML</h4><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{review.article.bodyHtml}</pre><p>The site is checked again before this change. An external edit after that check can still race with this action.</p><label className="checkbox-label"><input type="checkbox" checked={confirmed} disabled={busy || uncertain || !writable} onChange={event => { if (!current() || !writable || view.pending || uncertain || review.revision !== revision.current) return; confirmation.current = event.target.checked ? review : null; setConfirmed(event.target.checked); }}/>{review.action === 'schedule' ? 'I reviewed this exact account, blog, article and publication time in local time and UTC. WordPress will make this article public at the reviewed time.' : review.action === 'cancel-schedule' ? 'I reviewed this exact account, blog, article and current publication time. Cancel schedule removes its planned publication and retains it as an unpublished draft.' : review.action === 'publish' ? 'I reviewed this exact account, blog and article. Publish now makes this article public immediately.' : 'I reviewed this exact account, blog and article. Unpublish removes this article from public view and retains it as a draft.'}</label><button type="submit" className="button primary" disabled={busy || !confirmed || !writable}>{busy ? 'Checking publication…' : uncertain ? 'Check the same publication action' : publicationLabel(review.action, review.article)}</button></section>}
    {uncertain && <p className="alert" role="status">The outcome needs review in provider outcomes. This action key is retained. Check the same publication action before another article change.</p>}
    {saved && <p role="status">{saved.publicationState === 'scheduled' ? `Article scheduled for ${publicationTime(saved.publishDate!)}. This receipt records scheduling acceptance; refresh the article to check its current state` : saved.publicationState === 'published' ? 'Article published' : 'Article unpublished and retained as a draft'} · {saved.title} · Article {saved.id}.</p>}
  </form>;
}
