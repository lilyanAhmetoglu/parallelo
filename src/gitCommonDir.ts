import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { log } from './log';

const run = promisify(execFile);

/** Worktree root -> the git directory shared by every worktree of its repo. */
const cache = new Map<string, string>();

/**
 * The `.git` directory shared by every worktree of this repository.
 *
 * This is what says two worktrees belong to the same project. A linked
 * worktree's own `.git` is a file pointing into `<main>/.git/worktrees/<name>`,
 * which is per-worktree; the common directory above it is where `refs/stash`
 * and the object store actually live.
 *
 * Cached per root, so this does not respawn git on every session change --
 * both callers run on `onDidChangeSessions`, which fires on every git state
 * change of every tracked repository.
 */
export async function commonDirFor(root: string): Promise<string | undefined> {
  const cached = cache.get(root);
  if (cached) {
    return cached;
  }

  // A remembered failure. Almost always the worktree being deleted while its
  // session was still listed, so it is worth keeping while the directory is
  // gone -- but only until something is back at that path. This cache outlives
  // every consumer, so a failure held for good would make a worktree recreated
  // under the same name invisible to the radar and the stash guard for the
  // rest of the window, with nothing saying why.
  if (cached === '' && !(await exists(root))) {
    return undefined;
  }

  try {
    const { stdout } = await run('git', ['rev-parse', '--git-common-dir'], { cwd: root });
    // Prints `.git` in a main checkout and an absolute path in a worktree.
    const common = path.resolve(root, stdout.trim());
    cache.set(root, common);
    return common;
  } catch (error) {
    if (cached !== '') {
      log(`git: no common git dir for ${root} -- ${error}`);
    }
    cache.set(root, '');
    return undefined;
  }
}

async function exists(dir: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(dir));
    return true;
  } catch {
    return false;
  }
}
