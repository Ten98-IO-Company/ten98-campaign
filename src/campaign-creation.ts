export type CampaignCreationKind = 'plan' | 'social' | 'advertising' | 'email' | 'sms' | 'whatsapp' | 'billboards' | 'field';
export type CampaignCreationDestination = 'plan' | 'post' | 'ad' | 'google-shopping' | 'microsoft-search' | 'email' | 'sms' | 'whatsapp' | 'placement' | 'broadsign' | 'activation';
export type CampaignCreationIntent = {
  id: number;
  projectId: string;
  destination: CampaignCreationDestination;
  campaignId?: string;
  day?: string;
  dates?: { start?: string; end?: string };
};
// Native editors retain their own draft and operation state; the shell coordinates leaving them.
export type CampaignEditorGuard = { dirty: boolean; busy: boolean; revision: string; discard: () => void };

export function campaignCreationRoute(destination: CampaignCreationDestination): { page: 'Campaigns' | 'Publishing' | 'Ads manager' | 'Direct campaigns' | 'OOH media' | 'Field activity'; section: string } {
  if (destination === 'plan') return { page: 'Campaigns', section: '' };
  if (destination === 'post') return { page: 'Publishing', section: 'posts' };
  if (destination === 'ad' || destination === 'google-shopping' || destination === 'microsoft-search') return { page: 'Ads manager', section: destination === 'google-shopping' ? 'shopping' : destination === 'microsoft-search' ? 'microsoft' : 'campaigns' };
  if (destination === 'email' || destination === 'sms' || destination === 'whatsapp') return { page: 'Direct campaigns', section: 'campaigns' };
  return { page: destination === 'activation' ? 'Field activity' : 'OOH media', section: '' };
}

export const campaignCreationChoices: { value: CampaignCreationKind; label: string; description: string }[] = [
  { value: 'plan', label: 'Campaign plan', description: 'Organize a launch across channels. Saving a plan does not publish or spend.' },
  { value: 'social', label: 'Social post', description: 'Draft a post for your connected social accounts.' },
  { value: 'advertising', label: 'Ad campaign', description: 'Use the ad service’s setup and review. New campaigns start paused.' },
  { value: 'email', label: 'Email campaign', description: 'Prepare an email and audience before reviewing any send.' },
  { value: 'sms', label: 'SMS campaign', description: 'Prepare a text message and review recipients and charges.' },
  { value: 'whatsapp', label: 'WhatsApp campaign', description: 'Choose an approved template and review your audience.' },
  { value: 'billboards', label: 'Billboard booking', description: 'Record a booking plan or choose screens from a connected provider.' },
  { value: 'field', label: 'Field activity', description: 'Plan an event, visit or activation within a campaign plan.' },
];

export function campaignCreationDestination(kind: CampaignCreationKind, adService: 'connected' | 'google-shopping' | 'microsoft-search' = 'connected', billboardMode: 'manual' | 'broadsign' = 'manual'): CampaignCreationDestination {
  if (kind === 'advertising') return adService === 'connected' ? 'ad' : adService;
  if (kind === 'billboards') return billboardMode === 'manual' ? 'placement' : 'broadsign';
  return ({ plan: 'plan', social: 'post', email: 'email', sms: 'sms', whatsapp: 'whatsapp', field: 'activation' } as const)[kind];
}
