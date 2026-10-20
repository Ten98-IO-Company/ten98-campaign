import React, { useEffect, useRef, useState } from 'react';
import { ResourceCard, ReviewSummary } from '@ten98/ui';

type Props = { projectId: string; role: string; isOperator: boolean; mode?: 'workflow' | 'connection'; onOpenIntegrations?: () => void; request: (path: string, method?: string, body?: unknown, key?: string) => Promise<any>; onInventory?: (items: any[]) => void; onChanged?: () => void | Promise<void> };
const statuses: Record<number, string> = { 1: 'Saved', 3: 'Processing', 4: 'Held', 5: 'Partially held', 9: 'Booked', 10: 'Submitted', 11: 'Live', 12: 'Cancelled', 14: 'Ended', 15: 'Cancelling' };
export default function OohProviders({ projectId, role, isOperator, mode = 'workflow', onOpenIntegrations, request, onInventory, onChanged }: Props) {
  const [status, setStatus] = useState<any>(null), [inventory, setInventory] = useState<any[]>([]), [bookings, setBookings] = useState<any[]>([]);
  const [selected, setSelected] = useState<number[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [availability, setAvailability] = useState<Record<string, string>>({});
  const [refreshRequired, setRefreshRequired] = useState(false), refreshNeeded = useRef(false);
  const inventoryCallback = useRef(onInventory); inventoryCallback.current = onInventory;
  const pendingKeys = useRef(new Map<string, string>()), active = useRef(true);
  const canWrite = ['owner', 'admin', 'editor'].includes(role), canMap = isOperator && ['owner', 'admin'].includes(role);
  const path = `/projects/${encodeURIComponent(projectId)}/ooh`;
  async function write(target: string, body: unknown) {
    if (!active.current) throw new DOMException('The OOH view closed.', 'AbortError');
    if (refreshNeeded.current) throw new Error('Refresh provider details before making further changes.');
    const signature = JSON.stringify([target, body]);
    if (!pendingKeys.current.has(signature)) pendingKeys.current.set(signature, crypto.randomUUID());
    let result;
    try { result = await request(target, 'POST', body, pendingKeys.current.get(signature)); }
    catch (error) { if ((error as any).operation?.status === 'failed') pendingKeys.current.delete(signature); throw error; }
    if (!active.current) throw new DOMException('The OOH view closed.', 'AbortError');
    try { await load(); await onChanged?.(); }
    catch (error) { if (!active.current) throw error; refreshNeeded.current = true; setRefreshRequired(true); return result; }
    pendingKeys.current.delete(signature); return result;
  }
  async function load() {
    if (!active.current) throw new DOMException('The OOH view closed.', 'AbortError');
    const [connection, screens, saved] = await Promise.all([request(`${path}/status`), mode === 'connection' ? Promise.resolve({ inventory: [] }) : request(`${path}/inventory`), request(`${path}/bookings`)]);
    if (!active.current) throw new DOMException('The OOH view closed.', 'AbortError');
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
    }).catch(err => { if (current) setError(err.message || 'The OOH connection could not be loaded.'); });
    return () => { current = false; active.current = false; };
  }, [path, request, mode]);
  async function action(run: () => Promise<void>) {
    if (busy || !active.current) return; setBusy(true); setError(''); setNotice('');
    try { await run(); } catch (err) { if (active.current) setError((err as Error).message || 'The OOH action could not be completed.'); }
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
  async function submitBooking(event: React.FormEvent<HTMLFormElement>, booking: any) {
    event.preventDefault();
    await action(async () => {
      await write(`${path}/bookings/${encodeURIComponent(booking.id)}/submit`, { confirmBooking: true }); setNotice('Booking submitted. Broadsign reports the final booking and delivery status.');
    });
  }
  async function cancelBooking(event: React.FormEvent<HTMLFormElement>, booking: any) {
    event.preventDefault();
    await action(async () => {
      const target = `${path}/bookings/${encodeURIComponent(booking.id)}/cancel`, body = { confirmCancellation: true };
      if (booking.canRetryCancellation) pendingKeys.current.delete(JSON.stringify([target, body]));
      let result;
      try { result = await write(target, body); }
      catch (error) { await load().catch(() => {}); throw error; }
      setNotice(result.cancellation.confirmed ? 'Broadsign confirmed cancellation. Review any charges or refunds with the media provider.' : 'Cancellation requested. Delivery may continue until Broadsign confirms it. Refresh the delivery report for its actual status.');
    });
  }
  return <section className="panel settings-panel">
    <div className="section-heading"><div><h2>{mode === 'connection' ? 'Broadsign project connection' : 'Broadsign OOH'}</h2><p>{mode === 'connection' ? 'Approve the client and inventory available to this project.' : 'Sync approved screens and static faces, prepare proposals, and submit confirmed bookings.'}</p></div></div>
    {mode === 'workflow' && <p className="helper-note">Upload and schedule creative bundles in <a href="https://app.broadsign.com/campaigns" target="_blank" rel="noreferrer">Broadsign Guaranteed Campaigns</a> using the proposal ID below. Your provider account controls creative permissions and approvals.</p>}
    {error && <p className="alert" role="alert">{error}</p>}
    {notice && <p className="helper-note" role="status">{notice}</p>}
    {refreshRequired && <div className="alert" role="status"><span>Broadsign saved the action, but the latest details could not be loaded. Refresh provider details before making further changes.</span><button type="button" className="button" disabled={busy} onClick={refresh}>Refresh provider details</button></div>}
    <fieldset disabled={refreshRequired}>
    {mode === 'workflow' && status && <p className="helper-note">{status.connection ? `${status.connection.clientName} · ${status.environment}` : 'Connect this project’s Broadsign inventory in Integrations.'} {onOpenIntegrations && <button type="button" className="text-link" onClick={onOpenIntegrations}>Open integrations</button>}</p>}
    {mode === 'connection' && status && <ResourceCard title="Broadsign connection" description={status.configured ? `Credentials configured · ${status.environment}` : 'Configure Broadsign credentials above to connect this provider.'} status={status.connection ? 'Project inventory mapped' : 'Project mapping required'}>
    {status.connection && <p className="helper-note">Project {projectId} · Domain {status.connection.domainId} · {status.connection.clientName} · Client {status.connection.clientId}</p>}
    {canMap && status && <details><summary>Approve project inventory</summary>
      <p className="helper-note">Use the domain, client, and screen IDs supplied by your media provider. Each screen can belong to one project. Existing bookings lock this mapping.</p>
      <form onSubmit={saveMapping} key={`${projectId}-${JSON.stringify(status.connection)}`}><fieldset disabled={busy || !status.configured}>
        <label className="field"><span>Broadsign domain ID *</span><input name="domainId" type="number" min="1" step="1" required defaultValue={status.connection?.domainId}/></label>
        <label className="field"><span>Client ID *</span><input name="clientId" maxLength={200} required defaultValue={status.connection?.clientId}/></label>
        <label className="field"><span>Client name *</span><input name="clientName" maxLength={200} required defaultValue={status.connection?.clientName}/></label>
        <label className="field"><span>Approved screen IDs *</span><textarea name="screenIds" required rows={2} placeholder="54016, 54023" defaultValue={status.connection?.screenIds?.join(', ')}/></label>
        <button className="button" disabled={Boolean(bookings.length)}>Approve inventory mapping</button>
      </fieldset></form>
    </details>}
    </ResourceCard>}
    {mode === 'workflow' && status?.connection && <>
      <p><button type="button" className="button" disabled={busy || !canWrite || !status.configured} onClick={() => action(async () => { const result = await request(`${path}/sync`, 'POST', {}); if (!active.current) return; setInventory(result.inventory); setSelected(previous => previous.filter(id => result.inventory.some((screen: any) => screen.id === id))); inventoryCallback.current?.(result.inventory); await onChanged?.(); setNotice(`Synced ${result.inventory.length} approved screens.`); })}>{busy ? 'Working…' : 'Sync provider inventory'}</button></p>
      {!inventory.length && <p className="helper-note">Sync the approved inventory to load locations and start a provider proposal.</p>}
      {inventory.length > 0 && <div className="table-scroll"><table><thead><tr><th>Select</th><th>Screen / face</th><th>Location</th><th>Resolution</th></tr></thead><tbody>{inventory.map(screen => <tr key={screen.id}>
        <td><input type="checkbox" aria-label={`Select ${screen.name}`} disabled={busy || !canWrite} checked={selected.includes(screen.id)} onChange={event => setSelected(event.target.checked ? [...selected, screen.id] : selected.filter(id => id !== screen.id))}/></td>
        <td><strong>{screen.name}</strong><br/><small>{screen.id}</small></td><td>{screen.location || 'Location not supplied'}{screen.latitude !== null && screen.longitude !== null && <><br/><small>{screen.latitude}, {screen.longitude}</small></>}</td><td>{screen.resolution || '—'}</td>
      </tr>)}</tbody></table></div>}
      {canWrite && inventory.length > 0 && <details><summary>Create a provider proposal ({selected.length} selected)</summary>
        <form onSubmit={createDraft}><fieldset disabled={busy || !selected.length || !status?.configured}>
          <label className="field"><span>Proposal name *</span><input name="name" required maxLength={200}/></label>
          <label className="field"><span>Inventory type</span><select name="inventoryType" defaultValue="digital"><option value="digital">Digital screens</option><option value="static">Static faces</option></select></label>
          <label className="field"><span>Start date *</span><input name="startDate" type="date" required/></label>
          <label className="field"><span>End date *</span><input name="endDate" type="date" required/></label>
          <label className="field"><span>Ad duration (seconds) *</span><input name="slotDuration" type="number" required min="1" max="120" step="1" defaultValue="10"/></label>
          <label className="field"><span>Provider quote (account currency) *</span><input name="price" type="number" required min="0" max="1000000000" step="0.01" defaultValue="0"/></label>
          <p className="helper-note">Creates a saved frequency proposal with one play per loop, all days, and full-day scheduling. The media provider manages creative trafficking in Broadsign.</p>
          <button className="button primary">Save provider proposal</button>
        </fieldset></form>
      </details>}
    </>}
    {mode === 'workflow' && bookings.length > 0 && <><h3>Provider proposals</h3>{bookings.map(booking => <article className="panel" key={booking.id}>
      <h3>{booking.name}</h3><p>{booking.startDate} – {booking.endDate} · {booking.screenIds.length} screens · Quote {booking.price} in account currency</p>
      <p className="helper-note">Broadsign proposal {booking.proposalId || 'ID unconfirmed'} · {['creating', 'proposal-created'].includes(booking.stage) ? 'Incomplete draft: review in Broadsign before continuing.' : statuses[booking.providerStatus] || `Provider status ${booking.providerStatus}`}</p>
      {booking.stage === 'cancellation-requested' && <p className="helper-note" role="status">{booking.canRetryCancellation ? 'An operator reviewed this cancellation as not applied. This is a human review, not provider confirmation. You may explicitly request a fresh cancellation below; Broadsign’s current scope and status will be checked again.' : 'Cancellation requested; provider confirmation is pending. Delivery may continue. Refresh the delivery report before taking another action.'}</p>}
      <div className="button-row"><button type="button" className="button" disabled={busy || !status?.configured || !booking.lineItemId || Number(booking.providerStatus) !== 1} onClick={() => action(async () => { const result = await request(`${path}/bookings/${encodeURIComponent(booking.id)}/availability`); if (!active.current) return; setAvailability(previous => ({ ...previous, [booking.id]: `${result.availability} · ${result.bookableScreens ?? '—'} / ${result.requestedScreens ?? '—'} screens bookable` })); await onChanged?.(); })}>Check availability</button>
        <button type="button" className="button" disabled={busy || !status?.configured || !booking.lineItemId} onClick={() => action(async () => { await request(`${path}/bookings/${encodeURIComponent(booking.id)}/report`); await load(); await onChanged?.(); })}>Refresh delivery report</button></div>
      {Number(booking.providerStatus) === 1 && availability[booking.id] && <p className="helper-note" role="status">{availability[booking.id]}</p>}
      {booking.report && <p>Actual impressions: {booking.report.actualImpressions ?? 'Not reported'} · Actual plays: {booking.report.actualPlays ?? 'Not reported'}{booking.report.updatedAt ? ` · Updated ${booking.report.updatedAt}` : ''}</p>}
      {canWrite && booking.stage === 'draft' && Number(booking.providerStatus) === 1 && <form onSubmit={event => submitBooking(event, booking)}><fieldset disabled={busy || !status?.configured}>
        <ReviewSummary title="Review paid booking" scope={`Project ${projectId} · Broadsign ${status?.environment || 'environment unavailable'}`} resource={`${booking.name} · Booking ${booking.id} · Proposal ${booking.proposalId || 'ID unconfirmed'} · Line item ${booking.lineItemId || 'ID unconfirmed'}`}
          description={`${booking.startDate} – ${booking.endDate} · ${booking.inventoryType} · ${booking.slotDuration} seconds · Screen IDs ${booking.screenIds.join(', ')} · Quote ${booking.price} in account currency`}
          changes={[{ id: 'booking-request', label: 'Provider booking', before: statuses[booking.providerStatus] || `Provider status ${booking.providerStatus}`, after: 'Submit a paid booking request; final status comes from Broadsign' }]}
          consequences={<p>Submits the provider quote for these screens and dates. Availability is checked again before booking. Creative trafficking remains in Broadsign.</p>}
          actions={<><label><input type="checkbox" required/> I approve submitting this paid booking at the provider quote.</label><p><button className="button primary">Submit for booking</button></p></>}/>
      </fieldset></form>}
      {canWrite && booking.lineItemId && [3, 9, 10, 11].includes(Number(booking.providerStatus)) && (booking.canRetryCancellation || !['cancellation-requested', 'cancelling', 'cancelled'].includes(booking.stage)) && <form onSubmit={event => cancelBooking(event, booking)}><fieldset disabled={busy || !status?.configured}>
        <ReviewSummary title="Review cancellation request" scope={`Project ${projectId} · Broadsign ${status?.environment || 'environment unavailable'}`} resource={`${booking.name} · Booking ${booking.id} · Proposal ${booking.proposalId || 'ID unconfirmed'} · Line item ${booking.lineItemId || 'ID unconfirmed'}`}
          description={`${booking.startDate} – ${booking.endDate} · ${booking.inventoryType} · ${booking.slotDuration} seconds · Screen IDs ${booking.screenIds.join(', ')} · Quote ${booking.price} in account currency`}
          changes={[{ id: 'cancellation-request', label: 'Provider booking', before: statuses[booking.providerStatus] || `Provider status ${booking.providerStatus}`, after: 'Request cancellation; provider confirmation is pending' }]}
          consequences={<p className="helper-note">Cancellation can incur charges and does not guarantee a refund. Booked or live delivery may continue until the provider confirms cancellation.</p>}
          actions={<><label><input type="checkbox" required/> I approve cancelling this booking under the media provider’s terms.</label><p><button className="button danger">{booking.canRetryCancellation ? 'Request fresh cancellation' : 'Request cancellation'}</button></p></>}/>
      </fieldset></form>}
    </article>)}<p className="helper-note">Verified provider bookings also update your shared OOH plan. Per-location costs remain unknown when the provider reports only a combined quote. Delivery totals come from Broadsign’s line-item performance fields. Raw proof-of-play logs require a separate Broadsign Control / POP integration.</p></>}
    </fieldset>
  </section>;
}
