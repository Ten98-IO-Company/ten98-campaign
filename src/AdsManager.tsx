import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AppliedFilters, Button, DataTable, Disclosure, EmptyState, Icon, Inline, SegmentedControl, Select, Stack, StatusLine, Switch, Text, Tooltip, filterAndSortRows, type DataColumn, type TableSort } from '@ten98/ui';
import { adAccountOptions, adItemsPath, adRows, adSetRows, adsDirectViews, adsLevelViews, adsRangeOptions, anyNetwork, anyStatus, campaignKey, filterAdAccount, levelTotals, matchesFilters, networkOptions, statusOptions } from './ads-view';

type Row = Record<string, any>;
// Rows stay loosely typed: they are provider records passed through from the campaign list.
type Props = {
  view: string; onView: (view: string) => void;
  connected: boolean; busy: boolean; data?: Row; query: string;
  columns: (rows: any[]) => DataColumn<any>[]; rowActions?: (row: any) => ReactNode;
  range: string; onRange: (range: string) => void; account: string; onAccount: (account: string) => void;
  hideAmounts: boolean; onHideAmounts: (hidden: boolean) => void; network: (platform: string) => string;
  request: (path: string) => Promise<any>; onLoad: () => unknown; onOpen: (campaign: any) => void;
  empty: ReactNode; children?: ReactNode;
};
const readLimit = 10, plural = (count: number, noun: string) => `${count} ${count === 1 ? noun : noun + 's'}`;

// Issue #126: one table per level (Campaigns · Ad sets · Ads) under one period and one set of filters. Selecting rows
// narrows the next level; a row opens the campaign's details. Direct connections replace the table with their own view.
export default function AdsManager({ view, onView, connected, busy, data, query, columns, rowActions, range, onRange, account, onAccount, hideAmounts, onHideAmounts, network, request, onLoad, onOpen, empty, children }: Props) {
  const [networkFilter, setNetworkFilter] = useState(anyNetwork), [statusFilter, setStatusFilter] = useState(anyStatus), [sort, setSort] = useState<TableSort>({ key: 'spend', direction: 'desc' });
  const [selected, setSelected] = useState<string[]>([]), [selectedSets, setSelectedSets] = useState<string[]>([]), [items, setItems] = useState<Record<string, { rows?: Row[]; error?: string }>>({});
  const asked = useRef(false), mounted = useRef(true), loaded = useRef<{ data?: Row; at: Date | null; generation: number }>({ at: null, generation: 0 });
  // Each new campaign list gets a time and a generation, so "Updated" is honest and ad reads repeat after a refresh.
  if (loaded.current.data !== data) loaded.current = { data, at: data ? new Date() : null, generation: loaded.current.generation + 1 };
  const level = adsLevelViews.includes(view), direct = adsDirectViews.some(item => item.value === view);
  const all: Row[] = Array.isArray(data?.campaigns) ? data.campaigns : [];
  const base = filterAdAccount(all, account).filter(row => matchesFilters(row, { network: networkFilter, status: anyStatus }));
  const campaignRows = base.filter(row => matchesFilters(row, { network: anyNetwork, status: statusFilter }) && (!query || JSON.stringify(row).toLowerCase().includes(query.toLowerCase())));
  const setPool = adSetRows(base), chosenSets = setPool.filter(row => selectedSets.includes(row.key));
  const setRows = (selected.length ? setPool.filter(row => selected.includes(campaignKey(row.campaign))) : setPool).filter(row => matchesFilters(row, { network: anyNetwork, status: statusFilter }));
  const chosen = base.filter(row => selected.includes(campaignKey(row)) || chosenSets.some(set => set.campaign === row)), reading = view === 'ads' ? chosen.slice(0, readLimit) : [];
  const itemKey = (campaign: Row) => loaded.current.generation + ' ' + adItemsPath(campaign, range);
  const adPool = reading.flatMap(campaign => { const picked = chosenSets.filter(set => set.campaign === campaign).map(set => set.platformAdSetId), rows = items[itemKey(campaign)]?.rows || []; return picked.length ? rows.filter(ad => picked.includes(ad.platformAdSetId)) : rows; });
  const adRowsShown = adPool.filter(row => matchesFilters(row, { network: anyNetwork, status: statusFilter })), readErrors = reading.map(campaign => items[itemKey(campaign)]?.error).filter(Boolean) as string[];
  const reads = reading.map(itemKey);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // Load on view once per empty list; a failed read waits for Refresh instead of looping.
  useEffect(() => { if (data) { asked.current = false; return; } if (connected && level && !asked.current) { asked.current = true; void onLoad(); } }, [connected, data, level]);
  useEffect(() => {
    for (const campaign of reading) {
      const key = itemKey(campaign); if (items[key]) continue;
      setItems(current => ({ ...current, [key]: {} }));
      request(adItemsPath(campaign, range)).then(result => { if (mounted.current) setItems(current => ({ ...current, [key]: { rows: adRows(campaign, result) } })); })
        .catch(failure => { if (mounted.current) setItems(current => ({ ...current, [key]: { error: (failure as Error).message || 'Ads could not be read.' } })); });
    }
  }, [view, reads.join('\n')]);

  const networks = networkOptions(all, network), label = (options: { value: string; label: string }[], value: string) => options.find(option => option.value === value)?.label || value;
  const accounts = adAccountOptions(all, network);
  const filters = [
    networkFilter !== anyNetwork && { id: 'network', label: 'Network', value: label(networks, networkFilter) },
    statusFilter !== anyStatus && { id: 'status', label: 'Status', value: label(statusOptions, statusFilter) },
    account !== accounts[0].value && accounts.some(option => option.value === account) && { id: 'account', label: 'Ad account', value: label(accounts, account) },
    view !== 'campaigns' && selected.length > 0 && { id: 'campaigns', label: 'Campaigns', value: `${selected.length} selected` },
    view === 'ads' && selectedSets.length > 0 && { id: 'adsets', label: 'Ad sets', value: `${selectedSets.length} selected` },
  ].filter(Boolean) as { id: string; label: string; value: string }[];
  const clear = (id: string) => { if (id === 'network') setNetworkFilter(anyNetwork); if (id === 'status') setStatusFilter(anyStatus); if (id === 'account') onAccount(accounts[0].value); if (id === 'campaigns') setSelected([]); if (id === 'adsets') setSelectedSets([]); };
  function chooseNetwork(value: string) {
    if (adsDirectViews.some(item => item.value === value)) { onView(value); return; }
    setNetworkFilter(value); if (direct) onView('campaigns');
  }

  function table(name: string, noun: string, rows: Row[], total: number, extra: { selection?: [string[], (keys: string[]) => void]; actions?: boolean } = {}) {
    const levelColumns = columns(rows), shown: DataColumn<Row>[] = noun === 'campaign' ? levelColumns : levelColumns.flatMap(column => column.key === 'name' ? [{ ...column, header: noun === 'ad set' ? 'Ad set' : 'Ad' }, { key: 'campaign', header: 'Campaign', wrap: true, sortValue: (row: Row) => row.campaign?.name || row.campaign?.campaignName || '', render: (row: Row) => row.campaign?.name || row.campaign?.campaignName || 'Campaign' }] : [column]);
    const totals = levelTotals(rows), footer = shown.map(column => column.key === 'name' ? `Totals · ${plural(rows.length, noun)}${rows.length < total ? ' (filtered)' : ''}` : column.key === 'spend' && totals.mixedCurrency ? <Tooltip content="Spend in different currencies is not added."><Text as="span" tone="muted">—</Text></Tooltip> : column.numeric && column.render ? column.render(totals) : '');
    return <DataTable ariaLabel={name} searchable={false} pagination={false} density="compact" stickyHeader responsive="stack" columns={shown} rows={filterAndSortRows(rows, shown, '', sort)} rowKey={row => noun === 'campaign' ? campaignKey(row) : row.key} sort={sort} onSortChange={setSort}
      selectable={!!extra.selection} selectedKeys={extra.selection?.[0]} onSelectionChange={extra.selection?.[1]} onRowActivate={row => onOpen(noun === 'campaign' ? row : row.campaign)}
      rowActionsLabel={extra.actions ? 'Status' : undefined} rowActions={extra.actions ? rowActions : undefined} footerCells={footer} emptyTitle={total ? `No ${noun}s match these filters` : `No ${noun}s reported`} emptyDescription={total ? 'Change or clear the filters above.' : `${noun === 'ad set' ? 'Ad sets' : 'Ads'} appear here once your networks report them.`}/>;
  }

  return <Stack gap={4}>
    <Inline gap={3} align="end" justify="between">
      <Inline gap={3} align="end">
        {level && connected && <SegmentedControl label="Reporting period" options={adsRangeOptions} value={range} onValueChange={onRange}/>}
        <Select aria-label="Network" width="auto" value={direct ? view : networkFilter} options={networks} onChange={event => chooseNetwork(event.currentTarget.value)}/>
        {level && connected && <Select aria-label="Status" width="auto" value={statusFilter} options={statusOptions} onChange={event => setStatusFilter(event.currentTarget.value)}/>}
        {level && connected && all.length > 0 && <Select aria-label="Ad account" width="auto" value={account} options={accounts} onChange={event => onAccount(event.currentTarget.value)}/>}
      </Inline>
      {level && connected && <Inline gap={3} align="center">
        <Text tone="muted" size="sm">{busy && !data ? 'Loading campaigns…' : loaded.current.at ? `Updated ${loaded.current.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Not loaded'}</Text>
        <Button variant="ghost" size="sm" icon={<Icon name="refresh" size={16}/>} disabled={busy} onClick={() => { void onLoad(); }}>Refresh</Button>
        <Switch label="Hide amounts" checked={hideAmounts} onCheckedChange={onHideAmounts}/>
      </Inline>}
    </Inline>
    {level && filters.length > 0 && <AppliedFilters filters={filters} onRemove={clear} onClear={() => filters.forEach(filter => clear(filter.id))}/>}
    {level && !connected && empty}
    {level && connected && (!data ? busy ? <StatusLine busy>Loading campaigns…</StatusLine> : <EmptyState icon="target" title="Campaigns are not loaded" description="Refresh to read your connected ad accounts." action={<Button variant="secondary" onClick={() => { void onLoad(); }}>Refresh</Button>}/> : <>
      {data.backfillPending && <StatusLine tone="info">Some results are still syncing. Refresh after the sync completes.</StatusLine>}
      {view === 'campaigns' && (all.length ? table('Campaigns', 'campaign', campaignRows, all.length, { selection: [selected, setSelected], actions: true }) : <EmptyState icon="target" title="No campaigns yet" description="Campaigns from your connected ad accounts appear here. New campaigns are created paused."/>)}
      {view === 'adsets' && table('Ad sets', 'ad set', setRows, adSetRows(all).length, { selection: [selectedSets, setSelectedSets] })}
      {view === 'ads' && (!chosen.length ? <EmptyState icon="target" title="Select campaigns or ad sets first" description="Their ads appear here, with results for the reporting period." action={<Button variant="secondary" onClick={() => onView('campaigns')}>Choose campaigns</Button>}/> : <Stack gap={3}>
        {chosen.length > readLimit && <StatusLine>Showing ads for the first {readLimit} selected campaigns.</StatusLine>}
        {readErrors.map(message => <StatusLine key={message} tone="danger">{message}</StatusLine>)}
        {reads.some(key => !items[key] || !items[key].rows && !items[key].error) ? <StatusLine busy>Loading ads…</StatusLine> : table('Ads', 'ad', adRowsShown, adPool.length)}
      </Stack>)}
      {view === 'campaigns' && children && <Disclosure summary="Meta campaigns without ads">{children}</Disclosure>}
    </>)}
  </Stack>;
}
