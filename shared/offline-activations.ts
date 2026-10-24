// Offline field activity on a campaign (server validation and the activation editor share these).
export const ACTIVATION_TYPES = ['roadshow', 'door_to_door', 'event', 'street_team', 'sampling'] as const;
export type ActivationType = typeof ACTIVATION_TYPES[number];
export const ACTIVATION_TYPE_LABELS: Record<ActivationType, string> = { roadshow: 'Roadshow stop', door_to_door: 'Door-to-door area', event: 'Event or booth', street_team: 'Street team or flyering', sampling: 'Sampling' };

// Contacts captured at an activation carry this tag, so Direct campaigns can target them and results can count them.
export const activationTag = (activationId: string) => 'offline:' + activationId.slice(0, 8);
export type ConsentChannel = 'email' | 'sms' | 'whatsapp';
export const CONSENT_CHANNELS: ConsentChannel[] = ['email', 'sms', 'whatsapp'];
export const CONSENT_LABELS: Record<ConsentChannel, string> = { email: 'Email', sms: 'Text message', whatsapp: 'WhatsApp' };
// Channel names inside a sentence, always in CONSENT_CHANNELS order whatever order the boxes were ticked in.
const CONSENT_NAMES: Record<ConsentChannel, string> = { email: 'email', sms: 'text message', whatsapp: 'WhatsApp' };
export const consentChannelList = (channels: ConsentChannel[], conjunction: 'and' | 'or' = 'and') => {
  const names = CONSENT_CHANNELS.filter(channel => channels.includes(channel)).map(channel => CONSENT_NAMES[channel]);
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} ${conjunction} ${names[names.length - 1]}`;
};
// The sentence the capture form shows, updated as channels are ticked (every channel while none is). The server records
// the same sentence for the ticked channels as consent evidence, so the two cannot drift apart.
export const consentWording = (brand: string, channels: ConsentChannel[]) => `Yes, ${brand} may send me news and offers by ${channels.length ? consentChannelList(channels) : consentChannelList(CONSENT_CHANNELS, 'or')}. I can unsubscribe at any time.`;
