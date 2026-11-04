import { describe, expect, it } from 'vitest';
import {
  average,
  averageRatio,
  deltaByMonth,
  deltaSeries,
  hasData,
  jobShare,
  latest,
  latestInSeries,
  movingAverageByMonth,
  percentChange,
  precedingWindow,
  ratio,
  ratioSeries,
  series,
  sliceRange,
} from './metrics';
import type { MonthRecord } from './types';

function month(
  key: string,
  users: Partial<MonthRecord['users']> | null,
  jobs: Partial<MonthRecord['jobs']> | null = null,
): MonthRecord {
  return {
    month: key,
    users: users
      ? {
          total_registered: null,
          new_registrations: null,
          engaged: null,
          engaged_day_plus: null,
          new_engaged_day_plus: null,
          ...users,
        }
      : null,
    jobs: jobs
      ? {
          total_jobs: null,
          month_jobs: null,
          by_new_users: null,
          by_new_users_engaged_day_plus: null,
          errored: null,
          errored_by_new_users: null,
          ...jobs,
        }
      : null,
    usage: null,
  };
}

const fixture: MonthRecord[] = [
  month('2026-01', { total_registered: 100, new_registrations: 10, engaged: 40, engaged_day_plus: 20 }, { month_jobs: 1000, errored: 100, by_new_users: 400, by_new_users_engaged_day_plus: 300 }),
  // A gap month: the collector never ran, so both tables are absent.
  month('2026-02', null, null),
  month('2026-03', { total_registered: 130, new_registrations: 20, engaged: 60, engaged_day_plus: 40 }, { month_jobs: 2000, errored: 100, by_new_users: 600, by_new_users_engaged_day_plus: 500 }),
];

describe('average', () => {
  it('ignores nulls rather than treating them as zero', () => {
    expect(average(series(fixture, 'new_registrations'))).toBe(15);
  });

  it('is null when the range holds no values', () => {
    expect(average([null, null])).toBeNull();
  });
});

describe('latest', () => {
  it('reads a cumulative metric from the newest month that has one', () => {
    expect(latest(fixture, 'total_registered')).toEqual({ month: '2026-03', value: 130 });
  });

  it('skips trailing gap months', () => {
    expect(latest([...fixture, month('2026-04', null)], 'total_registered')).toEqual({
      month: '2026-03',
      value: 130,
    });
  });
});

describe('ratio', () => {
  it('guards against a zero denominator', () => {
    expect(ratio(5, 0)).toBeNull();
    expect(ratio(null, 10)).toBeNull();
  });

  it('produces a per-month series with nulls preserved', () => {
    expect(ratioSeries(fixture, 'errored', 'month_jobs')).toEqual([10, null, 5]);
  });
});

describe('averageRatio', () => {
  it('divides the two range averages, not the mean of monthly ratios', () => {
    // avg errored = 100, avg month_jobs = 1500 → 6.67%, whereas the mean of the
    // monthly rates (10% and 5%) would be 7.5%.
    expect(averageRatio(fixture, 'errored', 'month_jobs')).toBeCloseTo(6.667, 3);
  });
});

describe('jobShare', () => {
  it('splits each month into new and returning, summing to 100%', () => {
    const [first, gap, third] = jobShare(fixture);
    expect(first.returningUsers).toBeCloseTo(60);
    expect(first.newUsers).toBeCloseTo(40);
    expect(first.returningUsers! + first.newUsers!).toBeCloseTo(100);

    expect(gap.returningUsers).toBeNull();
    expect(gap.newUsers).toBeNull();
    expect(third.returningUsers).toBeCloseTo(70);
  });

  it('does not need the multi-day breakdown to produce a split', () => {
    const withoutBreakdown = [
      month('2026-01', null, {
        month_jobs: 1000,
        by_new_users: 250,
        by_new_users_engaged_day_plus: null,
      }),
    ];
    expect(jobShare(withoutBreakdown)[0].newUsers).toBeCloseTo(25);
  });
});

describe('deltaSeries', () => {
  it('reports what each month added to a cumulative counter', () => {
    const counters = [
      month('2026-01', { total_registered: 100 }),
      month('2026-02', { total_registered: 130 }),
      month('2026-03', { total_registered: 175 }),
    ];
    expect(deltaSeries(counters, 'total_registered')).toEqual([null, 30, 45]);
  });

  it('refuses to bridge a gap, which would report two months growth as one', () => {
    const counters = [
      month('2026-01', { total_registered: 100 }),
      month('2026-02', null),
      month('2026-03', { total_registered: 200 }),
    ];
    expect(deltaSeries(counters, 'total_registered')).toEqual([null, null, null]);
  });

  it('goes negative when a server purges data rather than hiding it', () => {
    const counters = [
      month('2026-01', null, { total_jobs: 500 }),
      month('2026-02', null, { total_jobs: 400 }),
    ];
    expect(deltaSeries(counters, 'total_jobs')).toEqual([null, -100]);
  });
});

describe('deltaByMonth', () => {
  const counters = [
    month('2026-01', { total_registered: 100 }),
    month('2026-02', { total_registered: 130 }),
    month('2026-03', { total_registered: 175 }),
  ];

  it('makes a month outside the visible range readable', () => {
    // Showing Feb–Mar, the Feb delta is still 30 because January is in the map.
    const byMonth = deltaByMonth(counters, 'total_registered');
    expect(byMonth.get('2026-02')).toBe(30);
    expect(byMonth.get('2026-03')).toBe(45);
  });

  it('has no delta for the very first month of the snapshot', () => {
    expect(deltaByMonth(counters, 'total_registered').get('2026-01')).toBeNull();
  });

  it('returns undefined for a month the snapshot never covered', () => {
    expect(deltaByMonth(counters, 'total_registered').get('2025-03')).toBeUndefined();
  });
});

describe('movingAverageByMonth', () => {
  const flows = [10, 20, 30, 40, 50].map((value, index) =>
    month(`2026-0${index + 1}`, { new_registrations: value }),
  );

  it('averages the trailing window', () => {
    const byMonth = movingAverageByMonth(flows, 'new_registrations', 3);
    expect(byMonth.get('2026-03')).toBe(20); // (10+20+30)/3
    expect(byMonth.get('2026-05')).toBe(40); // (30+40+50)/3
  });

  it('has nothing until a full window has accumulated', () => {
    const byMonth = movingAverageByMonth(flows, 'new_registrations', 3);
    expect(byMonth.get('2026-01')).toBeNull();
    expect(byMonth.get('2026-02')).toBeNull();
  });

  it('refuses a window containing a gap instead of shortening the denominator', () => {
    const withGap = [
      month('2026-01', { new_registrations: 10 }),
      month('2026-02', null),
      month('2026-03', { new_registrations: 30 }),
      month('2026-04', { new_registrations: 40 }),
      month('2026-05', { new_registrations: 50 }),
    ];
    const byMonth = movingAverageByMonth(withGap, 'new_registrations', 3);
    expect(byMonth.get('2026-03')).toBeNull();
    expect(byMonth.get('2026-04')).toBeNull();
    // The first window clear of the gap resumes.
    expect(byMonth.get('2026-05')).toBe(40);
  });

  it('smooths a seasonal cycle to a near-flat line at a full-year window', () => {
    // Twelve months alternating hard between 100 and 300 average to 200 flat.
    const seasonal = Array.from({ length: 24 }, (_, index) =>
      month(
        `${2025 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`,
        { new_registrations: index % 2 === 0 ? 100 : 300 },
      ),
    );
    const byMonth = movingAverageByMonth(seasonal, 'new_registrations', 12);
    expect(byMonth.get('2025-12')).toBe(200);
    expect(byMonth.get('2026-06')).toBe(200);
  });
});

describe('percentChange', () => {
  it('measures the move against the baseline', () => {
    expect(percentChange(4771, 4724)).toBeCloseTo(0.995, 3);
    expect(percentChange(615591, 768051)).toBeCloseTo(-19.85, 2);
  });

  it('is null when there is nothing to compare against', () => {
    expect(percentChange(100, null)).toBeNull();
    expect(percentChange(null, 100)).toBeNull();
  });

  it('is null against a zero baseline rather than infinite', () => {
    expect(percentChange(100, 0)).toBeNull();
  });
});

describe('precedingWindow', () => {
  const allMonths = [
    '2026-01', '2026-02', '2026-03', '2026-04', '2026-05',
    '2026-06', '2026-07', '2026-08', '2026-09', '2026-10',
  ];

  it('returns the equally long stretch immediately before the range', () => {
    expect(precedingWindow(allMonths, '2026-04', '2026-06')).toEqual({
      from: '2026-01',
      to: '2026-03',
      length: 3,
    });
  });

  it('omits the comparison rather than truncating the baseline', () => {
    // Only four months precede a six-month range. Comparing against four would
    // be neither comparable across servers nor stable as history accumulates.
    expect(precedingWindow(allMonths, '2026-05', '2026-10')).toBeNull();
  });

  it('starts working once the history reaches twice the range', () => {
    // The same six-month range, now with six months of history behind it.
    const withMoreHistory = ['2025-11', '2025-12', ...allMonths];
    expect(precedingWindow(withMoreHistory, '2026-05', '2026-10')).toEqual({
      from: '2025-11',
      to: '2026-04',
      length: 6,
    });
  });

  it('is null when the range starts at the beginning of the snapshot', () => {
    expect(precedingWindow(allMonths, '2026-01', '2026-06')).toBeNull();
  });

  it('is null for months the snapshot does not contain', () => {
    expect(precedingWindow(allMonths, '2025-04', '2026-06')).toBeNull();
  });
});

describe('latestInSeries', () => {
  it('returns the newest present value with its month', () => {
    expect(latestInSeries(['2026-01', '2026-02', '2026-03'], [5, 9, null])).toEqual({
      month: '2026-02',
      value: 9,
    });
  });

  it('is null when nothing is present', () => {
    expect(latestInSeries(['2026-01'], [null])).toBeNull();
  });
});

describe('sliceRange', () => {
  it('is inclusive at both ends', () => {
    expect(sliceRange(fixture, '2026-02', '2026-03').map((m) => m.month)).toEqual([
      '2026-02',
      '2026-03',
    ]);
  });
});

describe('hasData', () => {
  it('detects a table that was never populated for this server', () => {
    expect(hasData(fixture, 'month_jobs')).toBe(true);
    expect(hasData(fixture, 'tool_installs')).toBe(false);
  });
});
