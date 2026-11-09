import { ROLES } from './filters.js';
import { COMMANDS, flagsOf, GENERIC_FLAGS, isCommand, specOf, type Command } from './flags.js';
import { GROUP_SUBCOMMANDS } from './group-cmd.js';
import { GROUP_STATES } from './groups.js';
import { PRESET_NAMES } from './reasons.js';
import { ROSTER_SUBCOMMANDS } from './roster-cmd.js';

export const TOP_WORDS = [...COMMANDS, 'group', 'roster', 'completion'] as const;

// The script that `completion bash` prints. Bash calls `orca-broadcast __complete <words>` on each Tab; an empty answer falls back to file names.
export const BASH_SCRIPT = `_orca_broadcast() {
  local IFS=$'\\n'
  COMPREPLY=($(orca-broadcast __complete "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null))
}
complete -o default -F _orca_broadcast orca-broadcast
`;

// The values a flag takes, when they are a fixed list or the saved group names.
function valuesOf(flag: string, groupNames: readonly string[]): readonly string[] {
  if (flag === 'role') return ROLES;
  if (flag === 'state') return GROUP_STATES;
  if (flag === 'reason') return PRESET_NAMES;
  if (flag === 'group') return groupNames;
  return [];
}

const takesValue = (word: string): string | null => {
  const name = word.startsWith('--') && !word.includes('=') ? word.slice(2) : null;
  return name !== null && specOf(name)?.type === 'string' ? name : null;
};

// Bash splits `--flag=value` at `=` (it is in COMP_WORDBREAKS): join the pieces again, so `--role=worker` is one word.
function joinEquals(words: readonly string[]): string[] {
  const joined: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const last = joined.at(-1);
    if (words[i] === '=' && last?.startsWith('--') && !last.includes('=')) {
      joined[joined.length - 1] = `${last}=${words[i + 1] ?? ''}`;
      i++;
    } else joined.push(words[i]!);
  }
  return joined;
}

/** The candidates for the last word of `words` (the words after `orca-broadcast`; the last one is the word being typed, maybe empty). */
export function complete(raw: readonly string[], groupNames: readonly string[]): string[] {
  const words = joinEquals(raw);
  const current = words.at(-1) ?? '';
  // The value of `--flag=<value>`: bash replaces only the piece after `=`, or the `=` itself when it is the word being typed.
  const inline = /^--([^=]+)=(.*)$/.exec(current);
  if (inline) {
    const values = valuesOf(inline[1]!, groupNames).filter((value) => value.startsWith(inline[2]!));
    return raw.at(-1) === '=' ? values.map((value) => `=${value}`) : [...values];
  }
  const before = words.slice(0, -1);
  const pick = (candidates: readonly string[]) => candidates.filter((word) => word.startsWith(current));
  const valueFlag = before.length > 0 ? takesValue(before.at(-1)!) : null;
  if (valueFlag !== null) return pick(valuesOf(valueFlag, groupNames));

  // The words that are not flags or flag values.
  const positionals: string[] = [];
  const used = new Set<string>();
  for (let i = 0; i < before.length; i++) {
    const word = before[i]!;
    if (word.startsWith('--')) {
      used.add(word.slice(2).split('=')[0]!);
      if (takesValue(word) !== null) i++;
    } else positionals.push(word);
  }
  const flagWords = (names: readonly string[]) => names.filter((name) => specOf(name)?.multiple || !used.has(name)).map((name) => `--${name}`);
  const wantsFlag = current === '' || current.startsWith('-');
  const [target, sub] = positionals;

  if (target === undefined) return pick(current.startsWith('-') ? flagWords(GENERIC_FLAGS) : TOP_WORDS);
  if (target === 'group') {
    if (sub === undefined) return pick(current.startsWith('-') ? flagWords(GENERIC_FLAGS) : GROUP_SUBCOMMANDS);
    const flags = flagWords(sub === 'add' ? flagsOf('group add').map(([name]) => name) : GENERIC_FLAGS);
    const needsName = (sub === 'show' || sub === 'remove') && positionals.length === 2;
    if (needsName && !current.startsWith('-')) return pick(groupNames);
    return wantsFlag ? pick(flags) : [];
  }
  if (target === 'roster') return pick(sub === undefined && !current.startsWith('-') ? ROSTER_SUBCOMMANDS : flagWords(GENERIC_FLAGS));
  if (target === 'completion') return sub === undefined ? pick(['bash']) : [];
  if (!isCommand(target)) return [];
  return wantsFlag ? pick(flagWords(flagsOf(target as Command).map(([name]) => name))) : [];
}
