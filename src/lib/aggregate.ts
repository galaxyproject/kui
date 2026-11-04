import type { ServerEntry, Snapshot } from './types';
import {
  average,
  latest,
  ratioSeries,
  recordsAt,
  series,
  sliceRange,
  type MetricKey,
  type Series,
} from './metrics';

export interface AggregateInput {
  server: ServerEntry;
  snapshot: Snapshot;
}

export interface ServerSeries {
  id: string;
  name: string;
  shortName: string;
  color: string;
  values: Series;
  average: number | null;
}

/** Union of every server's months, continuous and ascending, so stacked charts
 *  line up even when servers started collecting at different times. */
export function unifiedMonths(inputs: AggregateInput[], from?: string, to?: string): string[] {
  const all = new Set<string>();
  for (const { snapshot } of inputs) {
    for (const record of snapshot.months) all.add(record.month);
  }
  const sorted = [...all].sort();
  const first = from ?? sorted[0];
  const last = to ?? sorted[sorted.length - 1];
  return sorted.filter((month) => month >= first && month <= last);
}

export function seriesByServer(
  inputs: AggregateInput[],
  months: string[],
  key: MetricKey,
): ServerSeries[] {
  return inputs.map(({ server, snapshot }) => {
    const values = series(recordsAt(snapshot.months, months), key);
    return {
      id: server.id,
      name: server.name,
      shortName: server.shortName,
      color: server.color,
      values,
      average: average(values),
    };
  });
}

export function ratioSeriesByServer(
  inputs: AggregateInput[],
  months: string[],
  numerator: MetricKey,
  denominator: MetricKey,
): ServerSeries[] {
  return inputs.map(({ server, snapshot }) => {
    const values = ratioSeries(recordsAt(snapshot.months, months), numerator, denominator);
    return {
      id: server.id,
      name: server.name,
      shortName: server.shortName,
      color: server.color,
      values,
      average: average(values),
    };
  });
}

export interface HeadlineTotal {
  key: MetricKey;
  total: number | null;
  /** Month each server contributed from — differing months get a footnote. */
  contributions: { server: string; month: string; value: number }[];
  missing: string[];
}

/** Sum of each server's newest available value within the range. Servers do not
 *  all report the same latest month, so the total is "as of" mixed months. */
export function headlineTotal(
  inputs: AggregateInput[],
  from: string,
  to: string,
  key: MetricKey,
): HeadlineTotal {
  const contributions: HeadlineTotal['contributions'] = [];
  const missing: string[] = [];

  for (const { server, snapshot } of inputs) {
    const newest = latest(sliceRange(snapshot.months, from, to), key);
    if (newest) contributions.push({ server: server.shortName, month: newest.month, value: newest.value });
    else missing.push(server.shortName);
  }

  return {
    key,
    total: contributions.length
      ? contributions.reduce((total, contribution) => total + contribution.value, 0)
      : null,
    contributions,
    missing,
  };
}

export function mixedMonths(total: HeadlineTotal): boolean {
  const months = new Set(total.contributions.map((contribution) => contribution.month));
  return months.size > 1;
}
