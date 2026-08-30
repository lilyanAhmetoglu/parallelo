import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { API as GitAPI } from './git';
import type { SessionTracker } from './sessionTracker';
import { log } from './log';

const run = promisify(execFile);

/**
 * Above this many *missing* terminals the extension will not open them itself.
 *
 * Opening one shell per worktree is cheap at four and hostile at forty. The
 * count that matters is how many would actually be created: a repository with
 * thirteen worktrees and twelve terminals already open needs one more, and
 * refusing that -- then saying so on every window open, forever -- is the
 * behaviour the cap is meant to prevent, not cause.
 */
const AUTO_OPEN_CAP = 12;

export interface WorktreeInfo {
  /** Absolute, symlink-resolved path of the working tree. */
  root: string;
  /** Branch checked out there, without `refs/heads/`. Absent when detached. */
  branch?: string;
  /** Whether this is the repository's main checkout rather than a linked worktree. */
  main: boolean;
}

export interface OpenResult {
  /** Terminals created by this pass. */
  opened: number;
  /** Linked worktrees found, whether or not they needed a terminal. */
  worktrees: number;
  /** Terminals that were not opened because the cap held them back. */
  heldBack: number;
  /**
   * Whether every registered repository failed to answer.
   *
   * Distinguishes "nothing to do" from "could not find out", which otherwise
   * both arrive as `opened: 0` and get reported as the wrong one.
   */
  unreadable: boolean;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * A path in the one form both sides of a comparison can agree on.
 *
 * `path.resolve` does not follow symlinks, and the two sources here disagree
 * about them: git records the real path, while a terminal's cwd is whatever
 * the shell was given. On macOS `/tmp/x` and `/private/tmp/x` are the same
 * directory and never compare equal, so a worktree reached through the link
 * looks unoccupied and gets a second terminal.
 *
 * Falls back to `resolve` for a path that no longer exists -- a pruned
 * worktree, a terminal in a deleted directory -- which cannot match anything
 * real anyway.
 */
export async function canonical(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return path.resolve(target);
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Every working tree of the repository `cwd` belongs to.
 *
 * `git worktree list --porcelain` prints the main checkout first and then each
 * linked worktree, as blank-line-separated records:
 *
 *     worktree /path/to/repo
 *     HEAD 1a2b3c...
 *     branch refs/heads/main
 *
 * A detached worktree prints `detached` in place of `branch`, and a prunable
 * one prints a `prunable` reason -- its directory is gone, so there is nothing
 * to open a terminal in and it is dropped here rather than downstream.
 */
async function worktreesOf(cwd: string): Promise<WorktreeInfo[]> {
  const listed = await git(cwd, ['worktree', 'list', '--porcelain']);
  const found: WorktreeInfo[] = [];
  let current: WorktreeInfo | undefined;
  let prunable = false;

  const flush = (): void => {
    if (current && !prunable) {
      found.push(current);
    }
    current = undefined;
    prunable = false;
  };

  for (const line of listed.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      current = {
        root: path.resolve(line.slice('worktree '.length).trim()),
        // The first record git prints is always the main working tree.
        main: found.length === 0
      };
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    } else if (line.startsWith('prunable')) {
      prunable = true;
    }
  }
  flush();

  return Promise.all(
    found.map(async worktree => ({ ...worktree, root: await canonical(worktree.root) }))
  );
}

interface Discovery {
  worktrees: WorktreeInfo[];
  /** Repositories that could not be listed, out of however many were asked. */
  failed: number;
  asked: number;
}

/**
 * Every worktree reachable from the repositories git has registered.
 *
 * Asking each registered repository rather than the workspace folders is what
 * makes this work for the case it exists for: the worktrees are usually
 * *outside* the folder that is open, so the folder alone would find none of
 * them. One repository is enough to name all of its siblings, so results are
 * deduplicated by resolved path -- several registered worktrees of one
 * repository would otherwise each report the whole set.
 */
export async function discoverWorktrees(gitApi: GitAPI): Promise<Discovery> {
  const byRoot = new Map<string, WorktreeInfo>();
  let failed = 0;
  let asked = 0;

  for (const repository of gitApi.repositories) {
    const from = repository.rootUri.fsPath;
    asked += 1;
    try {
      for (const worktree of await worktreesOf(from)) {
        if (!byRoot.has(worktree.root)) {
          byRoot.set(worktree.root, worktree);
        }
      }
    } catch (error) {
      // A repository git can no longer read is not a reason to open no
      // terminals at all; the others are still worth listing.
      failed += 1;
      log(`worktrees: could not list from ${from}: ${String(error)}`);
    }
  }

  return { worktrees: [...byRoot.values()], failed, asked };
}

/** Where a terminal is working, as far as can be told without resolving it. */
function terminalCwd(terminal: vscode.Terminal): string | undefined {
  const fromShell = terminal.shellIntegration?.cwd;
  if (fromShell) {
    return fromShell.fsPath;
  }
  const created = terminal.creationOptions as vscode.TerminalOptions;
  const cwd = created?.cwd;
  return typeof cwd === 'string' ? cwd : cwd?.fsPath;
}

/**
 * Worktrees that already have a terminal in them.
 *
 * Reads the tracker *and* the raw terminal list. The tracker is the better
 * source -- it is what resolves the case where an agent moved itself and left
 * the shell behind -- but it is populated asynchronously, and this runs during
 * activation while that is still in flight. On its own it reports an empty
 * window and every worktree gets a second terminal on every reload.
 *
 * A terminal deeper inside a worktree still occupies it, and the deepest
 * containing worktree wins, so a terminal in a nested worktree does not count
 * as occupying its parent. That is the same rule `SessionTracker` uses to pick
 * a repository, for the same reason.
 */
async function occupied(
  tracker: SessionTracker,
  worktrees: WorktreeInfo[]
): Promise<Set<string>> {
  const paths = [
    ...tracker.allSessions.map(session => session.root).filter((root): root is string => !!root),
    ...vscode.window.terminals.map(terminalCwd).filter((cwd): cwd is string => !!cwd)
  ];

  const taken = new Set<string>();
  for (const raw of paths) {
    const where = await canonical(raw);
    let deepest: WorktreeInfo | undefined;
    for (const worktree of worktrees) {
      if (isInside(worktree.root, where)) {
        if (!deepest || worktree.root.length > deepest.root.length) {
          deepest = worktree;
        }
      }
    }
    if (deepest) {
      taken.add(deepest.root);
    }
  }
  return taken;
}

/**
 * Runs of this pass, one at a time.
 *
 * A terminal created here is not occupancy anyone can see until `syncAll`
 * resolves it, so two overlapping passes both compute the same missing set and
 * both open it. Pressing the title-bar button twice, or pressing it while the
 * startup pass is still in flight, is enough to do that.
 */
let queue: Promise<unknown> = Promise.resolve();

function serialise<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

/**
 * Open a terminal in every linked worktree that does not already have one.
 *
 * The main checkout is never included. It is the thing that is already open,
 * so a terminal in it is one keystroke away and never a discovery problem;
 * including it would put an unasked-for terminal in every ordinary
 * single-checkout repository, which is most of them. `showMainCheckout` is
 * deliberately not consulted either -- it governs what the Sessions list
 * *shows*, not what gets opened.
 *
 * Terminals are created but not shown. Calling `show()` on each would steal
 * focus once per worktree and leave whichever came last in front; the point is
 * that the sessions exist and are listed, not that any one is in front.
 *
 * `cap` holds the pass back when that many terminals would be created, and
 * reports the number in `heldBack` rather than opening any of them.
 */
export function openWorktreeTerminals(
  gitApi: GitAPI,
  tracker: SessionTracker,
  cap?: number
): Promise<OpenResult> {
  return serialise(async () => {
    const { worktrees, failed, asked } = await discoverWorktrees(gitApi);
    const linked = worktrees.filter(worktree => !worktree.main);
    const result: OpenResult = {
      opened: 0,
      worktrees: linked.length,
      heldBack: 0,
      unreadable: asked > 0 && failed === asked
    };
    if (!linked.length) {
      return result;
    }

    // Give the tracker a chance to resolve the terminals that already exist
    // before deciding which worktrees are empty. Without this the set is read
    // while it is still filling and a restored window duplicates every
    // terminal it restored.
    await tracker.syncAll();

    const taken = await occupied(tracker, worktrees);
    const missing = linked.filter(worktree => !taken.has(worktree.root));
    if (!missing.length) {
      return result;
    }

    if (cap !== undefined && missing.length > cap) {
      result.heldBack = missing.length;
      log(`worktrees: ${missing.length} terminals to open, above the cap of ${cap}; opening none`);
      return result;
    }

    for (const worktree of missing) {
      vscode.window.createTerminal({
        name: path.basename(worktree.root),
        cwd: worktree.root,
        iconPath: new vscode.ThemeIcon('robot')
      });
      log(`worktrees: opened a terminal in ${worktree.root}`);
    }
    result.opened = missing.length;

    // A terminal created here is not tracked until something resolves its cwd,
    // and nothing else will until it is focused.
    await tracker.syncAll();
    return result;
  });
}

/**
 * Asked at most once per window.
 *
 * The startup pass runs again whenever git registers another repository, and a
 * held-back count does not change on its own, so without this the same
 * question arrives repeatedly with the same answer available.
 */
let capOffered = false;

/**
 * The startup pass.
 *
 * Separate from `openWorktreeTerminals` because only the automatic path has a
 * cap: running the command is an explicit request for however many there are,
 * whereas opening the window is not.
 */
export async function openWorktreeTerminalsOnStartup(
  gitApi: GitAPI,
  tracker: SessionTracker
): Promise<void> {
  const config = vscode.workspace.getConfiguration('parallelo');
  if (!config.get<boolean>('openWorktreeTerminals', true)) {
    return;
  }

  const result = await openWorktreeTerminals(gitApi, tracker, AUTO_OPEN_CAP);
  if (!result.heldBack || capOffered) {
    return;
  }

  capOffered = true;
  const answer = await vscode.window.showInformationMessage(
    `${result.heldBack} worktrees here have no terminal. Parallelo did not open that many on its own.`,
    'Open Them Anyway'
  );
  if (answer) {
    await openWorktreeTerminals(gitApi, tracker);
  }
}
