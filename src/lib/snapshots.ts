import type { Snapshot, SnapshotIndex } from './types';
import indexJson from '../../data/snapshots/index.json';

const modules = import.meta.glob<{ default: Snapshot }>('../../data/snapshots/*.json', {
  eager: true,
});

const byServer = new Map<string, Snapshot>();
for (const [path, module] of Object.entries(modules)) {
  if (path.endsWith('index.json')) continue;
  const snapshot = module.default;
  byServer.set(snapshot.server, snapshot);
}

export const snapshotIndex = indexJson as SnapshotIndex;

export function snapshotFor(serverId: string): Snapshot {
  const snapshot = byServer.get(serverId);
  if (!snapshot) throw new Error(`No snapshot committed for server '${serverId}'`);
  return snapshot;
}

export function allSnapshots(): Snapshot[] {
  return [...byServer.values()];
}

export function freshnessFor(serverId: string): string | null {
  return snapshotIndex.servers.find((s) => s.server === serverId)?.latestMonth ?? null;
}
