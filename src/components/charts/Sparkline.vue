<script setup lang="ts">
import { computed } from 'vue';
import ClientChart from './ClientChart.vue';
import { GALAXY_DARK } from '../../lib/echarts';
import { monthLabel } from '../../lib/format';
import type { Series } from '../../lib/metrics';

const props = withDefaults(
  defineProps<{
    months: string[];
    values: Series;
    color?: string;
  }>(),
  { color: GALAXY_DARK },
);

const option = computed(() => ({
  animation: false,
  grid: { left: 2, right: 2, top: 4, bottom: 2 },
  xAxis: { type: 'category', data: props.months, show: true, axisLabel: { show: false }, axisLine: { show: false }, axisTick: { show: false } },
  yAxis: { type: 'value', show: false, scale: true },
  tooltip: {
    trigger: 'axis',
    backgroundColor: '#ffffff',
    borderColor: '#e6edf4',
    textStyle: { color: GALAXY_DARK, fontSize: 11 },
    formatter: (params: { axisValue: string; value: number | null }[]) =>
      `${monthLabel(params[0].axisValue)}: <strong>${
        params[0].value === null ? '—' : params[0].value.toLocaleString('en-US')
      }</strong>`,
  },
  series: [
    {
      type: 'line',
      data: props.values,
      connectNulls: false,
      symbol: 'none',
      lineStyle: { color: props.color, width: 1.5 },
      areaStyle: { color: props.color, opacity: 0.08 },
    },
  ],
}));
</script>

<template>
  <ClientChart :option="option" label="Trend over the selected range" class="h-10 w-full" />
</template>
