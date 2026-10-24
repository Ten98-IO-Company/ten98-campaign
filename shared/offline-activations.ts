// Offline field activity on a campaign (server validation and the activation editor share these).
export const ACTIVATION_TYPES = ['roadshow', 'door_to_door', 'event', 'street_team', 'sampling'] as const;
export type ActivationType = typeof ACTIVATION_TYPES[number];
export const ACTIVATION_TYPE_LABELS: Record<ActivationType, string> = { roadshow: 'Roadshow stop', door_to_door: 'Door-to-door area', event: 'Event or booth', street_team: 'Street team or flyering', sampling: 'Sampling' };

// Contacts captured at an activation carry this tag, so Direct campaigns can target them and results can count them.
export const activationTag = (activationId: string) => 'offline:' + activationId.slice(0, 8);
export type ConsentChannel = 'email' | 'sms' | 'whatsapp';
export const CONSENT_CHANNELS: ConsentChannel[] = ['email', 'sms', 'whatsapp'];
export const CONSENT_LABELS: Record<ConsentChannel, string> = { email: 'Email', sms: 'Text message', whatsapp: 'WhatsApp' };
// What staff show above the unticked channel boxes; the server records the same sentence, with the ticked channels, as consent evidence.
export const consentPrompt = (brand: string) => `Yes, ${brand} may send me news and offers by`;
export const consentWording = (brand: string, channels: ConsentChannel[]) => `${consentPrompt(brand)} ${channels.map(channel => CONSENT_LABELS[channel].toLowerCase()).join(', ')}. I can unsubscribe at any time.`;
