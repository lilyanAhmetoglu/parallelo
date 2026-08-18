import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Working directories of the processes running inside a terminal.
 *
 * The shell's own cwd is not enough. An agent started with its own worktree
 * flag -- `claude --worktree`, and the equivalents in other tools -- chdirs
 * its own process and leaves the shell where it was, because a child cannot
 * move its parent. Asking the processes directly covers that case without the
 * extension ever knowing which agent it is looking at.
 *
 * Unsupported on Windows, where callers fall back to shell integration.
 */

/** Stop walking the process tree here. A terminal never has this many. */
const MAX_PROCESSES = 64;

/** Terminal switches can burst; reuse a recent answer rather than re-spawning. */
const CACHE_MS = 750;

const cache = new Map<number, { at: number; cwds: string[] }>();

/** Shared so that resolving every terminal at once reads `ps` only once. */
let table: { at: number; children: Map<number, number[]> } | undefined;

function run(cmd: string, args: string[]): Promise<string | undefined> {
  return new Promise(resolve => {
    cp.execFile(cmd, args, { timeout: 2000, windowsHide: true }, (_err, stdout) => {
      // lsof exits non-zero when any single pid is unreadable, but the
      // output for the readable ones is still there and still correct.
      resolve(stdout || undefined);
    });
  });
}

/** Parent -> children for every process on the machine. */
async function processTable(): Promise<Map<number, number[]>> {
  const now = Date.now();
  if (table && now - table.at < CACHE_MS) {
    return table.children;
  }

  const children = new Map<number, number[]>();
  const out = await run('ps', ['-axo', 'pid=,ppid=']);
  for (const line of (out ?? '').split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) {
      continue;
    }
    const parent = Number(match[2]);
    const existing = children.get(parent);
    if (existing) {
      existing.push(Number(match[1]));
    } else {
      children.set(parent, [Number(match[1])]);
    }
  }

  table = { at: now, children };
  return children;
}

/** `pid` and every process descended from it, breadth first. */
async function descendantPids(root: number): Promise<number[]> {
  const children = await processTable();
  const found: number[] = [];
  const queue = [root];
  while (queue.length && found.length < MAX_PROCESSES) {
    const pid = queue.shift() as number;
    found.push(pid);
    queue.push(...(children.get(pid) ?? []));
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

  const hit = cache.get(shellPid);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_MS) {
    return hit.cwds;
  }

  const pids = await descendantPids(shellPid);
  const raw =
    process.platform === 'linux' ? await cwdsViaProc(pids) : await cwdsViaLsof(pids);
  const cwds = [...new Set(raw.filter(c => c && path.isAbsolute(c)))];

  cache.set(shellPid, { at: now, cwds });
  return cwds;
}

/** Drops cached entries for terminals that have gone away. */
export function forgetProcess(shellPid: number): void {
  cache.delete(shellPid);
}
