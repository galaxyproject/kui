<script setup lang="ts">
import GroupedBarChart from './GroupedBarChart.vue';
import { GALAXY_DARK, type TooltipComparison } from '../../lib/echarts';
import type { Series } from '../../lib/metrics';

const props = withDefaults(
  defineProps<{
    months: string[];
    values: Series;
    name: string;
    color?: string;
    line?: { name: string; values: Series; color?: string } | null;
    trend?: Series | null;
    comparison?: TooltipComparison | null;
    ghost?: Series | null;
    height?: string;
  }>(),
  {
    color: GALAXY_DARK,
    line: null,
    trend: null,
    comparison: null,
    ghost: null,
    height: 'h-72',
  },
);
</script>

<template>
  <GroupedBarChart
    :months="props.months"
    :bars="[{ name: props.name, values: props.values, color: props.color }]"
    :line="props.line"
    :trend="props.trend"
    :comparison="props.comparison"
    :ghost="props.ghost"
    :height="props.height"
  />
</template>
