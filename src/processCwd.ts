import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Where the processes inside a terminal are.
 *
 * The shell alone is not enough. An agent started with its own
 * worktree flag -- `claude --worktree`, and the equivalents in other tools --
 * chdirs its own process and leaves the shell where it was, because a child
 * cannot move its parent.
 *
 * Asking the process tree covers that without the extension ever knowing which
 * agent it is looking at. Unsupported on Windows, where callers fall back to
 * shell integration.
 */

/** Stop walking the process tree here. A terminal never has this many. */
const MAX_PROCESSES = 64;

/** Terminal switches can burst; reuse a recent snapshot rather than re-spawning. */
const CACHE_MS = 750;

export interface Proc {
  pid: number;
  ppid: number;
}

export interface ProcSnapshot {
  procs: Map<number, Proc>;
  children: Map<number, number[]>;
  /** When the underlying `ps` finished, not when it was requested. */
  at: number;
}

const cwdCache = new Map<number, { at: number; cwds: string[] }>();

let snapshot: ProcSnapshot | undefined;
/** Concurrent callers share one `ps` rather than each spawning their own. */
let pending: Promise<ProcSnapshot> | undefined;

function run(cmd: string, args: string[]): Promise<string | undefined> {
  return new Promise(resolve => {
    cp.execFile(
      cmd,
      args,
      {
        timeout: 2000,
        windowsHide: true,
        // `ps` formats numbers with the locale's decimal separator, so a
        // German locale prints 0,9 and naive parsing reads it as 0.
        env: { ...process.env, LC_ALL: 'C' }
      },
      (_err, stdout) => {
        // lsof exits non-zero when any single pid is unreadable, but the
        // output for the readable ones is still there and still correct.
        resolve(stdout || undefined);
      }
    );
  });
}

/**
 * Every process on the machine, by pid, plus a parent -> children index.
 *
 * Cached by completion time rather than request time: stamping before the
 * `ps` runs meant the real lifetime was `CACHE_MS` minus however long `ps`
 * took, which on a loaded machine could be nothing at all.
 */
export async function processSnapshot(): Promise<ProcSnapshot> {
  if (snapshot && Date.now() - snapshot.at < CACHE_MS) {
    return snapshot;
  }
  if (pending) {
    return pending;
  }

  pending = (async () => {
    const procs = new Map<number, Proc>();
    const children = new Map<number, number[]>();
    const out = await run('ps', ['-axo', 'pid=,ppid=']);

    for (const line of (out ?? '').split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(\d+)/);
      if (!match) {
        continue;
      }
      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      procs.set(pid, { pid, ppid });

      const siblings = children.get(ppid);
      if (siblings) {
        siblings.push(pid);
      } else {
        children.set(ppid, [pid]);
      }
    }

    snapshot = { procs, children, at: Date.now() };
    return snapshot;
  })();

  try {
    return await pending;
  } finally {
    pending = undefined;
  }
}

/**
 * `root` and every process descended from it, breadth first.
 *
 * Pure and synchronous against one snapshot on purpose, so callers cannot mix
 * results from two different `ps` runs in which a pid appears in one and is
 * already gone from the other.
 */
export function descendantsOf(snap: ProcSnapshot, root: number): number[] {
  const found: number[] = [];
  const queue = [root];
  while (queue.length && found.length < MAX_PROCESSES) {
    const pid = queue.shift() as number;
    found.push(pid);
    queue.push(...(snap.children.get(pid) ?? []));
  }
  return found;
}

/** One lsof call for every pid at once, rather than one per process. */
async function cwdsViaLsof(pids: number[]): Promise<string[]> {
  const out = await run('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fn']);
  if (!out) {
    return [];
  }
  return out
    .split('\n')
    .filter(line => line.startsWith('n'))
    .map(line => line.slice(1));
}

/** /proc has the answer without spawning anything. */
async function cwdsViaProc(pids: number[]): Promise<string[]> {
  const found: string[] = [];
  for (const pid of pids) {
    try {
      found.push(await fs.promises.readlink(`/proc/${pid}/cwd`));
    } catch {
      // Process exited, or belongs to another user. Skip it.
    }
  }
  return found;
}

/** Every distinct working directory held by the terminal's process tree. */
export async function processCwds(shellPid: number): Promise<string[]> {
  if (process.platform === 'win32') {
    return [];
  }

  const hit = cwdCache.get(shellPid);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_MS) {
    return hit.cwds;
  }

  const snap = await processSnapshot();
  const pids = descendantsOf(snap, shellPid);
  const raw =
    process.platform === 'linux' ? await cwdsViaProc(pids) : await cwdsViaLsof(pids);
  const cwds = [...new Set(raw.filter(c => c && path.isAbsolute(c)))];

  cwdCache.set(shellPid, { at: Date.now(), cwds });
  return cwds;
}

/** Drops cached entries for terminals that have gone away. */
export function forgetProcess(shellPid: number): void {
  cwdCache.delete(shellPid);
}
