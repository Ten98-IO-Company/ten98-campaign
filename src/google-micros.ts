import type { DisplayFormatter } from '@ten98/ui';
import { minorDigits } from './display-locale.ts';

// Google Ads reports money in micros: millionths of the account currency, as an integer or its digit string. Shifting
// the decimal point in the digits keeps every amount exact; dividing by 1,000,000 would round through a float.
export function microsToDecimal(micros: unknown): string | null {
  const digits = wholeMicros(micros);
  if (digits === null) return null;
  const [, sign, value] = /^(-?)(\d+)$/.exec(digits)!;
  const padded = value.padStart(7, '0'), whole = padded.slice(0, -6).replace(/^0+(?=\d)/, ''), fraction = padded.slice(-6).replace(/0+$/, '');
  return `${sign}${whole}${fraction ? '.' + fraction : ''}`;
}

/**
 * A decimal amount in currency units as whole micros. A string must be exact to the micro ("12.345678"); a number is
 * already a float, so it is fixed to six decimals (0.1 + 0.2 gives 300000). Null for anything else.
 */
export function decimalToMicros(amount: unknown): string | null {
  const match = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(typeof amount === 'number' ? (Number.isFinite(amount) ? amount.toFixed(6) : '') : typeof amount === 'string' ? amount.trim() : '');
  return match ? `${match[1]}${BigInt(match[2] + (match[3] || '').padEnd(6, '0'))}` : null;
}

const wholeMicros = (micros: unknown) => {
  const text = typeof micros === 'number' ? (Number.isSafeInteger(micros) ? String(micros) : '') : typeof micros === 'string' ? micros.trim() : '';
  return /^-?\d+$/.test(text) ? text : null;
};


/** Whole micros rounded half-up (away from zero) to the currency's minor unit, in integer arithmetic. */
export function roundMicrosToMinor(micros: unknown, currency: string | undefined): string | null {
  const digits = wholeMicros(micros);
  if (digits === null) return null;
  const negative = digits.startsWith('-'), magnitude = BigInt(negative ? digits.slice(1) : digits), unit = 10n ** BigInt(6 - Math.min(6, minorDigits(currency)));
  const rounded = (magnitude + unit / 2n) / unit * unit;
  return `${negative && rounded > 0n ? '-' : ''}${rounded}`;
}

/**
 * A micros amount in its account currency; "—" when Google did not report one. Settings (budgets, bids) stay exact to
 * the micro, as Google holds them. Reported metrics pass `{ round: 'minor' }`: their extra digits are precision noise,
 * so spend and estimates read in the currency's minor units, as Google's own UI shows them.
 */
export function formatMicros(micros: unknown, currency: string | undefined, format: DisplayFormatter, options: { round?: 'minor' } = {}) {
  const value = microsToDecimal(options.round === 'minor' ? roundMicrosToMinor(micros, currency) : micros);
  // Without a known currency code the formatter shows the amount on its own.
  return value === null ? '—' : format.currency(value, currency || '');
}
