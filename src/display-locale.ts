import { createDisplayFormatter } from '@ten98/ui';

// Campaign shows dates, numbers and amounts in American English (owner decision, 2026-11-15), in the viewer's own time
// zone. The app root's DisplayFormatProvider and every formatter made outside React take this locale.
export const displayLocale = 'en-US';
// For code outside a component (pure view helpers, upload limits); components use useDisplayFormat, which has the same locale.
export const appFormat = createDisplayFormatter({ locale: displayLocale });

// The currency's minor-unit digits (2 for USD, 3 for KWD, 0 for JPY), read from Intl's currency data; undefined for a
// missing or malformed code. Formats nothing. The one copy until @ten98/runtime exposes currencyExponent.
export function currencyDigits(currency: unknown): number | undefined {
  if (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency)) return undefined;
  try { return new Intl.NumberFormat(displayLocale, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits; } catch { return undefined; }
}
/** As currencyDigits, with 2 for a missing or malformed code. */
export const minorDigits = (currency: unknown): number => currencyDigits(currency) ?? 2;
