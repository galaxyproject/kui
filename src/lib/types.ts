export interface UserMetrics {
  total_registered: number | null;
  new_registrations: number | null;
  engaged: number | null;
  engaged_day_plus: number | null;
  new_engaged_day_plus: number | null;
}

export interface JobMetrics {
  total_jobs: number | null;
  month_jobs: number | null;
  by_new_users: number | null;
  by_new_users_engaged_day_plus: number | null;
  errored: number | null;
  errored_by_new_users: number | null;
}

export interface UsageMetrics {
  total_histories: number | null;
  total_datasets: number | null;
  total_workflows: number | null;
  total_workflow_invocations: number | null;
  tool_installs: number | null;
}

/** One month of raw collected values. Derived metrics are computed at render
 *  time because they depend on the selected date range. */
export interface MonthRecord {
  month: string; // YYYY-MM
  users: UserMetrics | null;
  jobs: JobMetrics | null;
  usage: UsageMetrics | null;
}

export interface Snapshot {
  schemaVersion: number;
  server: string;
  generatedAt: string;
  months: MonthRecord[];
}

export interface ServerEntry {
  id: string;
  name: string;
  shortName: string;
  url: string;
  color: string;
  tables: { users?: string; jobs?: string; usage?: string };
}

export interface Registry {
  project: string;
  dataset: string;
  servers: ServerEntry[];
}

/** One plotted series: values align positionally with the chart's month axis,
 *  `null` where a month has no data. */
export interface BarSeries {
  name: string;
  values: (number | null)[];
  color?: string;
}

export interface SnapshotIndexEntry {
  server: string;
  firstMonth: string | null;
  latestMonth: string | null;
  monthCount: number;
}

export interface SnapshotIndex {
  schemaVersion: number;
  generatedAt: string;
  servers: SnapshotIndexEntry[];
}
