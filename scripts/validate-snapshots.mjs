#!/usr/bin/env node
// Validate servers.yml and every committed snapshot against the zod schemas.
// Runs in CI so a bad refresh or a malformed registry PR fails before deploy.

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { registrySchema, snapshotSchema, snapshotIndexSchema } from '../src/lib/schema.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const snapshotDir = join(repoRoot, 'data', 'snapshots');

const problems = [];

function check(label, schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) {
    problems.push(`${label}:\n${JSON.stringify(result.error.issues, null, 2)}`);
    return null;
  }
  return result.data;
}

const registry = check(
  'servers.yml',
  registrySchema,
  parse(await readFile(join(repoRoot, 'servers.yml'), 'utf8')),
);

const files = (await readdir(snapshotDir)).filter((f) => f.endsWith('.json'));

for (const file of files) {
  const contents = JSON.parse(await readFile(join(snapshotDir, file), 'utf8'));
  if (file === 'index.json') {
    check(file, snapshotIndexSchema, contents);
    continue;
  }
  const snapshot = check(file, snapshotSchema, contents);
  if (!snapshot) continue;

  if (registry && !registry.servers.some((s) => s.id === snapshot.server)) {
    problems.push(`${file}: server '${snapshot.server}' is not in servers.yml`);
  }
  const months = snapshot.months.map((m) => m.month);
  if (months.some((m, i) => i > 0 && m <= months[i - 1])) {
    problems.push(`${file}: months are not strictly ascending`);
  }
}

if (registry) {
  for (const server of registry.servers) {
    if (!files.includes(`${server.id}.json`)) {
      problems.push(`servers.yml: '${server.id}' has no snapshot in data/snapshots/`);
    }
  }
}

if (problems.length) {
  console.error(problems.join('\n\n'));
  process.exit(1);
}

console.log(`Validated servers.yml and ${files.length} snapshot file(s).`);
