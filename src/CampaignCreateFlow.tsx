import { useState } from 'react';
import { Alert, Button, FormActions, RadioGroup, Stack, Text } from '@ten98/ui';
import { campaignCreationChoices, campaignCreationDestination, type CampaignCreationDestination, type CampaignCreationKind } from './campaign-creation';

type Props = {
  initialKind?: CampaignCreationKind;
  campaignName?: string;
  disabled?: boolean;
  onContinue: (destination: CampaignCreationDestination) => void;
  onCancel: () => void;
};

export default function CampaignCreateFlow({ initialKind = 'plan', campaignName, disabled = false, onContinue, onCancel }: Props) {
  const [kind, setKind] = useState(initialKind);
  const [adService, setAdService] = useState<'connected' | 'google-shopping' | 'microsoft-search'>('connected');
  const [billboardMode, setBillboardMode] = useState<'manual' | 'broadsign'>('manual');
  const independent = kind === 'advertising' || kind === 'billboards' && billboardMode === 'broadsign';
  return <Stack as="form" gap={4} onSubmit={event => { event.preventDefault(); if (!disabled) onContinue(campaignCreationDestination(kind, adService, billboardMode)); }}>
    <Text tone="muted">Choose what to create. The next screen contains its details and review.</Text>
    <RadioGroup name="campaignKind" legend="Campaign type" value={kind} disabled={disabled} onValueChange={value => setKind(value as CampaignCreationKind)} options={campaignCreationChoices}/>
    {kind === 'advertising' && <RadioGroup name="adService" legend="Ad service" value={adService} disabled={disabled} onValueChange={value => setAdService(value as typeof adService)} options={[
      { value: 'connected', label: 'Connected ad accounts', description: 'Create through your connected social and ad accounts.' },
      { value: 'google-shopping', label: 'Google Shopping', description: 'Use the direct Google Ads connection.' },
      { value: 'microsoft-search', label: 'Microsoft Search', description: 'Use the direct Microsoft Advertising connection.' },
    ]}/>}
    {kind === 'billboards' && <RadioGroup name="billboardMode" legend="Booking type" value={billboardMode} disabled={disabled} onValueChange={value => setBillboardMode(value as typeof billboardMode)} options={[
      { value: 'manual', label: 'Booking plan', description: 'Record dates, location and cost without contacting a provider.' },
      { value: 'broadsign', label: 'Connected screens', description: 'Choose inventory, then review a provider proposal and any booking separately.' },
    ]}/>}
    {campaignName && <Alert tone="info">{kind === 'plan' ? 'This creates a separate campaign plan.' : independent ? 'This provider manages its own campaigns and bookings. It will not be linked automatically to “' + campaignName + '”.' : 'Start this work in “' + campaignName + '”.'}</Alert>}
    <FormActions><Button type="submit" variant="primary" disabled={disabled}>Continue</Button><Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button></FormActions>
  </Stack>;
}
