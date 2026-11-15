import type { DisplayFormatter } from '@ten98/ui';

// Google Ads reports money in micros: millionths of the account currency, as an integer or its digit string. Shifting
// the decimal point in the digits keeps every amount exact; dividing by 1,000,000 would round through a float.
export function microsToDecimal(micros: unknown): string | null {
  const text = typeof micros === 'number' ? (Number.isSafeInteger(micros) ? String(micros) : '') : typeof micros === 'string' ? micros.trim() : '';
  const match = /^(-?)(\d+)$/.exec(text);
  if (!match) return null;
  const digits = match[2].padStart(7, '0'), whole = digits.slice(0, -6).replace(/^0+(?=\d)/, ''), fraction = digits.slice(-6).replace(/0+$/, '');
  return `${match[1]}${whole}${fraction ? '.' + fraction : ''}`;
}

/** A micros amount in its account currency, exact to the micro; "—" when Google did not report one. */
export function formatMicros(micros: unknown, currency: string | undefined, format: DisplayFormatter) {
  const value = microsToDecimal(micros);
  // Without a known currency code the formatter shows the amount on its own.
  return value === null ? '—' : format.currency(value, currency || '');
}
