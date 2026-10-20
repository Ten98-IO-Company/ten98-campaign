import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { accountLabel } from './PostComposer';

type Row = Record<string, any>;
type Request = (path: string) => Promise<any>;
export default function AdCampaignDiscovery({ request }: { request: Request }) {
  const [accounts, setAccounts] = useState<Row[] | null>(null), [accountId, setAccountId] = useState(''), [advertisers, setAdvertisers] = useState<Row[] | null>(null), [adAccountId, setAdAccountId] = useState('');
  const [result, setResult] = useState<Row | null>(null), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const generation = useRef(0), mounted = useRef(true), requester = useRef(request), frame = useMemo(() => ({}), [accountId, adAccountId]), committed = useRef(frame);
  useLayoutEffect(() => { committed.current = frame; requester.current = request; }, [frame, request]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  const current = () => mounted.current && committed.current === frame;
  function withdraw() { generation.current++; setResult(null); setError(''); setBusy(''); }
  async function loadAccounts() {
    if (!current()) return;
    withdraw(); setAccounts(null); setAccountId(''); setAdvertisers(null); setAdAccountId('');
    const read = ++generation.current; setBusy('accounts');
    try {
      const value = await requester.current('accounts');
      if (!mounted.current || read !== generation.current) return;
      if (!Array.isArray(value?.accounts) || value.accounts.some((row: Row) => !row || typeof row._id !== 'string' || !row._id || typeof row.platform !== 'string') || new Set(value.accounts.map((row: Row) => row._id)).size !== value.accounts.length) throw new Error('Project connections could not be verified.');
      setAccounts(value.accounts.filter((row: Row) => ['metaads', 'facebook', 'instagram'].includes(row.platform)));
    } catch (failure) { if (mounted.current && read === generation.current) setError((failure as Error).message || 'Project connections are unavailable.'); }
    finally { if (mounted.current && read === generation.current) setBusy(''); }
  }
  async function loadAdvertisers() {
    if (!current() || !accountId) return;
    withdraw(); setAdvertisers(null); setAdAccountId('');
    const read = ++generation.current; setBusy('advertisers');
    try {
      const value = await requester.current('ads/accounts?' + new URLSearchParams({ accountId }));
      if (!mounted.current || read !== generation.current) return;
      if (value?.stale || !Array.isArray(value?.accounts) || value.accounts.some((row: Row) => !row || typeof row.id !== 'string' || !row.id || row.selectable !== undefined && typeof row.selectable !== 'boolean' || row.name != null && typeof row.name !== 'string') || new Set(value.accounts.map((row: Row) => row.id)).size !== value.accounts.length) throw new Error('Current advertiser access could not be verified.');
      setAdvertisers(value.accounts);
    } catch (failure) { if (mounted.current && read === generation.current) setError((failure as Error).message || 'Advertiser access is unavailable.'); }
    finally { if (mounted.current && read === generation.current) setBusy(''); }
  }
  useEffect(() => { if (accountId) void loadAdvertisers(); }, [accountId]);
  async function discover() {
    if (!current() || !accountId || !adAccountId || !advertisers?.some(row => row.id === adAccountId && row.selectable !== false)) return;
    withdraw(); const read = ++generation.current; setBusy('campaigns');
    try {
      const value = await requester.current('ads/campaign-discovery?' + new URLSearchParams({ accountId, adAccountId }));
      if (!mounted.current || read !== generation.current) return;
      if (value?.accountId !== accountId || value.adAccountId !== adAccountId || value.complete !== true || !Array.isArray(value.campaigns) || value.campaigns.length > 1000 || value.campaigns.some((row: Row) => !row || typeof row.platformCampaignId !== 'string' || !row.platformCampaignId || !['facebook', 'instagram'].includes(row.platform) || ['campaignName', 'status', 'platformCampaignStatus'].some(field => row[field] !== null && typeof row[field] !== 'string') || row.adCount !== null && (!Number.isSafeInteger(row.adCount) || row.adCount < 0)) || new Set(value.campaigns.map((row: Row) => row.platformCampaignId)).size !== value.campaigns.length) throw new Error('The complete campaign list and selected advertiser could not be verified.');
      setResult(value);
    } catch (failure) { if (mounted.current && read === generation.current) setError((failure as Error).message || 'Campaign discovery is unavailable.'); }
    finally { if (mounted.current && read === generation.current) setBusy(''); }
  }
  return <section className="panel settings-panel"><div className="panel-heading"><h2>Discover Meta campaigns</h2><button type="button" className="button" disabled={busy === 'accounts'} onClick={loadAccounts}>{busy === 'accounts' ? 'Loading connections…' : 'Load Meta connections'}</button></div>
    <p className="helper-note">Includes campaigns with no ads. These results are read-only. Delivery status is last stored by the provider, not a live switch check.</p>
    {error && <p className="alert" role="alert">{error}</p>}
    {accounts && !accounts.length && <p role="status">No Meta connections were returned for this project.</p>}
    {accounts && accounts.length > 0 && <div className="form-grid"><label className="field"><span>Meta connection</span><select name="accountId" autoComplete="off" value={accountId} onChange={event => { if (!current()) return; const id = event.target.value; if (id && !accounts.some(row => row._id === id && row.isActive !== false)) return; withdraw(); setAccountId(id); setAdvertisers(null); setAdAccountId(''); }}><option value="">Choose a connection</option>{accounts.map(row => <option key={row._id} value={row._id} disabled={row.isActive === false}>{accountLabel({ ...row, id: row._id })}{row.isActive === false ? ' · Unavailable' : ''}</option>)}</select></label>
    <label className="field"><span>Meta advertiser</span><select name="adAccountId" autoComplete="off" value={adAccountId} disabled={!advertisers?.length} onChange={event => { if (!current()) return; const id = event.target.value; if (id && !advertisers?.some(row => row.id === id && row.selectable !== false)) return; withdraw(); setAdAccountId(id); }}><option value="">{busy === 'advertisers' ? 'Loading advertisers…' : 'Choose an advertiser'}</option>{advertisers?.map(row => <option key={row.id} value={row.id} disabled={row.selectable === false}>{row.name || row.id} · {row.id}{row.selectable === false ? ' · Unavailable' : ''}</option>)}</select></label></div>}
    {accountId && <div className="button-wrap"><button type="button" className="button" disabled={busy === 'advertisers'} onClick={loadAdvertisers}>Refresh advertisers</button><button type="button" className="button" disabled={!adAccountId || !!busy} onClick={discover}>{busy === 'campaigns' ? 'Discovering campaigns…' : 'Discover campaigns'}</button></div>}
    {advertisers && !advertisers.length && <p role="status">No advertisers were returned for this connection.</p>}
    {result && <><p className="helper-note" role="status">Connection {result.accountId} · Advertiser {result.adAccountId} · {result.campaigns.length} {result.campaigns.length === 1 ? 'campaign' : 'campaigns'} returned</p>{result.campaigns.length ? <div className="table-scroll"><table><thead><tr><th>Campaign</th><th>Network</th><th>Stored delivery</th><th>Ads</th></tr></thead><tbody>{result.campaigns.map((row: Row) => <tr key={row.platformCampaignId}><td><strong>{row.campaignName || 'Name not reported'}</strong><small> · Native ID {row.platformCampaignId}</small></td><td>{row.platform === 'instagram' ? 'Instagram' : 'Facebook'}</td><td>{row.status ?? 'Not reported'}{row.platformCampaignStatus && <small> · {row.platformCampaignStatus}</small>}</td><td>{row.adCount === null ? 'Not reported' : row.adCount}</td></tr>)}</tbody></table></div> : <p role="status">No campaigns returned for this advertiser, including campaigns with no ads.</p>}</>}
  </section>;
}
