import { readdir, readFile, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const read = (name: string): Promise<string> => readFile(join(root, name), 'utf8');

interface Tree {
  kind(path: string): Promise<'file' | 'dir' | undefined>;
  text(path: string): Promise<string>;
  list(dir: string): Promise<string[]>;
}

const isMissing = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');

const orMissing = async <T>(work: Promise<T>, fallback: T): Promise<T> => {
  try {
    return await work;
  } catch (error) {
    if (isMissing(error)) return fallback;
    throw error;
  }
};

const diskTree: Tree = {
  kind: (path) => orMissing(stat(join(root, path)).then((info) => (info.isDirectory() ? 'dir' : 'file')), undefined),
  text: read,
  list: (dir) => orMissing(readdir(join(root, dir)), []),
};

const fenceOpen = /^ {0,3}(`{3,}|~{3,})/;

/** The lines of a Markdown text that are outside code fences. */
function outsideFences(markdown: string): string[] {
  const lines: string[] = [];
  let open: string | undefined;
  for (const line of markdown.split('\n')) {
    const fence = fenceOpen.exec(line)?.[1];
    if (open === undefined) {
      if (fence === undefined) lines.push(line);
      else open = fence;
    } else if (fence !== undefined && fence[0] === open[0] && fence.length >= open.length) {
      open = undefined;
    }
  }
  return lines;
}

/** GitHub's anchor form of a heading text, before the `-1` suffix of a repeated heading. */
function slug(heading: string): string {
  const spans: string[] = [];
  return heading
    .replace(/(`+)(.*?)\1/g, (_match, _ticks, code: string) => `\u0000${spans.push(code) - 1}\u0000`)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*+/g, '')
    .replace(/(?<![\p{L}\p{N}_])_+|_+(?![\p{L}\p{N}_])/gu, '')
    .replace(/\u0000(\d+)\u0000/g, (_match, index: string) => spans[Number(index)] ?? '')
    .toLowerCase()
    .replace(/ /g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '');
}

function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const repeats = new Map<string, number>();
  for (const line of outsideFences(markdown)) {
    const heading = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line)?.[1];
    if (heading === undefined) continue;
    const base = slug(heading);
    let count = repeats.get(base);
    let anchor = base;
    if (count !== undefined) {
      do {
        count += 1;
        anchor = `${base}-${count}`;
      } while (anchors.has(anchor));
    }
    repeats.set(base, count ?? 0);
    anchors.add(anchor);
  }
  return anchors;
}

/** The targets of the inline links and image links outside code fences and code spans. */
function linkTargets(markdown: string): string[] {
  const targets: string[] = [];
  for (const line of outsideFences(markdown)) {
    const text = line.replace(/(`+).*?\1/g, '');
    for (const match of text.matchAll(/\]\(\s*(<[^>]*>|[^\s)]*)(?:\s+[^)]*)?\)/g)) {
      const target = match[1] ?? '';
      targets.push(target.startsWith('<') ? target.slice(1, -1) : target);
    }
  }
  return targets;
}

/** Every broken link of `README.md` and of the `.md` files of `docs/guide/`, as `<file>: <target> (<reason>)`. */
async function checkLinks(tree: Tree): Promise<string[]> {
  const guide: string[] = [];
  for (const name of (await tree.list('docs/guide')).filter((entry) => entry.endsWith('.md')).sort()) {
    if ((await tree.kind(`docs/guide/${name}`)) === 'file') guide.push(`docs/guide/${name}`);
  }
  const problems: string[] = [];
  for (const file of ['README.md', ...guide]) {
    if ((await tree.kind(file)) !== 'file') {
      problems.push(`${file}: ${file} (missing target)`);
      continue;
    }
    for (const target of linkTargets(await tree.text(file))) {
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) continue;
      const hash = target.indexOf('#');
      const path = hash === -1 ? target : target.slice(0, hash);
      const anchor = hash === -1 ? '' : target.slice(hash + 1);
      const resolved = path === '' ? file : posix.normalize(posix.join(posix.dirname(file), path)).replace(/(.)\/$/, '$1');
      const kind = path.startsWith('/') || resolved.startsWith('..') ? undefined : await tree.kind(resolved);
      if (kind === undefined) {
        problems.push(`${file}: ${target} (missing target)`);
        continue;
      }
      if (anchor === '') continue;
      if (kind === 'dir' || !headingAnchors(await tree.text(resolved)).has(anchor)) problems.push(`${file}: ${target} (unknown anchor)`);
    }
  }
  return problems;
}

/** An in-memory tree: the keys are file paths, the values are file texts. */
function memoryTree(files: Record<string, string>): Tree {
  const names = Object.keys(files);
  return {
    kind: async (path) => (Object.hasOwn(files, path) ? 'file' : path === '.' || names.some((name) => name.startsWith(`${path}/`)) ? 'dir' : undefined),
    text: async (path) => files[path] ?? '',
    list: async (dir) => [...new Set(names.filter((name) => name.startsWith(`${dir}/`)).map((name) => name.slice(dir.length + 1).split('/')[0] ?? ''))],
  };
}

/** The problems of a sample tree, each as `<file> (<reason>)`: the tests check the file and the reason, not the full line. */
const problemsOf = async (files: Record<string, string>): Promise<string[]> =>
  (await checkLinks(memoryTree(files))).map((problem) => problem.replace(/^(.*?): .* (\([a-z ]+\))$/, '$1 $2'));

describe('docs link check', () => {
  it('passes on README.md and docs/guide/ of the repo', async () => {
    expect(await checkLinks(diskTree)).toEqual([]);
  });

  it('fails on a link to a missing file, and passes on an existing file and folder', async () => {
    expect(await problemsOf({ 'README.md': '[a](docs/none.md)', 'docs/x.md': '' })).toEqual(['README.md (missing target)']);
    expect(await problemsOf({ 'README.md': '[a](docs/x.md) [b](docs) [c](docs/)', 'docs/x.md': '' })).toEqual([]);
  });

  it('fails on a link that leaves the repo root', async () => {
    expect(await problemsOf({ 'README.md': '[a](../../x.md)' })).toEqual(['README.md (missing target)']);
  });

  it('fails on an unknown anchor and passes on an existing heading', async () => {
    const files = { 'README.md': '[a](docs/x.md#plain) [b](docs/x.md#nope)', 'docs/x.md': '# Plain\n' };
    expect(await problemsOf(files)).toEqual(['README.md (unknown anchor)']);
  });

  it('turns headings with code, bold, italic text, punctuation and repeats into GitHub anchors', async () => {
    const headings = ['# The `--json` flag', '## **Bold** text', '## An *italic* one', '## Same', '## Same', '## Same', '## Why? Because: yes!', '## snake_case and _word_', '## Über straße', '## A [link](x.md) here', '## Closed ##'];
    const anchors = ['the---json-flag', 'bold-text', 'an-italic-one', 'same', 'same-1', 'same-2', 'why-because-yes', 'snake_case-and-word', 'über-straße', 'a-link-here', 'closed'];
    const links = anchors.map((anchor) => `[a](docs/x.md#${anchor})`).join(' ');
    expect(await problemsOf({ 'README.md': links, 'docs/x.md': headings.join('\n') })).toEqual([]);
    expect(await problemsOf({ 'README.md': '[a](docs/x.md#same-3) [b](docs/x.md#Same)', 'docs/x.md': '## Same\n## Same\n' })).toHaveLength(2);
  });

  it('keeps underscores inside inline code in a heading anchor', async () => {
    const files = { 'README.md': '[a](docs/x.md#__init__) [b](docs/x.md#_private-field) [c](docs/x.md#a__b__c)', 'docs/x.md': '## `__init__`\n## `_private` field\n## a__b__c\n' };
    expect(await problemsOf(files)).toEqual([]);
  });

  it('removes the underscore marks of adjacent italic words, and keeps link syntax inside inline code', async () => {
    const files = { 'README.md': '[a](docs/x.md#a-b) [b](docs/x.md#ab) [c](docs/x.md#x)', 'docs/x.md': '## _a_ _b_\n## `[a](b)`\n## [`x`](y.md)\n' };
    expect(await problemsOf(files)).toEqual([]);
  });

  it('fails on a link to a folder with an anchor', async () => {
    expect(await problemsOf({ 'README.md': '[a](docs#x)', 'docs/x.md': '' })).toEqual(['README.md (unknown anchor)']);
  });

  it('ignores headings inside code fences, including a fence that never closes', async () => {
    const closed = '```sh\n# comment\n```\n~~~~\n# tilde\n~~~\n# still inside\n~~~~\n# real\n';
    expect(await problemsOf({ 'README.md': '[a](docs/x.md#real)', 'docs/x.md': closed })).toEqual([]);
    for (const anchor of ['comment', 'tilde', 'still-inside']) {
      expect(await problemsOf({ 'README.md': `[a](docs/x.md#${anchor})`, 'docs/x.md': closed })).toHaveLength(1);
    }
    expect(await problemsOf({ 'README.md': '[a](docs/x.md#late)', 'docs/x.md': '```\n# late\n' })).toHaveLength(1);
  });

  it('checks a link that is only an anchor against its own file', async () => {
    expect(await problemsOf({ 'README.md': '# Top\n[a](#top) [b](#nope)' })).toEqual(['README.md (unknown anchor)']);
  });

  it('ignores absolute URLs, even with an anchor', async () => {
    expect(await problemsOf({ 'README.md': '[a](https://x.test/y#z) [b](http://x.test) [c](mailto:a@b.test)' })).toEqual([]);
  });

  it('fails on an image link to a missing file', async () => {
    expect(await problemsOf({ 'README.md': '![alt](img/none.png)' })).toEqual(['README.md (missing target)']);
  });

  it('reads a link with a title and a link in angle brackets like a plain link', async () => {
    const files = { 'README.md': '[a](docs/x.md "title") [b](<docs/x.md>) [c](docs/none.md "title") [d](<docs/none.md>)', 'docs/x.md': '' };
    expect(await problemsOf(files)).toEqual(['README.md (missing target)', 'README.md (missing target)']);
  });

  it('does not read a link inside a code fence or an inline code span', async () => {
    expect(await problemsOf({ 'README.md': '```\n[a](none.md)\n```\nText `[b](none.md)` here.' })).toEqual([]);
  });

  it('reads the .md files of docs/guide/, including a page added later', async () => {
    const files = { 'README.md': '', 'docs/guide/a.md': '[x](none.md)', 'docs/guide/note.txt': '[x](none.md)', 'docs/guide/sub/b.md': '[x](none.md)', 'docs/guide/dir.md/c.md': '[x](none.md)' };
    expect(await problemsOf(files)).toEqual(['docs/guide/a.md (missing target)']);
  });

  it('checks README.md only when docs/guide/ is missing, and fails when README.md is missing', async () => {
    expect(await problemsOf({ 'README.md': '# Title' })).toEqual([]);
    expect(await problemsOf({ 'docs/x.md': '' })).toEqual(['README.md (missing target)']);
  });

  it('resolves a link of a guide page from the folder of that page', async () => {
    const files = { 'README.md': '', 'docs/guide/a.md': '[x](../adr/y.md#t) [y](b.md) [z](../adr/none.md)', 'docs/adr/y.md': '# T', 'docs/guide/b.md': '' };
    expect(await problemsOf(files)).toEqual(['docs/guide/a.md (missing target)']);
  });

  it('reports every broken link of a run', async () => {
    expect(await problemsOf({ 'README.md': '[a](none.md) [b](#nope)' })).toEqual(['README.md (missing target)', 'README.md (unknown anchor)']);
  });
});

describe('roster documents', () => {
  it('the roster page holds the commands that turn the roster timer on and off, and its 5-minute interval', async () => {
    const roster = await read('docs/guide/roster.md');
    expect(roster).toContain('systemctl --user enable --now');
    expect(roster).toContain('systemctl --user disable --now');
    expect(roster).toContain('OnUnitActiveSec=5min');
  });

  it('the reference page documents the warnings field of --json', async () => {
    expect(await read('docs/guide/reference.md')).toContain('Every object has a `warnings` array');
  });

  it('README.md and every guide page leave out the "(not in `--json`)" note', async () => {
    const pages = (await diskTree.list('docs/guide')).filter((entry) => entry.endsWith('.md')).map((entry) => `docs/guide/${entry}`);
    for (const page of ['README.md', ...pages]) {
      expect(await read(page), page).not.toContain('(not in `--json`)');
    }
  });

  it('the roster page documents the automatic saves', async () => {
    const roster = await read('docs/guide/roster.md');
    expect(roster).toContain('These commands also save the roster');
    expect(roster).toContain('| `broadcast`, `resume` |');
    expect(roster).toContain('| `pause` |');
    expect(roster).toContain('| `recover` |');
  });

  it('CONTEXT.md defines the roster term', async () => {
    expect(await read('CONTEXT.md')).toMatch(/^\*\*Roster\*\*:/m);
  });
});

describe('recover crash mode documents', () => {
  it.each(['Crash mode', 'Recovery record', 'Restored agent', 'Restarted agent', 'Held session', 'Missing agent'])('CONTEXT.md defines the term %s', async (term) => {
    expect(await read('CONTEXT.md')).toMatch(new RegExp(`^\\*\\*${term}\\*\\*:`, 'm'));
  });

  it('CONTEXT.md defines the term Pause-run mode', async () => {
    expect(await read('CONTEXT.md')).toMatch(/^\*\*Pause-run mode\*\*:/m);
  });

  it('the recover page describes pause-run mode', async () => {
    const recover = await read('docs/guide/recover.md');
    expect(recover).toContain('pause-run mode');
    expect(recover).toContain('coordinator-not-paused');
  });

  it('the pause-and-resume page holds the worker sentence of resume', async () => {
    expect(await read('docs/guide/pause-and-resume.md')).toMatch(/stored missing workers[^\n]*worker-start --retry-of/);
  });

  it('the recover page says that left-to-coordinator means the list was sent, not that the workers were restarted', async () => {
    expect(await read('docs/guide/recover.md')).toMatch(/left-to-coordinator[^\n]*not[^\n]*restarted/);
  });

  it.each(['--timeout', '--yes', '--json', '--group'])('the reference page Options row of %s names recover', async (flag) => {
    const options = (await read('docs/guide/reference.md')).split(/^## Options$/m)[1]?.split('\n## ')[0] ?? '';
    const row = options.split('\n').find((line) => line.startsWith(`| \`${flag}`));
    expect(row).toBeDefined();
    expect(row).toContain('`recover`');
  });
});

describe('session-ID identity documents', () => {
  it('ADR 0002 records that agents are identified across a restart by session ID', async () => {
    const adrs = await readdir(join(import.meta.dirname, '..', 'docs', 'adr'));
    const name = adrs.find((file) => file.startsWith('0002-'));
    expect(name).toBeDefined();
    expect(await read(join('docs', 'adr', name as string))).toMatch(/^# Agents are identified across a restart by Claude session ID, not `paneKey`/m);
  });

  it('ADR 0003 records that recover holds the lock, as an exception to ADR 0001', async () => {
    const adrs = await readdir(join(import.meta.dirname, '..', 'docs', 'adr'));
    const name = adrs.find((file) => file.startsWith('0003-'));
    expect(name).toBeDefined();
    const adr = await read(join('docs', 'adr', name as string));
    expect(adr).toMatch(/^# `recover` holds the lock: there is no hand-over from it/m);
    expect(adr).toContain('ADR 0001');
  });

  it('the how-it-works page names the recoveries folder of the record store', async () => {
    expect(await read('docs/guide/how-it-works.md')).toContain('`recoveries/`');
  });

  it('AGENTS.md holds the session-ID rule next to the paneKey gotcha', async () => {
    const agents = await read('AGENTS.md');
    expect(agents).toContain('Agents are identified by `paneKey`');
    expect(agents).toContain('Across a restart, agents are matched by Claude session ID (ADR 0002)');
  });
});
