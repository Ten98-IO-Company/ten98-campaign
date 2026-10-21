import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Field, FormActions, Input, Stack, StatusLine } from '@ten98/ui';

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
  return <Stack as="form" gap={3} onSubmit={connect}><Stack as="fieldset" gap={3} disabled={busy}><Field label="ChatGPT Ads Manager API key" required description="The key is sent securely to Zernio. It is not saved in this app. Submit a rotated key to update the same account."><Input name="apiKey" type="password" required maxLength={500} autoComplete="off" spellCheck={false}/></Field><FormActions><Button type="submit" loading={busy}>{busy ? 'Verifying connection…' : 'Connect ChatGPT Ads'}</Button></FormActions></Stack>{error && <Alert tone="danger" title={error}/>}{notice && <StatusLine tone="success">{notice}</StatusLine>}</Stack>;
}
