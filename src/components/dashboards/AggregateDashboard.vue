<script setup lang="ts">
import { computed } from 'vue';
import DateRangePicker from '../controls/DateRangePicker.vue';
import GroupedBarChart from '../charts/GroupedBarChart.vue';
import StackedBarChart from '../charts/StackedBarChart.vue';
import ChartCard from '../cards/ChartCard.vue';
import StatCard from '../cards/StatCard.vue';
import { useMonthRange } from '../../lib/useMonthRange';
import { compact, monthLabel, shiftMonth } from '../../lib/format';
import {
  headlineTotal,
  mixedMonths,
  ratioSeriesByServer,
  seriesByServer,
  unifiedMonths,
  type AggregateInput,
} from '../../lib/aggregate';
import type { MetricKey } from '../../lib/metrics';

const props = defineProps<{ inputs: AggregateInput[] }>();

const allMonths = unifiedMonths(props.inputs);
const range = useMonthRange(allMonths);

const months = computed(() =>
  allMonths.filter((month) => month >= range.value.from && month <= range.value.to),
);

const HEADLINES: { key: MetricKey; label: string }[] = [
  { key: 'total_registered', label: 'Total registered users' },
  { key: 'total_jobs', label: 'Total jobs' },
  { key: 'total_datasets', label: 'Total datasets' },
  { key: 'total_workflows', label: 'Total workflows' },
];

const headlines = computed(() =>
  HEADLINES.map(({ key, label }) => {
    const total = headlineTotal(props.inputs, range.value.from, range.value.to, key);
    const caption = mixedMonths(total)
      ? `newest month per server: ${total.contributions
          .map((c) => `${c.server} ${monthLabel(c.month)}`)
          .join(', ')}`
      : total.contributions.length
        ? `as of ${monthLabel(total.contributions[0].month)}`
        : 'no data in range';
    return { key, label, value: compact(total.total), caption, missing: total.missing };
  }),
);

const stacked = computed(() => ({
  total_registered: seriesByServer(props.inputs, months.value, 'total_registered'),
  new_registrations: seriesByServer(props.inputs, months.value, 'new_registrations'),
  engaged: seriesByServer(props.inputs, months.value, 'engaged'),
  total_jobs: seriesByServer(props.inputs, months.value, 'total_jobs'),
}));

const engagedShare = computed(() =>
  ratioSeriesByServer(props.inputs, months.value, 'engaged_day_plus', 'engaged'),
);
const newEngagedShare = computed(() =>
  ratioSeriesByServer(props.inputs, months.value, 'new_engaged_day_plus', 'new_registrations'),
);
const errorRate = computed(() =>
  ratioSeriesByServer(props.inputs, months.value, 'errored', 'month_jobs'),
);

function bars(seriesList: ReturnType<typeof seriesByServer>) {
  return seriesList.map((s) => ({ name: s.shortName, values: s.values, color: s.color }));
}

function averages(seriesList: ReturnType<typeof seriesByServer>) {
  return seriesList.map((s) => s.average);
}

// Only the monthly-flow charts get a year-over-year line in the tooltip; on a
// cumulative counter it would report growth every month and say nothing.
const YEAR = -12;

function yearOverYear(key: MetricKey) {
  const priorMonths = months.value.map((month) => shiftMonth(month, YEAR));
  return {
    offsetMonths: YEAR,
    bySeries: Object.fromEntries(
      seriesByServer(props.inputs, priorMonths, key).map((s) => [s.shortName, s.values]),
    ),
  };
}
</script>

<template>
  <div class="space-y-12">
    <div class="card flex flex-wrap items-center justify-between gap-4">
      <DateRangePicker v-model="range" :months="allMonths" />
      <p class="text-xs text-galaxy-muted">
        {{ months.length }} month{{ months.length === 1 ? '' : 's' }} shown
      </p>
    </div>

    <section>
      <h2 class="section-heading">Total counts across all usegalaxy.* servers</h2>
      <div class="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          v-for="headline in headlines"
          :key="headline.key"
          :label="headline.label"
          :value="headline.value"
          :caption="headline.caption"
        >
          <p v-if="headline.missing.length" class="text-xs text-galaxy-muted">
            no data: {{ headline.missing.join(', ') }}
          </p>
        </StatCard>
      </div>
    </section>

    <section>
      <h2 class="section-heading">Totals over time, by server</h2>
      <div class="grid gap-6 xl:grid-cols-2">
        <ChartCard title="Total registered users">
          <StackedBarChart :months="months" :bars="bars(stacked.total_registered)" />
        </ChartCard>
        <ChartCard title="Total jobs">
          <StackedBarChart :months="months" :bars="bars(stacked.total_jobs)" />
        </ChartCard>
      </div>
    </section>

    <section>
      <h2 class="section-heading">
        User registrations &amp; engagement
        <span class="text-sm font-normal text-galaxy-muted">(engaged = ran a job)</span>
      </h2>
      <div class="grid gap-6 xl:grid-cols-2">
        <ChartCard title="New user registrations">
          <StackedBarChart
            :months="months"
            :bars="bars(stacked.new_registrations)"
            :comparison="yearOverYear('new_registrations')"
          />
        </ChartCard>
        <ChartCard title="Engaged user counts">
          <StackedBarChart
            :months="months"
            :bars="bars(stacked.engaged)"
            :comparison="yearOverYear('engaged')"
          />
        </ChartCard>
        <ChartCard title="Percent users engaged >1 day" subtitle="dashed lines show each server's range average">
          <GroupedBarChart
            :months="months"
            :bars="bars(engagedShare)"
            :bar-averages="averages(engagedShare)"
            percent-axis
          />
        </ChartCard>
        <ChartCard title="Percent new users engaged >1 day" subtitle="dashed lines show each server's range average">
          <GroupedBarChart
            :months="months"
            :bars="bars(newEngagedShare)"
            :bar-averages="averages(newEngagedShare)"
            percent-axis
          />
        </ChartCard>
      </div>
    </section>

    <section>
      <h2 class="section-heading">Server job error rates</h2>
      <ChartCard subtitle="errored jobs as a share of that month's jobs; dashed lines show each server's range average">
        <GroupedBarChart
          :months="months"
          :bars="bars(errorRate)"
          :bar-averages="averages(errorRate)"
          percent-axis
          height="h-96"
        />
      </ChartCard>
    </section>
  </div>
</template>
