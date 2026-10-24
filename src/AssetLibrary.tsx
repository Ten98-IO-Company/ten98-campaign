import React, { type DragEvent, type ReactNode, Suspense, useEffect, useRef, useState } from 'react';
import { AppBadge, AppIcon as Icon } from '@ten98/ui/app';
import { Alert, AssetDetails, Button, Card, DataTable, Dialog, Disclosure, EmptyState, FileField, Grid, Inline, Link, ResourceCard, SegmentedControl, Stack, StatusLine, Tabs, Text, type FileItem } from '@ten98/ui';
import { assetDeliveryIssue } from '../shared/social-posts.ts';

const ZernioMediaUpload = React.lazy(() => import('./ZernioMediaUpload'));

type Row = { id: string; [key: string]: any };
type Related = { campaigns: Row[]; posts: Row[]; placements: Row[]; activations?: Row[] };
type Props = {
  projectId: string;
  assets: Row[];
  /** This page's assets after the shell search and the type filter. */
  visibleAssets: Row[];
  busy: boolean;
  canWrite: boolean;
  drive?: { configured?: boolean; mapped?: boolean };
  driveSyncReason: string;
  connected: boolean;
  tab: string;
  onTabChange: (tab: string) => void;
  /** Project records that can use an asset, for the detail view's "Used in" list. */
  related: Related;
  onSync: () => void;
  /** The app's Drive upload: one file per call, with its own size check, request and success notice. */
  onUpload: (files: File[]) => void | Promise<void>;
  request: (path: string, method?: string, body?: unknown, key?: string) => Promise<any>;
  onDeliverySaved: () => void;
  /** Opens the app's asset editor (details, approval, delete) or its publishing-copy upload. */
  onOpen: (modal: { type: 'asset' | 'asset-delivery'; item: Row }) => void;
  onSetUpDrive: () => void;
  /** The app's preview for an asset: a placeholder for samples, a checked thumbnail otherwise. */
  preview: (asset: Row) => ReactNode;
};
type Upload = FileItem & { file?: File };

// The Drive upload rules: the server's MIME list and message, and the app upload handler's size limit and message.
const DRIVE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'application/pdf', 'text/plain'];
const DRIVE_LIMIT = 5 * 1024 * 1024;
export function uploadIssue(file: Pick<File, 'type' | 'size'>) {
  if (!DRIVE_TYPES.includes(file.type)) return 'Choose a JPG, PNG, WebP, GIF, MP4, PDF, or text file.';
  return file.size > DRIVE_LIMIT ? 'Choose a file of at most 5 MB.' : '';
}
// The same references the server's delete check refuses on: a record's assetId or a per-platform/per-account variant's.
const useKinds: [keyof Related, string][] = [['campaigns', 'Campaign'], ['posts', 'Post'], ['placements', 'Booking'], ['activations', 'Activation']];
export function assetUses(id: string, related: Related) {
  return useKinds.flatMap(([collection, kind]) => (related[collection] || []).filter(record => record.assetId === id || [...Object.values(record.platformOverrides || {}), ...Object.values(record.accountOverrides || {})].some((variant: any) => variant?.assetId === id))
    .map(record => ({ kind, id: record.id, label: String(record.name || record.content || 'Untitled').replace(/\s+/g, ' ').trim().slice(0, 80), status: record.status || '', when: record.scheduledAt || record.startDate || '' })));
}

const label = (value: string) => value ? value.charAt(0).toUpperCase() + value.slice(1).replaceAll('_', ' ') : '';
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const source = (asset: Row) => asset.source === 'google-drive' ? 'Drive' : asset.source === 'zernio' ? 'Uploaded' : asset.sample ? 'Sample' : 'Link';
const sourceDetail = (asset: Row) => ({ Drive: 'Google Drive', Uploaded: 'Uploaded for publishing', Sample: 'Sample creative', Link: 'Linked file' })[source(asset)];
const when = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : '';
const bytes = (size: unknown) => typeof size === 'number' && size > 0 ? size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB` : '';
const approval = (asset: Row) => <AppBadge value={asset.approval || 'pending'} label={label(asset.approval || 'pending')}/>;

export default function AssetLibrary({ projectId, assets, visibleAssets, busy, canWrite, drive, driveSyncReason, connected, tab, onTabChange, related, onSync, onUpload, request, onDeliverySaved, onOpen, onSetUpDrive, preview }: Props) {
  const [view, setView] = useState('grid'), [selectedId, setSelectedId] = useState(''), [uploadOpen, setUploadOpen] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]), [dragging, setDragging] = useState(false), [detailTab, setDetailTab] = useState('details');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const driveReady = canWrite && !!drive?.configured && !!drive?.mapped, canUpload = driveReady || canWrite && connected;
  const selected = assets.find(asset => asset.id === selectedId);

  // Checks every file first, then hands valid ones to the app's Drive upload one at a time. Rejected files stay listed with
  // their reason until removed; the app's own notice or error reports each upload's outcome.
  async function addUploads(files: File[]) {
    if (!driveReady || !files.length) return;
    const items: Upload[] = files.map(file => { const error = uploadIssue(file); return { id: crypto.randomUUID(), name: file.name, size: file.size, status: error ? 'error' : 'pending', ...(error ? { error } : { file }) }; });
    setUploads(list => [...list, ...items]);
    for (const item of items.filter(item => item.file)) {
      if (!mounted.current) return;
      setUploads(list => list.map(entry => entry.id === item.id ? { ...entry, status: 'uploading' } : entry));
      try { await onUpload([item.file!]); } finally { setUploads(list => list.filter(entry => entry.id !== item.id)); }
    }
  }
  const files = (event: DragEvent) => Array.from(event.dataTransfer?.types || []).includes('Files');
  function dropped(event: DragEvent) {
    setDragging(false);
    // A drop the inner drop zone already took is not uploaded twice.
    if (event.defaultPrevented || !driveReady) return;
    event.preventDefault(); void addUploads(Array.from(event.dataTransfer.files));
  }
  function openEditor(type: 'asset' | 'asset-delivery', item: Row) { setSelectedId(''); onOpen({ type, item }); }

  const toolbar = <Inline justify="between" align="center">
    <Inline gap={3} align="center">
      <SegmentedControl label="Asset type" value={tab} onValueChange={onTabChange} options={['all', 'image', 'video', 'document'].map(t => ({ value: t, label: (t === 'all' ? 'All assets' : label(t) + 's') + ' · ' + assets.filter(a => t === 'all' || a.kind === t).length }))}/>
      <SegmentedControl label="Layout" value={view} onValueChange={setView} options={[{ value: 'grid', label: 'Grid' }, { value: 'list', label: 'List' }]}/>
    </Inline>
    <Inline gap={2} align="center">
      <Text tone="muted" size="sm">{plural(assets.length, 'asset')}</Text>
      <Button variant="secondary" icon={<Icon name="refresh" size={15}/>} disabled={busy || !canWrite || !drive?.configured || !drive?.mapped} onClick={onSync}>Sync Drive</Button>
      {canUpload && <Button variant="primary" icon={<Icon name="arrow-up" size={15}/>} onClick={() => setUploadOpen(true)}>Upload</Button>}
    </Inline>
  </Inline>;
  const uploadField = (labelText: string) => <FileField label={labelText} description="JPG, PNG, WebP, GIF, MP4, PDF or text · up to 5 MB each. You can also drop files anywhere on this page." accept={DRIVE_TYPES.join(',')} multiple disabled={busy} busy={busy} onFiles={chosen => { setUploadOpen(false); void addUploads(chosen); }}/>;
  const tray = uploads.length > 0 && <Card as="section" headingLevel={2} title="Uploads" description="Files go to the project's Drive folder one at a time." actions={uploads.some(item => item.status === 'error') ? <Button variant="ghost" size="sm" onClick={() => setUploads(list => list.filter(item => item.status !== 'error'))}>Clear failed</Button> : undefined}>
    <Stack as="ul" gap={2}>{uploads.map(item => <Stack as="li" key={item.id} gap={1}>
      <Inline justify="between" align="center"><Text weight="medium">{item.name}</Text>{item.status === 'error' ? <AppBadge value="rejected" label="Not uploaded"/> : <AppBadge value="pending" label={item.status === 'uploading' ? 'Uploading' : 'Waiting'}/>}</Inline>
      {item.status === 'uploading' && <StatusLine busy>Uploading to Drive…</StatusLine>}
      {item.error && <Text tone="danger" size="sm">{item.error}</Text>}
    </Stack>)}</Stack>
  </Card>;

  const empty = !visibleAssets.length && (assets.length
    ? <EmptyState icon="image" title="No assets match" description="Try another type or clear the search." action={tab !== 'all' ? <Button variant="secondary" onClick={() => onTabChange('all')}>Show all types</Button> : undefined}/>
    : driveReady ? uploadField('Add your first files')
      : <EmptyState icon="image" title="No assets yet" description={driveSyncReason || 'Choose a Drive folder for this project to bring in your media.'} action={canWrite && !(drive?.configured && drive?.mapped) ? <Button variant="secondary" onClick={onSetUpDrive}>Choose Drive folder</Button> : undefined}/>);
  const grid = <Grid columns="auto" minItemWidth="sm">{visibleAssets.map(a => <ResourceCard key={a.id} title={a.name} description={label(a.kind) + ' · ' + source(a)} status={approval(a)} media={preview(a)} tags={a.tags?.slice(0, 3) || []}
    actions={<Button variant="secondary" size="sm" aria-label={'View ' + a.name} onClick={() => { setDetailTab('details'); setSelectedId(a.id); }}>View</Button>}>{assetDeliveryIssue(a) && <Text tone="warning" size="sm">Publishing copy needs renewing</Text>}</ResourceCard>)}</Grid>;
  const list = <DataTable ariaLabel="Assets" searchable={false} sortable={false} pagination={false} rows={visibleAssets} rowKey={a => a.id} columns={[
    { key: 'name', header: 'Name', rowHeader: true, wrap: true, render: a => <Stack gap={0}><Text weight="semibold">{a.name}</Text>{!!a.tags?.length && <Text as="small" size="sm" tone="muted">{a.tags.slice(0, 3).join(', ')}</Text>}</Stack> },
    { key: 'kind', header: 'Type', render: a => label(a.kind) },
    { key: 'source', header: 'Source', render: a => source(a) },
    { key: 'approval', header: 'Approval', render: a => approval(a) },
    { key: 'updated', header: 'Updated', render: a => when(a.updatedAt) || '—' },
  ]} rowActionsLabel="Actions" rowActions={a => <Button variant="ghost" size="sm" aria-label={'View ' + a.name} onClick={() => { setDetailTab('details'); setSelectedId(a.id); }}>View</Button>}/>;

  const uses = selected ? assetUses(selected.id, related) : [], issue = selected ? assetDeliveryIssue(selected) : '';
  const details = selected && <AssetDetails assetId={selected.id} name={selected.name} kind={label(selected.kind)} preview={preview(selected)} source={sourceDetail(selected)}
    metadata={[['Size', bytes(selected.size)], ['Dimensions', selected.width && selected.height ? `${selected.width} × ${selected.height}` : ''], ['Duration', typeof selected.duration === 'number' ? `${Math.round(selected.duration)} s` : ''], ['Modified', when(selected.modifiedTime)], ['Tags', selected.tags?.join(', ')], ['Description', selected.description]].filter(([, value]) => value).map(([term, value]) => ({ label: term, value }))}
    original={selected.url ? <Link variant="standalone" href={selected.url} target="_blank" rel="noreferrer">Open original</Link> : undefined}
    delivery={selected.sample ? 'Not applicable' : selected.deliveryUrl ? <Link variant="standalone" href={selected.deliveryUrl} target="_blank" rel="noreferrer">Open publishing copy</Link> : 'Not prepared for publishing'}
    approvalStatus={approval(selected)} deliveryStatus={selected.sample ? 'Never sent to providers' : issue || (selected.deliveryUrl ? 'Publishing copy available' : 'Not prepared for publishing')}
    deliveryExpiry={selected.deliverySource === 'zernio' ? when(selected.deliveryExpiresAt) || 'Expiry unverified' : selected.deliveryUrl ? 'No expiry' : 'Not applicable'}
    readOnlyReason={selected.sample ? 'This is a sample creative. Sample assets are never sent to providers.' : !canWrite ? 'You have view-only access to this project.' : undefined}
    issue={issue || undefined}
    actions={canWrite ? <Inline gap={2}><Button variant="secondary" onClick={() => openEditor('asset', selected)}>Edit details</Button>{!selected.sample && <Button variant="secondary" onClick={() => openEditor('asset-delivery', selected)}>{selected.deliveryUrl ? 'Replace publishing copy' : 'Prepare for publishing'}</Button>}</Inline> : undefined}/>;
  const usedIn = uses.length ? <Stack as="ul" gap={3}>{uses.map(use => <Inline as="li" key={use.kind + use.id} justify="between" align="center"><Stack gap={0}><Text weight="medium">{use.label}</Text><Text tone="muted" size="sm">{use.kind}{when(use.when) ? ' · ' + when(use.when) : ''}</Text></Stack>{use.status && <AppBadge value={use.status} label={label(use.status)}/>}</Inline>)}</Stack>
    : <Text tone="muted">Not used in any campaign, post, booking or activation yet.</Text>;

  return <>
    <Stack gap={4} onDragEnter={event => { if (driveReady && files(event)) { event.preventDefault(); setDragging(true); } }} onDragOver={event => { if (driveReady && files(event)) event.preventDefault(); }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={dropped}>
      {toolbar}
      {driveSyncReason && <Text tone="muted" size="sm">{driveSyncReason}</Text>}
      {dragging && <Alert tone="info" title="Drop to upload to Google Drive">JPG, PNG, WebP, GIF, MP4, PDF or text · up to 5 MB each.</Alert>}
      {tray}
      {empty || (view === 'list' ? list : grid)}
    </Stack>
    <Dialog open={uploadOpen} onOpenChange={setUploadOpen} title="Upload media" description="Add images, video and documents to this project's library.">
      <Stack gap={4}>
        {driveReady ? uploadField('Upload to Google Drive') : driveSyncReason && <Text tone="muted" size="sm">{driveSyncReason}</Text>}
        {canWrite && connected && <Disclosure variant="boxed" summary="Upload for publishing only (no Drive copy)"><Suspense fallback={<StatusLine busy>Loading upload controls…</StatusLine>}><ZernioMediaUpload key={'new-delivery:' + projectId} projectId={projectId} configured={connected} disabled={busy} request={request} onSaved={onDeliverySaved}/></Suspense></Disclosure>}
      </Stack>
    </Dialog>
    <Dialog open={!!selected} onOpenChange={open => { if (!open) setSelectedId(''); }} size="wide" eyebrow="Asset" title={selected?.name || 'Asset'}>
      {selected && <Tabs label="Asset" value={detailTab} onValueChange={setDetailTab} items={[{ value: 'details', label: 'Details', content: details }, { value: 'used', label: 'Used in · ' + uses.length, content: usedIn }]}/>}
    </Dialog>
  </>;
}
