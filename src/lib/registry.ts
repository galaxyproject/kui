import { parse } from 'yaml';
import registryYaml from '../../servers.yml?raw';
import { registrySchema } from './schema';
import type { Registry, ServerEntry } from './types';

export const registry: Registry = registrySchema.parse(parse(registryYaml)) as Registry;

export const servers: ServerEntry[] = registry.servers;

export function serverById(id: string): ServerEntry {
  const server = servers.find((s) => s.id === id);
  if (!server) throw new Error(`Unknown server '${id}'`);
  return server;
}
