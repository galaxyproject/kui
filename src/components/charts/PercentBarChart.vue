<script setup lang="ts">
import { computed } from 'vue';
import ClientChart from './ClientChart.vue';
import { AXIS_TEXT, GRID_LINE, GALAXY_DARK, axisTooltip } from '../../lib/echarts';
import { monthLabel, percent } from '../../lib/format';
import type { BarSeries } from '../../lib/types';

const props = defineProps<{
  months: string[];
  bars: BarSeries[];
}>();

// One row per month; the row count drives the height so 12 months and 48
// months both stay readable.
const height = computed(() => `${Math.max(240, props.months.length * 26 + 60)}px`);

const option = computed(() => ({
  animationDuration: 400,
  textStyle: { fontFamily: "'Atkinson Hyperlegible', system-ui, sans-serif" },
  grid: { left: 8, right: 24, top: 32, bottom: 24, containLabel: true },
  tooltip: axisTooltip(percent),
  legend: { top: 0, icon: 'roundRect', itemWidth: 12, itemHeight: 12, textStyle: { fontSize: 12 } },
  xAxis: {
    type: 'value',
    max: 100,
    axisLabel: { color: AXIS_TEXT, fontSize: 11, formatter: (v: number) => `${v}%` },
    splitLine: { lineStyle: { color: GRID_LINE } },
  },
  yAxis: {
    type: 'category',
    inverse: true,
    data: props.months,
    axisLabel: { color: AXIS_TEXT, fontSize: 11, formatter: (m: string) => monthLabel(m) },
    axisLine: { lineStyle: { color: GRID_LINE } },
    axisTick: { show: false },
  },
  series: props.bars.map((bar) => ({
    type: 'bar',
    name: bar.name,
    stack: 'share',
    data: bar.values,
    itemStyle: { color: bar.color },
    label: {
      show: true,
      formatter: ({ value }: { value: number | null }) =>
        value !== null && value >= 6 ? `${value.toFixed(1)}%` : '',
      color: GALAXY_DARK,
      fontSize: 11,
    },
  })),
}));
</script>

<template>
  <ClientChart :option="option" label="Share of monthly jobs by user cohort" class="w-full" :style="{ height }" />
</template>
