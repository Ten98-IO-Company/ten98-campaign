import React, { useEffect, useRef, useState } from 'react';
import AdSpendNotice from './AdSpendNotice';
import { adSpendBlock, type AdSpendBlock } from './approval-status';
import { Alert, Button, Card, Checkbox, DataTable, Disclosure, Field, Fieldset, FormActions, FormGrid, Heading, Inline, Input, Link, Option, ResourceCard, ReviewSummary, Select, Stack, StatusLine, Tabs, Text, Textarea } from '@ten98/ui';

/** In workflow mode this is the OOH page: `bookings` is its Bookings tab, and Inventory is added once Broadsign is connected. */
type Props = { projectId: string; role: string; isOperator: boolean; mode?: 'workflow' | 'connection'; bookings?: React.ReactNode; onOpenIntegrations?: () => void; onOpenApprovals?: () => void; onSpendReview?: () => void; request: (path: string, method?: string, body?: unknown, key?: string) => Promise<any>; onInventory?: (items: any[]) => void; onChanged?: () => void | Promise<void> };
const statuses: Record<number, string> = { 1: 'Saved', 3: 'Processing', 4: 'Held', 5: 'Partially held', 9: 'Booked', 10: 'Submitted', 11: 'Live', 12: 'Cancelled', 14: 'Ended', 15: 'Cancelling' };
export default function OohProviders({ projectId, role, isOperator, mode = 'workflow', bookings: bookingsView, onOpenIntegrations, onOpenApprovals, onSpendReview, request, onInventory, onChanged }: Props) {
  const [status, setStatus] = useState<any>(null), [inventory, setInventory] = useState<any[]>([]), [bookings, setBookings] = useState<any[]>([]);
  const [selected, setSelected] = useState<number[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [availability, setAvailability] = useState<Record<string, string>>({});
  const [refreshRequired, setRefreshRequired] = useState(false), refreshNeeded = useRef(false);
  const [spendBlock, setSpendBlock] = useState<AdSpendBlock | null>(null);
  const [view, setView] = useState('bookings');
  const inventoryCallback = useRef(onInventory); inventoryCallback.current = onInventory;
  const pendingKeys = useRef(new Map<string, string>()), active = useRef(true);
  const canWrite = ['owner', 'admin', 'editor'].includes(role), canMap = isOperator && ['owner', 'admin'].includes(role);
  const path = `/projects/${encodeURIComponent(projectId)}/ooh`;
  async function write(target: string, body: unknown) {
    if (!active.current) throw new DOMException('The billboard view closed.', 'AbortError');
    if (refreshNeeded.current) throw new Error('Refresh the booking details before making further changes.');
    const signature = JSON.stringify([target, body]);
    if (!pendingKeys.current.has(signature)) pendingKeys.current.set(signature, crypto.randomUUID());
    let result;
    try { result = await request(target, 'POST', body, pendingKeys.current.get(signature)); }
    catch (error) { if ((error as any).operation?.status === 'failed') pendingKeys.current.delete(signature); throw error; }
    if (!active.current) throw new DOMException('The billboard view closed.', 'AbortError');
    try { await load(); await onChanged?.(); }
    catch (error) { if (!active.current) throw error; refreshNeeded.current = true; setRefreshRequired(true); return result; }
    pendingKeys.current.delete(signature); return result;
  }
  async function load() {
    if (!active.current) throw new DOMException('The billboard view closed.', 'AbortError');
    const [connection, screens, saved] = await Promise.all([request(`${path}/status`), mode === 'connection' ? Promise.resolve({ inventory: [] }) : request(`${path}/inventory`), request(`${path}/bookings`)]);
    if (!active.current) throw new DOMException('The billboard view closed.', 'AbortError');
    setStatus(connection); setInventory(screens.inventory); setBookings(saved.bookings); setSelected(previous => previous.filter(id => screens.inventory.some((screen: any) => screen.id === id))); inventoryCallback.current?.(screens.inventory);
  }
  async function refresh() {
    await action(async () => {
      await load(); await onChanged?.(); pendingKeys.current.clear(); refreshNeeded.current = false; setRefreshRequired(false); setNotice('Provider details refreshed.');
    });
  }
  useEffect(() => {
    active.current = true; let current = true; setStatus(null); setInventory([]); setBookings([]); setSelected([]); setError(''); setNotice(''); setAvailability({});
    Promise.all([request(`${path}/status`), mode === 'connection' ? Promise.resolve({ inventory: [] }) : request(`${path}/inventory`), request(`${path}/bookings`)]).then(([connection, screens, saved]) => {
      if (current) { setStatus(connection); setInventory(screens.inventory); setBookings(saved.bookings); inventoryCallback.current?.(screens.inventory); }
    }).catch(err => { if (current) setError(err.message || 'The billboard connection could not be loaded.'); });
    return () => { current = false; active.current = false; };
  }, [path, request, mode]);
  async function action(run: () => Promise<void>) {
    if (busy || !active.current) return; setBusy(true); setError(''); setNotice(''); setSpendBlock(null);
    try { await run(); } catch (err) {
      // A booking held back by ad spend approval explains itself; the review it opened updates the Approvals badge.
      const block = adSpendBlock(err);
      if (active.current && block) { setSpendBlock(block); if (block.review) onSpendReview?.(); }
      else if (active.current) setError((err as Error).message || 'The billboard action could not be completed.');
    }
    finally { if (active.current) setBusy(false); }
  }
  async function saveMapping(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget));
    await action(async () => {
      const screenIds = String(values.screenIds).split(/[\s,]+/).filter(Boolean).map(Number);
      await request(`${path}/connection`, 'POST', { domainId: Number(values.domainId), clientId: values.clientId, clientName: values.clientName, screenIds });
      await load(); await onChanged?.(); setSelected([]); setNotice('Project inventory mapping approved. Sync the screens to continue.');
    });
  }
  async function createDraft(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget, values = Object.fromEntries(new FormData(form));
    await action(async () => {
      await write(`${path}/bookings`, { name: values.name, screenIds: selected, startDate: values.startDate, endDate: values.endDate, slotDuration: Number(values.slotDuration), price: Number(values.price), inventoryType: values.inventoryType });
      form.reset(); setNotice('Saved the proposal and line item in Broadsign. Review availability before submitting a booking.');
    });
  }
  async function submitBooking(event: React.FormEvent, booking: any) {
    event.preventDefault();
    await action(async () => {
      await write(`${path}/bookings/${encodeURIComponent(booking.id)}/submit`, { confirmBooking: true }); setNotice('Booking submitted. Broadsign reports the final booking and delivery status.');
    });
  }
  async function cancelBooking(event: React.FormEvent, booking: any) {
    event.preventDefault();
    await action(async () => {
      const target = `${path}/bookings/${encodeURIComponent(booking.id)}/cancel`, body = { confirmCancellation: true };
      if (booking.canRetryCancellation) pendingKeys.current.delete(JSON.stringify([target, body]));
      let result;
      try { result = await write(target, body); }
      catch (error) { await load().catch(() => {}); throw error; }
      setNotice(result.cancellation.confirmed ? 'Broadsign confirmed cancellation. Review any charges or refunds with the partner.' : 'Cancellation requested. Delivery may continue until Broadsign confirms it. Refresh the delivery report for its actual status.');
    });
  }
  const inventoryTable = <DataTable ariaLabel="Approved Broadsign inventory" searchable={false} sortable={false} pagination={false} rows={inventory} rowKey={screen => String(screen.id)}
    selectable={canWrite} selectedKeys={selected.map(String)} onSelectionChange={keys => { if (!busy) setSelected(inventory.filter(screen => keys.includes(String(screen.id))).map(screen => screen.id)); }} columns={[
    { key: 'screen', header: 'Screen / face', render: screen => <Stack gap={1}><Text as="strong" weight="semibold">{screen.name}</Text><Text as="small" size="xs" tone="muted">{screen.id}</Text></Stack> },
    { key: 'location', header: 'Location', render: screen => <Stack gap={1}><Text as="span">{screen.location || 'Location not supplied'}</Text>{screen.latitude !== null && screen.longitude !== null && <Text as="small" size="xs" tone="muted">{screen.latitude}, {screen.longitude}</Text>}</Stack> },
    { key: 'resolution', header: 'Resolution', render: screen => screen.resolution || '—' }]}/>;
  const body = <>
    {mode === 'workflow' && <Text tone="muted">Upload and schedule creative bundles in <Link href="https://app.broadsign.com/campaigns" target="_blank" rel="noreferrer">Broadsign Guaranteed Campaigns</Link> using the proposal ID below. Your provider account controls creative permissions and approvals.</Text>}
    {error && <Alert tone="danger">{error}</Alert>}
    {spendBlock && (spendBlock.review ? <AdSpendNotice block={spendBlock} onOpenApprovals={onOpenApprovals} onDismiss={() => setSpendBlock(null)}/>
      // Broadsign quotes carry no currency: approval-required projects need the account currency in Settings › Connections.
      : <Alert tone="warning" title="Set the Broadsign account currency" onDismiss={() => setSpendBlock(null)} dismissLabel="Dismiss" actions={onOpenIntegrations && <Button variant="secondary" size="sm" onClick={onOpenIntegrations}>Open Connections</Button>}>This project requires approval before bookings are submitted, and the quote can only be matched to an approval with the Broadsign account currency. Nothing was submitted. Set the account currency in Settings › Connections, then submit again.</Alert>)}
    {notice && <StatusLine>{notice}</StatusLine>}
    {refreshRequired && <Alert tone="warning" actions={<Button disabled={busy} onClick={refresh}>Refresh provider details</Button>}>Broadsign saved the action, but the latest details could not be loaded. Refresh the booking details before making further changes.</Alert>}
    <Stack as="fieldset" disabled={refreshRequired}>
    {mode === 'workflow' && status?.connection && <Inline gap={2} justify="between" align="center"><Inline gap={2} align="center"><Text tone="muted">{`${status.connection.clientName} · ${status.environment}`}</Text>{onOpenIntegrations && <Button variant="ghost" size="sm" onClick={onOpenIntegrations}>Open Connections</Button>}</Inline>
      <Button disabled={busy || !canWrite || !status.configured} onClick={() => action(async () => { const result = await request(`${path}/sync`, 'POST', {}); if (!active.current) return; setInventory(result.inventory); setSelected(previous => previous.filter(id => result.inventory.some((screen: any) => screen.id === id))); inventoryCallback.current?.(result.inventory); await onChanged?.(); setNotice(`Synced ${result.inventory.length} approved screens.`); })}>{busy ? 'Working…' : 'Update partner screens'}</Button></Inline>}
    {mode === 'connection' && status && <ResourceCard title="Broadsign connection" description={status.configured ? `Credentials configured · ${status.environment}` : 'Ask your admin to add the Broadsign account to connect this partner.'} status={status.connection ? 'Project inventory mapped' : 'Project mapping required'}>
    {status.connection && <Text tone="muted">Project {projectId} · Domain {status.connection.domainId} · {status.connection.clientName} · Client {status.connection.clientId}</Text>}
    {canMap && status && <Disclosure summary="Approve project inventory"><Stack gap={3}>
      <Text tone="muted">Use the domain, client, and screen IDs supplied by your media provider. Each screen can belong to one project. Existing bookings lock this mapping.</Text>
      <Stack as="form" onSubmit={saveMapping} key={`${projectId}-${JSON.stringify(status.connection)}`}><Stack as="fieldset" disabled={busy || !status.configured}>
        <Field label="Broadsign domain ID *"><Input name="domainId" type="number" min="1" step="1" required defaultValue={status.connection?.domainId}/></Field>
        <Field label="Client ID *"><Input name="clientId" maxLength={200} required defaultValue={status.connection?.clientId}/></Field>
        <Field label="Client name *"><Input name="clientName" maxLength={200} required defaultValue={status.connection?.clientName}/></Field>
        <Field label="Approved screen IDs *"><Textarea name="screenIds" required rows={2} placeholder="54016, 54023" defaultValue={status.connection?.screenIds?.join(', ')}/></Field>
        <FormActions><Button type="submit" disabled={Boolean(bookings.length)}>Approve inventory mapping</Button></FormActions>
      </Stack></Stack>
    </Stack></Disclosure>}
    </ResourceCard>}
    {mode === 'workflow' && status?.connection && <>
      {!inventory.length && <Text tone="muted">Sync the approved inventory to load locations and start a provider proposal.</Text>}
      {inventory.length > 0 && (canWrite ? <Stack as="form" gap={4} onSubmit={createDraft}>
        {/* Dates and budget come first: they decide what the selected screens can be booked for. */}
        <Fieldset legend="Dates and budget" description="Creates a saved frequency proposal with one play per loop, all days, and full-day scheduling. The partner loads your creative in Broadsign." disabled={busy || !status.configured}>
          <FormGrid>
            <Field label="Start date *"><Input name="startDate" type="date" required/></Field>
            <Field label="End date *"><Input name="endDate" type="date" required/></Field>
            <Field label="Provider quote (account currency) *"><Input name="price" type="number" required min="0" max="1000000000" step="0.01" defaultValue="0"/></Field>
            <Field label="Ad duration (seconds) *"><Input name="slotDuration" type="number" required min="1" max="120" step="1" defaultValue="10"/></Field>
            <Field label="Inventory type"><Select name="inventoryType" defaultValue="digital"><Option value="digital">Digital screens</Option><Option value="static">Static faces</Option></Select></Field>
            <Field label="Proposal name *"><Input name="name" required maxLength={200}/></Field>
          </FormGrid>
        </Fieldset>
        {/* The selection summary and its action sit above the list, so they stay in view however long the list is. */}
        <Inline gap={3} justify="between" align="center"><Text weight="semibold">{`${selected.length} of ${inventory.length} screens selected`}</Text><Button type="submit" variant="primary" disabled={busy || !selected.length || !status.configured}>Save provider proposal</Button></Inline>
        {inventoryTable}
      </Stack> : inventoryTable)}
    </>}
    {mode === 'workflow' && bookings.length > 0 && <><Heading level={3} size="sm">Provider proposals</Heading>{bookings.map(booking => <Card as="article" headingLevel={3} title={booking.name} key={booking.id}><Stack gap={3}>
      <Text>{booking.startDate} – {booking.endDate} · {booking.screenIds.length} screens · Quote {booking.price} in account currency</Text>
      <Text tone="muted">Broadsign proposal {booking.proposalId || 'ID unconfirmed'} · {['creating', 'proposal-created'].includes(booking.stage) ? 'Incomplete draft: review in Broadsign before continuing.' : statuses[booking.providerStatus] || `Provider status ${booking.providerStatus}`}</Text>
      {booking.stage === 'cancellation-requested' && <StatusLine tone="warning">{booking.canRetryCancellation ? 'An operator reviewed this cancellation as not applied. This is a human review, not provider confirmation. You may explicitly request a fresh cancellation below; Broadsign’s current scope and status will be checked again.' : 'Cancellation requested; the partner hasn’t confirmed yet. Delivery may continue. Refresh the delivery report before taking another action.'}</StatusLine>}
      <Inline gap={2}><Button disabled={busy || !status?.configured || !booking.lineItemId || Number(booking.providerStatus) !== 1} onClick={() => action(async () => { const result = await request(`${path}/bookings/${encodeURIComponent(booking.id)}/availability`); if (!active.current) return; setAvailability(previous => ({ ...previous, [booking.id]: `${result.availability} · ${result.bookableScreens ?? '—'} / ${result.requestedScreens ?? '—'} screens bookable` })); await onChanged?.(); })}>Check availability</Button>
        <Button disabled={busy || !status?.configured || !booking.lineItemId} onClick={() => action(async () => { await request(`${path}/bookings/${encodeURIComponent(booking.id)}/report`); await load(); await onChanged?.(); })}>Refresh delivery report</Button></Inline>
      {Number(booking.providerStatus) === 1 && availability[booking.id] && <StatusLine>{availability[booking.id]}</StatusLine>}
      {booking.report && <Text>Actual impressions: {booking.report.actualImpressions ?? 'Not reported'} · Actual plays: {booking.report.actualPlays ?? 'Not reported'}{booking.report.updatedAt ? ` · Updated ${booking.report.updatedAt}` : ''}</Text>}
      {canWrite && booking.stage === 'draft' && Number(booking.providerStatus) === 1 && <Stack as="form" onSubmit={event => submitBooking(event, booking)}><Stack as="fieldset" disabled={busy || !status?.configured}>
        <ReviewSummary title="Review paid booking" scope={`Project ${projectId} · Broadsign ${status?.environment || 'environment unavailable'}`} resource={`${booking.name} · Booking ${booking.id} · Proposal ${booking.proposalId || 'ID unconfirmed'} · Line item ${booking.lineItemId || 'ID unconfirmed'}`}
          description={`${booking.startDate} – ${booking.endDate} · ${booking.inventoryType} · ${booking.slotDuration} seconds · Screen IDs ${booking.screenIds.join(', ')} · Quote ${booking.price} in account currency`}
          changes={[{ id: 'booking-request', label: 'Provider booking', before: statuses[booking.providerStatus] || `Provider status ${booking.providerStatus}`, after: 'Submit a paid booking request; final status comes from Broadsign' }]}
          consequences={<Text>Submits the provider quote for these screens and dates. Availability is checked again before booking. Creative trafficking remains in Broadsign.</Text>}
          actions={<><Checkbox required label="I approve submitting this paid booking at the partner’s quote."/><FormActions><Button type="submit" variant="primary">Submit for booking</Button></FormActions></>}/>
      </Stack></Stack>}
      {canWrite && booking.lineItemId && [3, 9, 10, 11].includes(Number(booking.providerStatus)) && (booking.canRetryCancellation || !['cancellation-requested', 'cancelling', 'cancelled'].includes(booking.stage)) && <Stack as="form" onSubmit={event => cancelBooking(event, booking)}><Stack as="fieldset" disabled={busy || !status?.configured}>
        <ReviewSummary title="Review cancellation request" scope={`Project ${projectId} · Broadsign ${status?.environment || 'environment unavailable'}`} resource={`${booking.name} · Booking ${booking.id} · Proposal ${booking.proposalId || 'ID unconfirmed'} · Line item ${booking.lineItemId || 'ID unconfirmed'}`}
          description={`${booking.startDate} – ${booking.endDate} · ${booking.inventoryType} · ${booking.slotDuration} seconds · Screen IDs ${booking.screenIds.join(', ')} · Quote ${booking.price} in account currency`}
          changes={[{ id: 'cancellation-request', label: 'Provider booking', before: statuses[booking.providerStatus] || `Provider status ${booking.providerStatus}`, after: 'Request cancellation; the partner confirms it' }]}
          consequences={<Text tone="muted">Cancellation can incur charges and does not guarantee a refund. Booked or live delivery may continue until the partner confirms cancellation.</Text>}
          actions={<><Checkbox required label="I approve cancelling this booking under the partner’s terms."/><FormActions><Button type="submit" variant="danger">{booking.canRetryCancellation ? 'Request fresh cancellation' : 'Request cancellation'}</Button></FormActions></>}/>
      </Stack></Stack>}
    </Stack></Card>)}<Text tone="muted">Verified provider bookings also update your shared OOH plan. Per-location costs remain unknown when the provider reports only a combined quote. Delivery totals come from Broadsign’s line-item performance fields. Raw proof-of-play logs require a separate Broadsign Control / POP integration.</Text></>}
    </Stack>
  </>;
  // The Integrations provider card already names Broadsign, so connection mode adds no heading or panel of its own.
  if (mode === 'connection') return <Stack gap={4}><Text tone="muted">Approve the client and inventory available to this project.</Text>{body}</Stack>;
  // The provider status decides the page layout, so the bookings view waits for it and then mounts once.
  if (!status) return error ? <Stack gap={4}><Alert tone="danger">{error}</Alert>{bookingsView}</Stack> : <StatusLine busy>Loading OOH media…</StatusLine>;
  if (!status.connection) return <Stack gap={4}>
    {canMap && <Inline gap={2} align="center"><Text tone="muted" size="sm">Connect this project’s Broadsign screens in Settings › Connections to plan screen bookings here.</Text>{onOpenIntegrations && <Button variant="ghost" size="sm" onClick={onOpenIntegrations}>Open Connections</Button>}</Inline>}
    {bookingsView}
  </Stack>;
  return <Tabs label="OOH media" value={view} onValueChange={setView} items={[{ value: 'bookings', label: 'Bookings', content: bookingsView }, { value: 'inventory', label: 'Inventory', content: <Stack gap={4}>{body}</Stack> }]}/>;
}
