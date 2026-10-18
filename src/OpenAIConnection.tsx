import React, { useEffect, useRef, useState } from 'react';

export default function OpenAIConnection({ request, onConnected }: { request: (path: string, body?: any) => Promise<any>; onConnected: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function connect(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const form = event.currentTarget, apiKey = String(new FormData(form).get('apiKey') || '').trim();
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await request('connect/openai-ads', { apiKey });
      if (mounted.current) { form.reset(); setNotice(`${result.adAccountName || 'ChatGPT Ads'} connected. You can now create a paused campaign.`); onConnected(); }
    } catch (failure) { if (mounted.current && (failure as Error).name !== 'AbortError') setError((failure as Error).message || 'The connection could not be confirmed.'); }
    finally { if (mounted.current) setBusy(false); }
  }
  return <section className="panel settings-panel"><h2>ChatGPT advertising</h2><p>Connect the ad account through Zernio using an API key from ChatGPT Ads Manager. Each key covers one advertising account and carries campaign write access.</p><form onSubmit={connect}><fieldset disabled={busy}><label className="field"><span>ChatGPT Ads Manager API key *</span><input name="apiKey" type="password" required maxLength={500} autoComplete="off" spellCheck={false}/></label><p className="field-help">The key is sent securely to Zernio. It is not saved in this app. Submit a rotated key to update the same account.</p><button className="button primary">{busy ? 'Verifying connection…' : 'Connect ChatGPT Ads'}</button></fieldset></form>{error && <div className="alert" role="alert">{error}</div>}{notice && <p role="status">{notice}</p>}</section>;
}
