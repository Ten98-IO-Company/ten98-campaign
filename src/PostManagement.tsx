import { useEffect, useRef, useState } from 'react';
import PostComposer, { PostVariantPreview } from './PostComposer';
import { PLATFORM_RULES, resolveVariant } from '../shared/social-posts.mjs';

type Props = { request: (path: string, body?: any) => Promise<any>; post: any; canWrite: boolean; assets?: any[]; campaigns?: any[]; accounts?: any[]; onCancel?: () => void; onChanged?: () => void; onShortenLinks?: (values: Record<string, any>) => Promise<{ content: string; platformOverrides: Record<string, any> }> };
const editPlatforms = ['twitter', 'discord', 'facebook', 'reddit', 'linkedin', 'telegram', 'pinterest', 'googlebusiness', 'youtube', 'slack'];
const removePlatforms = ['threads', 'facebook', 'twitter', 'linkedin', 'youtube', 'pinterest', 'reddit', 'bluesky', 'googlebusiness', 'telegram'];
const accountId = (item: any) => String(item.accountId?._id || item.accountId);
const liveUrl = (value: string) => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined; } catch { return undefined; } };
const deliveryLabel = (item: any) => item.platform === 'tiktok' && (item.platformSpecificData?.isDraft === true || item.platformSpecificData?.draft === true) ? 'Handed to TikTok draft — finish in TikTok' : item.status || 'Not reported';
function previewCopy(post: any, copy: any, assets: any[]) {
  const variant = resolveVariant(post, copy.platform, assets);
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
  const providerAccounts = accounts.length ? accounts : copies.map((item: any) => ({ ...(typeof item.accountId === 'object' ? item.accountId : {}), _id: accountId(item), platform: item.platform }));
  const seenCopies = new Map<string, string>(), divergentCopies = copies.some((item: any) => { const configuration = JSON.stringify([item.customContent, item.customMedia, item.platformSpecificData]), previous = seenCopies.get(item.platform); seenCopies.set(item.platform, configuration); return previous !== undefined && previous !== configuration; });
  useEffect(() => { let active = true; setCurrent(post); setBusy(true); setError(''); setNotice(''); requester.current('social/status?postId=' + encodeURIComponent(post.id)).then(async result => { if (active) { setCurrent(result.post); await changed.current?.(); } }).catch(err => { if (active) setError(err.message); }).finally(() => { if (active) setBusy(false); }); return () => { active = false; }; }, [post.id]);
  async function act(path: string, body: any, message: string) {
    setBusy(true); setError(''); setNotice('');
    try { const result = await requester.current(path, body); setCurrent(result.post); setNotice(message); onChanged?.(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function update(values: Record<string, any>) {
    if (divergentCopies && !replaceVariants) throw new Error('Confirm replacing the different account copies before applying platform-wide versions.');
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await requester.current('social/update', { postId: post.id, content: values.content, mediaItems: values.mediaItems, assetId: values.assetId, platformOverrides: values.platformOverrides, ...(replaceVariants ? { confirmReplaceVariants: true } : {}), mode: values.scheduledAt ? 'scheduled' : 'draft', ...(values.scheduledAt ? { scheduledAt: values.scheduledAt } : {}) });
      setCurrent(result.post); setNotice('Platform versions and schedule saved with Zernio.'); onChanged?.();
    } finally { setBusy(false); }
  }
  return <section>
    <div className="panel-heading"><div><h2>Provider post</h2><p>Status: {current.providerStatus || current.status || 'Unknown'}</p></div><button type="button" className="button" disabled={busy} onClick={() => act('social/status?postId=' + encodeURIComponent(post.id), undefined, 'Provider status refreshed.')}>Refresh status</button></div>
    {error && <div className="alert" role="alert">{error}</div>}{notice && <p role="status">{notice}</p>}{busy && <p role="status">Checking with Zernio…</p>}
    {current.providerDeletedAt ? <div className="alert">This unpublished provider record was cancelled. Its local receipt is retained. Create a new draft to publish it again.</div> : <>
      <p className="field-help">Provider changes are checked against the connected accounts in this project. Destinations stay fixed; review each platform’s caption, media, options and timing before saving.</p>
      {copies.length > 0 && <div className="table-scroll"><table><thead><tr><th>Account</th><th>Delivery</th><th>Published copy</th></tr></thead><tbody>{copies.map((item: any, index: number) => <tr key={accountId(item) + index}><td>{item.accountId?.displayName || item.accountId?.username || item.platform || 'Connected account'}</td><td>{deliveryLabel(item)}{item.error && <p className="field-help">{typeof item.error === 'string' ? item.error : item.error.message || 'Provider rejected this copy.'}</p>}</td><td>{liveUrl(item.platformPostUrl) ? <a href={liveUrl(item.platformPostUrl)} target="_blank" rel="noreferrer">Open post</a> : 'Not reported'}</td></tr>)}</tbody></table></div>}
      {canWrite && editable ? <>
        {divergentCopies && <label className="checkbox-label"><input type="checkbox" checked={replaceVariants} onChange={event => setReplaceVariants(event.target.checked)}/>Some accounts on the same platform have different content. Apply these platform versions to all of those account copies.</label>}
        <PostComposer key={current.updatedAt || current.id} post={current} assets={assets} campaigns={campaigns} accounts={providerAccounts} canWrite={canWrite} providerPost busy={busy} onShortenLinks={onShortenLinks} onSubmit={update} onCancel={onCancel} onValidate={values => requester.current('social/validate', values)} onInspectMedia={item => requester.current('social/validate-media', { url: item.url })} onTikTokInfo={(accountId, mediaType) => requester.current(`social/tiktok-creator-info?accountId=${encodeURIComponent(accountId)}&mediaType=${encodeURIComponent(mediaType)}`)}/>
        <div className="modal-actions"><button className="button danger" type="button" disabled={busy} onClick={() => { if (window.confirm('Cancel this unpublished post and remove its record from Zernio? The local receipt will remain. A post already being sent may still go out.')) act('social/cancel', { postId: post.id, confirmCancellation: true }, 'Provider publication cancelled.'); }}>Cancel provider post</button></div>
      </> : <>{(copies.length ? copies : (current.platforms || []).map((platform: string) => ({ platform }))).map((copy: any, index: number) => {
        const variant = previewCopy(current, copy, assets), name = copy.accountId?.displayName || copy.accountId?.username || providerAccounts.find((account: any) => String(account._id || account.id) === accountId(copy))?.displayName || (copy.accountId ? accountId(copy) : 'Your brand');
        return <section className="details" key={copy.platform + ':' + index}><h3>{PLATFORM_RULES[copy.platform]?.label || copy.platform}</h3><PostVariantPreview platform={copy.platform} variant={variant} accountName={name} scheduled={current.status === 'scheduled'}/>{Object.keys(variant.options).length > 0 && <details><summary>Publishing options</summary><dl>{Object.entries(variant.options).map(([key, value]) => <div key={key}><dt>{PLATFORM_RULES[copy.platform]?.options.find(option => option.key === key)?.label || key}</dt><dd style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{typeof value === 'boolean' ? value ? 'On' : 'Off' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)}</dd></div>)}</dl></details>}</section>;
      })}{!copies.length && !current.platforms?.length && <p className="agent-answer">{current.content}</p>}</>}
      {canWrite && current.status === 'failed' && editable && <div className="modal-actions"><button className="button" disabled={busy} onClick={() => { if (window.confirm('Retry this failed post now? Zernio will attempt immediate publication to its existing accounts.')) act('social/retry', { postId: post.id, confirmPublish: true }, 'Retry submitted. Refresh status for each account’s result.'); }}>Retry publishing now</button></div>}
      {canWrite && copies.filter((item: any) => item.status === 'published' && (editPlatforms.includes(item.platform) || removePlatforms.includes(item.platform))).map((item: any) => <details key={accountId(item)}><summary>Manage published copy · {item.accountId?.displayName || item.accountId?.username || item.platform}</summary>
        {editPlatforms.includes(item.platform) && <form onSubmit={event => { event.preventDefault(); const content = String(new FormData(event.currentTarget).get('content')); if (window.confirm('Change the text of this live ' + item.platform + ' copy? Existing media will stay in place.')) act('social/edit-published', { postId: post.id, accountId: accountId(item), content, confirmEdit: true }, 'Published copy updated.'); }}><fieldset disabled={busy}><label className="field"><span>{item.platform === 'youtube' ? 'Video description' : item.platform === 'pinterest' ? 'Pin description' : 'Published text'}</span><textarea name="content" defaultValue={item.customContent ?? current.content ?? ''} maxLength={item.platform === 'linkedin' ? 3000 : item.platform === 'pinterest' ? 800 : item.platform === 'slack' ? 4000 : 10000} required/></label><p className="field-help">Platform rules still apply. X requires Premium, a single tweet, and its editing window. Reddit titles and link posts cannot be changed. Pinterest needs API beta access. Media is unchanged.</p><button className="button" disabled={busy}>Update live text</button></fieldset></form>}
        {removePlatforms.includes(item.platform) && <div className="modal-actions"><button className="button danger" disabled={busy} onClick={() => { if (window.confirm('Permanently remove this published ' + item.platform + ' copy? This removes the live post and its engagement. YouTube deletion is permanent.')) act('social/unpublish', { postId: post.id, accountId: accountId(item), confirmRemoval: true }, 'Published copy removed.'); }}>Remove live copy</button></div>}
      </details>)}
    </>}
  </section>;
}
