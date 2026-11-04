import { ref, watch, type Ref } from 'vue';

export interface MonthRange {
  from: string;
  to: string;
}

function clamp(month: string | null, allMonths: string[], fallback: string): string {
  if (!month || !allMonths.includes(month)) return fallback;
  return month;
}

/** Date range shared by every chart on a page, seeded from `?from=&to=` so a
 *  filtered view can be linked to, and mirrored back on change. */
export function useMonthRange(allMonths: string[], defaultMonthsBack = 13): Ref<MonthRange> {
  const last = allMonths[allMonths.length - 1] ?? '';
  const defaultFrom = allMonths[Math.max(0, allMonths.length - defaultMonthsBack)] ?? last;

  const params = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search);
  const range = ref<MonthRange>({
    from: clamp(params?.get('from') ?? null, allMonths, defaultFrom),
    to: clamp(params?.get('to') ?? null, allMonths, last),
  });

  if (range.value.from > range.value.to) range.value.from = defaultFrom;

  watch(
    range,
    (value) => {
      if (typeof window === 'undefined') return;
      const next = new URLSearchParams(window.location.search);
      next.set('from', value.from);
      next.set('to', value.to);
      window.history.replaceState({}, '', `${window.location.pathname}?${next}`);
    },
    { deep: true },
  );

  return range;
}
