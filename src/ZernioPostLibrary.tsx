import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, CodeBlock, DataTable, Disclosure, Field, FormActions, FormGrid, Inline, Input, Link, Option, Pager, Select, Stack, StatusLine, Text } from '@ten98/ui';

type Row = Record<string, any>;
type Props = { projectId: string; canWrite: boolean; campaigns?: Row[]; request: (path: string, method?: string, body?: unknown, key?: string) => Promise<any> };
const platforms = ['instagram', 'facebook', 'tiktok', 'youtube', 'twitter', 'threads', 'pinterest', 'reddit', 'bluesky', 'googlebusiness', 'linkedin'];
const platformName = (value: string) => ({ twitter: 'X', googlebusiness: 'Google Business Profile', youtube: 'YouTube', tiktok: 'TikTok', linkedin: 'LinkedIn' }[value] || value[0]?.toUpperCase() + value.slice(1));
const date = (value: string | null) => value ? new Date(value).toLocaleString() : 'Not reported';

export default function ZernioPostLibrary({ projectId, canWrite, campaigns = [], request }: Props) {
  const path = `/projects/${encodeURIComponent(projectId)}/integrations`, [accounts, setAccounts] = useState<Row[]>([]), [accountId, setAccountId] = useState(''), [tab, setTab] = useState('external-posts'), [page, setPage] = useState(1);
  const [posts, setPosts] = useState<Row[]>([]), [saved, setSaved] = useState<Row[]>([]), [pagination, setPagination] = useState<Row | null>(null), [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [locator, setLocator] = useState(''), [locatorType, setLocatorType] = useState('url'), [campaignId, setCampaignId] = useState(''), [pendingImport, setPendingImport] = useState<Row | null>(null);
  const requester = useRef(request), mounted = useRef(true), pending = useRef(false), reads = useRef(0), keys = useRef(new Map<string, string>()); requester.current = request;
  const identity = JSON.stringify([path, accountId, canWrite]), scope = useRef({ identity }); if (scope.current.identity !== identity) scope.current = { identity };
  const view = scope.current, current = () => mounted.current && scope.current === view, account = accounts.find(row => row._id === accountId), available = account && account.isActive !== false && account.needsReconnection !== true;
  const target = `${path}/publishing/accounts/${encodeURIComponent(accountId)}`;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; reads.current++; }; }, []);
  useEffect(() => { let active = true; setAccounts([]); setAccountId(''); setError(''); requester.current(path + '/accounts').then(result => { if (active) setAccounts(result.accounts.filter((row: Row) => platforms.includes(row.platform))); }).catch(failure => { if (active) setError(failure.message); }); return () => { active = false; }; }, [path]);
  useEffect(() => { pending.current = false; reads.current++; setBusy(false); setPosts([]); setSaved([]); setPagination(null); setLoaded(false); setPage(1); setTab('external-posts'); setLocator(''); setCampaignId(''); setPendingImport(null); setNotice(''); setError(''); }, [identity]);
  useEffect(() => { if (accountId && account) void action(() => load(tab, page)); }, [identity, account?.platform, tab, page]);
  async function action(run: () => Promise<void>) {
    if (!current() || pending.current) return; pending.current = true; setBusy(true); setError('');
    try { await run(); } catch (failure) { if (current() && (failure as Error).name !== 'AbortError') setError((failure as Error).message || 'The post library could not be confirmed.'); }
    finally { if (current()) { pending.current = false; setBusy(false); } }
  }
  async function load(source = tab, requestedPage = page) {
    if (!current() || !accountId) return;
    const read = ++reads.current; setLoaded(false); setPosts([]); setPagination(null);
    const refs = await requester.current(target + '/external-references');
    if (!current() || reads.current !== read) return; setSaved(refs.references);
    if (!available && source !== 'references') { setLoaded(true); return; }
    if (source === 'references') { setLoaded(true); return; }
    const result = await requester.current(`${target}/${source}${source === 'external-posts' ? '?page=' + requestedPage : ''}`);
    if (!current() || reads.current !== read) return;
    if (result.accountId !== accountId || result.platform !== account?.platform || !Array.isArray(result.posts)) throw new Error('The selected account’s post library could not be read.');
    setPosts(result.posts); setPagination(result.pagination || null); setLoaded(true);
  }
  async function importPost(body: Row) {
    if (!current() || !canWrite || !available) return;
    const fingerprint = JSON.stringify([target, body]); if (!keys.current.has(fingerprint)) keys.current.set(fingerprint, crypto.randomUUID());
    let result;
    try {
      result = await requester.current(target + '/external-import', 'POST', body, keys.current.get(fingerprint));
      if (result.operation?.status !== 'complete' || result.accountId !== accountId || typeof result.found !== 'boolean' || result.found && (result.imported !== true || typeof result.post?.platformPostId !== 'string')) throw new Error('The import receipt could not be read. Review provider outcomes before another attempt.');
      keys.current.delete(fingerprint);
    } catch (failure) {
      const problem = failure as Error & { status?: number; code?: string; operation?: Row }, uncertain = !problem.status || problem.status >= 500 || problem.code === 'OPERATION_UNCERTAIN' || ['pending', 'uncertain'].includes(problem.operation?.status);
      if (uncertain) { if (current()) setPendingImport(body); } else { keys.current.delete(fingerprint); if (current()) setPendingImport(null); }
      throw failure;
    }
    if (!current()) return; setPendingImport(null);
    setNotice(result.found ? `External post imported${body.campaignId ? ' and linked to the selected campaign' : ''}. No new post was published.${body.campaignId === '' ? ' The campaign link was removed.' : ''}${result.synced?.skipped ? ' Zernio used a recent sync inside its short refresh window.' : ''}` : 'No matching post was found in this account. Check the URL or native ID, or retry after Zernio’s short refresh window. No local reference was saved.');
    await load();
  }
  async function removeReference(post: Row) {
    if (!canWrite || !current()) return;
    const result = await requester.current(target + '/external-remove', 'POST', { postId: post.platformPostId, confirmed: true }, crypto.randomUUID());
    if (!current()) return; if (result.removed !== true) throw new Error('The local reference removal could not be confirmed.'); setNotice('Local reference removed. The live post and Zernio’s external history remain.'); await load();
  }
  function refreshReference(post: Row) {
    const previous = saved.find(row => row.platformPostId === post.platformPostId);
    return importPost({ ...(account?.platform === 'linkedin' && (post.platformPostUrl || /^urn:li:/.test(post.platformPostId)) ? { url: post.platformPostUrl || post.platformPostId } : { postId: post.platformPostId }), ...(!previous && campaignId ? { campaignId: campaignId === '__clear__' ? '' : campaignId } : {}) });
  }
  const rows = tab === 'references' ? saved : posts;
  return <Card as="section" headingLevel={2} title="External post library" description="Find posts published directly on connected platforms and link them to campaigns." actions={accountId && <Button type="button" disabled={busy} onClick={() => action(() => load())}>Refresh library</Button>}><Stack gap={4}>
    {error && <Alert tone="danger">{error}</Alert>}{notice && <StatusLine tone="success">{notice}</StatusLine>}{busy && <StatusLine busy>Reading or importing platform posts…</StatusLine>}
    <Field label="Connected account"><Select value={accountId} disabled={busy} onChange={event => { setPage(1); setTab('external-posts'); setAccountId(event.target.value); }}><Option value="">Choose an account</Option>{accounts.map(row => <Option key={row._id} value={row._id}>{platformName(row.platform)} · {row.displayName || row.username || row._id}{row.isActive === false || row.needsReconnection === true ? ' · Reconnect required' : ''}</Option>)}</Select></Field>
    {account && <>{!available && <Alert tone="warning">Reconnect this account to read or import platform posts. Saved campaign references remain available.</Alert>}
      <Inline role="group" aria-label="Post library source">{[['external-posts', 'Synced history'], ['posts', 'Latest platform posts'], ['references', 'Campaign references']].map(([value, label]) => <Button type="button" variant={tab === value ? 'primary' : 'secondary'} key={value} pressed={tab === value} disabled={busy || value === 'posts' && account.platform === 'googlebusiness'} onClick={() => { reads.current++; setPage(1); setTab(value); }}>{label}</Button>)}</Inline>
      <Text tone="muted">{tab === 'posts' ? 'The platform returns up to its latest 25 posts. LinkedIn personal profiles require a post URL in the import form below.' : tab === 'references' ? 'These are local references to posts already published elsewhere, separate from drafts and publication receipts. Up to the latest 250 references are shown for this account.' : 'Paginated posts synced by Zernio from this account, usually covering up to its last 12 months. Recent posts may need an import by URL or ID.'}</Text>
      {canWrite && <Stack as="form" onSubmit={event => { event.preventDefault(); action(() => importPost({ [locatorType]: locator.trim(), ...(campaignId ? { campaignId: campaignId === '__clear__' ? '' : campaignId } : {}) })); }}><Stack as="fieldset" disabled={busy || !available || Boolean(pendingImport)}><FormGrid><Field label="Find a published post by"><Select value={locatorType} onChange={event => { setLocatorType(event.target.value); setLocator(''); }}><Option value="url">Post URL or LinkedIn URN</Option><Option value="postId">Native platform post ID</Option></Select></Field><Field label={locatorType === 'url' ? 'Published post URL or LinkedIn URN' : 'Native platform post ID'}><Input required maxLength={locatorType === 'url' ? 8192 : 500} value={locator} onChange={event => setLocator(event.target.value)} placeholder={locatorType === 'url' ? 'https://…' : 'Platform post or video ID'}/></Field><Field label="Campaign link (optional)"><Select value={campaignId} onChange={event => setCampaignId(event.target.value)}><Option value="">Keep existing link; no link for new posts</Option><Option value="__clear__">Remove existing campaign link</Option>{campaigns.map(row => <Option key={row.id} value={row.id}>{row.name}</Option>)}</Select></Field></FormGrid><FormActions><Button variant="primary" type="submit">Import post reference</Button></FormActions></Stack></Stack>}
      <Text tone="muted">Importing checks ownership through the connected account and refreshes Zernio’s external analytics. It creates no social post or editable draft. LinkedIn personal imports may have no caption or media; use an activity URL for the exact publication time. Insights can be delayed, and a reported zero may still be provisional.</Text>
      {pendingImport && <Alert tone="warning" actions={<Button type="button" disabled={busy} onClick={() => action(() => importPost(pendingImport))}>Check the same import receipt</Button>}>This import’s outcome needs review in provider outcomes. Its original action key has been retained.</Alert>}
      {loaded && rows.length === 0 && <Text>{tab === 'references' ? 'No campaign references saved for this account.' : 'No posts returned for this account and page.'}</Text>}
      {rows.length > 0 && <DataTable searchable={false} sortable={false} pagination={false} ariaLabel="External posts" rows={rows} rowKey={row => row.platformPostId} columns={[
        { key: 'post', header: 'Post', wrap: true, minWidth: 'lg', render: row => <Stack gap={1}><CodeBlock code={row.content === null ? 'Caption not available from the platform' : row.content || 'No caption'} label="Post caption" wrap/><Text size="sm" tone="muted">{row.platformPostId}{row.mediaType ? ' · ' + row.mediaType : ''}</Text>{row.platformPostUrl && <Link href={row.platformPostUrl} target="_blank" rel="noreferrer">Open published post</Link>}{row.importedAt && <Text size="sm" tone="muted">Snapshot imported {date(row.importedAt)}</Text>}</Stack> },
        { key: 'published', header: 'Published', render: row => date(row.publishedAt) },
        { key: 'engagement', header: 'Engagement snapshot', render: row => <Stack gap={1}>{['likes', 'comments', 'shares', 'views', 'reach', 'impressions'].map(metric => <Text as="span" key={metric}>{metric[0].toUpperCase() + metric.slice(1)}: {row.analytics?.[metric] == null ? 'Not reported' : row.analytics[metric].toLocaleString()}</Text>)}{row.analytics?.lastUpdated && <Text size="sm" tone="muted">Updated {date(row.analytics.lastUpdated)}</Text>}</Stack> },
        { key: 'reference', header: tab === 'references' ? 'Campaign' : 'Reference', wrap: true, render: row => tab === 'references' ? <Stack gap={2}><Text as="span">{row.campaignName || 'No campaign'}</Text>{canWrite && <><Button type="button" disabled={busy || !available || Boolean(pendingImport)} onClick={() => action(() => refreshReference(row))}>Refresh reference</Button><Disclosure variant="plain" summary="Remove local reference"><Stack gap={2}><Text>The live post and its engagement remain.</Text><Button variant="danger" type="button" disabled={busy} onClick={() => action(() => removeReference(row))}>Confirm reference removal</Button></Stack></Disclosure></>}</Stack> : <Stack gap={2}>{saved.some(item => item.platformPostId === row.platformPostId) && <Text size="sm" tone="muted">Reference saved</Text>}{canWrite && <Button type="button" disabled={busy || !available || Boolean(pendingImport)} onClick={() => action(() => refreshReference(row))}>{saved.some(item => item.platformPostId === row.platformPostId) ? 'Refresh reference' : 'Import reference'}</Button>}</Stack> },
      ]}/>}
      {pagination && <Pager label="Post library pages" previousLabel="Previous page" nextLabel="Next page" status={`Page ${pagination.pages ? pagination.page : 1} of ${pagination.pages || 1} · ${pagination.total} posts`} onPrevious={busy || page <= 1 ? undefined : () => setPage(value => value - 1)} onNext={busy || page >= pagination.pages ? undefined : () => setPage(value => value + 1)}/>}
    </>}
  </Stack></Card>;
}
