import { matches, NO_FILTERS } from './filters.js';
import { absoluteWorktrees, describeGroup, groupKinds, hasGroupKinds, isGroupName, loadGroups, lookupGroup, saveGroups, toGroupFilter, type GroupSpec } from './groups.js';
import { isSendable, listSnapshot, liveSources, locate, resolveFilterSet, subjectOfRow } from './shared.js';
import type { Clock, OrcaPort } from './types.js';

const GROUP_SUBCOMMANDS = ['add', 'list', 'show', 'remove'] as const;
export type GroupSubcommand = (typeof GROUP_SUBCOMMANDS)[number];
export const isGroupSubcommand = (value: string | undefined): value is GroupSubcommand => GROUP_SUBCOMMANDS.some((name) => name === value);

export interface GroupDeps {
  path: string;
  /** Called only when the command needs live Orca listings, so `list` and `remove` never build the real adapter. */
  port: () => OrcaPort;
  clock: Clock;
  cwd: string;
}

export interface ShownAgent {
  repo: string;
  worktree: string;
  role: string;
  state: string;
}

export interface GroupResult {
  outcome: 'done' | 'nothing-to-do';
  text: string;
  groups: Record<string, { filters: Record<string, string[]>; agents?: ShownAgent[] }>;
}

// Group commands never send: the port is only listed, and no run lock is taken.
export async function runGroup(sub: GroupSubcommand, name: string | undefined, spec: GroupSpec, deps: GroupDeps): Promise<GroupResult> {
  const groups = await loadGroups(deps.path);
  const entry = (group: GroupSpec) => ({ filters: groupKinds(group) });
  if (sub === 'list') {
    const text = groups.size === 0 ? 'no groups\n' : [...groups].map(([groupName, group]) => `${groupName}: ${describeGroup(group)}\n`).join('');
    return { outcome: 'done', text, groups: Object.fromEntries([...groups].map(([groupName, group]) => [groupName, entry(group)])) };
  }

  const groupName = name as string;
  if (sub === 'remove') {
    const group = lookupGroup(groups, groupName);
    groups.delete(groupName);
    await saveGroups(deps.path, groups);
    return { outcome: 'done', text: `removed group ${groupName}\n`, groups: { [groupName]: entry(group) } };
  }

  if (sub === 'add') {
    if (!isGroupName(groupName)) throw new Error(`invalid group name "${groupName}": use lowercase letters, digits and -, start with a letter, at most 40 characters`);
    if (!hasGroupKinds(spec)) throw new Error('a group needs at least one filter');
    if (groups.has(groupName)) throw new Error(`group "${groupName}" exists: remove it first`);
    const stored = absoluteWorktrees(spec, deps.cwd);
    // Role and state values need no listing; the others must resolve to exactly one thing now.
    if (stored.repo.length + stored.worktree.length + stored.run.length > 0) {
      const live = { port: deps.port(), clock: deps.clock };
      resolveFilterSet(stored, await liveSources(await listSnapshot(live), live), [], deps.cwd);
    }
    groups.set(groupName, stored);
    await saveGroups(deps.path, groups);
    return { outcome: 'done', text: `added group ${groupName}\n`, groups: { [groupName]: entry(stored) } };
  }

  // show: the agents a broadcast would target, matched now.
  const group = lookupGroup(groups, groupName);
  const live = { port: deps.port(), clock: deps.clock };
  const snapshot = await listSnapshot(live);
  const set = resolveFilterSet(NO_FILTERS, await liveSources(snapshot, live), [], deps.cwd, toGroupFilter(groupName, group));
  const agents: ShownAgent[] = [];
  for (const [paneKey, row] of snapshot.agents) {
    if ('gone' in locate(paneKey, snapshot.agents, snapshot.terminals)) continue;
    if (!isSendable(row) || (group.state.length > 0 && !group.state.some((state) => state === row.state))) continue;
    const subject = subjectOfRow(row, snapshot.roles);
    if (matches(set, subject)) agents.push({ repo: row.repo, worktree: row.worktree, role: subject.role, state: row.state });
  }
  const header = `group ${groupName}: ${describeGroup(group)}\n`;
  const body = agents.length === 0 ? 'no agents match\n' : agents.map((a) => `${a.repo}/${a.worktree}  ${a.role}  ${a.state}\n`).join('');
  return { outcome: agents.length === 0 ? 'nothing-to-do' : 'done', text: header + body, groups: { [groupName]: { ...entry(group), agents } } };
}
