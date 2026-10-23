// Offline field activity on a campaign (server validation and the activation editor share these).
export const ACTIVATION_TYPES = ['roadshow', 'door_to_door', 'event', 'street_team', 'sampling'] as const;
export type ActivationType = typeof ACTIVATION_TYPES[number];
export const ACTIVATION_TYPE_LABELS: Record<ActivationType, string> = { roadshow: 'Roadshow stop', door_to_door: 'Door-to-door area', event: 'Event or booth', street_team: 'Street team or flyering', sampling: 'Sampling' };
