import { describe, expect, it } from 'vitest';
import { shiftMonth, signedPercent } from './format';

describe('shiftMonth', () => {
  it('steps back a year', () => {
    expect(shiftMonth('2026-06', -12)).toBe('2025-06');
  });

  it('crosses the year boundary in both directions', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2025-12', 1)).toBe('2026-01');
  });

  it('keeps January and December intact rather than sliding by one', () => {
    expect(shiftMonth('2026-01', -12)).toBe('2025-01');
    expect(shiftMonth('2026-12', -12)).toBe('2025-12');
  });

  it('handles multi-year offsets', () => {
    expect(shiftMonth('2026-03', -24)).toBe('2024-03');
  });
});

describe('signedPercent', () => {
  it('carries the direction', () => {
    expect(signedPercent(1.04)).toBe('+1.0%');
    expect(signedPercent(-15.25)).toBe('−15.3%');
    expect(signedPercent(0)).toBe('0.0%');
  });

  it('is an em dash when there is nothing to compare', () => {
    expect(signedPercent(null)).toBe('—');
    expect(signedPercent(Number.POSITIVE_INFINITY)).toBe('—');
  });
});
