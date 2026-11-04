import type { MonthRecord, Snapshot } from './types';

export type Series = (number | null)[];

/** Every metric a chart or card can ask for, addressed by a flat key. */
export type MetricKey =
  | 'total_registered'
  | 'new_registrations'
  | 'engaged'
  | 'engaged_day_plus'
  | 'new_engaged_day_plus'
  | 'total_jobs'
  | 'month_jobs'
  | 'by_new_users'
  | 'by_new_users_engaged_day_plus'
  | 'errored'
  | 'errored_by_new_users'
  | 'total_histories'
  | 'total_datasets'
  | 'total_workflows'
  | 'total_workflow_invocations'
  | 'tool_installs';

const GROUP_OF: Record<MetricKey, 'users' | 'jobs' | 'usage'> = {
  total_registered: 'users',
  new_registrations: 'users',
  engaged: 'users',
  engaged_day_plus: 'users',
  new_engaged_day_plus: 'users',
  total_jobs: 'jobs',
  month_jobs: 'jobs',
  by_new_users: 'jobs',
  by_new_users_engaged_day_plus: 'jobs',
  errored: 'jobs',
  errored_by_new_users: 'jobs',
  total_histories: 'usage',
  total_datasets: 'usage',
  total_workflows: 'usage',
  total_workflow_invocations: 'usage',
  tool_installs: 'usage',
};

export function valueAt(record: MonthRecord, key: MetricKey): number | null {
  const group = record[GROUP_OF[key]];
  if (!group) return null;
  return (group as unknown as Record<MetricKey, number | null>)[key] ?? null;
}

export function series(months: MonthRecord[], key: MetricKey): Series {
  return months.map((record) => valueAt(record, key));
}

export function monthKeys(months: MonthRecord[]): string[] {
  return months.map((record) => record.month);
}

export function sliceRange(months: MonthRecord[], from: string, to: string): MonthRecord[] {
  return months.filter((record) => record.month >= from && record.month <= to);
}

/** Mean over present values only; null when the range holds no data. */
export function average(values: Series): number | null {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return null;
  return present.reduce((sum, value) => sum + value, 0) / present.length;
}

export function sum(values: Series): number | null {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return null;
  return present.reduce((total, value) => total + value, 0);
}

/** Cumulative metrics ("total registered users") read off the newest month
 *  in range that actually has the value, not the newest month in range. */
export function latest(
  months: MonthRecord[],
  key: MetricKey,
): { month: string; value: number } | null {
  for (let i = months.length - 1; i >= 0; i--) {
    const value = valueAt(months[i], key);
    if (value !== null) return { month: months[i].month, value };
  }
  return null;
}

export function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  return (numerator / denominator) * 100;
}

/** Relative change between two comparable figures. Null when there is nothing
 *  to compare against — including a zero baseline, where the change is
 *  arithmetically infinite rather than informative. */
export function percentChange(current: number | null, prior: number | null): number | null {
  if (current === null || prior === null || prior === 0) return null;
  return ((current - prior) / prior) * 100;
}

/** The equally long stretch of months immediately before a range, for
 *  period-over-period comparison.
 *
 *  Null when the history does not reach back far enough. A truncated baseline
 *  would be neither comparable across servers nor stable over time, so a server
 *  that cannot support the comparison omits it and starts showing it once it
 *  has accumulated the months — no per-server thresholds to maintain. */
export function precedingWindow(
  allMonths: string[],
  from: string,
  to: string,
): { from: string; to: string; length: number } | null {
  const fromIndex = allMonths.indexOf(from);
  const toIndex = allMonths.indexOf(to);
  if (fromIndex < 0 || toIndex < 0) return null;

  const length = toIndex - fromIndex + 1;
  if (fromIndex < length) return null;

  return { from: allMonths[fromIndex - length], to: allMonths[fromIndex - 1], length };
}

/** Per-month ratio series, e.g. monthly error rate. */
export function ratioSeries(
  months: MonthRecord[],
  numeratorKey: MetricKey,
  denominatorKey: MetricKey,
): Series {
  return months.map((record) => ratio(valueAt(record, numeratorKey), valueAt(record, denominatorKey)));
}

/** Ratio of the two range averages — the figure shown on the gauge cards.
 *  Deliberately not the average of the monthly ratios: the dashboard reports
 *  "of the average X, how much was Y". */
export function averageRatio(
  months: MonthRecord[],
  numeratorKey: MetricKey,
  denominatorKey: MetricKey,
): number | null {
  return ratio(average(series(months, numeratorKey)), average(series(months, denominatorKey)));
}

export interface JobShare {
  month: string;
  returningUsers: number | null;
  newUsers: number | null;
}

/** Share of each month's jobs by user cohort. Sums to 100% per month.
 *  Deliberately two cohorts: splitting new users again by multi-day engagement
 *  produced a figure that took a paragraph to explain. */
export function jobShare(months: MonthRecord[]): JobShare[] {
  return months.map((record) => {
    const total = valueAt(record, 'month_jobs');
    const byNew = valueAt(record, 'by_new_users');
    if (total === null || total === 0 || byNew === null) {
      return { month: record.month, returningUsers: null, newUsers: null };
    }
    return {
      month: record.month,
      returningUsers: ((total - byNew) / total) * 100,
      newUsers: (byNew / total) * 100,
    };
  });
}

/** Month-over-month change in a cumulative counter — what was actually created
 *  that month. Null at the first month and across gaps: bridging a gap would
 *  report two months of growth as one. */
export function deltaSeries(months: MonthRecord[], key: MetricKey): Series {
  return months.map((record, index) => {
    if (index === 0) return null;
    const current = valueAt(record, key);
    const previous = valueAt(months[index - 1], key);
    if (current === null || previous === null) return null;
    return current - previous;
  });
}

/** Deltas across the whole snapshot, addressable by month. Computing over the
 *  full history and looking up afterwards means the earliest month on screen
 *  still has a change, and a year-earlier month can be read even when it falls
 *  outside the selected range. */
export function deltaByMonth(months: MonthRecord[], key: MetricKey): Map<string, number | null> {
  const deltas = deltaSeries(months, key);
  return new Map(months.map((record, index) => [record.month, deltas[index]]));
}

/** Months of smoothing needed to cancel the academic-calendar cycle in this
 *  data: registrations swing about ±30% between the March/November peaks and
 *  the July/August troughs, and only a full-year window removes it. */
export const TREND_WINDOW_MONTHS = 12;

/** Trailing moving average, addressable by month. Computed across the whole
 *  snapshot so a twelve-month window does not consume the start of a
 *  thirteen-month view. A window containing a gap yields null rather than
 *  averaging over a shorter denominator and passing it off as comparable. */
export function movingAverageByMonth(
  months: MonthRecord[],
  key: MetricKey,
  window = TREND_WINDOW_MONTHS,
): Map<string, number | null> {
  const values = series(months, key);
  return new Map(
    months.map((record, index) => {
      if (index < window - 1) return [record.month, null];
      const span = values.slice(index - window + 1, index + 1);
      if (span.some((value) => value === null)) return [record.month, null];
      return [record.month, (span as number[]).reduce((sum, value) => sum + value, 0) / window];
    }),
  );
}

/** Newest present value of a standalone series aligned to `months`. */
export function latestInSeries(
  months: string[],
  values: Series,
): { month: string; value: number } | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const value = values[i];
    if (value !== null && value !== undefined) return { month: months[i], value };
  }
  return null;
}

/** True when a table was never populated for this server, so the page can hide
 *  the whole section instead of drawing an empty chart. */
export function hasData(months: MonthRecord[], key: MetricKey): boolean {
  return months.some((record) => valueAt(record, key) !== null);
}

export function availableMonths(snapshot: Snapshot): string[] {
  return snapshot.months.map((record) => record.month);
}

/** Line records up against an arbitrary month axis, filling anything the
 *  snapshot does not cover with an empty record. Lets a caller ask for months
 *  outside the snapshot — a year-earlier axis, say — without special cases. */
export function recordsAt(months: MonthRecord[], monthKeys: string[]): MonthRecord[] {
  const byMonth = new Map(months.map((record) => [record.month, record]));
  return monthKeys.map(
    (month) => byMonth.get(month) ?? { month, users: null, jobs: null, usage: null },
  );
}
