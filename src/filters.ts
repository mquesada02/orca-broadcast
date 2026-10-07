import { isAbsolute, resolve } from 'node:path';
import type { FilterSet, FilterSpec, GroupFilter, Role } from './types.js';

export const ROLES: readonly Role[] = ['coordinator', 'worker', 'session'];

export const isRole = (value: string): value is Role => (ROLES as readonly string[]).includes(value);

export const FILTER_KINDS = ['repo', 'worktree', 'role', 'run'] as const;

// The filter set of a plain command: no kind, so it matches every agent.
export const ALL_AGENTS: FilterSet = { typed: {} };

export const NO_FILTERS: FilterSpec = { repo: [], worktree: [], role: [], run: [] };

export const hasFilters = (spec: FilterSpec): boolean => FILTER_KINDS.some((kind) => spec[kind].length > 0) || (spec.state?.length ?? 0) > 0;

// A command is filtered by ad-hoc filters, by a group, or by both.
export const isFiltered = (spec: FilterSpec, group?: GroupFilter): boolean => hasFilters(spec) || group !== undefined;

// The values an agent is matched on: live from a row and its computed roles, or saved in a record.
export interface Subject {
  repoId: string;
  worktreeId: string;
  role: Role;
  orchestrationRunIds: string[];
  /** The live Orca state; only a broadcast filters on it. Absent when the agent cannot be located now. */
  state?: string;
}

// AND across kinds, OR within a kind.
export function matches(set: FilterSet, subject: Subject): boolean {
  return (
    (!set.repoIds || set.repoIds.includes(subject.repoId)) &&
    (!set.worktreeIds || set.worktreeIds.includes(subject.worktreeId)) &&
    (!set.roles || set.roles.includes(subject.role)) &&
    (!set.runIds || subject.orchestrationRunIds.some((id) => set.runIds?.includes(id))) &&
    (!set.states || (subject.state !== undefined && (set.states as string[]).includes(subject.state)))
  );
}

export interface FilterSources {
  repos: { id: string; path?: string; name: string }[];
  worktrees: { id: string; path: string; name: string; repoId: string }[];
  runIds: string[];
}

const label = (id: string, name: string | undefined) => (name && name !== id ? `${id} (${name})` : id);

// A value is tried as an id, a path and a display name together; reaching more than one id is ambiguous.
function pick(kind: string, value: string, hits: Map<string, string>, known: string): string {
  if (hits.size === 0) throw new Error(`unknown --${kind} "${value}"; ${known}`);
  if (hits.size > 1) throw new Error(`ambiguous --${kind} "${value}": it matches ${[...hits].map(([id, name]) => label(id, name)).join(', ')}`);
  return [...hits.keys()][0] as string;
}

const knownList = (items: Map<string, string>) => (items.size === 0 ? 'none is known' : `known: ${[...items].map(([id, name]) => label(id, name)).join(', ')}`);

export function resolveFilters(spec: FilterSpec, sources: FilterSources, cwd: string): FilterSet {
  const typed: Partial<FilterSpec> = Object.fromEntries(FILTER_KINDS.filter((kind) => spec[kind].length > 0).map((kind) => [kind, [...spec[kind]]]));
  const set: FilterSet = { typed };

  const repoNames = new Map(sources.repos.map((repo) => [repo.id, repo.name]));
  if (spec.repo.length > 0) {
    set.repoIds = [...new Set(spec.repo.map((value) => {
      const hits = new Map<string, string>();
      for (const repo of sources.repos) {
        if (repo.id === value || repo.name === value || (isAbsolute(value) && repo.path !== undefined && resolve(repo.path) === resolve(value))) hits.set(repo.id, repo.name);
      }
      return pick('repo', value, hits, knownList(repoNames));
    }))];
  }

  if (spec.worktree.length > 0) {
    const scoped = (repoId: string) => !set.repoIds || set.repoIds.includes(repoId);
    const worktreeNames = new Map(sources.worktrees.map((w) => [w.id, w.name]));
    set.worktreeIds = [...new Set(spec.worktree.map((value) => {
      const hits = new Map<string, string>();
      for (const w of sources.worktrees) {
        if (w.id === value || resolve(w.path) === resolve(cwd, value) || (w.name === value && scoped(w.repoId))) hits.set(w.id, w.name);
      }
      return pick('worktree', value, hits, knownList(worktreeNames));
    }))];
  }

  if (spec.role.length > 0) set.roles = [...new Set(spec.role)];
  if (spec.state && spec.state.length > 0) {
    set.states = [...new Set(spec.state)];
    typed.state = [...spec.state];
  }

  if (spec.run.length > 0) {
    const known = new Map(sources.runIds.map((id) => [id, id]));
    set.runIds = [...new Set(spec.run.map((value) => pick('run', value, new Map(known.has(value) ? [[value, value]] : []), knownList(known))))];
  }
  return set;
}

const both = <T>(a: T[] | undefined, b: T[] | undefined): T[] | undefined => (a && b ? a.filter((value) => b.includes(value)) : (a ?? b));

// A group's resolved set narrowed by the ad-hoc set: kinds are ANDed, the same kind is intersected, and a kind left with no value matches nobody.
export function combineSets(group: FilterSet, adhoc: FilterSet, name: string): FilterSet {
  const typed = Object.fromEntries(FILTER_KINDS.flatMap((kind) => {
    const values = [...(group.typed[kind] ?? []), ...(adhoc.typed[kind] ?? [])];
    return values.length > 0 ? [[kind, values]] : [];
  }));
  const states = [...(group.typed.state ?? []), ...(adhoc.typed.state ?? [])];
  const set: FilterSet = { typed: states.length > 0 ? { ...typed, state: states } : typed, group: name };
  for (const key of ['repoIds', 'worktreeIds', 'roles', 'runIds', 'states'] as const) {
    const values = both<string>(group[key], adhoc[key]);
    if (values) Object.assign(set, { [key]: values });
  }
  return set;
}

export function describeFilters(spec: FilterSpec): string {
  return [...FILTER_KINDS.flatMap((kind) => spec[kind].map((value) => `--${kind} ${value}`)), ...(spec.state ?? []).map((value) => `--state ${value}`)].join(' ');
}
