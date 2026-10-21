import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, CodeBlock, ConfirmDialog, ContentPreview, DataTable, DescriptionList, Disclosure, Field, FormActions, Heading, Link, OperationResults, Stack, StatusLine, Text, Textarea } from '@ten98/ui';
import { AppField } from '@ten98/ui/app';
import PostComposer, { PostVariantPreview } from './PostComposer';
import { PLATFORM_RULES, normalizePostTags, resolveVariant } from '../shared/social-posts.ts';

type Props = { request: (path: string, body?: any, validate?: (result: any) => void) => Promise<any>; post: any; canWrite: boolean; assets?: any[]; campaigns?: any[]; accounts?: any[]; onCancel?: () => void; onChanged?: () => void; onShortenLinks?: (values: Record<string, any>) => Promise<{ content: string; platformOverrides: Record<string, any> }>; onRequestReview?: (path: string, body: { action: string; proposal: EditProposal }) => Promise<any> };
type EditProposal = Record<string, unknown>;
type AskReview = (action: string, proposal: EditProposal) => Promise<any>;
const editPlatforms = ['twitter', 'discord', 'facebook', 'reddit', 'linkedin', 'telegram', 'pinterest', 'googlebusiness', 'youtube', 'slack'];
const removePlatforms = ['threads', 'facebook', 'twitter', 'linkedin', 'youtube', 'pinterest', 'reddit', 'bluesky', 'googlebusiness', 'telegram'];
const accountId = (item: any) => String(item.accountId?._id || item.accountId);
const liveUrl = (value: string) => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined; } catch { return undefined; } };
const deliveryLabel = (item: any) => item.platform === 'tiktok' && (item.platformSpecificData?.isDraft === true || item.platformSpecificData?.draft === true) ? 'Handed to TikTok draft — finish in TikTok' : item.status || 'Not reported';
const deliveryError = (item: any) => [typeof item.errorMessage === 'string' ? item.errorMessage : typeof item.error === 'string' ? item.error : typeof item.error?.message === 'string' ? item.error.message : '', typeof item.errorCategory === 'string' ? item.errorCategory : '', typeof item.errorSource === 'string' ? item.errorSource : ''].filter(Boolean).join(' · ');
type EditReview = { status: 'required' | 'stale' | 'waiting' | 'pending' | 'approved'; proposal: EditProposal; error?: string };
// The send's answer when the project requires publishing approval: this exact change needs an approved review first.
const reviewStatus = (error: any): 'required' | 'stale' | null => error?.status === 403 && error.code === 'PUBLISHING_APPROVAL_REQUIRED' ? 'required' : error?.status === 409 && error.code === 'PUBLISHING_APPROVAL_STALE' ? 'stale' : null;
// Holds a published-copy change whose send needs review and asks for review of exactly that proposal. The send itself
// stays the existing confirmed one: once the review is approved, the same values go out again with confirmEdit.
function useEditReview(postId: string, send?: (proposal: EditProposal) => Promise<any>) {
  const [review, setReview] = useState<EditReview | null>(null), [busy, setBusy] = useState(false);
  const scope = useRef(''), mounted = useRef(true), pending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function hold(error: unknown, proposal: EditProposal) {
    const status = reviewStatus(error), key = JSON.stringify(proposal);
    if (!status) return false;
    scope.current = key;
    // Sending before approval is answered "required" again; the change then reads as not approved yet.
    setReview(previous => ({ status: status === 'required' && previous && ['pending', 'waiting'].includes(previous.status) && JSON.stringify(previous.proposal) === key ? 'waiting' : status, proposal }));
    return true;
  }
  function clear() { scope.current = ''; setReview(null); }
  async function ask() {
    if (!send || !review || pending.current) return;
    const held = review, key = JSON.stringify(held.proposal), current = () => mounted.current && scope.current === key;
    pending.current = true; setBusy(true); setReview({ ...held, error: undefined });
    try {
      const result = await send(held.proposal), status = result?.item?.review?.status;
      if (result?.item?.post?.id !== postId || !['pending', 'approved'].includes(status)) throw new Error('Campaign could not confirm the review. Check Approvals before asking again.');
      if (current()) setReview({ status, proposal: held.proposal });
    } catch (failure) { if (current()) setReview({ ...held, error: (failure as Error).message }); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  return { review, busy, hold, clear, ask: send ? ask : undefined };
}
function EditReviewStatus({ review, busy, ask }: { review: EditReview | null; busy: boolean; ask?: () => void }) {
  if (!review) return null;
  if (review.status === 'pending') return <StatusLine tone="info">This change awaits review by an owner or administrator in Approvals. Send it again after the review is approved.</StatusLine>;
  if (review.status === 'approved') return <StatusLine tone="success">This change is approved. Send it again to update the published copy.</StatusLine>;
  const reason = review.status === 'stale' ? 'This change no longer matches its approved review: the post, its published copy or the change differs from what was approved.' : review.status === 'waiting' ? 'The review of this change is not approved yet. Wait for an owner or administrator to approve it, or ask again if the review was rejected.' : 'This project requires an owner or administrator to approve changes to published copies before they are sent.';
  return <Stack gap={2}>
    <Alert tone="warning" title="Review needed" actions={ask && <Button type="button" disabled={busy} onClick={ask}>Request review of this change</Button>}>{reason} {ask ? 'Request review of this exact change, then send it again once it is approved.' : 'This view cannot submit the change for review.'}</Alert>
    {busy && <StatusLine busy>Submitting the change for review…</StatusLine>}{review.error && <Alert tone="danger">{review.error}</Alert>}
  </Stack>;
}
function PublishedTextEdit({ postId, item, content, busy, askReview, onSend }: { postId: string; item: any; content: string; busy: boolean; askReview?: AskReview; onSend: (content: string, review: ReturnType<typeof useEditReview>) => void }) {
  const review = useEditReview(postId, askReview && (proposal => askReview('social/edit-published', proposal)));
  return <Stack as="form" onSubmit={event => { event.preventDefault(); onSend(String(new FormData(event.currentTarget as HTMLFormElement).get('content')), review); }} onInput={review.clear}><Stack as="fieldset" disabled={busy || review.busy} gap={3}><Field label={item.platform === 'youtube' ? 'Video description' : item.platform === 'pinterest' ? 'Pin description' : 'Published text'}><Textarea name="content" defaultValue={content} maxLength={item.platform === 'linkedin' ? 3000 : item.platform === 'pinterest' ? 800 : item.platform === 'slack' ? 4000 : 10000} required/></Field><Text tone="muted">Platform rules still apply. X requires Premium, a single tweet, and its editing window. Reddit titles and link posts cannot be changed. Pinterest needs API beta access. Media is unchanged.</Text><FormActions><Button type="submit" disabled={busy}>Update live text</Button></FormActions></Stack><EditReviewStatus review={review.review} busy={review.busy} ask={review.ask}/></Stack>;
}
function YouTubeMetadata({ postId, copy, request, askReview, disabled, onAccepted }: { postId: string; copy: any; request: Props['request']; askReview?: AskReview; disabled: boolean; onAccepted: (result: any) => void }) {
  const id = accountId(copy), videoId = copy.platformPostId, identity = JSON.stringify([postId, id, videoId]);
  const scope = useRef(identity), mounted = useRef(true), pending = useRef(false); scope.current = identity;
  const [review, setReview] = useState<any>(null), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState('');
  const [acceptance, setAcceptance] = useState<any>(null);
  const editReview = useEditReview(postId, askReview && (proposal => askReview('social/update-metadata', proposal)));
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
      if (current()) { setAcceptance({ ...result.metadataAcceptance, receiptId: result.operation.id }); setReview(null); editReview.clear(); onAccepted(result); }
    } catch (failure) {
      if (current()) {
        const problem = failure as Error & { status?: number; code?: string; operation?: { status?: string } };
        const proposal = Object.fromEntries(Object.entries(body).filter(([key]) => !['postId', 'confirmEdit'].includes(key)));
        if (editReview.hold(problem, proposal)) { setReview(null); setError(''); return; }
        if (problem.operation?.status !== 'failed' && (!problem.status || problem.status >= 500 || ['OPERATION_UNCERTAIN', 'OPERATION_REVIEWED'].includes(problem.code || '') || ['pending', 'uncertain'].includes(problem.operation?.status || ''))) setUncertain(true);
        setReview(null); setError(problem.message);
      }
    } finally { pending.current = false; if (current()) setBusy(false); }
  }
  if (typeof videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return <Text tone="muted">A published YouTube video ID is required for metadata changes. Refresh status or manage this video in YouTube Studio.</Text>;
  return <Stack as="form" onSubmit={submit} onInput={() => { setReview(null); editReview.clear(); }}>
    <Stack as="fieldset" disabled={disabled || busy || uncertain || editReview.busy} gap={3}>
      <Heading level={4}>YouTube title and keyword tags</Heading><Text tone="muted">Enter replacement values for this copy only. These fields start empty because the current live values are unavailable. Other metadata stays omitted. Zernio’s acceptance receipt does not verify live values.</Text>
      <Checkbox name="changeTitle" label="Change video title"/><AppField label="Replacement video title" name="title" maxLength={100}/>
      <Checkbox name="changeTags" label="Replace keyword tags"/><AppField label="Replacement keyword tags, one per line" name="tags" multiline maxLength={1000}/><Text tone="muted">At most 100 characters per tag and 500 combined. Selecting tags with an empty list requests removal of all keyword tags. Unselected fields stay omitted.</Text>
      {review && <Card headingLevel={4} title="Review metadata request"><Stack gap={1}><Text>Account: {copy.accountId?.displayName || copy.accountId?.username || id} · {id}</Text><Text>Video ID: {videoId}</Text>{Object.hasOwn(review.body, 'title') && <Text>Replacement title: {review.body.title}</Text>}{Object.hasOwn(review.body, 'tags') && <Text>Replacement tags: {review.body.tags.length ? review.body.tags.join(', ') : 'Remove all keyword tags'}</Text>}<Text>Accepted values will remain unverified until checked in YouTube Studio.</Text></Stack></Card>}
      <FormActions><Button type="submit">{review ? 'Confirm metadata request' : 'Review metadata request'}</Button></FormActions>
    </Stack>
    <EditReviewStatus review={editReview.review} busy={editReview.busy} ask={editReview.ask}/>
    {acceptance && <OperationResults title="Last metadata request" items={[{ id: identity, target: `YouTube ${id} · ${videoId}`, status: 'accepted', detail: 'Accepted by Zernio; live values unverified.', receipt: <>Fields: {acceptance.updatedFields.join(', ')}{acceptance.receiptId && <> · Receipt: {acceptance.receiptId}</>}</> }]}/>}
    {error && <Alert tone="danger">{error}</Alert>}{busy && <StatusLine busy>Sending the reviewed metadata request…</StatusLine>}{uncertain && <Text tone="warning">Another request is blocked here. Check YouTube Studio and Provider receipts & recovery before reopening this editor.</Text>}
  </Stack>;
}

function previewCopy(post: any, copy: any, assets: any[]) {
  const variant = resolveVariant(post, copy.platform, assets, copy.accountId ? String(copy.accountId?._id || copy.accountId) : undefined);
  return { ...variant,
    content: typeof copy.customContent === 'string' ? copy.customContent : variant.content,
    mediaItems: Array.isArray(copy.customMedia) ? copy.customMedia : variant.mediaItems,
    options: copy.platformSpecificData && typeof copy.platformSpecificData === 'object' && !Array.isArray(copy.platformSpecificData) ? copy.platformSpecificData : variant.options,
  };
}

export default function PostManagement({ request, post, canWrite, assets = [], campaigns = [], accounts = [], onCancel, onChanged, onShortenLinks, onRequestReview }: Props) {
  const requester = useRef(request); requester.current = request;
  const changed = useRef(onChanged); changed.current = onChanged;
  // Review of a proposed change to a published copy; after approval the same values are sent with confirmEdit.
  const askReview = onRequestReview && ((action: string, proposal: EditProposal) => onRequestReview('approvals/posts/' + encodeURIComponent(post.id) + '/request', { action, proposal }));
  const [current, setCurrent] = useState(post), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [replaceVariants, setReplaceVariants] = useState(false), [confirming, setConfirming] = useState<{ title: string; description: string; confirmLabel: string; danger?: boolean; run: () => Promise<void> }>();
  const copies = current.providerResults || [], editable = !current.providerDeletedAt && ['draft', 'scheduled', 'failed', 'cancelled'].includes(current.status) && !copies.some((item: any) => ['published', 'publishing'].includes(item.status));
  const retryable = !current.providerDeletedAt && ['failed', 'partial'].includes(current.status) && copies.some((item: any) => item.status === 'failed') && (current.status === 'partial') === copies.some((item: any) => item.status === 'published') && copies.every((item: any) => ['failed', 'published', 'cancelled'].includes(item.status));
  const providerAccounts = accounts.length ? accounts : copies.map((item: any) => ({ ...(typeof item.accountId === 'object' ? item.accountId : {}), _id: accountId(item), platform: item.platform }));
  const ambiguousCopies = new Set(copies.map(accountId)).size !== copies.length;
  const accountCopiesReady = !ambiguousCopies && copies.every((item: any) => !copies.some((other: any) => other.platform === item.platform && JSON.stringify([other.customContent, other.customMedia, other.platformSpecificData]) !== JSON.stringify([item.customContent, item.customMedia, item.platformSpecificData])) || current.accountOverrides?.[accountId(item)]?.platform === item.platform);
  const seenCopies = new Map<string, string>(), divergentCopies = copies.some((item: any) => { const configuration = JSON.stringify([item.customContent, item.customMedia, item.platformSpecificData]), previous = seenCopies.get(item.platform); seenCopies.set(item.platform, configuration); return previous !== undefined && previous !== configuration; });
  useEffect(() => { let active = true; setCurrent(post); setBusy(true); setError(''); setNotice(''); requester.current('social/status?postId=' + encodeURIComponent(post.id)).then(async result => { if (active) { setCurrent(result.post); await changed.current?.(); } }).catch(err => { if (active) setError(err.message); }).finally(() => { if (active) setBusy(false); }); return () => { active = false; }; }, [post.id]);
  // `held` takes a failure that its caller handles itself (a change that needs review).
  async function act(path: string, body: any, message: string, held?: (error: unknown) => boolean) {
    setBusy(true); setError(''); setNotice('');
    try { const result = await requester.current(path, body); setCurrent(result.post); setNotice([message, ...(Array.isArray(result.validationWarnings) ? result.validationWarnings.filter((value: unknown) => typeof value === 'string') : [])].join(' ')); onChanged?.(); }
    catch (err) { if (!held?.(err)) setError((err as Error).message); } finally { setBusy(false); }
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
  return <Card as="section" headingLevel={2} title="Provider post" description={`Status: ${current.providerStatus || current.status || 'Unknown'}`} actions={<Button type="button" disabled={busy} onClick={() => act('social/status?postId=' + encodeURIComponent(post.id), undefined, 'Provider status refreshed.')}>Refresh status</Button>}><Stack gap={4}>
    {error && <Alert tone="danger">{error}</Alert>}{notice && <StatusLine tone="success">{notice}</StatusLine>}{busy && <StatusLine busy>Checking with Zernio…</StatusLine>}
    {current.providerDeletedAt ? <Alert tone="info">This unpublished provider record was cancelled. Its local receipt is retained. Create a new draft to publish it again.</Alert> : <>
      <Text tone="muted">Provider changes are checked against the connected accounts in this project. Destinations stay fixed; review each platform’s caption, media, options and timing before saving.</Text>
      {copies.length > 0 && <DataTable searchable={false} sortable={false} pagination={false} ariaLabel="Provider copies" rows={(copies as any[]).map((item, index) => ({ item, index }))} rowKey={({ item, index }) => accountId(item) + index} columns={[
        { key: 'account', header: 'Account', render: ({ item }) => item.accountId?.displayName || item.accountId?.username || item.platform || 'Connected account' },
        { key: 'delivery', header: 'Delivery', wrap: true, render: ({ item }) => <Stack gap={1}><Text as="span">{deliveryLabel(item)}</Text>{deliveryError(item) && <Text size="sm" tone="muted">{deliveryError(item)}</Text>}</Stack> },
        { key: 'published', header: 'Published copy', render: ({ item }) => liveUrl(item.platformPostUrl) ? <Link href={liveUrl(item.platformPostUrl)!} target="_blank" rel="noreferrer">Open post</Link> : 'Not reported' },
      ]}/>}
      {!editable && current.tags?.length > 0 && <Text tone="muted">Stored upload keyword tags: {current.tags.join(', ')}. Published-copy metadata requests have separate receipts; live values are unverified.</Text>}
      {ambiguousCopies && <Text tone="warning">This post repeats an account across different destinations. Content editing is available in Zernio; this app keeps each received copy visible without selecting an ambiguous destination.</Text>}
      {canWrite && editable && !ambiguousCopies ? <>
        {divergentCopies && !accountCopiesReady && <Checkbox checked={replaceVariants} onChange={event => setReplaceVariants(event.target.checked)} label="Some accounts on the same platform have different content. Apply these platform versions to all of those account copies."/>}
        <PostComposer key={current.updatedAt || current.id} post={current} assets={assets} campaigns={campaigns} accounts={providerAccounts} canWrite={canWrite} providerPost busy={busy} onShortenLinks={onShortenLinks} onSubmit={update} onCancel={onCancel} onValidate={values => requester.current('social/validate', values)} onInspectMedia={item => requester.current('social/validate-media', { url: item.url })} onLookupDestinations={(accountId, resource, params = {}) => requester.current(`publishing/accounts/${encodeURIComponent(accountId)}/${encodeURIComponent(resource)}?${new URLSearchParams(params)}`)} onTikTokInfo={(accountId, mediaType) => requester.current(`social/tiktok-creator-info?accountId=${encodeURIComponent(accountId)}&mediaType=${encodeURIComponent(mediaType)}`)}/>
        <FormActions><Button variant="danger" type="button" disabled={busy} onClick={() => setConfirming({ title: 'Cancel this unpublished post and remove its record from Zernio?', description: 'The local receipt will remain. A post already being sent may still go out.', confirmLabel: 'Cancel provider post', danger: true, run: () => act('social/cancel', { postId: post.id, confirmCancellation: true }, 'Provider publication cancelled.') })}>Cancel provider post</Button></FormActions>
      </> : <>{(copies.length ? copies : (current.platforms || []).map((platform: string) => ({ platform }))).map((copy: any, index: number) => {
        const variant = previewCopy(current, copy, assets), name = copy.accountId?.displayName || copy.accountId?.username || providerAccounts.find((account: any) => String(account._id || account.id) === accountId(copy))?.displayName || (copy.accountId ? accountId(copy) : 'Your brand');
        return <Stack as="section" gap={3} key={copy.platform + ':' + index}><Heading level={3}>{PLATFORM_RULES[copy.platform]?.label || copy.platform}</Heading><PostVariantPreview platform={copy.platform} variant={variant} accountName={name} scheduled={current.status === 'scheduled'}/>{Object.keys(variant.options).length > 0 && <Disclosure summary="Publishing options"><DescriptionList items={Object.entries(variant.options).map(([key, value]) => { const label = PLATFORM_RULES[copy.platform]?.options.find(option => option.key === key)?.label || key; return { key, term: label, description: typeof value === 'boolean' ? value ? 'On' : 'Off' : <CodeBlock code={typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)} label={label} wrap/> }; })}/></Disclosure>}</Stack>;
      })}{!copies.length && !current.platforms?.length && <ContentPreview label="Post content" destination="No platform selected" provider="Campaign" text={String(current.content ?? '')}/>}</>}
      {canWrite && retryable && <FormActions><Button type="button" disabled={busy} onClick={() => setConfirming({ title: 'Retry the failed copies now?', description: 'Zernio will publish them immediately. Published and cancelled copies are skipped.', confirmLabel: 'Retry failed copies now', run: () => act('social/retry', { postId: post.id, confirmPublish: true }, 'Failed-copy retry submitted. Published copies are preserved. Refresh status for each account’s result.') })}>Retry failed copies now</Button></FormActions>}
      {canWrite && copies.filter((item: any) => copies.filter((other: any) => accountId(other) === accountId(item)).length === 1 && item.status === 'published' && (editPlatforms.includes(item.platform) || removePlatforms.includes(item.platform))).map((item: any) => <Disclosure key={accountId(item)} summary={'Manage published copy · ' + (item.accountId?.displayName || item.accountId?.username || item.platform)}><Stack gap={4}>
        {item.platform === 'youtube' && <YouTubeMetadata key={post.id + ':' + accountId(item) + ':' + item.platformPostId} postId={post.id} copy={item} request={(path, body, validate) => requester.current(path, body, validate)} askReview={askReview} disabled={busy} onAccepted={result => { setCurrent(result.post); setNotice('Accepted by Zernio; live values unverified. Check YouTube Studio for the current title and keyword tags.'); onChanged?.(); }}/>}
        {editPlatforms.includes(item.platform) && <PublishedTextEdit postId={post.id} item={item} content={item.customContent ?? current.content ?? ''} busy={busy} askReview={askReview} onSend={(content, review) => setConfirming({ title: 'Change the text of this live ' + item.platform + ' copy?', description: 'Existing media will stay in place.', confirmLabel: 'Update live text', run: async () => { let held = false; await act('social/edit-published', { postId: post.id, accountId: accountId(item), content, confirmEdit: true }, 'Published copy updated.', error => (held = review.hold(error, { accountId: accountId(item), content }))); if (!held) review.clear(); } })}/>}
        {removePlatforms.includes(item.platform) && <FormActions><Button variant="danger" type="button" disabled={busy} onClick={() => setConfirming({ title: 'Permanently remove this published ' + item.platform + ' copy?', description: 'This removes the live post and its engagement. YouTube deletion is permanent.', confirmLabel: 'Remove live copy', danger: true, run: () => act('social/unpublish', { postId: post.id, accountId: accountId(item), confirmRemoval: true }, 'Published copy removed.') })}>Remove live copy</Button></FormActions>}
      </Stack></Disclosure>)}
    </>}
    {canWrite && <ConfirmDialog open={!!confirming} onOpenChange={open => { if (!open) setConfirming(undefined); }} title={confirming?.title || ''} description={confirming?.description || ''} confirmLabel={confirming?.confirmLabel} danger={confirming?.danger} onConfirm={() => confirming!.run()}/>}
  </Stack></Card>;
}
