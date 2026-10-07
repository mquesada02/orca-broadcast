import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { FILTER_KINDS, isRole } from './filters.js';
import type { AgentState, FilterSpec, GroupFilter } from './types.js';

export const GROUP_STATES: readonly AgentState[] = ['working', 'done'];
export type GroupState = AgentState;

// The filter kinds of a saved group: the four every command knows, plus `state` for broadcast.
export const GROUP_KINDS = [...FILTER_KINDS, 'state'] as const;

export interface GroupSpec extends FilterSpec {
  state: GroupState[];
}

const NAME = /^[a-z][a-z0-9-]{0,39}$/;
export const isGroupName = (name: string): boolean => NAME.test(name);
export const isGroupState = (value: string): value is GroupState => (GROUP_STATES as readonly string[]).includes(value);

export function resolveGroupsPath(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  const base = env.XDG_CONFIG_HOME || join(home, '.config');
  return join(base, 'orca-broadcast', 'groups.json');
}

export const hasGroupKinds = (spec: GroupSpec): boolean => GROUP_KINDS.some((kind) => spec[kind].length > 0);

// The kinds that are set, as the file and the JSON output write them.
export function groupKinds(spec: GroupSpec): Partial<Record<(typeof GROUP_KINDS)[number], string[]>> {
  return Object.fromEntries(GROUP_KINDS.filter((kind) => spec[kind].length > 0).map((kind) => [kind, [...spec[kind]]]));
}

// A worktree value that looks like a path (it holds a `/` or starts with `.`) is saved absolute; a name or an id is saved as typed.
export function absoluteWorktrees(spec: GroupSpec, cwd: string): GroupSpec {
  return { ...spec, worktree: spec.worktree.map((value) => (value.includes('/') || value.startsWith('.') ? resolve(cwd, value) : value)) };
}

// A group for pause, resume and close: the `state` kind is not used there.
export function toGroupFilter(name: string, spec: GroupSpec): GroupFilter {
  return { name, spec: { repo: spec.repo, worktree: spec.worktree, role: spec.role, run: spec.run } };
}

// Reads the file on every call. A missing file is no groups; anything invalid is an error that names the file.
export async function loadGroups(path: string): Promise<Map<string, GroupSpec>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw new Error(`cannot read groups file ${path}: ${(error as Error).message}`);
  }
  const invalid = (reason: string) => new Error(`invalid groups file ${path}: ${reason}`);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw invalid((error as Error).message);
  }
  if (!isRecord(data) || Object.keys(data).some((key) => key !== 'version' && key !== 'groups')) throw invalid('expected an object with "version" and "groups"');
  if (data.version !== 1) throw invalid(`unsupported version ${JSON.stringify(data.version)}; expected 1`);
  if (!isRecord(data.groups)) throw invalid('"groups" must be an object');
  const groups = new Map<string, GroupSpec>();
  for (const [name, raw] of Object.entries(data.groups)) {
    if (!isGroupName(name)) throw invalid(`bad group name "${name}"`);
    if (!isRecord(raw)) throw invalid(`group "${name}" must be an object`);
    const unknown = Object.keys(raw).find((key) => !(GROUP_KINDS as readonly string[]).includes(key));
    if (unknown) throw invalid(`group "${name}" has an unknown key "${unknown}"`);
    const spec: GroupSpec = { repo: [], worktree: [], role: [], run: [], state: [] };
    for (const kind of GROUP_KINDS) {
      const values = raw[kind];
      if (values === undefined) continue;
      if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || value === '')) throw invalid(`group "${name}": "${kind}" must be a list of non-empty strings`);
      if (kind === 'role') for (const value of values) if (!isRole(value)) throw invalid(`group "${name}": bad role "${value}"`);
      if (kind === 'state') for (const value of values) if (!isGroupState(value)) throw invalid(`group "${name}": bad state "${value}"`);
      (spec[kind] as string[]) = values as string[];
    }
    if (!hasGroupKinds(spec)) throw invalid(`group "${name}" has no filter`);
    groups.set(name, spec);
  }
  return groups;
}

// A temporary file in the same folder, then a rename: a crash never leaves half a file.
export async function saveGroups(path: string, groups: Map<string, GroupSpec>): Promise<void> {
  const file = { version: 1, groups: Object.fromEntries([...groups].map(([name, spec]) => [name, groupKinds(spec)])) };
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

export function lookupGroup(groups: Map<string, GroupSpec>, name: string): GroupSpec {
  const spec = groups.get(name);
  if (!spec) throw new Error(`unknown group "${name}"; ${groups.size === 0 ? 'no groups are saved' : `known: ${[...groups.keys()].join(', ')}`}`);
  return spec;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
