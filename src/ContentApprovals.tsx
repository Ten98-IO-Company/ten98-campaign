import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Checkbox, CodeBlock, DescriptionList, Disclosure, EmptyState, FeatureControls, Field, FormActions, Grid, Heading, Inline, Link, List, ListItem, Option, Progress, ReviewSummary, SegmentedControl, Select, StatusLine, Stack, Switch, Text, Textarea, ValidationSummary, type ReviewChange, type ValidationTarget, useConfirmDialog } from '@ten98/ui';
import { PostVariantPreview } from './PostComposer';
import { PLATFORM_RULES } from '../shared/social-posts.ts';
import { reviewKeyAction } from './review-keys';
import { adSpendActionLabel, adSpendPlatformLabel, formatMinorUnits } from './approval-status';

type Props = { projectId: string; role: string; request: (path: string, method?: string, body?: unknown, key?: string) => Promise<any>; onChanged?: () => void | Promise<void> };
const label = (value: string) => ({ not_requested: 'Not requested', pending: 'Awaiting review', approved: 'Approved', rejected: 'Changes requested', stale: 'Changed since review', submitted: 'Submitted to provider' }[value] || value);
const when = (value: string) => new Date(value).toLocaleString();
const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function link(value?: string) { try { const url = new URL(value || ''); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; } catch { return ''; } }
// Reviewed text keeps its line breaks without native pre-wrap markup.
const lines = (text: unknown) => <Text preserveWhitespace>{String(text ?? '')}</Text>;
// The Approve button and the A key share one block: an unverified queue or any creative not yet approved.
// A submitted post has no queue to verify, and a proposed update is checked against the creative it would send.
const approveBlocked = (item: any) => Boolean(item.post.queueId && !item.queue?.ready && !item.publishedEdit && !item.proposedUpdate) || (item.proposedUpdate?.assets || item.assets || (item.asset ? [item.asset] : [])).some((asset: any) => asset.missing || asset.approval !== 'approved');
// Bulk review ported from pendpost/pendpost@42ac77b29f7720a912bdce1507b16a2a56fca74f app/src/components/Freigaben.jsx:1013-1100 and 1213-1276 (MIT):
// it touches only the visible, actionable, selected posts and sends each one the single-card review request in turn.
type Restriction = { platform?: string; field?: string; message: string; accountId?: string };
// One validation target per platform and account, as the server reports the restrictions that refused an approval.
const restrictionTargets = (rows: Restriction[]): ValidationTarget[] => Object.values(rows.reduce<Record<string, ValidationTarget>>((targets, row, index) => { const key = (row.platform || '') + ':' + (row.accountId || ''), target = targets[key] ||= { id: key, target: [row.platform ? PLATFORM_RULES[row.platform]?.label || row.platform : 'Post', row.accountId && 'Account ' + row.accountId].filter(Boolean).join(' · '), status: 'error', messages: [] }; target.messages = [...(target.messages || []), { id: String(index), text: row.message }]; return targets; }, {}));
const postName = (item: any) => String(item.post.content || '').trim().slice(0, 60) || item.post.id;
const options = (platform: string, values: Record<string, unknown>) => Object.entries(values).map(([key, value]) => ({ key, term: PLATFORM_RULES[platform]?.options.find((option: any) => option.key === key)?.label || key, description: value && typeof value === 'object' ? <CodeBlock code={JSON.stringify(value, null, 2)} label={key} wrap/> : <Stack gap={0}>{lines(typeof value === 'boolean' ? value ? 'On' : 'Off' : String(value))}</Stack> }));
// A pending review of a change to a submitted post: the post is already with the provider, yet the change awaits review.
// A published-copy edit carries `publishedEdit`; a social/update (council ten98-code-system#30 Q2) carries only `proposal`,
// the request body, and its snapshot is the whole post after the update.
const reviewItem = (item: any) => { const snapshot = item.status === 'submitted' && item.review?.status === 'pending' ? item.review.snapshot : null, edit = snapshot?.publishedEdit; return edit ? { ...item, status: 'pending', publishedEdit: edit } : snapshot?.proposal && typeof snapshot.proposal === 'object' ? { ...item, status: 'pending', proposedUpdate: snapshot } : item; };
// The account and the proposed text or YouTube metadata beside the post's current copy of that account.
function PublishedEditComparison({ post, edit }: { post: any; edit: any }) {
  const metadata = edit.path === 'social/update-metadata', tags = (values: string[]) => values.length ? values.join(', ') : 'Remove all keyword tags';
  const current = post.providerVariants?.find((target: any) => target.accountId === edit.accountId && typeof target.customContent === 'string')?.customContent ?? post.accountOverrides?.[edit.accountId]?.content ?? post.platformOverrides?.[edit.platform]?.content ?? post.content;
  return <Stack as="section" gap={2} aria-label="Proposed change to a published copy">
    <Text><Text as="strong">Account:</Text> {PLATFORM_RULES[edit.platform]?.label || edit.platform} · {edit.accountId}{metadata ? ` · Video ${edit.videoId}` : ''}</Text>
    <Grid columns={2}>
      <Stack gap={1}><Heading level={3}>Current copy</Heading>{metadata ? <>{Object.hasOwn(edit, 'title') && <Text><Text as="strong">Title:</Text> Not available in Campaign; check YouTube Studio.</Text>}{Object.hasOwn(edit, 'tags') && <Text><Text as="strong">Keyword tags:</Text> {post.tags?.length ? post.tags.join(', ') : 'None stored'}</Text>}</> : lines(current)}</Stack>
      <Stack gap={1}><Heading level={3}>Proposed change</Heading>{metadata ? <>{Object.hasOwn(edit, 'title') && <Text preserveWhitespace><Text as="strong">Title:</Text> {edit.title}</Text>}{Object.hasOwn(edit, 'tags') && <Text preserveWhitespace><Text as="strong">Keyword tags:</Text> {tags(edit.tags || [])}</Text>}</> : lines(edit.content)}</Stack>
    </Grid>
  </Stack>;
}
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const creativeState = (asset: any) => asset?.missing ? 'Missing from this project' : asset?.approval === 'approved' ? 'Approved asset' : 'Asset approval required';
// Each field a pending social/update proposes, beside the post's current local copy. Versions and media are summarised;
// a changed or added version opens as a preview.
function ProposedUpdateComparison({ item }: { item: any }) {
  const post = item.post, next = item.proposedUpdate, proposal = next.proposal, has = (key: string) => Object.hasOwn(proposal, key), plain = (text: string) => <Text>{text}</Text>;
  const schedule = (value: string) => plain(value ? when(value) : 'No planned time');
  const tags = (values: unknown) => Array.isArray(values) && values.length ? <List>{values.map((tag, index) => <ListItem key={index}>{String(tag)}</ListItem>)}</List> : plain('No keyword tags');
  const media = (items: unknown, changed = false) => plain(Array.isArray(items) && items.length ? plural(items.length, 'media item') + (changed ? ' · changed' : '') : 'No media');
  const creative = (id: string, asset: any) => plain(id ? `${creativeState(asset)} · ${id}` : 'No referenced creative');
  const versions = (id: string, label: string, current: Record<string, any> = {}, proposed: Record<string, any> = {}, account = false): ReviewChange => {
    const platformOf = (key: string, variant: any) => account ? variant.platform : key, name = (key: string, variant: any) => (PLATFORM_RULES[platformOf(key, variant)]?.label || platformOf(key, variant)) + (account ? ` · Account ${key}` : '');
    const state = (key: string) => !Object.hasOwn(current, key) ? 'added' : !Object.hasOwn(proposed, key) ? 'removed' : JSON.stringify(current[key]) === JSON.stringify(proposed[key]) ? 'unchanged' : 'changed';
    const keys = [...new Set([...Object.keys(current), ...Object.keys(proposed)])], shown = keys.filter(key => ['added', 'changed'].includes(state(key)));
    return { id, label, before: plain(Object.keys(current).length ? plural(Object.keys(current).length, 'version') : 'No versions'), after: keys.length ? <Stack gap={2}><List>{keys.map(key => <ListItem key={key}>{name(key, current[key] || proposed[key])}: {state(key)}</ListItem>)}</List>{shown.map(key => <Disclosure key={key} summary={`Preview the proposed ${name(key, proposed[key])} version`}><PostVariantPreview platform={platformOf(key, proposed[key])} accountName={account ? key : undefined} variant={proposed[key]} scheduled={Boolean(next.scheduledAt)}/></Disclosure>)}</Stack> : plain('No versions') };
  };
  const changes = [
    has('content') && { id: 'content', label: 'Text', before: lines(post.content), after: lines(next.content) },
    (has('mode') || has('scheduledAt')) && { id: 'schedule', label: 'Schedule', before: schedule(post.scheduledAt), after: proposal.mode === 'draft' ? plain('Draft at the provider · no planned time') : schedule(next.scheduledAt) },
    has('tags') && { id: 'tags', label: 'Keyword tags', before: tags(post.tags), after: tags(next.tags) },
    has('mediaItems') && { id: 'media', label: 'Media', before: media(post.mediaItems), after: media(next.mediaItems, post.mediaItems?.length === next.mediaItems?.length && JSON.stringify(post.mediaItems) !== JSON.stringify(next.mediaItems)) },
    has('assetId') && { id: 'creative', label: 'Creative', before: creative(post.assetId, item.asset), after: creative(next.assetId, next.asset) },
    has('platformOverrides') && versions('platforms', 'Platform versions', post.platformOverrides, next.platformOverrides),
    (has('accountOverrides') || has('platformOverrides') && Object.keys(post.accountOverrides || {}).length > 0) && versions('accounts', 'Account versions', post.accountOverrides, next.accountOverrides, true),
  ].filter(Boolean) as ReviewChange[];
  return <ReviewSummary title="Review the update" description="Current values are the post as stored in Campaign. Proposed values are the post after this update." scope={(post.platforms || []).map((platform: string) => PLATFORM_RULES[platform]?.label || platform).join(', ') || 'No platforms'} resource={`Post ${post.id}`} changes={changes}
    consequences={<Text>{proposal.confirmReplaceVariants ? 'The update replaces the saved platform and account versions. ' : ''}Approving does not send the update to the provider.</Text>}/>;
}

// Ad spend reviews (council decision ten98-code-system#35, Q1). Each card is one exact change: subject, platform, action,
// amount in minor units and currency. A blocked activation or budget increase opens its review on the server; approving
// allows one matching provider write and never sends it.
const spendSubject = (action: string) => action === 'ooh/booking' ? 'OOH booking' : action.includes('ad-status') ? 'Ad' : action.includes('adset') ? 'Ad set' : 'Campaign';
// Changing the ad spend setting voids unused approvals and pending requests (council decision on #35 Q1), so the switch
// confirms first; the page's handler runs only after confirmation.
function AdSpendPolicySwitch({ label, checked, disabled, onCheckedChange }: { label: string; checked: boolean; disabled: boolean; onCheckedChange: (checked: boolean) => void }) {
  const [confirm, dialog] = useConfirmDialog();
  return <>{dialog}<Switch label={label} checked={checked} disabled={disabled} onCheckedChange={async next => { if (await confirm({ title: next ? 'Require ad spend approval?' : 'Stop requiring ad spend approval?', description: 'Changing this setting voids every unused ad spend approval and pending ad spend request in this project. They stay listed as rejected.', confirmLabel: next ? 'Require approval' : 'Stop requiring approval' })) onCheckedChange(next); }}/></>;
}
function AdSpendReviews({ path, required, canReview, request, onChanged }: { path: string; required: boolean; canReview: boolean; request: Props['request']; onChanged?: Props['onChanged'] }) {
  const [data, setData] = useState<any>(null), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [notes, setNotes] = useState<Record<string, string>>({});
  const active = useRef(true), readVersion = useRef(0);
  async function load() {
    const read = ++readVersion.current, result = await request(path + '/ad-spend');
    if (active.current && read === readVersion.current) setData(result);
  }
  useEffect(() => { active.current = true; load().catch(err => { if (active.current) setError(err.message); }); return () => { active.current = false; }; }, [path, required]);
  async function act(name: string, work: () => Promise<void>) {
    if (busy || !active.current) return; setBusy(name); setError(''); setNotice('');
    try { await work(); } catch (err) { if (active.current) setError((err as Error).message || 'This review could not be saved.'); }
    finally { if (active.current) setBusy(''); }
  }
  const decide = (review: any, decision: string) => act(review.id, async () => {
    await request(`${path}/ad-spend/review`, 'POST', { reviewId: review.id, decision, note: notes[review.id] || '' }); if (!active.current) return;
    setNotes(previous => ({ ...previous, [review.id]: '' })); setNotice(decision === 'approved' ? 'Spend change approved. Make the same change again to send it to the provider.' : 'Changes requested. The spend change was not sent.');
    await onChanged?.(); await load();
  });
  const reviews = (data?.reviews || []).filter(Boolean);
  if (!required && !reviews.length && !error) return null;
  return <Stack as="section" gap={3} aria-label="Ad spend">
    <Heading level={2}>Ad spend</Heading>
    <Text tone="muted" size="sm">Activating a campaign, ad set or ad and raising a budget wait for an owner or administrator while ad spend approval is required. Pausing, ending and lowering budgets never need approval.</Text>
    <Inline><Button variant="secondary" disabled={Boolean(busy)} onClick={() => act('refresh', load)}>{busy === 'refresh' ? 'Refreshing…' : 'Refresh ad spend reviews'}</Button></Inline>
    {error && <Alert tone="danger">{error}</Alert>}{notice && <StatusLine>{notice}</StatusLine>}
    {!data && !error && <StatusLine busy>Loading ad spend reviews…</StatusLine>}
    {reviews.map((review: any) => { const change = review.snapshot || {}, platform = adSpendPlatformLabel(String(change.platform || '')), subject = `${spendSubject(String(change.action || ''))} ${change.subjectId}`, pending = review.status === 'pending';
      // The server supplies when an approval stops being usable; an unused one past it needs re-approval.
      const expired = review.status === 'approved' && !review.consumed && typeof review.expiresAt === 'string' && Date.parse(review.expiresAt) <= Date.now();
      return <Card as="article" key={review.id} headingLevel={3} title={`${adSpendActionLabel(String(change.action || ''))} · ${platform}`} description={subject} actions={<Badge tone={expired ? 'warning' : review.status === 'approved' ? 'success' : review.status === 'rejected' ? 'danger' : 'warning'}>{expired ? 'Expired' : label(review.status)}</Badge>}><Stack gap={3}>
        <ReviewSummary title="Spend change" scope={platform} resource={subject} changes={[
          { id: 'budget', label: change.activates ? 'Budget that starts spending' : 'Budget', before: formatMinorUnits(change.currentAmount, change.currency), after: formatMinorUnits(change.amount, change.currency) },
          ...(change.activates ? [{ id: 'delivery', label: 'Delivery', before: 'Not running', after: 'Starts when the change is sent' }] : []),
        ]} consequences={<Text>{change.activates ? 'This change starts ad delivery.' : 'This change raises the budget; it does not start delivery on its own.'} Approving allows one matching change and never sends it to the provider.</Text>}/>
        <Text tone="muted" size="sm">Requested by {review.requestedBy?.name || 'Team member'} · {when(review.requestedAt)}{review.reviewedAt && <> · {label(review.status)}{review.reviewedBy ? ` by ${review.reviewedBy.name || 'Administrator'}` : ''}{review.selfApproved ? ' (only administrator)' : ''} · {when(review.reviewedAt)}</>}</Text>
        {review.note && <Stack gap={0}>{lines(review.note)}</Stack>}
        {review.status === 'approved' && <Text tone="muted" size="sm">{review.consumed ? 'This approval was used by a provider change.' : expired ? 'This approval expired before it was used. Make the same change again to request re-approval.' : 'Approved and not yet used. Make the same change again to send it.'}</Text>}
        {canReview && pending && <Stack as="fieldset" gap={3} disabled={Boolean(busy)}><Field label="Review note (optional)"><Textarea rows={2} maxLength={2000} value={notes[review.id] || ''} onChange={event => setNotes(previous => ({ ...previous, [review.id]: event.target.value }))}/></Field><FormActions><Button onClick={() => decide(review, 'approved')}>Approve spend change</Button><Button variant="secondary" onClick={() => decide(review, 'rejected')}>Request changes</Button></FormActions></Stack>}
      </Stack></Card>; })}
    {data && !reviews.length && <EmptyState title="No ad spend reviews." description="A blocked activation or budget increase opens its review here."/>}
  </Stack>;
}

export default function ContentApprovals({ projectId, role, request, onChanged }: Props) {
  const [data, setData] = useState<any>(null), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [filter, setFilter] = useState('all'), [notes, setNotes] = useState<Record<string, string>>({});
  const [focusId, setFocusId] = useState(''), advance = useRef<{ id: string; index: number } | null>(null);
  const [selected, setSelected] = useState<string[]>([]), [bulk, setBulk] = useState<{ done: number; total: number } | null>(null), [bulkResult, setBulkResult] = useState<{ decision: string; ok: number; skipped: number; failed: { id: string; name: string; message: string }[] } | null>(null);
  const [sort, setSort] = useState('requested'), [platform, setPlatform] = useState('');
  const [restrictions, setRestrictions] = useState<Record<string, Restriction[]>>({});
  const active = useRef(true), readVersion = useRef(0), path = `/projects/${encodeURIComponent(projectId)}/approvals`, canReview = ['owner', 'admin'].includes(role), canRequest = ['owner', 'admin', 'editor'].includes(role);
  function acceptItem(item: any) { if (active.current) setData((previous: any) => previous ? { ...previous, posts: previous.posts.map((entry: any) => entry.post.id === item.post.id ? item : entry) } : previous); }
  async function load() {
    if (!active.current) return; const read = ++readVersion.current;
    try { const result = await request(path + '/posts'); if (active.current && read === readVersion.current) setData(result); }
    catch (err) { if (active.current && read === readVersion.current) throw err; }
  }
  useEffect(() => { active.current = true; const loading = load(), read = readVersion.current; loading.catch(err => { if (active.current && read === readVersion.current) setError(err.message); }); return () => { active.current = false; }; }, [projectId]);
  // A refused approval returns the publishing restrictions that blocked it; keep them beside that post until its next attempt.
  function noteRestrictions(postId: string, failure: unknown) {
    const problem = failure as { code?: string; details?: unknown } | null;
    const rows = problem?.code === 'APPROVAL_POST_RESTRICTIONS' && Array.isArray(problem.details) ? problem.details.filter((row: any) => row && typeof row.message === 'string' && row.message && ['platform', 'field', 'accountId'].every(key => row[key] === undefined || typeof row[key] === 'string')).slice(0, 100) : [];
    setRestrictions(previous => { const { [postId]: _previous, ...rest } = previous; return rows.length ? { ...rest, [postId]: rows } : rest; });
  }
  // A failed action also drops a pending keyboard move, so a later refresh cannot jump focus to another card.
  async function action(name: string, run: () => Promise<void>) {
    if (busy || !active.current) return; readVersion.current++; setBusy(name); setError(''); setNotice(''); noteRestrictions(name, null);
    try { await run(); } catch (err) { if (active.current) { setError((err as Error).message || 'This review could not be saved.'); noteRestrictions(name, err); } advance.current = null; }
    finally { if (active.current) setBusy(''); }
  }
  async function review(item: any, decision: string) {
    await action(item.post.id, async () => { const result = await request(`${path}/posts/${encodeURIComponent(item.post.id)}/review`, 'POST', { decision, note: notes[item.post.id] || '', reviewId: item.review.id }); if (!active.current) return; acceptItem(result.item); setNotes(previous => ({ ...previous, [item.post.id]: '' })); setNotice(decision === 'approved' ? 'Post approved. Publishing remains a separate action.' : 'Changes requested. The author can update this draft and request another review.'); await onChanged?.(); await load(); });
  }
  const posts = (data?.posts || []).map((item: any) => reviewItem(item)).filter((item: any) => !item.post.sample && inPlatform(item) && (filter === 'all' || item.status === filter)).sort(byReviewOrder);
  // Counts, sort and platform filter follow pendpost/pendpost@42ac77b29f7720a912bdce1507b16a2a56fca74f app/src/components/Freigaben.jsx:54-60, 807-833 and 896-920 (MIT):
  // each status count uses the list's own platform filter, so a count never promises posts the list hides. Only loaded data is used.
  function inPlatform(item: any) { return !platform || (item.post.platforms || []).includes(platform); }
  function reviewTime(item: any) { const value = Date.parse(sort === 'planned' ? item.post.scheduledAt : item.review?.requestedAt); return Number.isFinite(value) ? value : null; }
  function byReviewOrder(a: any, b: any) { const left = reviewTime(a), right = reviewTime(b); return left === null ? right === null ? 0 : 1 : right === null ? -1 : sort === 'planned' ? left - right : right - left; }
  const statusValues = ['all', 'pending', 'stale', 'approved', 'rejected', 'not_requested'], loaded = (data?.posts || []).map((item: any) => reviewItem(item)).filter((item: any) => !item.post.sample);
  const counts: Record<string, number> = Object.fromEntries(statusValues.map(value => [value, loaded.filter((item: any) => inPlatform(item) && (value === 'all' || item.status === value)).length]));
  const platformChoices: string[] = [...new Set([...loaded.flatMap((item: any) => item.post.platforms || []), ...(platform ? [platform] : [])])];
  // A hidden or no-longer-pending post can stay in the selection, so every count and the loop use this intersection.
  const actionable = canReview ? posts.filter((item: any) => item.status === 'pending') : [], chosen = actionable.filter((item: any) => selected.includes(item.post.id)), blockedChosen = chosen.filter((item: any) => approveBlocked(item)).length;
  async function bulkReview(decision: string) {
    const targets = decision === 'approved' ? chosen.filter((item: any) => !approveBlocked(item)) : chosen;
    if (!targets.length) return;
    await action('bulk', async () => {
      const succeeded: string[] = [], failed: { id: string; name: string; message: string }[] = [];
      setBulkResult(null); setBulk({ done: 0, total: targets.length });
      try {
        for (const item of targets) {
          try { const result = await request(`${path}/posts/${encodeURIComponent(item.post.id)}/review`, 'POST', { decision, note: notes[item.post.id] || '', reviewId: item.review.id }); if (!active.current) return; acceptItem(result.item); succeeded.push(item.post.id); }
          catch (err) { if (!active.current) return; noteRestrictions(item.post.id, err); failed.push({ id: item.post.id, name: postName(item), message: (err as Error).message || 'This review could not be saved.' }); }
          setBulk({ done: succeeded.length + failed.length, total: targets.length });
        }
      } finally { if (active.current) setBulk(null); }
      // Failed posts stay selected so they can be retried; skipped (blocked) posts were never sent.
      setSelected(previous => previous.filter(id => !succeeded.includes(id))); setRestrictions(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => !succeeded.includes(id)))); setNotes(previous => ({ ...previous, ...Object.fromEntries(succeeded.map(id => [id, ''])) }));
      setBulkResult({ decision, ok: succeeded.length, skipped: chosen.length - targets.length, failed });
      await onChanged?.(); await load();
    });
  }
  function focusCard(index: number) { const target = posts[Math.max(0, Math.min(posts.length - 1, index))]; if (!target) return; setFocusId(target.post.id); document.getElementById('review-' + target.post.id)?.focus(); }
  // After a keyboard review settles, move to the next card: the acted card leaves a filtered view, or stays in "All posts".
  useEffect(() => { const acted = advance.current; if (!acted) return; advance.current = null; const item = posts.find((entry: any) => entry.post.id === acted.id); if (item?.status === 'pending') return; focusCard(item ? acted.index + 1 : acted.index); }, [data]);
  function onCardKey(event: KeyboardEvent<HTMLElement>, item: any, index: number) {
    const action = reviewKeyAction(event, canReview && item.status === 'pending' && !busy, approveBlocked(item)); if (!action) return;
    event.preventDefault();
    if (action === 'next' || action === 'previous') { focusCard(index + (action === 'next' ? 1 : -1)); return; }
    advance.current = { id: item.post.id, index }; void review(item, action === 'approve' ? 'approved' : 'rejected');
  }
  return <Stack gap={4}>
    <Card as="section" title="Review before publishing" headingLevel={2}><Stack gap={3}><Text>Owners and administrators review the exact text, recipients, schedule, and creative. Changes to a post or its referenced asset require a new review.</Text>
      {data && <Text tone="muted" size="sm">Publishing approval is <Text as="strong">{data.requireApproval ? 'required' : 'optional'}</Text> for this project. Approving a post never publishes it.</Text>}
      {canReview && data && <Switch label="Require approval before publishing" disabled={Boolean(busy)} checked={data.requireApproval} onCheckedChange={requireApproval => { action('policy', async () => { const result = await request(path + '/policy', 'POST', { requireApproval }); if (!active.current) return; setData((previous: any) => ({ ...previous, ...result })); setNotice(requireApproval ? 'Every post now needs current approval before publishing or retrying.' : 'Publishing approval is now optional.'); await onChanged?.(); await load(); }); }}/>}
      {data && <Text tone="muted" size="sm">Ad spend approval is <Text as="strong">{data.requireAdApproval ? 'required' : 'optional'}</Text> for this project. Approving a spend change never sends it to the provider.</Text>}
      {canReview && data && <AdSpendPolicySwitch label="Require approval before activating ads or raising budgets" disabled={Boolean(busy)} checked={Boolean(data.requireAdApproval)} onCheckedChange={requireAdApproval => { action('ad-policy', async () => { const result = await request(path + '/policy', 'POST', { requireAdApproval }); if (!active.current) return; setData((previous: any) => ({ ...previous, ...result })); setNotice(requireAdApproval ? 'Activating ads and raising budgets now need an approved review first.' : 'Ad spend approval is now optional.'); await onChanged?.(); }); }}/>}
      <Inline><Button variant="secondary" disabled={Boolean(busy)} onClick={() => action('refresh', load)}>{busy === 'refresh' ? 'Refreshing…' : 'Refresh review queue'}</Button></Inline>
      {canReview && <Text tone="muted" size="sm">Keyboard review: focus a post, move with ↑ and ↓, then press A to approve or R to request changes.</Text>}
      {data?.requireApproval && <Text tone="muted" size="sm">While approval is required, an owner or administrator must make changes to posts already submitted to a provider. Editors can still cancel or remove copies using the publishing controls.</Text>}
    </Stack></Card>
    {error && <Alert tone="danger">{error}</Alert>}{notice && <StatusLine>{notice}</StatusLine>}
    <SegmentedControl label="Review status" value={filter} onValueChange={setFilter} options={statusValues.map(value => ({ value, label: `${value === 'all' ? 'All posts' : label(value)} (${counts[value]})` }))}/>
    <FeatureControls><Field label="Platform"><Select value={platform} onChange={event => setPlatform(event.target.value)}><Option value="">All platforms</Option>{platformChoices.map(value => <Option key={value} value={value}>{PLATFORM_RULES[value]?.label || value}</Option>)}</Select></Field><Field label="Sort"><Select value={sort} onChange={event => setSort(event.target.value)}><Option value="requested">Newest review request first</Option><Option value="planned">Planned time, soonest first</Option></Select></Field></FeatureControls>
    {canReview && actionable.length > 0 && <Stack as="section" gap={3} aria-label="Bulk review">
      <Checkbox label={`Select all visible posts awaiting review (${actionable.length})`} disabled={Boolean(busy)} checked={chosen.length === actionable.length} onChange={event => setSelected(event.target.checked ? actionable.map((item: any) => item.post.id) : [])}/>
      {chosen.length > 0 && <><StatusLine>{chosen.length} post{chosen.length === 1 ? '' : 's'} selected.{blockedChosen ? ` Approve will skip ${blockedChosen} whose approval is blocked by an unverified queue or a creative not yet approved.` : ''}</StatusLine>
        <Inline gap={2}><Button disabled={Boolean(busy) || chosen.length === blockedChosen} onClick={() => bulkReview('approved')}>Approve {chosen.length - blockedChosen}</Button><Button variant="secondary" disabled={Boolean(busy)} onClick={() => bulkReview('rejected')}>Request changes on {chosen.length}</Button><Button variant="ghost" disabled={Boolean(busy)} onClick={() => setSelected([])}>Clear selection</Button></Inline>
        <Text tone="muted" size="sm">Each post is reviewed separately, in order, with its own note. Approving never publishes.</Text></>}
      {bulk && <Progress value={bulk.total ? bulk.done / bulk.total * 100 : 0} label={`Reviewed ${bulk.done} of ${bulk.total}`}/>}
    </Stack>}
    {bulkResult && <Alert tone={bulkResult.failed.length ? 'danger' : 'success'} title={`${bulkResult.decision === 'approved' ? 'Approved' : 'Requested changes on'} ${bulkResult.ok} post${bulkResult.ok === 1 ? '' : 's'}${bulkResult.failed.length ? `; ${bulkResult.failed.length} failed` : ''}${bulkResult.skipped ? `; ${bulkResult.skipped} skipped` : ''}`} onDismiss={() => setBulkResult(null)}>{bulkResult.failed.length > 0 ? <Stack gap={1}><Text>These posts were not reviewed and stay selected:</Text><List>{bulkResult.failed.map(row => <ListItem key={row.id}>{row.name} ({row.id}): {row.message}</ListItem>)}</List></Stack> : <Text>{bulkResult.decision === 'approved' ? 'Publishing remains a separate action.' : 'The authors can update these drafts and request another review.'}</Text>}</Alert>}
    {!data && !error && <StatusLine busy>Loading the review queue…</StatusLine>}
    {posts.map((item: any, index: number) => { const post = item.post, reviewData = item.review, edit = item.publishedEdit, proposed = item.proposedUpdate, creative = link(item.asset?.deliveryUrl || item.asset?.url), submitted = item.status === 'submitted' || Boolean(edit || proposed); return <Card as="section" key={post.id} id={'review-' + post.id} tabIndex={post.id === (posts.some((entry: any) => entry.post.id === focusId) ? focusId : posts[0].post.id) ? 0 : -1} aria-keyshortcuts={canReview && item.status === 'pending' ? 'A R' : undefined} onFocus={event => { if (event.target === event.currentTarget) setFocusId(post.id); }} onKeyDown={event => onCardKey(event, item, index)} headingLevel={2} title={edit ? 'Change to a published post' : proposed ? 'Proposed update to a submitted post' : post.platforms?.length ? post.platforms.map((name: string) => PLATFORM_RULES[name]?.label || name).join(', ') : 'Social post draft'} description={`${post.queueId && !submitted ? 'Provider queue · next free slot assigned on submission' : post.scheduledAt ? `Planned for ${when(post.scheduledAt)}` : 'No planned publishing time'}${post.accounts?.length ? ` · ${post.accounts.length} selected account${post.accounts.length === 1 ? '' : 's'}` : ''}`} actions={<Inline gap={2} align="center">{canReview && item.status === 'pending' && <Checkbox label="Select" aria-label={`Select ${postName(item)} for bulk review`} disabled={Boolean(busy)} checked={selected.includes(post.id)} onChange={event => setSelected(previous => event.target.checked ? [...previous.filter(id => id !== post.id), post.id] : previous.filter(id => id !== post.id))}/>}<Badge tone={item.status === 'approved' ? 'success' : item.status === 'rejected' ? 'danger' : 'warning'}>{label(item.status)}</Badge></Inline>}><Stack gap={3}>
      {edit && <PublishedEditComparison post={post} edit={edit}/>}
      {proposed && <ProposedUpdateComparison item={item}/>}
      {!!post.accounts?.length && <Text tone="muted" size="sm"><Text as="strong">Selected account IDs:</Text> {post.accounts.join(', ')}</Text>}
      {post.queueId && !submitted && <Stack gap={1}><Text as="strong">{item.queue?.name || 'Publishing queue unavailable'}</Text>{item.queue?.timezone && <Text tone="muted" size="sm">{item.queue.timezone} · {(item.queue.slots || []).map((slot: any) => `${days[slot.dayOfWeek]} ${slot.time}`).join(', ') || 'No weekly slots'}</Text>}<Text tone="muted" size="sm">{item.queue?.ready ? 'These queue settings match the saved post. Zernio reserves the next free slot only when it is submitted.' : item.queue?.message || 'Refresh to verify this queue before approving the post.'}</Text>{!item.queue?.ready && <Text tone="muted" size="sm">Edit the saved post, load its current queue settings and save them before requesting a new review.</Text>}</Stack>}
      <Stack gap={0}>{lines(post.content)}</Stack>
      {Array.isArray(post.tags) && post.tags.length > 0 && <Text tone="muted" size="sm"><Text as="strong">YouTube keywords (all YouTube accounts):</Text> {post.tags.join(', ')}</Text>}
      {Object.entries(post.platformOverrides || {}).map(([platform, variant]: [string, any]) => <Stack as="section" gap={2} key={platform}><Heading level={3}>{PLATFORM_RULES[platform]?.label || platform}</Heading><PostVariantPreview platform={platform} variant={variant} scheduled={!!post.scheduledAt}/>{Object.keys(variant.options || {}).length > 0 && <Disclosure summary="Publishing options"><DescriptionList items={options(platform, variant.options)}/></Disclosure>}</Stack>)}
      {Object.entries(post.accountOverrides || {}).map(([id, variant]: [string, any]) => <Stack as="section" gap={2} key={id}><Heading level={3}>{PLATFORM_RULES[variant.platform]?.label || variant.platform} · Account {id}</Heading><PostVariantPreview platform={variant.platform} accountName={id} variant={variant} scheduled={!!post.scheduledAt}/><Text tone="muted" size="sm">Account schedule: {variant.scheduledAt ? when(variant.scheduledAt) : post.queueId ? 'Next free queue slot' : post.scheduledAt ? when(post.scheduledAt) + ' · Inherited post time' : 'No fixed time'}</Text><Disclosure summary="Account publishing options">{Object.keys(variant.options || {}).length ? <DescriptionList items={options(variant.platform, variant.options)}/> : <Text>Provider defaults</Text>}</Disclosure></Stack>)}
      {post.providerVariants?.map((target: any, index: number) => <Stack as="section" gap={2} key={index}><Heading level={3}>{PLATFORM_RULES[target.platform]?.label || target.platform} · {target.accountId}</Heading><PostVariantPreview platform={target.platform} accountName={target.accountId} variant={{content:target.customContent ?? post.content,mediaItems:target.customMedia ?? post.mediaItems ?? [],options:target.platformSpecificData}}/>{target.scheduledFor && <Text tone="muted" size="sm">Account schedule: {when(target.scheduledFor)}</Text>}{Object.keys(target.platformSpecificData || {}).length > 0 && <Disclosure summary="Account publishing options"><DescriptionList items={options(target.platform, target.platformSpecificData)}/></Disclosure>}<Text tone="muted" size="sm">This account has its own provider settings. They are included in this review.</Text></Stack>)}
      {post.providerFailed && <Text tone="muted" size="sm">Review the latest text and creative before retrying failed copies from Publishing. Published copies are skipped. Refresh the provider status after making any changes in Zernio.</Text>}
      {item.asset && <Text tone="muted" size="sm">Referenced creative: {item.asset.missing ? 'Missing from this project' : item.asset.approval === 'approved' ? 'Approved asset' : 'Asset approval required'}{creative && <> · <Link href={creative} target="_blank" rel="noopener noreferrer">Open creative</Link></>}</Text>}
      {(item.assets || []).filter((asset: any) => asset.id !== item.asset?.id).map((asset: any) => <Text tone="muted" size="sm" key={asset.id}>Platform creative: {asset.missing ? 'Missing from this project' : asset.approval === 'approved' ? 'Approved asset' : 'Asset approval required'}{link(asset.deliveryUrl || asset.url) && <> · <Link href={link(asset.deliveryUrl || asset.url)} target="_blank" rel="noopener noreferrer">Open creative</Link></>}</Text>)}
      {!!post.mediaItems?.length && <Inline>{post.mediaItems.map((media: any, index: number) => { const url = link(media.url); return url && <Link key={index} variant="standalone" href={url} target="_blank" rel="noopener noreferrer">View {media.type || 'media'} {index + 1}</Link>; })}</Inline>}
      {reviewData && <Stack gap={1}><Text tone="muted" size="sm">Requested by {reviewData.requestedBy?.name || 'Team member'} · {when(reviewData.requestedAt)}{reviewData.reviewedAt && <> · {label(reviewData.status)} by {reviewData.reviewedBy?.name || 'Administrator'} · {when(reviewData.reviewedAt)}</>}</Text>{reviewData.note && <Stack gap={0}>{lines(reviewData.note)}</Stack>}</Stack>}
      {item.status === 'stale' && <Text tone="muted" size="sm">The current draft differs from the reviewed version. Request review again after your edits are ready.</Text>}
      {!submitted && canRequest && !['pending', 'approved'].includes(item.status) && <Inline><Button variant="secondary" disabled={Boolean(busy) || Boolean(post.queueId && !item.queue?.ready)} onClick={() => action(post.id, async () => { const result = await request(`${path}/posts/${encodeURIComponent(post.id)}/request`, 'POST', {}); if (!active.current) return; acceptItem(result.item); setNotice('Review requested. An owner or administrator can approve or request changes.'); await onChanged?.(); await load(); })}>{busy === post.id ? 'Saving…' : 'Request review'}</Button></Inline>}
      {restrictions[post.id] && <ValidationSummary title="Publishing restrictions blocked this approval" items={restrictionTargets(restrictions[post.id])}/>}
      {canReview && item.status === 'pending' && <Stack as="fieldset" gap={3} disabled={Boolean(busy)}><Field label="Review note (optional)"><Textarea rows={2} maxLength={2000} value={notes[post.id] || ''} onChange={event => setNotes(previous => ({ ...previous, [post.id]: event.target.value }))}/></Field><FormActions><Button disabled={approveBlocked(item)} onClick={() => review(item, 'approved')}>Approve post</Button><Button variant="secondary" onClick={() => review(item, 'rejected')}>Request changes</Button></FormActions></Stack>}
    </Stack></Card>; })}
    {data && !posts.length && <EmptyState title="No posts in this review view." description="Create a post draft in Publishing, then request review here."/>}
    <AdSpendReviews path={path} required={Boolean(data?.requireAdApproval)} canReview={canReview} request={request} onChanged={onChanged}/>
  </Stack>;
}
