<script setup lang="ts">
import { computed } from 'vue';
import { compact, percent } from '../../lib/format';

const props = withDefaults(
  defineProps<{
    label: string;
    /** Numerator average, shown beside the headline percentage. */
    value: number | null;
    /** Denominator average; the bar shows value as a fraction of it. */
    max: number | null;
    caption?: string;
    /** A second denominator for the same numerator, rendered as one extra
     *  line. Two cards showing one count against two bases is a card too many. */
    secondary?: { label: string; max: number | null } | null;
  }>(),
  { caption: '', secondary: null },
);

function share(value: number | null, max: number | null): number | null {
  if (value === null || max === null || max === 0) return null;
  return (value / max) * 100;
}

const primaryShare = computed(() => share(props.value, props.max));
const secondaryShare = computed(() => share(props.value, props.secondary?.max ?? null));

const barWidth = computed(() => `${Math.min(100, Math.max(0, primaryShare.value ?? 0))}%`);
</script>

<template>
  <div class="card flex flex-col gap-2">
    <div class="text-sm text-galaxy-muted">{{ label }}</div>
    <div class="flex items-baseline gap-2">
      <span class="text-3xl font-bold tabular-nums">{{ percent(primaryShare) }}</span>
      <span class="text-sm font-bold text-galaxy-primary tabular-nums">{{ compact(value) }}</span>
    </div>
    <div
      class="h-2.5 w-full rounded-full bg-galaxy-bg"
      role="img"
      :aria-label="`${percent(primaryShare)} of ${compact(max)}`"
    >
      <div class="h-2.5 rounded-full bg-galaxy-primary" :style="{ width: barWidth }" />
    </div>
    <div class="flex justify-between text-xs text-galaxy-muted">
      <span>{{ caption }}</span>
      <span class="tabular-nums">of {{ compact(max) }}</span>
    </div>
    <div v-if="secondary" class="border-t border-galaxy-border pt-2 text-xs text-galaxy-muted">
      <span class="font-bold tabular-nums text-galaxy-dark">{{ percent(secondaryShare) }}</span>
      {{ secondary.label }}
      <span class="tabular-nums">({{ compact(secondary.max) }})</span>
    </div>
  </div>
</template>
