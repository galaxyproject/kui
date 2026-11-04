<script setup lang="ts">
import { computed } from 'vue';
import ClientChart from './ClientChart.vue';
import {
  averageMarkLine,
  axisTooltip,
  baseOption,
  SERIES_COLORS,
  GALAXY_ALERT,
  GALAXY_TREND,
  PRIOR_YEAR_SERIES,
  TREND_SERIES,
  type TooltipComparison,
} from '../../lib/echarts';
import { integer, monthLabel, percent } from '../../lib/format';
import type { Series } from '../../lib/metrics';
import type { BarSeries } from '../../lib/types';

const props = withDefaults(
  defineProps<{
    months: string[];
    bars: BarSeries[];
    /** Optional line drawn on top of the bars, e.g. errored jobs. */
    line?: BarSeries | null;
    /** Smoothed trend for the first bar series. Replaces the flat range average
     *  that used to sit here — the stat card beside the chart already states
     *  that number, and a trend says something the card cannot. */
    trend?: Series | null;
    /** One dashed reference line per bar series, in the series' own color. */
    barAverages?: (number | null)[] | null;
    /** Prior-period values shown beneath each tooltip row. */
    comparison?: TooltipComparison | null;
    /** Same-month-last-year values for the first bar series, drawn as a faded
     *  bar behind it. Ignored when the prior year holds no data. */
    ghost?: Series | null;
    stack?: boolean;
    percentAxis?: boolean;
    height?: string;
  }>(),
  {
    line: null,
    trend: null,
    barAverages: null,
    comparison: null,
    ghost: null,
    stack: false,
    percentAxis: false,
    height: 'h-72',
  },
);

const BAR_MAX_WIDTH = 28;

// Overlapping bars share one slot via barGap, which would collapse a genuinely
// grouped chart, so the ghost only applies to single-series charts. An all-null
// prior year (a server younger than a year) drops it rather than drawing a
// legend entry for nothing.
const ghostValues = computed(() => {
  if (!props.ghost || props.bars.length !== 1) return null;
  return props.ghost.some((value) => value !== null) ? props.ghost : null;
});

// A server without enough history to smooth gets no line at all, rather than a
// stub drawn from the two or three months that happen to qualify.
const trendValues = computed(() =>
  props.trend?.some((value) => value !== null) ? props.trend : null,
);

const option = computed(() => {
  const base = baseOption(props.months);
  const formatValue = props.percentAxis ? (value: number) => percent(value) : undefined;
  const barSeries = props.bars.map((series, index) => {
    const color = series.color ?? SERIES_COLORS[index % SERIES_COLORS.length];
    const markLine = props.barAverages
      ? averageMarkLine(props.barAverages[index] ?? null, `Avg ${series.name}`, color, formatValue)
      : undefined;
    return {
      type: 'bar',
      name: series.name,
      data: series.values,
      stack: props.stack ? 'total' : undefined,
      itemStyle: { color, borderRadius: props.stack ? 0 : 2 },
      barMaxWidth: BAR_MAX_WIDTH,
      z: 3,
      markLine,
    };
  });

  // Same width as the current bar and drawn behind it, so last year only
  // surfaces as a pale cap on the months it beat. A wider bar would read as a
  // halo at short ranges and disappear at long ones, since both would clamp to
  // the category band.
  const ghostSeries = ghostValues.value
    ? [
        {
          type: 'bar',
          name: PRIOR_YEAR_SERIES,
          data: ghostValues.value,
          barGap: '-100%',
          barMaxWidth: BAR_MAX_WIDTH,
          z: 2,
          silent: true,
          itemStyle: {
            color: props.bars[0].color ?? SERIES_COLORS[0],
            opacity: 0.35,
            borderRadius: 2,
          },
        },
      ]
    : [];

  const lineSeries = props.line
    ? [
        {
          type: 'line',
          name: props.line.name,
          data: props.line.values,
          // Gaps must read as gaps, not as an interpolated trend.
          connectNulls: false,
          symbol: 'circle',
          symbolSize: 5,
          z: 4,
          lineStyle: { color: props.line.color ?? GALAXY_ALERT, width: 2 },
          itemStyle: { color: props.line.color ?? GALAXY_ALERT },
        },
      ]
    : [];

  const trendSeries = trendValues.value
    ? [
        {
          type: 'line',
          name: TREND_SERIES,
          data: trendValues.value,
          connectNulls: false,
          symbol: 'none',
          z: 5,
          lineStyle: { color: GALAXY_TREND, width: 2.5 },
          itemStyle: { color: GALAXY_TREND },
        },
      ]
    : [];

  return {
    ...base,
    yAxis: props.percentAxis
      ? { ...base.yAxis, axisLabel: { ...base.yAxis.axisLabel, formatter: (v: number) => `${v}%` } }
      : base.yAxis,
    // Stacked charts show a total row; grouped ones would be summing unrelated
    // series (e.g. engaged users and new registrations), so they do not.
    tooltip: axisTooltip(props.percentAxis ? percent : integer, {
      showTotal: props.stack,
      comparison: props.comparison,
      // The comparison line under each row already states last year's value.
      omitSeries: [PRIOR_YEAR_SERIES],
    }),
    legend: {
      ...base.legend,
      show:
        props.bars.length > 1 ||
        Boolean(props.line) ||
        Boolean(ghostValues.value) ||
        Boolean(trendValues.value),
    },
    series: [...ghostSeries, ...barSeries, ...lineSeries, ...trendSeries],
  };
});

const label = computed(() => {
  const names = props.bars.map((bar) => bar.name).join(', ');
  if (props.months.length === 0) return names;
  return `${names} from ${monthLabel(props.months[0])} to ${monthLabel(props.months[props.months.length - 1])}`;
});
</script>

<template>
  <ClientChart :option="option" :label="label" :class="['w-full', height]" />
</template>
