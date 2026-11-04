<script setup lang="ts">
import { computed } from 'vue';
import {
  Database,
  FolderClock,
  PlayCircle,
  Workflow as WorkflowIcon,
  Wrench,
} from '@lucide/vue';
import DateRangePicker from '../controls/DateRangePicker.vue';
import BarChart from '../charts/BarChart.vue';
import GroupedBarChart from '../charts/GroupedBarChart.vue';
import PercentBarChart from '../charts/PercentBarChart.vue';
import ChartCard from '../cards/ChartCard.vue';
import GaugeCard from '../cards/GaugeCard.vue';
import SparkStatCard from '../cards/SparkStatCard.vue';
import StatCard from '../cards/StatCard.vue';
import { useMonthRange } from '../../lib/useMonthRange';
import { compact, integer, monthLabel, shiftMonth } from '../../lib/format';
import { GALAXY_ACCENT, GALAXY_ALERT, GALAXY_DARK, GALAXY_PRIMARY } from '../../lib/echarts';
import {
  average,
  deltaByMonth,
  hasData,
  jobShare,
  latest,
  latestInSeries,
  monthKeys,
  movingAverageByMonth,
  percentChange,
  precedingWindow,
  recordsAt,
  series,
  sliceRange,
  type MetricKey,
} from '../../lib/metrics';
import type { Snapshot } from '../../lib/types';

const props = defineProps<{ snapshot: Snapshot }>();

const allMonths = props.snapshot.months.map((record) => record.month);
const range = useMonthRange(allMonths);

const rows = computed(() => sliceRange(props.snapshot.months, range.value.from, range.value.to));
const months = computed(() => monthKeys(rows.value));

const has = (key: MetricKey) => computed(() => hasData(rows.value, key));
const hasUsers = has('new_registrations');
const hasJobs = has('month_jobs');
const hasUsage = has('total_datasets');

const totalRegistered = computed(() => latest(rows.value, 'total_registered'));
const avgNewRegistrations = computed(() => average(series(rows.value, 'new_registrations')));

const engagedAverage = computed(() => average(series(rows.value, 'engaged')));
const engagedDayPlusAverage = computed(() => average(series(rows.value, 'engaged_day_plus')));
const newEngagedDayPlusAverage = computed(() =>
  average(series(rows.value, 'new_engaged_day_plus')),
);

const totalJobs = computed(() => latest(rows.value, 'total_jobs'));
const monthJobsAverage = computed(() => average(series(rows.value, 'month_jobs')));
const erroredAverage = computed(() => average(series(rows.value, 'errored')));
const byNewUsersAverage = computed(() => average(series(rows.value, 'by_new_users')));
const erroredByNewUsersAverage = computed(() =>
  average(series(rows.value, 'errored_by_new_users')),
);

const YEAR = -12;

// Cumulative counters are reported as what was created that month; the running
// total moves to the caption, where it stays available without dominating.
const GROWTH_METRICS: { label: string; key: MetricKey; icon: unknown }[] = [
  { label: 'Datasets', key: 'total_datasets', icon: Database },
  { label: 'Histories', key: 'total_histories', icon: FolderClock },
  { label: 'Workflows', key: 'total_workflows', icon: WorkflowIcon },
  { label: 'Workflow invocations', key: 'total_workflow_invocations', icon: PlayCircle },
];

const growthCards = computed(() =>
  GROWTH_METRICS.map(({ label, key, icon }) => {
    const byMonth = deltaByMonth(props.snapshot.months, key);
    const deltas = months.value.map((month) => byMonth.get(month) ?? null);
    const newest = latestInSeries(months.value, deltas);
    const runningTotal = latest(rows.value, key);

    // The month a year before the newest one usually sits outside the range,
    // which is why this reads from the whole-snapshot map.
    const priorMonth = newest ? shiftMonth(newest.month, YEAR) : null;
    const change = newest
      ? percentChange(newest.value, priorMonth ? (byMonth.get(priorMonth) ?? null) : null)
      : null;

    return {
      key,
      label,
      icon,
      values: deltas,
      value: newest ? `${newest.value >= 0 ? '+' : ''}${compact(newest.value)}` : '—',
      caption: newest
        ? `in ${monthLabel(newest.month)} · ${compact(runningTotal?.value ?? null)} total`
        : 'no change data in range',
      change:
        change === null || !priorMonth
          ? null
          : { percent: change, label: `vs ${monthLabel(priorMonth)}` },
    };
  }),
);

// Averages are compared against the equally long stretch before the selected
// range, so the figure moves when the reader changes the range — the chip
// names the window to keep that honest.
const priorWindow = computed(() => precedingWindow(allMonths, range.value.from, range.value.to));

function averageChange(key: MetricKey) {
  const window = priorWindow.value;
  if (!window) return null;
  const current = average(series(rows.value, key));
  const prior = average(series(sliceRange(props.snapshot.months, window.from, window.to), key));
  const change = percentChange(current, prior);
  return change === null ? null : { percent: change, label: `vs prior ${window.length} mo` };
}

// Not a cumulative counter but a point-in-time inventory, so it keeps its
// absolute value rather than becoming a delta.
const toolsInstalled = computed(() => latest(rows.value, 'tool_installs'));

const share = computed(() => jobShare(rows.value));
const shareBars = computed(() => [
  {
    name: '% jobs by returning users',
    values: share.value.map((entry) => entry.returningUsers),
    color: '#a8c8e8',
  },
  {
    name: '% jobs by new users',
    values: share.value.map((entry) => entry.newUsers),
    color: '#d9b8e8',
  },
]);

function asOf(entry: { month: string } | null): string {
  return entry ? `as of ${monthLabel(entry.month)}` : 'no data in range';
}

// Year-over-year context for the monthly-flow charts. The comparison months
// usually sit outside the selected range, so they are read straight from the
// snapshot rather than from `rows`.
const priorYearRows = computed(() =>
  recordsAt(
    props.snapshot.months,
    months.value.map((month) => shiftMonth(month, YEAR)),
  ),
);

function priorYearSeries(key: MetricKey) {
  return series(priorYearRows.value, key);
}

// Smoothed over the whole snapshot, then clipped, so the line covers the whole
// visible range instead of starting a year in.
function trendSeries(key: MetricKey) {
  const byMonth = movingAverageByMonth(props.snapshot.months, key);
  return months.value.map((month) => byMonth.get(month) ?? null);
}

function yearOverYear(bySeries: Record<string, MetricKey>) {
  return {
    offsetMonths: YEAR,
    bySeries: Object.fromEntries(
      Object.entries(bySeries).map(([name, key]) => [name, series(priorYearRows.value, key)]),
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

    <p v-if="months.length === 0" class="card text-galaxy-muted">
      No data for the selected range.
    </p>

    <!-- 1. User registrations -->
    <section v-if="hasUsers">
      <h2 class="section-heading">User registrations</h2>
      <div class="grid gap-6 lg:grid-cols-3">
        <div class="grid content-start gap-6">
          <StatCard
            label="Average monthly new registrations"
            :value="integer(avgNewRegistrations)"
            caption="mean over selected range"
            :change="averageChange('new_registrations')"
          />
          <StatCard
            label="Total registered users"
            :value="integer(totalRegistered?.value ?? null)"
            :caption="asOf(totalRegistered)"
            size="md"
          />
        </div>
        <ChartCard
          class="lg:col-span-2"
          title="New user registrations"
          subtitle="pale cap marks months the prior year ran higher"
        >
          <BarChart
            :months="months"
            :values="series(rows, 'new_registrations')"
            name="New user registrations"
            :color="GALAXY_DARK"
            :trend="trendSeries('new_registrations')"
            :comparison="yearOverYear({ 'New user registrations': 'new_registrations' })"
            :ghost="priorYearSeries('new_registrations')"
          />
        </ChartCard>
      </div>
    </section>

    <!-- 2. User engagement -->
    <section v-if="hasUsers">
      <h2 class="section-heading">
        User engagement
        <span class="text-sm font-normal text-galaxy-muted">(engaged = ran a job)</span>
      </h2>
      <div class="grid gap-6 lg:grid-cols-3">
        <ChartCard class="lg:col-span-2" title="Engaged users">
          <GroupedBarChart
            :months="months"
            :bars="[
              { name: 'Engaged users', values: series(rows, 'engaged'), color: GALAXY_DARK },
              { name: 'Engaged >1 day', values: series(rows, 'engaged_day_plus'), color: GALAXY_ACCENT },
              {
                name: 'New users engaged >1 day',
                values: series(rows, 'new_engaged_day_plus'),
                color: GALAXY_ALERT,
              },
            ]"
            :trend="trendSeries('engaged')"
            :comparison="
              yearOverYear({
                'Engaged users': 'engaged',
                'Engaged >1 day': 'engaged_day_plus',
                'New users engaged >1 day': 'new_engaged_day_plus',
              })
            "
          />
        </ChartCard>
        <div class="grid content-start gap-6">
          <GaugeCard
            label="Avg engaged >1 day"
            :value="engagedDayPlusAverage"
            :max="engagedAverage"
            caption="of engaged users"
          />
          <GaugeCard
            label="Avg new users engaged >1 day"
            :value="newEngagedDayPlusAverage"
            :max="avgNewRegistrations"
            caption="of new registrations"
          />
        </div>
      </div>
    </section>

    <!-- 3. Service usage -->
    <section v-if="hasUsage">
      <h2 class="section-heading">
        Service usage
        <span class="text-sm font-normal text-galaxy-muted">(created per month)</span>
      </h2>
      <div class="grid gap-6 sm:grid-cols-2 xl:grid-cols-5">
        <SparkStatCard
          v-for="card in growthCards"
          :key="card.key"
          :label="card.label"
          :value="card.value"
          :caption="card.caption"
          :change="card.change"
          :months="months"
          :values="card.values"
          :color="GALAXY_PRIMARY"
          size="md"
        >
          <template #icon><component :is="card.icon" class="h-4 w-4" /></template>
        </SparkStatCard>
        <SparkStatCard
          label="Tools installed"
          :value="compact(toolsInstalled?.value ?? null)"
          :caption="asOf(toolsInstalled)"
          :months="months"
          :values="series(rows, 'tool_installs')"
          :color="GALAXY_PRIMARY"
          size="md"
        >
          <template #icon><Wrench class="h-4 w-4" /></template>
        </SparkStatCard>
      </div>
    </section>

    <!-- 4. Job counts -->
    <section v-if="hasJobs">
      <h2 class="section-heading">Job counts</h2>
      <div class="grid gap-6 lg:grid-cols-3">
        <div class="grid content-start gap-6">
          <StatCard
            label="Total jobs"
            :value="compact(totalJobs?.value ?? null)"
            :caption="asOf(totalJobs)"
          />
          <SparkStatCard
            label="Avg. monthly jobs"
            :value="compact(monthJobsAverage)"
            :change="averageChange('month_jobs')"
            :months="months"
            :values="series(rows, 'month_jobs')"
            :color="GALAXY_ACCENT"
          />
          <GaugeCard
            label="Avg. errored jobs"
            :value="erroredAverage"
            :max="monthJobsAverage"
            caption="of monthly jobs"
          />
        </div>
        <ChartCard
          class="lg:col-span-2"
          title="Jobs per month"
          subtitle="pale cap marks months the prior year ran higher"
        >
          <GroupedBarChart
            :months="months"
            :bars="[{ name: 'Number of jobs', values: series(rows, 'month_jobs'), color: GALAXY_ACCENT }]"
            :line="{ name: 'Number of errored jobs', values: series(rows, 'errored'), color: GALAXY_ALERT }"
            :trend="trendSeries('month_jobs')"
            :comparison="
              yearOverYear({
                'Number of jobs': 'month_jobs',
                'Number of errored jobs': 'errored',
              })
            "
            :ghost="priorYearSeries('month_jobs')"
          />
        </ChartCard>
      </div>

      <div class="mt-6 grid gap-6 lg:grid-cols-3">
        <ChartCard
          class="lg:col-span-2"
          title="Share of monthly jobs: new vs returning users"
          subtitle="new = registered that month"
        >
          <PercentBarChart :months="months" :bars="shareBars" />
        </ChartCard>
        <div class="grid content-start gap-6">
          <GaugeCard
            label="Avg errored jobs by new users"
            :value="erroredByNewUsersAverage"
            :max="byNewUsersAverage"
            caption="of jobs by new users"
            :secondary="{ label: 'of all monthly jobs', max: monthJobsAverage }"
          />
        </div>
      </div>
    </section>
  </div>
</template>
