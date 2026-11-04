import { describe, expect, it } from 'vitest';
import { headlineTotal, mixedMonths, seriesByServer, unifiedMonths } from './aggregate';
import type { AggregateInput } from './aggregate';
import type { MonthRecord, ServerEntry } from './types';

function server(id: string, color: string): ServerEntry {
  return {
    id,
    name: id,
    shortName: id.toUpperCase(),
    url: `https://${id}`,
    color,
    tables: {},
  };
}

function record(month: string, totalRegistered: number | null): MonthRecord {
  return {
    month,
    users: {
      total_registered: totalRegistered,
      new_registrations: null,
      engaged: null,
      engaged_day_plus: null,
      new_engaged_day_plus: null,
    },
    jobs: null,
    usage: null,
  };
}

// Servers start collecting at different times and stop at different times —
// 'be' here stands in for the real partial-table server.
const inputs: AggregateInput[] = [
  {
    server: server('org', '#f4761f'),
    snapshot: {
      schemaVersion: 1,
      server: 'org',
      generatedAt: '',
      months: [record('2026-01', 100), record('2026-02', 110), record('2026-03', 120)],
    },
  },
  {
    server: server('be', '#8b5cf6'),
    snapshot: {
      schemaVersion: 1,
      server: 'be',
      generatedAt: '',
      months: [record('2026-02', 5)],
    },
  },
];

describe('unifiedMonths', () => {
  it('unions every server month and stays ascending', () => {
    expect(unifiedMonths(inputs)).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  it('honours an explicit range', () => {
    expect(unifiedMonths(inputs, '2026-02', '2026-03')).toEqual(['2026-02', '2026-03']);
  });
});

describe('seriesByServer', () => {
  it('pads a late-starting server with nulls so bars stay aligned', () => {
    const months = unifiedMonths(inputs);
    const [org, be] = seriesByServer(inputs, months, 'total_registered');
    expect(org.values).toEqual([100, 110, 120]);
    expect(be.values).toEqual([null, 5, null]);
    expect(be.average).toBe(5);
  });
});

describe('headlineTotal', () => {
  it('sums each server newest in-range value even when months differ', () => {
    const total = headlineTotal(inputs, '2026-01', '2026-03', 'total_registered');
    expect(total.total).toBe(125);
    expect(mixedMonths(total)).toBe(true);
    expect(total.contributions).toEqual([
      { server: 'ORG', month: '2026-03', value: 120 },
      { server: 'BE', month: '2026-02', value: 5 },
    ]);
  });

  it('reports servers with nothing in range instead of counting them as zero', () => {
    const total = headlineTotal(inputs, '2026-03', '2026-03', 'total_registered');
    expect(total.total).toBe(120);
    expect(total.missing).toEqual(['BE']);
  });
});
