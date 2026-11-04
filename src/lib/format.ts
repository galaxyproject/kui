const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Compact form used for big numbers on cards and chart axes: 147.6M, 8.5K. */
export function compact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${trim(value / 1e9)}B`;
  if (abs >= 1e6) return `${trim(value / 1e6)}M`;
  if (abs >= 1e3) return `${trim(value / 1e3)}K`;
  return String(Math.round(value));
}

function trim(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}

export function integer(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString('en-US');
}

export function percent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

/** Change figures carry their direction: '+4.2%', '−1.0%'. */
export function signedPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${Math.abs(value).toFixed(digits)}%`;
}

/** Month arithmetic on the 'YYYY-MM' keys used throughout: shiftMonth('2026-06', -12) → '2025-06'. */
export function shiftMonth(month: string, deltaMonths: number): string {
  const [year, index] = month.split('-').map(Number);
  const absolute = year * 12 + (index - 1) + deltaMonths;
  return `${Math.floor(absolute / 12)}-${String((absolute % 12) + 1).padStart(2, '0')}`;
}

/** '2026-06' → 'Jun 2026' */
export function monthLabel(month: string): string {
  const [year, index] = month.split('-');
  return `${MONTH_NAMES[Number(index) - 1]} ${year}`;
}

/** '2026-06' → 'Jun\n2026', for crowded category axes. */
export function monthLabelShort(month: string): string {
  const [year, index] = month.split('-');
  return `${MONTH_NAMES[Number(index) - 1]} '${year.slice(2)}`;
}
