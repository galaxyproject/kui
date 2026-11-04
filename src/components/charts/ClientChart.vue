<script setup lang="ts">
import { defineAsyncComponent, onMounted, ref } from 'vue';

defineProps<{ option: Record<string, unknown>; label?: string }>();

// ECharts renders to canvas, so there is nothing to server-render; loading it
// on mount keeps `document` out of the SSR path and off the critical bundle.
const VChart = defineAsyncComponent(async () => {
  await import('../../lib/echartsRegister');
  return (await import('vue-echarts')).default;
});

const mounted = ref(false);
onMounted(() => {
  mounted.value = true;
});
</script>

<template>
  <!-- The caller's height class lands here as a fallthrough attribute, so this
       element must not set its own height: `h-full` would win over it and
       resolve against an auto-height parent, which sends `autoresize` into a
       grow-measure-grow loop. -->
  <div class="w-full">
    <VChart v-if="mounted" :option="option" :aria-label="label" autoresize class="h-full w-full" />
    <div v-else class="h-full w-full animate-pulse rounded bg-galaxy-bg" aria-hidden="true" />
  </div>
</template>
