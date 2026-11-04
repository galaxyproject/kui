import { z } from 'zod';

const count = z.number().int().nullable();

const monthKey = z.string().regex(/^\d{4}-\d{2}$/, 'month must be YYYY-MM');

export const userMetricsSchema = z.object({
  total_registered: count,
  new_registrations: count,
  engaged: count,
  engaged_day_plus: count,
  new_engaged_day_plus: count,
});

export const jobMetricsSchema = z.object({
  total_jobs: count,
  month_jobs: count,
  by_new_users: count,
  by_new_users_engaged_day_plus: count,
  errored: count,
  errored_by_new_users: count,
});

export const usageMetricsSchema = z.object({
  total_histories: count,
  total_datasets: count,
  total_workflows: count,
  total_workflow_invocations: count,
  tool_installs: count,
});

export const monthRecordSchema = z.object({
  month: monthKey,
  users: userMetricsSchema.nullable(),
  jobs: jobMetricsSchema.nullable(),
  usage: usageMetricsSchema.nullable(),
});

export const snapshotSchema = z.object({
  schemaVersion: z.literal(1),
  server: z.string().min(1),
  generatedAt: z.string(),
  months: z.array(monthRecordSchema),
});

export const snapshotIndexSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  servers: z.array(
    z.object({
      server: z.string().min(1),
      firstMonth: monthKey.nullable(),
      latestMonth: monthKey.nullable(),
      monthCount: z.number().int().nonnegative(),
    }),
  ),
});

export const registrySchema = z.object({
  project: z.string().min(1),
  dataset: z.string().min(1),
  servers: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9-]+$/, 'id must be kebab-case'),
        name: z.string().min(1),
        shortName: z.string().min(1),
        url: z.url(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        tables: z
          .object({
            users: z.string().optional(),
            jobs: z.string().optional(),
            usage: z.string().optional(),
          })
          .default({}),
      }),
    )
    .min(1),
});

export const SCHEMA_VERSION = 1;
