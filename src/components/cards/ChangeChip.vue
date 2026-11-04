<script setup lang="ts">
import { computed } from 'vue';
import { signedPercent } from '../../lib/format';

const props = defineProps<{
  /** Relative change; null hides the chip entirely rather than showing a placeholder. */
  percent: number | null;
  /** Names the baseline, e.g. 'vs Jul 2025' or 'vs prior 25 mo'. */
  label: string;
}>();

// Direction only. Errored jobs rising is not good news, so nothing here reads
// as approval or alarm — no green, no red.
const arrow = computed(() => {
  if (props.percent === null || props.percent === 0) return '';
  return props.percent > 0 ? '▲' : '▼';
});
</script>

<template>
  <p v-if="percent !== null" class="flex items-center gap-1 text-xs text-galaxy-muted">
    <span v-if="arrow" aria-hidden="true">{{ arrow }}</span>
    <span class="font-bold tabular-nums">{{ signedPercent(percent) }}</span>
    <span>{{ label }}</span>
  </p>
</template>
