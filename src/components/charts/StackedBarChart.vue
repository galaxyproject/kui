<script setup lang="ts">
import GroupedBarChart from './GroupedBarChart.vue';
import type { TooltipComparison } from '../../lib/echarts';
import type { BarSeries } from '../../lib/types';

const props = withDefaults(
  defineProps<{
    months: string[];
    bars: BarSeries[];
    comparison?: TooltipComparison | null;
    height?: string;
  }>(),
  { comparison: null, height: 'h-80' },
);
</script>

<template>
  <GroupedBarChart
    :months="props.months"
    :bars="props.bars"
    :comparison="props.comparison"
    stack
    :height="props.height"
  />
</template>
