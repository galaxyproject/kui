<script setup lang="ts">
import { computed } from 'vue';
import Sparkline from '../charts/Sparkline.vue';
import ChangeChip from './ChangeChip.vue';
import type { Series } from '../../lib/metrics';

const VALUE_SIZE = { sm: 'text-xl', md: 'text-2xl', lg: 'text-3xl' } as const;

const props = withDefaults(
  defineProps<{
    label: string;
    value: string;
    months: string[];
    values: Series;
    caption?: string;
    color?: string;
    size?: keyof typeof VALUE_SIZE;
    change?: { percent: number | null; label: string } | null;
  }>(),
  { caption: '', size: 'lg', change: null },
);

const valueClass = computed(() => VALUE_SIZE[props.size]);
</script>

<template>
  <div class="card flex flex-col gap-1">
    <div class="flex items-center gap-2 text-sm text-galaxy-muted">
      <slot name="icon" />
      <span>{{ label }}</span>
    </div>
    <div :class="['font-bold tabular-nums', valueClass]">{{ value }}</div>
    <div v-if="caption" class="text-xs text-galaxy-muted">{{ caption }}</div>
    <ChangeChip v-if="change" :percent="change.percent" :label="change.label" />
    <Sparkline :months="months" :values="values" :color="color" />
  </div>
</template>
