import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { SessionTracker } from './sessionTracker';

const run = promisify(execFile);

/** `WIP on session/test-a: 1a2b3c4 subject`, or `On session/test-a: ...`. */
const REFLOG_BRANCH = /^(?:WIP on|On) ([^:]+):/;

/**
 * The branch a reflog line was stashed from.
 *
 * Lines read `<old> <new> <who> <when>\tWIP on session/test-a: 1a2b3c4 subject`,
 * so the message is whatever follows the tab.
 */
function branchOf(line: string | undefined): string | undefined {
  const message = line?.split('\t')[1];
  return message ? REFLOG_BRANCH.exec(message)?.[1] : undefined;
}

/**
 * Warns when the stash is used while more than one worktree has a session.
 *
 * `refs/stash` lives in the common git directory, so every worktree of a
 * repository pushes onto the same stack. Two agents stashing concurrently will
 * pop each other's work, and neither git nor VS Code says a word about it.
 *
 * This is a warning and nothing more. The extension never offers a stash
 * feature -- see the non-goals in docs/ROADMAP.md.
 */
export class StashGuard implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  /** Worktree root -> the common git dir shared by every worktree of its repo. */
  private readonly commonDirs = new Map<string, string>();
  private readonly watchers = new Map<string, vscode.FileSystemWatcher>();
  /** One warning per repository per window, as promised. */
  private readonly warned = new Set<string>();
  /** Reflog length when we last looked, so a push reads differently to a pop. */
  private readonly depth = new Map<string, number>();
  private checking = false;

  constructor(private readonly tracker: SessionTracker) {
    this.disposables.push(
      // Fires on terminal changes *and* on any git state change in a tracked
      // repository, which is what a stash push or pop produces. This is the
      // signal the guard actually relies on; the watcher below is a bonus.
      tracker.onDidChangeSessions(() => void this.check()),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('parallelo.stashGuard')) {
          void this.check();
        }
      })
    );
    void this.check();
  }

  private enabled(): boolean {
    return vscode.workspace
      .getConfiguration('parallelo')
      .get<boolean>('stashGuard', true);
  }

  /** Re-reads every stash stack that has a session on it. */
  private async check(): Promise<void> {
    if (this.checking || !this.enabled()) {
      return;
    }
    this.checking = true;
    try {
      // How many worktrees sit on each stack. Counting worktrees rather than
      // terminals: two terminals in one worktree are a plain git race, not the
      // cross-worktree hazard this warns about.
      const worktrees = new Map<string, number>();
      const roots = new Set(
        this.tracker.allSessions
          .map(session => session.repository?.rootUri.fsPath)
          .filter((root): root is string => Boolean(root))
      );
      for (const root of roots) {
        const common = await this.commonDirFor(root);
        if (common) {
          worktrees.set(common, (worktrees.get(common) ?? 0) + 1);
        }
      }

      for (const [common, sharing] of worktrees) {
        this.watch(common);
        await this.inspect(common, sharing);
      }
    } finally {
      this.checking = false;
    }
  }

  /**
   * The `.git` directory shared by every worktree of this repository.
   *
   * A linked worktree's own `.git` is a file pointing into
   * `<main>/.git/worktrees/<name>`, and `refs/stash` is not in there -- it is
   * up in the common directory, which is the whole reason the stack is shared.
   */
  private async commonDirFor(root: string): Promise<string | undefined> {
    const cached = this.commonDirs.get(root);
    if (cached !== undefined) {
      return cached || undefined;
    }
    try {
      const { stdout } = await run('git', ['rev-parse', '--git-common-dir'], { cwd: root });
      // Prints `.git` in a main checkout and an absolute path in a worktree.
      const common = path.resolve(root, stdout.trim());
      this.commonDirs.set(root, common);
      return common;
    } catch {
      // Not a repository any more, or git is missing. Remember the failure so
      // this does not respawn git on every session change.
      this.commonDirs.set(root, '');
      return undefined;
    }
  }

  /**
   * Watches `refs/stash` directly, as a second trigger.
   *
   * Git state changes already drive `check`, so this only sharpens the timing
   * and catches a push and pop that would otherwise cancel out between two
   * readings. The base is the `refs` folder and the pattern a plain filename,
   * because that is the one shape the API documents for a folder outside the
   * workspace -- a multi-segment pattern is ambiguous about whether it watches
   * recursively, and a recursive watch here would cover `.git/objects`.
   */
  private watch(common: string): void {
    if (this.watchers.has(common)) {
      return;
    }
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(path.join(common, 'refs')), 'stash'),
      false,
      false,
      // A pop that empties the stack deletes the ref, and `check` reads the
      // reflog on the next git state change anyway.
      true
    );
    const onEvent = () => void this.check();
    watcher.onDidCreate(onEvent);
    watcher.onDidChange(onEvent);

    this.watchers.set(common, watcher);
    this.disposables.push(watcher);
  }

  private async inspect(common: string, sharing: number): Promise<void> {
    const entries = await this.reflog(common);
    const before = this.depth.get(common);

    // Record the depth before deciding whether to warn. Skipping this when we
    // stay quiet would leave a stale reading behind, and the next pop would be
    // measured against it, read as a push, and name the wrong branch.
    this.depth.set(common, entries.length);

    // First look at this repository: nothing to compare against yet, and a
    // stash that was already sitting there is not news.
    if (before === undefined || entries.length === before) {
      return;
    }
    if (this.warned.has(common) || sharing < 2) {
      return;
    }

    // On a pop git removes the reflog entry, so the branch named in the last
    // remaining line belongs to somebody else. Only attribute a push.
    const pushed = entries.length > before;
    const branch = pushed ? branchOf(entries[entries.length - 1]) : undefined;
    const what = pushed
      ? branch
        ? `A stash was pushed from ${branch}.`
        : 'A stash was pushed.'
      : 'A stash was applied or dropped.';

    this.warned.add(common);
    vscode.window.showWarningMessage(
      `${what} The stash is shared across every worktree of this repository, and ` +
        `${sharing} of them have a live session. One can pop what another stashed. ` +
        'Have agents commit to their session branch instead.'
    );
  }

  /** Lines of `logs/refs/stash`, oldest first. Absent reflog reads as empty. */
  private async reflog(common: string): Promise<string[]> {
    try {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.file(path.join(common, 'logs', 'refs', 'stash'))
      );
      return Buffer.from(bytes).toString('utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this.watchers.clear();
  }
}
