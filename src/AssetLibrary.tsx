import React, { type ReactNode, Suspense } from 'react';
import { AppBadge, AppIcon as Icon } from '@ten98/ui/app';
import { Button, Card, Disclosure, EmptyState, FileField, Grid, Inline, ResourceCard, SegmentedControl, StatusLine, Text } from '@ten98/ui';
import { assetDeliveryIssue } from '../shared/social-posts.ts';

const ZernioMediaUpload = React.lazy(() => import('./ZernioMediaUpload'));

type Row = { id: string; [key: string]: any };
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
  onSync: () => void;
  onUpload: (files: File[]) => void | Promise<void>;
  request: (path: string, method?: string, body?: unknown, key?: string) => Promise<any>;
  onDeliverySaved: () => void;
  onOpen: (modal: { type: 'asset' | 'asset-delivery'; item: Row }) => void;
  /** The app's preview for an asset: a placeholder for samples, a checked thumbnail otherwise. */
  preview: (asset: Row) => ReactNode;
};
const label = (value: string) => value ? value.charAt(0).toUpperCase() + value.slice(1).replaceAll('_', ' ') : '';
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

export default function AssetLibrary({ projectId, assets, visibleAssets, busy, canWrite, drive, driveSyncReason, connected, tab, onTabChange, onSync, onUpload, request, onDeliverySaved, onOpen, preview }: Props) {
  return <><Card as="section" headingLevel={2} title="Google Drive assets" description="Sync files, review assets and attach approved media to posts." actions={<Button variant="secondary" icon={<Icon name="refresh" size={15}/>} disabled={busy || !canWrite || !drive?.configured || !drive?.mapped} onClick={onSync}>Sync Drive</Button>}>{driveSyncReason && <Text tone="muted" size="sm">{driveSyncReason}</Text>}{canWrite && drive?.configured && drive?.mapped && <FileField label="Upload to Drive" description="Images, MP4 video, PDF or text, up to 5 MB." accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,application/pdf,text/plain" disabled={busy} busy={busy} onFiles={onUpload}/>}</Card>{canWrite && <Disclosure variant="boxed" summary="Upload a public delivery file"><Suspense fallback={<StatusLine busy>Loading upload controls…</StatusLine>}><ZernioMediaUpload key={'new-delivery:' + projectId} projectId={projectId} configured={connected} disabled={busy} request={request} onSaved={onDeliverySaved}/></Suspense></Disclosure>}<Inline justify="between" align="center"><SegmentedControl label="Asset type" value={tab} onValueChange={onTabChange} options={['all', 'image', 'video', 'document'].map(t => ({ value: t, label: (t === 'all' ? 'All assets' : label(t) + 's') + ' · ' + assets.filter(a => t === 'all' || a.kind === t).length }))}/><Text tone="muted" size="sm">{plural(assets.length, 'asset')} in this project</Text></Inline><Grid columns="auto" minItemWidth="sm">{visibleAssets.map(a => <ResourceCard key={a.id} title={a.name} description={a.source === 'google-drive' ? 'Google Drive' : a.source === 'zernio' ? 'Zernio upload' : a.sample ? 'Sample creative' : 'Linked asset'} status={<AppBadge value={a.approval || 'pending'} label={label(a.approval || 'pending')}/>} media={preview(a)} tags={[label(a.kind), ...(a.tags?.slice(0, 3) || [])]} actions={<Inline gap={2}><Button variant="secondary" size="sm" aria-label={'View ' + a.name} onClick={() => onOpen({ type: 'asset', item: a })}>View</Button>{canWrite && !a.sample && <Button variant="ghost" size="sm" aria-label={'Upload delivery file for ' + a.name} onClick={() => onOpen({ type: 'asset-delivery', item: a })}>Upload delivery file</Button>}</Inline>}>{a.deliverySource === 'zernio' && <Text tone="muted" size="sm">{assetDeliveryIssue(a) || `${label(a.deliveryKind)} delivery file · expires ${new Date(a.deliveryExpiresAt).toLocaleString()}`}</Text>}</ResourceCard>)}</Grid>{!visibleAssets.length && <EmptyState icon="image" title={assets.length ? "No assets in this view" : "No assets"} description={assets.length ? "Try another asset type or search." : "Sync a shared Drive folder or add a link to your first creative asset."}/>}</>;
}
