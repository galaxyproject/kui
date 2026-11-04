<script setup lang="ts">
import { computed } from 'vue';
import { monthLabel } from '../../lib/format';
import type { MonthRange } from '../../lib/useMonthRange';

const props = defineProps<{
  months: string[];
  modelValue: MonthRange;
}>();

const emit = defineEmits<{ 'update:modelValue': [MonthRange] }>();

// Spans, not counts: "1 yr" reads naturally as May 2025 – May 2026, which is
// the 13 points a same-month year-over-year comparison needs.
const PRESETS = [
  { label: '1 yr', monthsBack: 13 },
  { label: '2 yr', monthsBack: 25 },
  { label: 'All', monthsBack: Number.POSITIVE_INFINITY },
];

const last = computed(() => props.months[props.months.length - 1] ?? '');

// The From list may not exceed To (and vice versa) — an inverted range would
// silently render an empty dashboard.
const fromOptions = computed(() => props.months.filter((m) => m <= props.modelValue.to));
const toOptions = computed(() => props.months.filter((m) => m >= props.modelValue.from));

function applyPreset(monthsBack: number) {
  const start = Number.isFinite(monthsBack)
    ? props.months[Math.max(0, props.months.length - monthsBack)]
    : props.months[0];
  emit('update:modelValue', { from: start ?? last.value, to: last.value });
}

function activePreset(monthsBack: number): boolean {
  const start = Number.isFinite(monthsBack)
    ? props.months[Math.max(0, props.months.length - monthsBack)]
    : props.months[0];
  return props.modelValue.from === start && props.modelValue.to === last.value;
}

function update(key: keyof MonthRange, value: string) {
  emit('update:modelValue', { ...props.modelValue, [key]: value });
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-3">
    <div class="flex items-center gap-2">
      <label class="text-sm text-galaxy-muted" for="range-from">From</label>
      <select
        id="range-from"
        class="rounded-md border border-galaxy-border bg-white px-2 py-1 text-sm"
        :value="modelValue.from"
        @change="update('from', ($event.target as HTMLSelectElement).value)"
      >
        <option v-for="month in fromOptions" :key="month" :value="month">
          {{ monthLabel(month) }}
        </option>
      </select>
    </div>

    <div class="flex items-center gap-2">
      <label class="text-sm text-galaxy-muted" for="range-to">To</label>
      <select
        id="range-to"
        class="rounded-md border border-galaxy-border bg-white px-2 py-1 text-sm"
        :value="modelValue.to"
        @change="update('to', ($event.target as HTMLSelectElement).value)"
      >
        <option v-for="month in toOptions" :key="month" :value="month">
          {{ monthLabel(month) }}
        </option>
      </select>
    </div>

    <div class="flex gap-1">
      <button
        v-for="preset in PRESETS"
        :key="preset.label"
        type="button"
        class="rounded-md px-3 py-1 text-sm font-bold transition-colors"
        :class="
          activePreset(preset.monthsBack)
            ? 'bg-galaxy-primary text-white'
            : 'bg-white text-galaxy-primary border border-galaxy-border hover:bg-galaxy-bg'
        "
        @click="applyPreset(preset.monthsBack)"
      >
        {{ preset.label }}
      </button>
    </div>
  </div>
</template>
