import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createOrcaAdapter, ORCA_EXECUTABLE, type AdapterOptions, type Exec } from '../src/orca-adapter.js';
import { parseProcStartTime } from '../src/store.js';

const fixturePath = (name: string) => join(import.meta.dirname, 'fixtures', name);
const fixture = (name: string) => readFileSync(fixturePath(name), 'utf8');
const json = (name: string) => JSON.parse(fixture(name));

const STAT = fixture('proc-stat.txt');
const START_TICKS = parseProcStartTime(STAT) as string;
const CMDLINE_ID = '00000000-0000-4000-8000-000000000001';
const FILE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const UID = 1000;

// A part of a fake process folder: absent (ENOENT), a directory where a file belongs (cannot be read), or its content.
type Part = 'omit' | 'dir' | string;

interface ProcSpec {
  uid?: number;
  args?: string[];
  status?: Part;
  cmdline?: Part;
  stat?: Part;
  environ?: Part;
  /** `omit`: no link (ENOENT); `file`: a regular file (the read fails with another error); otherwise the link target. */
  cwd?: 'omit' | 'file' | string;
  /** The `sessions/<pid>.json`: `none`, `ok` (start time equals the process's), `stale` (another start time), `no-start` (no `procStart`) or `badjson`. */
  session?: 'none' | 'ok' | 'stale' | 'no-start' | 'badjson';
}

function fakeMachine() {
  const root = mkdtempSync(join(tmpdir(), 'orca-broadcast-proc-'));
  const proc = join(root, 'proc');
  const claude = join(root, 'claude');
  const work = join(root, 'work');
  mkdirSync(join(proc, 'sys/kernel/random'), { recursive: true });
  mkdirSync(join(claude, 'sessions'), { recursive: true });
  mkdirSync(work);
  copyFileSync(fixturePath('boot-id.txt'), join(proc, 'sys/kernel/random/boot_id'));

  const put = (path: string, part: Part, content: string | Buffer) => {
    if (part === 'omit') return;
    if (part === 'dir') mkdirSync(path);
    else writeFileSync(path, part === 'ok' ? content : part);
  };

  function addProc(pid: number, spec: ProcSpec = {}) {
    const dir = join(proc, String(pid));
    mkdirSync(dir);
    const status = fixture('claude-status.txt').replace('Uid:\t1000\t1000\t1000\t1000', `Uid:\t${spec.uid ?? UID}\t${spec.uid ?? UID}\t${spec.uid ?? UID}\t${spec.uid ?? UID}`);
    put(join(dir, 'status'), spec.status ?? 'ok', status);
    const args = spec.args ?? ['claude', '--resume', CMDLINE_ID];
    put(join(dir, 'cmdline'), spec.cmdline ?? 'ok', Buffer.from(args.join('\0') + '\0'));
    put(join(dir, 'stat'), spec.stat ?? 'ok', STAT);
    put(join(dir, 'environ'), spec.environ ?? 'ok', readFileSync(fixturePath('claude-environ.bin')));
    const cwd = spec.cwd ?? work;
    if (cwd === 'file') writeFileSync(join(dir, 'cwd'), '');
    else if (cwd !== 'omit') symlinkSync(cwd, join(dir, 'cwd'));
    const session = spec.session ?? 'ok';
    const file = join(claude, 'sessions', `${pid}.json`);
    const body = { ...json('claude-session.json'), pid, sessionId: FILE_ID, procStart: session === 'stale' ? '1' : START_TICKS };
    if (session === 'no-start') delete (body as Record<string, unknown>).procStart;
    if (session === 'badjson') writeFileSync(file, '{not json');
    else if (session !== 'none') writeFileSync(file, JSON.stringify(body));
  }

  const adapter = (options: AdapterOptions = {}, exec: Exec = async () => { throw new Error('unexpected exec'); }) =>
    createOrcaAdapter(exec, { procRoot: proc, claudeDir: claude, uid: UID, ...options });
  return { root, proc, claude, work, addProc, adapter };
}

describe('scanSessions', () => {
  it('returns a session from a fixture process: session file ID, pane key, folder, start time', async () => {
    const m = fakeMachine();
    m.addProc(100);
    const scan = await m.adapter().scanSessions();
    expect(scan).toEqual({
      sessions: [
        {
          sessionId: FILE_ID,
          paneKey: 'tab-0001:leaf-0001',
          cwd: m.work,
          permission: null,
          startTime: Number(START_TICKS),
          transcript: { sessionId: FILE_ID, cwd: '/work/example-worktree', configDir: m.claude, pid: 100, startTime: Number(START_TICKS) },
        },
      ],
      unknown: [],
      heldByOthers: [],
    });
  });

  describe('transcript identity', () => {
    // A process with CLAUDE_CONFIG_DIR set to `value`, and a session file written only where the test says.
    const withConfigDir = (m: ReturnType<typeof fakeMachine>, pid: number, value: string, spec: ProcSpec = {}) => {
      const environ = readFileSync(fixturePath('claude-environ.bin'), 'utf8') + `CLAUDE_CONFIG_DIR=${value}\0`;
      m.addProc(pid, { session: 'none', environ, ...spec });
    };
    const writeSession = (dir: string, pid: number, body: Record<string, unknown> = {}) => {
      mkdirSync(join(dir, 'sessions'), { recursive: true });
      writeFileSync(join(dir, 'sessions', `${pid}.json`), JSON.stringify({ ...json('claude-session.json'), pid, sessionId: OTHER_ID, procStart: START_TICKS, ...body }));
    };

    it('uses the session file of CLAUDE_CONFIG_DIR, and names that dir in the identity', async () => {
      const m = fakeMachine();
      const dir = join(m.root, 'account');
      withConfigDir(m, 100, dir);
      writeSession(dir, 100);
      const scan = await m.adapter().scanSessions();
      expect(scan.unknown).toEqual([]);
      expect(scan.sessions[0]?.sessionId).toBe(OTHER_ID);
      expect(scan.sessions[0]?.transcript).toEqual({ sessionId: OTHER_ID, cwd: '/work/example-worktree', configDir: dir, pid: 100, startTime: Number(START_TICKS) });
    });

    it('uses the claudeDir option when the variable is unset', async () => {
      const m = fakeMachine();
      m.addProc(100);
      expect((await m.adapter().scanSessions()).sessions[0]?.transcript?.configDir).toBe(m.claude);
    });

    it('lets the variable win over the claudeDir option: a session file only in the option dir is not used', async () => {
      const m = fakeMachine();
      withConfigDir(m, 100, join(m.root, 'account'));
      writeSession(m.claude, 100);
      const scan = await m.adapter().scanSessions();
      expect(scan.sessions.map((s) => s.sessionId)).toEqual([CMDLINE_ID]);
      expect(scan.sessions[0]?.transcript).toBeUndefined();
    });

    it('counts a relative or empty value as unset', async () => {
      const m = fakeMachine();
      withConfigDir(m, 100, 'relative/dir');
      withConfigDir(m, 101, '');
      writeSession(m.claude, 100);
      writeSession(m.claude, 101);
      const scan = await m.adapter().scanSessions();
      expect(scan.sessions.map((s) => s.transcript?.configDir)).toEqual([m.claude, m.claude]);
    });

    it('gives no transcript for a session file with no cwd, a non-string cwd or an empty cwd, and keeps the session ID', async () => {
      const m = fakeMachine();
      for (const [pid, cwd] of [[100, undefined], [101, 5], [102, '']] as const) {
        m.addProc(pid, { session: 'none' });
        writeSession(m.claude, pid, { cwd });
      }
      const scan = await m.adapter().scanSessions();
      expect(scan.sessions.map((s) => [s.sessionId, s.transcript])).toEqual([[OTHER_ID, undefined], [OTHER_ID, undefined], [OTHER_ID, undefined]]);
    });

    it('gives no transcript when the session ID came from --resume', async () => {
      const m = fakeMachine();
      m.addProc(100, { session: 'none' });
      const scan = await m.adapter().scanSessions();
      expect(scan.sessions[0]).toMatchObject({ sessionId: CMDLINE_ID });
      expect(scan.sessions[0]?.transcript).toBeUndefined();
    });
  });

  it('counts a claude process by the base name of its first argument', async () => {
    const m = fakeMachine();
    m.addProc(100, { args: ['/usr/local/bin/claude'], session: 'ok' });
    m.addProc(101, { args: ['node', '/opt/claude/cli.js'], session: 'ok' });
    m.addProc(102, { args: ['claude-helper'], session: 'ok' });
    const scan = await m.adapter().scanSessions();
    expect(scan.sessions).toHaveLength(1);
    expect(scan.unknown).toEqual([]);
  });

  it('skips the processes of another user, and counts a process whose Uid line cannot be parsed as the user own', async () => {
    const m = fakeMachine();
    m.addProc(100, { uid: 2000 });
    m.addProc(101, { status: 'no uid line here\n' });
    m.addProc(102, { status: 'dir' });
    const scan = await m.adapter().scanSessions();
    expect(scan.sessions.map((s) => s.startTime)).toHaveLength(2);
    // another user's shell with --resume is not held by the user either
    const other = fakeMachine();
    other.addProc(200, { uid: 2000, args: ['bash', '-c', `claude --resume ${OTHER_ID}`] });
    other.addProc(201, { uid: 2000, args: ['bash', '--resume', OTHER_ID] });
    expect((await other.adapter().scanSessions()).heldByOthers).toEqual([]);
  });

  it('ignores a process that is gone when its status is read', async () => {
    const m = fakeMachine();
    m.addProc(100, { status: 'omit' });
    expect(await m.adapter().scanSessions()).toEqual({ sessions: [], unknown: [], heldByOthers: [] });
  });

  it('uses the sessions file only when its start time equals the live one: a stale file (pid reuse) falls back to --resume', async () => {
    const m = fakeMachine();
    m.addProc(100, { session: 'stale' });
    m.addProc(101, { session: 'badjson' });
    m.addProc(102, { session: 'none' });
    m.addProc(103, { session: 'no-start' });
    const ids = (await m.adapter().scanSessions()).sessions.map((s) => s.sessionId);
    expect(ids).toEqual([CMDLINE_ID, CMDLINE_ID, CMDLINE_ID, CMDLINE_ID]);
  });

  it('reads --resume and -r UUIDs of either case, and ignores a value that is not a UUID', async () => {
    const m = fakeMachine();
    m.addProc(100, { session: 'none', args: ['claude', '-r', OTHER_ID.toUpperCase()] });
    m.addProc(101, { session: 'none', args: ['claude', '--resume', 'not-a-uuid'] });
    m.addProc(102, { session: 'none', args: ['claude'] });
    const scan = await m.adapter().scanSessions();
    expect(scan.sessions.map((s) => s.sessionId)).toEqual([OTHER_ID.toUpperCase()]);
    expect(scan.unknown).toEqual([{ cwd: m.work }, { cwd: m.work }]);
  });

  it('puts a process with no determinable session ID in unknown, with its folder', async () => {
    const m = fakeMachine();
    m.addProc(100, { session: 'none', args: ['claude'] });
    const scan = await m.adapter().scanSessions();
    expect(scan).toEqual({ sessions: [], unknown: [{ cwd: m.work }], heldByOthers: [] });
  });

  it('treats a claude process with an unreadable command line as unknown with no folder, and does not read the other files', async () => {
    const m = fakeMachine();
    m.addProc(100, { cmdline: 'dir', stat: 'omit', environ: 'omit', cwd: 'omit' });
    expect(await m.adapter().scanSessions()).toEqual({ sessions: [], unknown: [{ cwd: null }], heldByOthers: [] });
  });

  it('ignores a process whose command line is gone', async () => {
    const m = fakeMachine();
    m.addProc(100, { cmdline: 'omit' });
    expect(await m.adapter().scanSessions()).toEqual({ sessions: [], unknown: [], heldByOthers: [] });
  });

  it('precedence of reads: stat gone ignores the process; stat unreadable gives unknown with the folder even with a valid sessions file and --resume', async () => {
    const m = fakeMachine();
    m.addProc(100, { stat: 'omit' });
    m.addProc(101, { stat: 'dir', environ: 'omit' });
    m.addProc(102, { stat: 'garbage without field 22' });
    m.addProc(103, { stat: 'dir', cwd: 'omit' });
    const scan = await m.adapter().scanSessions();
    expect(scan.sessions).toEqual([]);
    expect(scan.unknown).toEqual([{ cwd: m.work }, { cwd: m.work }]);
  });

  it('precedence of reads: an unreadable command line with stat gone gives unknown with no folder', async () => {
    const m = fakeMachine();
    m.addProc(100, { cmdline: 'dir', stat: 'omit' });
    expect((await m.adapter().scanSessions()).unknown).toEqual([{ cwd: null }]);
  });

  it('reads environ and cwd defensively: an unreadable environ gives a null pane key, an unreadable cwd gives a null folder, a gone one ignores the process', async () => {
    const m = fakeMachine();
    m.addProc(100, { environ: 'dir' });
    m.addProc(101, { cwd: 'file' });
    m.addProc(102, { environ: 'omit' });
    m.addProc(103, { cwd: 'omit' });
    m.addProc(104, { environ: 'no pane key here\0' });
    const scan = await m.adapter().scanSessions();
    expect(scan.sessions.map((s) => [s.paneKey, s.cwd])).toEqual([
      [null, m.work],
      ['tab-0001:leaf-0001', null],
      [null, m.work],
    ]);
  });

  it('keeps only ORCA_PANE_KEY from the environment: no other value reaches any result field', async () => {
    const m = fakeMachine();
    m.addProc(100, { environ: 'SECRET_TOKEN=hunter2\0ORCA_AGENT_HOOK_TOKEN=also-secret\0ORCA_PANE_KEY=tab-9:leaf-9\0AWS_KEY=abc\0' });
    const scan = await m.adapter().scanSessions();
    expect(scan.sessions[0]?.paneKey).toBe('tab-9:leaf-9');
    const text = JSON.stringify(scan);
    for (const secret of ['hunter2', 'also-secret', 'AWS_KEY', 'abc', 'SECRET_TOKEN']) expect(text).not.toContain(secret);
  });

  it('records the three permission flag forms, the earliest wins, and any other token is no flag', async () => {
    const m = fakeMachine();
    const forms: string[][] = [
      ['claude', '--permission-mode', 'bypassPermissions'],
      ['claude', '--permission-mode=bypassPermissions'],
      ['claude', '--dangerously-skip-permissions'],
      ['claude', '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions'],
      ['claude', '--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions'],
      ['claude', '--permission-mode', 'auto'],
      ['claude', '--permission-mode', 'auto', '--dangerously-skip-permissions'],
      ['claude', '--permission-mode'],
      ['claude', '--model', 'bypassPermissions'],
    ];
    forms.forEach((args, i) => m.addProc(100 + i, { args }));
    const permissions = (await m.adapter().scanSessions()).sessions.map((s) => s.permission);
    expect(permissions).toEqual([
      '--permission-mode bypassPermissions',
      '--permission-mode bypassPermissions',
      '--dangerously-skip-permissions',
      '--dangerously-skip-permissions',
      '--permission-mode bypassPermissions',
      null,
      '--dangerously-skip-permissions',
      null,
      null,
    ]);
  });

  it('lists the session IDs that a non-claude process of the user holds, each once and only UUIDs', async () => {
    const m = fakeMachine();
    m.addProc(100, { args: ['bash', '-c', 'x'] });
    m.addProc(101, { args: ['zsh', '--resume', OTHER_ID] });
    m.addProc(102, { args: ['sh', '-r', OTHER_ID, '--resume', 'nope'] });
    m.addProc(103, { args: ['claude-launcher', '--resume', FILE_ID] });
    // a claude process adds nothing, even one whose command line cannot be read
    m.addProc(104, { args: ['claude', '--resume', CMDLINE_ID] });
    m.addProc(105, { cmdline: 'dir' });
    expect((await m.adapter().scanSessions()).heldByOthers).toEqual([OTHER_ID, FILE_ID]);
  });

  it('applies the option defaults: the injected uid, the proc root and the Claude folder are what is read', async () => {
    const m = fakeMachine();
    m.addProc(100);
    const withUid = await createOrcaAdapter(async () => { throw new Error('unexpected exec'); }, { procRoot: m.proc, claudeDir: m.claude, uid: 4242 }).scanSessions();
    expect(withUid.sessions).toEqual([]);
    const defaults = createOrcaAdapter(async () => { throw new Error('unexpected exec'); }, { procRoot: m.proc, claudeDir: m.claude });
    expect((await defaults.scanSessions()).sessions).toHaveLength(process.getuid!() === UID ? 1 : 0);
  });

  it('fails when the proc root cannot be listed, and when the boot ID cannot be read', async () => {
    const m = fakeMachine();
    await expect(m.adapter({ procRoot: join(m.root, 'missing') }).scanSessions()).rejects.toThrow();
    // a proc root that lists fine but holds no boot_id: the scan fails, whatever its processes are
    const noBoot = fakeMachine();
    const bare = join(noBoot.root, 'bare-proc');
    mkdirSync(join(bare, '100'), { recursive: true });
    await expect(noBoot.adapter({ procRoot: bare }).bootId()).rejects.toThrow();
    await expect(noBoot.adapter({ procRoot: bare }).scanSessions()).rejects.toThrow();
  });

  it('does not fail on one unreadable process', async () => {
    const m = fakeMachine();
    m.addProc(100, { cmdline: 'dir' });
    m.addProc(101, { status: 'dir', cmdline: 'dir' });
    await expect(m.adapter().scanSessions()).resolves.toMatchObject({ unknown: [{ cwd: null }, { cwd: null }] });
  });
});

describe('bootId', () => {
  it('returns the trimmed content of the boot_id file under the proc root', async () => {
    const m = fakeMachine();
    expect(await m.adapter().bootId()).toBe(fixture('boot-id.txt').trim());
  });
});

describe('listAgentsWithRuntime', () => {
  const psExec = (name: string): { exec: Exec; calls: string[][] } => {
    const calls: string[][] = [];
    return { calls, exec: async (_file, args) => (calls.push(args), { stdout: fixture(name), stderr: '', code: 0 }) };
  };

  it('returns the rows of listAgents and the runtime ID of the same call, with one worktree ps', async () => {
    const { exec, calls } = psExec('worktree-ps.json');
    const adapter = createOrcaAdapter(exec);
    const listed = await adapter.listAgentsWithRuntime();
    expect(listed.runtimeId).toBe(json('worktree-ps.json')._meta.runtimeId);
    expect(typeof listed.runtimeId).toBe('string');
    expect(calls).toEqual([['worktree', 'ps', '--json']]);
    expect(listed.rows).toEqual(await adapter.listAgents());
  });

  it('keeps a null runtime ID as null', async () => {
    const { exec } = psExec('worktree-ps-plain-handoff.json');
    expect((await createOrcaAdapter(exec).listAgentsWithRuntime()).runtimeId).toBeNull();
  });

  it('treats a missing _meta as an unknown runtime, and leaves the other listings untouched', async () => {
    const body = json('worktree-ps.json');
    delete body._meta;
    const exec: Exec = async () => ({ stdout: JSON.stringify(body), stderr: '', code: 0 });
    expect((await createOrcaAdapter(exec).listAgentsWithRuntime()).runtimeId).toBeNull();
    expect(await createOrcaAdapter(exec).listAgents()).toHaveLength(body.result.worktrees.flatMap((w: any) => w.agents ?? []).length);
  });

  it('createOrcaAdapter(exec) without options keeps working', async () => {
    const { exec } = psExec('worktree-ps.json');
    expect((await createOrcaAdapter(exec).listAgents()).length).toBeGreaterThan(0);
  });
});

describe('startAgent', () => {
  const WORKTREE = '/work/example tree.v2';

  function setup(result: { stdout?: string; stderr?: string; code?: number } | Error = {}) {
    const m = fakeMachine();
    const calls: { file: string; args: string[] }[] = [];
    const exec: Exec = async (file, args) => {
      calls.push({ file, args });
      if (result instanceof Error) throw result;
      return { stdout: result.stdout ?? fixture('terminal-create.json'), stderr: result.stderr ?? '', code: result.code ?? 0 };
    };
    const folder = join(m.claude, 'projects', WORKTREE.replace(/[^A-Za-z0-9]/g, '-'));
    const withTranscript = (id = CMDLINE_ID) => {
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, `${id}.jsonl`), '');
    };
    return { m, calls, adapter: createOrcaAdapter(exec, { procRoot: m.proc, claudeDir: m.claude, uid: UID }), withTranscript };
  }

  it('builds the exact terminal create arguments, with no permission flag', async () => {
    const { adapter, calls, withTranscript } = setup();
    withTranscript();
    const result = await adapter.startAgent(WORKTREE, CMDLINE_ID, null, 'repo/tree (recovered)');
    expect(result).toEqual({ started: true, handle: json('terminal-create.json').result.terminal.handle });
    expect(calls).toEqual([
      {
        file: ORCA_EXECUTABLE,
        args: ['terminal', 'create', '--worktree', `path:${WORKTREE}`, '--title', 'repo/tree (recovered)', '--command', `env -u CLAUDE_CODE_RESUME_INTERRUPTED_TURN claude --resume ${CMDLINE_ID}`, '--json'],
      },
    ]);
  });

  it('with title updates off, sets CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 beside the unset, and passes the title', async () => {
    const { adapter, calls, withTranscript } = setup();
    withTranscript();
    expect((await adapter.startAgent(WORKTREE, CMDLINE_ID, null, 'My tab', true)).started).toBe(true);
    expect(calls).toEqual([
      {
        file: ORCA_EXECUTABLE,
        args: ['terminal', 'create', '--worktree', `path:${WORKTREE}`, '--title', 'My tab', '--command', `env -u CLAUDE_CODE_RESUME_INTERRUPTED_TURN CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 claude --resume ${CMDLINE_ID}`, '--json'],
      },
    ]);
  });

  it('with title updates off and a permission flag, the variable comes before claude and the flag after the session ID', async () => {
    const { adapter, calls, withTranscript } = setup();
    withTranscript();
    await adapter.startAgent(WORKTREE, CMDLINE_ID, '--dangerously-skip-permissions', 't', true);
    expect(calls[0]?.args[calls[0].args.indexOf('--command') + 1]).toBe(`env -u CLAUDE_CODE_RESUME_INTERRUPTED_TURN CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 claude --resume ${CMDLINE_ID} --dangerously-skip-permissions`);
  });

  it('an explicit false leaves the command as it is', async () => {
    const { adapter, calls, withTranscript } = setup();
    withTranscript();
    await adapter.startAgent(WORKTREE, CMDLINE_ID, null, 't', false);
    expect(calls[0]?.args[calls[0].args.indexOf('--command') + 1]).toBe(`env -u CLAUDE_CODE_RESUME_INTERRUPTED_TURN claude --resume ${CMDLINE_ID}`);
  });

  it('with title updates off, the same checks refuse as with them on', async () => {
    const { adapter, calls } = setup();
    expect(await adapter.startAgent(WORKTREE, 'not-a-uuid', null, 't', true)).toEqual({ started: false, reason: 'invalid-session-id' });
    expect(await adapter.startAgent(WORKTREE, CMDLINE_ID, '--permission-mode auto', 't', true)).toEqual({ started: false, reason: 'flag-not-allowed' });
    expect(await adapter.startAgent(WORKTREE, CMDLINE_ID, null, 't', true)).toEqual({ started: false, reason: 'no-transcript' });
    expect(calls).toEqual([]);
  });

  it.each(['--permission-mode bypassPermissions', '--dangerously-skip-permissions'])('appends the allowed flag %s to the command', async (flag) => {
    const { adapter, calls, withTranscript } = setup();
    withTranscript();
    expect((await adapter.startAgent(WORKTREE, CMDLINE_ID, flag, 't')).started).toBe(true);
    expect(calls[0]?.args[calls[0].args.indexOf('--command') + 1]).toBe(`env -u CLAUDE_CODE_RESUME_INTERRUPTED_TURN claude --resume ${CMDLINE_ID} ${flag}`);
  });

  it('keeps a path and a title that look like shell text as plain arguments', async () => {
    const { m, calls } = setup();
    const worktree = '/work/a; rm -x $(id)';
    const folder = join(m.claude, 'projects', worktree.replace(/[^A-Za-z0-9]/g, '-'));
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${CMDLINE_ID}.jsonl`), '');
    const exec: Exec = async (file, args) => (calls.push({ file, args }), { stdout: fixture('terminal-create.json'), stderr: '', code: 0 });
    await createOrcaAdapter(exec, { claudeDir: m.claude }).startAgent(worktree, CMDLINE_ID, null, '--title "x"; true');
    expect(calls[0]?.args).toContain(`path:${worktree}`);
    expect(calls[0]?.args).toContain('--title "x"; true');
    expect(calls[0]?.args.at(-2)).toBe(`env -u CLAUDE_CODE_RESUME_INTERRUPTED_TURN claude --resume ${CMDLINE_ID}`);
  });

  it('refuses in order and never calls exec: invalid-session-id, flag-not-allowed, no-transcript', async () => {
    const { adapter, calls } = setup();
    expect(await adapter.startAgent(WORKTREE, 'not-a-uuid', '--permission-mode auto', 't')).toEqual({ started: false, reason: 'invalid-session-id' });
    expect(await adapter.startAgent(WORKTREE, CMDLINE_ID, '--permission-mode auto', 't')).toEqual({ started: false, reason: 'flag-not-allowed' });
    expect(await adapter.startAgent(WORKTREE, CMDLINE_ID, '--permission-mode=bypassPermissions', 't')).toEqual({ started: false, reason: 'flag-not-allowed' });
    expect(await adapter.startAgent(WORKTREE, CMDLINE_ID, null, 't')).toEqual({ started: false, reason: 'no-transcript' });
    expect(calls).toEqual([]);
  });

  it('refuses with no-transcript when the transcript exists for another session, or the check fails for another reason', async () => {
    const { adapter, withTranscript, m } = setup();
    withTranscript(OTHER_ID);
    expect(await adapter.startAgent(WORKTREE, CMDLINE_ID, null, 't')).toEqual({ started: false, reason: 'no-transcript' });
    // a Claude folder that is a file: the check fails with an error other than "missing", which is also no-transcript
    writeFileSync(join(m.claude, 'projects-file'), '');
    const blocked = createOrcaAdapter(async () => { throw new Error('unexpected exec'); }, { claudeDir: join(m.claude, 'projects-file') });
    expect(await blocked.startAgent(WORKTREE, CMDLINE_ID, null, 't')).toEqual({ started: false, reason: 'no-transcript' });
  });

  it('is start-failed with the code, whatever stdout holds, when the exit code is not zero', async () => {
    const { adapter, withTranscript } = setup({ code: 3, stderr: 'boom' });
    withTranscript();
    const result = await adapter.startAgent(WORKTREE, CMDLINE_ID, null, 't');
    expect(result).toMatchObject({ started: false, reason: 'start-failed' });
    expect((result as { message: string }).message).toContain('3');
    expect((result as { message: string }).message).toContain('boom');
  });

  it('is start-failed with the error text for an ok:false envelope, an unreadable envelope and a thrown exec', async () => {
    for (const [setupArg, text] of [
      [{ stdout: JSON.stringify({ ok: false, error: { code: 'x', message: 'no such worktree' } }) }, 'no such worktree'],
      [{ stdout: 'not json' }, 'invalid JSON'],
      [new Error('spawn failed'), 'spawn failed'],
    ] as const) {
      const { adapter, withTranscript } = setup(setupArg);
      withTranscript();
      const result = await adapter.startAgent(WORKTREE, CMDLINE_ID, null, 't');
      expect(result).toMatchObject({ started: false, reason: 'start-failed' });
      expect((result as { message: string }).message).toContain(text);
    }
  });

  it('is start-failed when an ok:true receipt has no handle', async () => {
    const body = json('terminal-create.json');
    delete body.result.terminal.handle;
    const { adapter, withTranscript } = setup({ stdout: JSON.stringify(body) });
    withTranscript();
    expect(await adapter.startAgent(WORKTREE, CMDLINE_ID, null, 't')).toEqual({ started: false, reason: 'start-failed', message: 'no handle in the receipt' });
  });
});

describe('clearWorktree', () => {
  const WORKTREE = '/work/example tree.v2';

  function setup(result: { stdout?: string; stderr?: string; code?: number } | Error) {
    const m = fakeMachine();
    const calls: { file: string; args: string[] }[] = [];
    const exec: Exec = async (file, args) => {
      calls.push({ file, args });
      if (result instanceof Error) throw result;
      return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', code: result.code ?? 0 };
    };
    return { calls, adapter: createOrcaAdapter(exec, { procRoot: m.proc, claudeDir: m.claude, uid: UID }) };
  }

  it('runs terminal close for the worktree path with --all and nothing else, and succeeds on exit code 0', async () => {
    const { adapter, calls } = setup({});
    expect(await adapter.clearWorktree(WORKTREE)).toEqual({ cleared: true });
    expect(calls).toEqual([{ file: ORCA_EXECUTABLE, args: ['terminal', 'close', '--worktree', `path:${WORKTREE}`, '--all'] }]);
  });

  it('returns the failure with a message for a non-zero exit code', async () => {
    const { adapter } = setup({ code: 1, stderr: 'no such worktree\n' });
    expect(await adapter.clearWorktree(WORKTREE)).toEqual({ cleared: false, message: 'orca-ide terminal close exited with code 1: no such worktree' });
  });

  it('returns the failure with a message when the command cannot run', async () => {
    const { adapter } = setup(new Error('spawn orca-ide ENOENT'));
    expect(await adapter.clearWorktree(WORKTREE)).toEqual({ cleared: false, message: 'spawn orca-ide ENOENT' });
  });
});
