import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { log } from './log';

const run = promisify(execFile);

/** Worktree root -> the git directory shared by every worktree of its repo. */
const cache = new Map<string, string>();

/** Worktree root -> when asking last failed. See the note on retries below. */
const failures = new Map<string, number>();

/**
 * How long a failure is believed before git is asked again.
 *
 * Long enough that a path which is simply broken does not spawn a process on
 * every git event, short enough that a worktree deleted and recreated under
 * the same name comes back on its own rather than staying invisible for the
 * rest of the window.
 */
const RETRY_MS = 30_000;

/**
 * The `.git` directory shared by every worktree of this repository.
 *
 * This is what says two worktrees belong to the same project. A linked
 * worktree's own `.git` is a file pointing into `<main>/.git/worktrees/<name>`,
 * which is per-worktree; the common directory above it is where `refs/stash`
 * and the object store actually live.
 *
 * Cached per root, successes for good and failures for `RETRY_MS`. Both
 * callers run on `onDidChangeSessions`, which fires on every git state change
 * of every tracked repository -- so a failure that was retried every time
 * would be a process spawn per session per keystroke-worth of git activity,
 * and one that was never retried would outlive the thing that caused it.
 */
export async function commonDirFor(root: string): Promise<string | undefined> {
  const known = cache.get(root);
  if (known) {
    return known;
  }

  const failedAt = failures.get(root);
  const firstFailure = failedAt === undefined;
  if (!firstFailure && Date.now() - failedAt < RETRY_MS) {
    return undefined;
  }

  try {
    const { stdout } = await run('git', ['rev-parse', '--git-common-dir'], { cwd: root });
    // Prints `.git` in a main checkout and an absolute path in a worktree.
    const common = path.resolve(root, stdout.trim());
    cache.set(root, common);
    failures.delete(root);
    return common;
  } catch (error) {
    // Only the first one. After that this is a known-bad path being retried on
    // a timer, and saying so every half minute is noise in the one channel
    // used to work out why something stayed quiet.
    if (firstFailure) {
      log(`git: no common git dir for ${root} -- ${error}`);
    }
    failures.set(root, Date.now());
    return undefined;
  }
}
