import { useEffect, useRef, useState } from 'react';
import { OperationResults } from '@ten98/ui';
import { AppField } from '@ten98/ui/app';
import PostComposer, { PostVariantPreview } from './PostComposer';
import { PLATFORM_RULES, normalizePostTags, resolveVariant } from '../shared/social-posts.mjs';

type Props = { request: (path: string, body?: any, validate?: (result: any) => void) => Promise<any>; post: any; canWrite: boolean; assets?: any[]; campaigns?: any[]; accounts?: any[]; onCancel?: () => void; onChanged?: () => void; onShortenLinks?: (values: Record<string, any>) => Promise<{ content: string; platformOverrides: Record<string, any> }> };
const editPlatforms = ['twitter', 'discord', 'facebook', 'reddit', 'linkedin', 'telegram', 'pinterest', 'googlebusiness', 'youtube', 'slack'];
const removePlatforms = ['threads', 'facebook', 'twitter', 'linkedin', 'youtube', 'pinterest', 'reddit', 'bluesky', 'googlebusiness', 'telegram'];
const accountId = (item: any) => String(item.accountId?._id || item.accountId);
const liveUrl = (value: string) => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined; } catch { return undefined; } };
const deliveryLabel = (item: any) => item.platform === 'tiktok' && (item.platformSpecificData?.isDraft === true || item.platformSpecificData?.draft === true) ? 'Handed to TikTok draft — finish in TikTok' : item.status || 'Not reported';
const deliveryError = (item: any) => [typeof item.errorMessage === 'string' ? item.errorMessage : typeof item.error === 'string' ? item.error : typeof item.error?.message === 'string' ? item.error.message : '', typeof item.errorCategory === 'string' ? item.errorCategory : '', typeof item.errorSource === 'string' ? item.errorSource : ''].filter(Boolean).join(' · ');
function YouTubeMetadata({ postId, copy, request, disabled, onAccepted }: { postId: string; copy: any; request: Props['request']; disabled: boolean; onAccepted: (result: any) => void }) {
  const id = accountId(copy), videoId = copy.platformPostId, identity = JSON.stringify([postId, id, videoId]);
  const scope = useRef(identity), mounted = useRef(true), pending = useRef(false); scope.current = identity;
  const [review, setReview] = useState<any>(null), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState('');
  const [acceptance, setAcceptance] = useState<any>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setReview(null); setError(''); setUncertain(false); setAcceptance(null); }, [identity]);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || pending.current || uncertain) return;
    const form = event.currentTarget, values = new FormData(form), body: any = { postId, accountId: id, videoId, confirmEdit: true };
    try {
      if (values.has('changeTitle')) { body.title = String(values.get('title') || '').trim(); if (!body.title || body.title.length > 100 || /[\u0000-\u001f\u007f]/u.test(body.title)) throw new Error('Enter a title of 1–100 characters without control characters.'); }
      if (values.has('changeTags')) body.tags = normalizePostTags(String(values.get('tags') || '').split('\n').map(value => value.trim()).filter(Boolean), { preserve: true });
      if (!Object.hasOwn(body, 'title') && !Object.hasOwn(body, 'tags')) throw new Error('Select the title or keyword tags to change.');
      setError('');
    } catch (failure) { setReview(null); setError((failure as Error).message); return; }
    if (!review || review.identity !== identity || JSON.stringify(review.body) !== JSON.stringify(body)) { setReview({ identity, body }); return; }
    const view = identity, current = () => mounted.current && scope.current === view;
    pending.current = true; setBusy(true); setError('');
    try {
      const validate = (result: any) => {
        const accepted = result.metadataAcceptance, fields = ['title', 'tags'].filter(field => Object.hasOwn(body, field));
        if (result.operation?.status !== 'complete' || result.post?.id !== postId || !accepted || accepted.postId !== postId || accepted.accountId !== id || accepted.videoId !== videoId || JSON.stringify(accepted.requested) !== JSON.stringify(Object.fromEntries(fields.map(field => [field, body[field]]))) || !Array.isArray(accepted.updatedFields) || accepted.updatedFields.length !== fields.length || new Set(accepted.updatedFields).size !== fields.length || fields.some(field => !accepted.updatedFields.includes(field))) throw new Error('The metadata acceptance receipt could not be read. Review Provider receipts & recovery before another attempt.');
      };
      const result = await request('social/update-metadata', body, validate); validate(result);
      if (current()) { setAcceptance({ ...result.metadataAcceptance, receiptId: result.operation.id }); setReview(null); onAccepted(result); }
    } catch (failure) {
      if (current()) {
        const problem = failure as Error & { status?: number; code?: string; operation?: { status?: string } };
        if (problem.operation?.status !== 'failed' && (!problem.status || problem.status >= 500 || ['OPERATION_UNCERTAIN', 'OPERATION_REVIEWED'].includes(problem.code || '') || ['pending', 'uncertain'].includes(problem.operation?.status || ''))) setUncertain(true);
        setReview(null); setError(problem.message);
      }
    } finally { pending.current = false; if (current()) setBusy(false); }
  }
  if (typeof videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return <p className="field-help">A published YouTube video ID is required for metadata changes. Refresh status or manage this video in YouTube Studio.</p>;
  return <form onSubmit={submit} onInput={() => setReview(null)}>
    <fieldset disabled={disabled || busy || uncertain}>
      <h4>YouTube title and keyword tags</h4><p className="field-help">Enter replacement values for this copy only. These fields start empty because the current live values are unavailable. Other metadata stays omitted. Zernio’s acceptance receipt does not verify live values.</p>
      <label><input type="checkbox" name="changeTitle"/>Change video title</label><AppField label="Replacement video title" name="title" maxLength={100}/>
      <label><input type="checkbox" name="changeTags"/>Replace keyword tags</label><AppField label="Replacement keyword tags, one per line" name="tags" multiline maxLength={1000}/><p className="field-help">At most 100 characters per tag and 500 combined. Selecting tags with an empty list requests removal of all keyword tags. Unselected fields stay omitted.</p>
      {review && <div className="details"><h4>Review metadata request</h4><p>Account: {copy.accountId?.displayName || copy.accountId?.username || id} · {id}</p><p>Video ID: {videoId}</p>{Object.hasOwn(review.body, 'title') && <p>Replacement title: {review.body.title}</p>}{Object.hasOwn(review.body, 'tags') && <p>Replacement tags: {review.body.tags.length ? review.body.tags.join(', ') : 'Remove all keyword tags'}</p>}<p>Accepted values will remain unverified until checked in YouTube Studio.</p></div>}
      <button className="button" type="submit">{review ? 'Confirm metadata request' : 'Review metadata request'}</button>
    </fieldset>
    {acceptance && <OperationResults title="Last metadata request" items={[{ id: identity, target: `YouTube ${id} · ${videoId}`, status: 'accepted', detail: 'Accepted by Zernio; live values unverified.', receipt: <>Fields: {acceptance.updatedFields.join(', ')}{acceptance.receiptId && <> · Receipt: {acceptance.receiptId}</>}</> }]}/>}
    {error && <p className="alert" role="alert">{error}</p>}{busy && <p role="status">Sending the reviewed metadata request…</p>}{uncertain && <p className="helper-note">Another request is blocked here. Check YouTube Studio and Provider receipts & recovery before reopening this editor.</p>}
  </form>;
}

function previewCopy(post: any, copy: any, assets: any[]) {
  const variant = resolveVariant(post, copy.platform, assets, copy.accountId ? String(copy.accountId?._id || copy.accountId) : undefined);
  return { ...variant,
    content: typeof copy.customContent === 'string' ? copy.customContent : variant.content,
    mediaItems: Array.isArray(copy.customMedia) ? copy.customMedia : variant.mediaItems,
    options: copy.platformSpecificData && typeof copy.platformSpecificData === 'object' && !Array.isArray(copy.platformSpecificData) ? copy.platformSpecificData : variant.options,
  };
}

export default function PostManagement({ request, post, canWrite, assets = [], campaigns = [], accounts = [], onCancel, onChanged, onShortenLinks }: Props) {
  const requester = useRef(request); requester.current = request;
  const changed = useRef(onChanged); changed.current = onChanged;
  const [current, setCurrent] = useState(post), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [replaceVariants, setReplaceVariants] = useState(false);
  const copies = current.providerResults || [], editable = !current.providerDeletedAt && ['draft', 'scheduled', 'failed', 'cancelled'].includes(current.status) && !copies.some((item: any) => ['published', 'publishing'].includes(item.status));
  const retryable = !current.providerDeletedAt && ['failed', 'partial'].includes(current.status) && copies.some((item: any) => item.status === 'failed') && (current.status === 'partial') === copies.some((item: any) => item.status === 'published') && copies.every((item: any) => ['failed', 'published', 'cancelled'].includes(item.status));
  const providerAccounts = accounts.length ? accounts : copies.map((item: any) => ({ ...(typeof item.accountId === 'object' ? item.accountId : {}), _id: accountId(item), platform: item.platform }));
  const ambiguousCopies = new Set(copies.map(accountId)).size !== copies.length;
  const accountCopiesReady = !ambiguousCopies && copies.every((item: any) => !copies.some((other: any) => other.platform === item.platform && JSON.stringify([other.customContent, other.customMedia, other.platformSpecificData]) !== JSON.stringify([item.customContent, item.customMedia, item.platformSpecificData])) || current.accountOverrides?.[accountId(item)]?.platform === item.platform);
  const seenCopies = new Map<string, string>(), divergentCopies = copies.some((item: any) => { const configuration = JSON.stringify([item.customContent, item.customMedia, item.platformSpecificData]), previous = seenCopies.get(item.platform); seenCopies.set(item.platform, configuration); return previous !== undefined && previous !== configuration; });
  useEffect(() => { let active = true; setCurrent(post); setBusy(true); setError(''); setNotice(''); requester.current('social/status?postId=' + encodeURIComponent(post.id)).then(async result => { if (active) { setCurrent(result.post); await changed.current?.(); } }).catch(err => { if (active) setError(err.message); }).finally(() => { if (active) setBusy(false); }); return () => { active = false; }; }, [post.id]);
  async function act(path: string, body: any, message: string) {
    setBusy(true); setError(''); setNotice('');
    try { const result = await requester.current(path, body); setCurrent(result.post); setNotice([message, ...(Array.isArray(result.validationWarnings) ? result.validationWarnings.filter((value: unknown) => typeof value === 'string') : [])].join(' ')); onChanged?.(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function update(values: Record<string, any>) {
    if (ambiguousCopies) throw new Error('This provider post repeats an account across destinations. Edit it in Zernio until each destination can be selected safely.');
    if (divergentCopies && !accountCopiesReady && !replaceVariants) throw new Error('Confirm replacing the different account copies before applying platform-wide versions.');
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await requester.current('social/update', { postId: post.id, content: values.content, ...(values.tags !== undefined ? { tags: values.tags } : {}), mediaItems: values.mediaItems, assetId: values.assetId, platformOverrides: values.platformOverrides, ...(values.accountOverrides !== undefined ? { accountOverrides: values.accountOverrides } : {}), ...(replaceVariants ? { confirmReplaceVariants: true } : {}), mode: values.scheduledAt ? 'scheduled' : 'draft', ...(values.scheduledAt ? { scheduledAt: values.scheduledAt } : {}) });
      setCurrent(result.post); setNotice(['Platform versions and schedule saved with Zernio.', ...(Array.isArray(result.validationWarnings) ? result.validationWarnings.filter((value: unknown) => typeof value === 'string') : [])].join(' ')); onChanged?.();
    } finally { setBusy(false); }
  }
  return <section>
    <div className="panel-heading"><div><h2>Provider post</h2><p>Status: {current.providerStatus || current.status || 'Unknown'}</p></div><button type="button" className="button" disabled={busy} onClick={() => act('social/status?postId=' + encodeURIComponent(post.id), undefined, 'Provider status refreshed.')}>Refresh status</button></div>
    {error && <div className="alert" role="alert">{error}</div>}{notice && <p role="status">{notice}</p>}{busy && <p role="status">Checking with Zernio…</p>}
    {current.providerDeletedAt ? <div className="alert">This unpublished provider record was cancelled. Its local receipt is retained. Create a new draft to publish it again.</div> : <>
      <p className="field-help">Provider changes are checked against the connected accounts in this project. Destinations stay fixed; review each platform’s caption, media, options and timing before saving.</p>
      {copies.length > 0 && <div className="table-scroll"><table><thead><tr><th>Account</th><th>Delivery</th><th>Published copy</th></tr></thead><tbody>{copies.map((item: any, index: number) => <tr key={accountId(item) + index}><td>{item.accountId?.displayName || item.accountId?.username || item.platform || 'Connected account'}</td><td>{deliveryLabel(item)}{deliveryError(item) && <p className="field-help">{deliveryError(item)}</p>}</td><td>{liveUrl(item.platformPostUrl) ? <a href={liveUrl(item.platformPostUrl)} target="_blank" rel="noreferrer">Open post</a> : 'Not reported'}</td></tr>)}</tbody></table></div>}
      {!editable && current.tags?.length > 0 && <p className="field-help">Stored upload keyword tags: {current.tags.join(', ')}. Published-copy metadata requests have separate receipts; live values are unverified.</p>}
      {ambiguousCopies && <p className="helper-note">This post repeats an account across different destinations. Content editing is available in Zernio; this app keeps each received copy visible without selecting an ambiguous destination.</p>}
      {canWrite && editable && !ambiguousCopies ? <>
        {divergentCopies && !accountCopiesReady && <label className="checkbox-label"><input type="checkbox" checked={replaceVariants} onChange={event => setReplaceVariants(event.target.checked)}/>Some accounts on the same platform have different content. Apply these platform versions to all of those account copies.</label>}
        <PostComposer key={current.updatedAt || current.id} post={current} assets={assets} campaigns={campaigns} accounts={providerAccounts} canWrite={canWrite} providerPost busy={busy} onShortenLinks={onShortenLinks} onSubmit={update} onCancel={onCancel} onValidate={values => requester.current('social/validate', values)} onInspectMedia={item => requester.current('social/validate-media', { url: item.url })} onLookupDestinations={(accountId, resource, params = {}) => requester.current(`publishing/accounts/${encodeURIComponent(accountId)}/${encodeURIComponent(resource)}?${new URLSearchParams(params)}`)} onTikTokInfo={(accountId, mediaType) => requester.current(`social/tiktok-creator-info?accountId=${encodeURIComponent(accountId)}&mediaType=${encodeURIComponent(mediaType)}`)}/>
        <div className="modal-actions"><button className="button danger" type="button" disabled={busy} onClick={() => { if (window.confirm('Cancel this unpublished post and remove its record from Zernio? The local receipt will remain. A post already being sent may still go out.')) act('social/cancel', { postId: post.id, confirmCancellation: true }, 'Provider publication cancelled.'); }}>Cancel provider post</button></div>
      </> : <>{(copies.length ? copies : (current.platforms || []).map((platform: string) => ({ platform }))).map((copy: any, index: number) => {
        const variant = previewCopy(current, copy, assets), name = copy.accountId?.displayName || copy.accountId?.username || providerAccounts.find((account: any) => String(account._id || account.id) === accountId(copy))?.displayName || (copy.accountId ? accountId(copy) : 'Your brand');
        return <section className="details" key={copy.platform + ':' + index}><h3>{PLATFORM_RULES[copy.platform]?.label || copy.platform}</h3><PostVariantPreview platform={copy.platform} variant={variant} accountName={name} scheduled={current.status === 'scheduled'}/>{Object.keys(variant.options).length > 0 && <details><summary>Publishing options</summary><dl>{Object.entries(variant.options).map(([key, value]) => <div key={key}><dt>{PLATFORM_RULES[copy.platform]?.options.find(option => option.key === key)?.label || key}</dt><dd style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{typeof value === 'boolean' ? value ? 'On' : 'Off' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)}</dd></div>)}</dl></details>}</section>;
      })}{!copies.length && !current.platforms?.length && <p className="agent-answer">{current.content}</p>}</>}
      {canWrite && retryable && <div className="modal-actions"><button className="button" disabled={busy} onClick={() => { if (window.confirm('Retry the failed copies now? Zernio will publish them immediately. Published and cancelled copies are skipped.')) act('social/retry', { postId: post.id, confirmPublish: true }, 'Failed-copy retry submitted. Published copies are preserved. Refresh status for each account’s result.'); }}>Retry failed copies now</button></div>}
      {canWrite && copies.filter((item: any) => copies.filter((other: any) => accountId(other) === accountId(item)).length === 1 && item.status === 'published' && (editPlatforms.includes(item.platform) || removePlatforms.includes(item.platform))).map((item: any) => <details key={accountId(item)}><summary>Manage published copy · {item.accountId?.displayName || item.accountId?.username || item.platform}</summary>
        {item.platform === 'youtube' && <YouTubeMetadata key={post.id + ':' + accountId(item) + ':' + item.platformPostId} postId={post.id} copy={item} request={(path, body, validate) => requester.current(path, body, validate)} disabled={busy} onAccepted={result => { setCurrent(result.post); setNotice('Accepted by Zernio; live values unverified. Check YouTube Studio for the current title and keyword tags.'); onChanged?.(); }}/>}
        {editPlatforms.includes(item.platform) && <form onSubmit={event => { event.preventDefault(); const content = String(new FormData(event.currentTarget).get('content')); if (window.confirm('Change the text of this live ' + item.platform + ' copy? Existing media will stay in place.')) act('social/edit-published', { postId: post.id, accountId: accountId(item), content, confirmEdit: true }, 'Published copy updated.'); }}><fieldset disabled={busy}><label className="field"><span>{item.platform === 'youtube' ? 'Video description' : item.platform === 'pinterest' ? 'Pin description' : 'Published text'}</span><textarea name="content" defaultValue={item.customContent ?? current.content ?? ''} maxLength={item.platform === 'linkedin' ? 3000 : item.platform === 'pinterest' ? 800 : item.platform === 'slack' ? 4000 : 10000} required/></label><p className="field-help">Platform rules still apply. X requires Premium, a single tweet, and its editing window. Reddit titles and link posts cannot be changed. Pinterest needs API beta access. Media is unchanged.</p><button className="button" disabled={busy}>Update live text</button></fieldset></form>}
        {removePlatforms.includes(item.platform) && <div className="modal-actions"><button className="button danger" disabled={busy} onClick={() => { if (window.confirm('Permanently remove this published ' + item.platform + ' copy? This removes the live post and its engagement. YouTube deletion is permanent.')) act('social/unpublish', { postId: post.id, accountId: accountId(item), confirmRemoval: true }, 'Published copy removed.'); }}>Remove live copy</button></div>}
      </details>)}
    </>}
  </section>;
}
