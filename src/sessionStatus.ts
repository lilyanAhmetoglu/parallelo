import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { log } from './log';

const run = promisify(execFile);

/** The file each worktree's agent writes, inside the git directory. */
const FILE = 'parallelo-status';

/**
 * What a session is waiting for you to do, if anything.
 *
 * `waiting` -- it asked something and has stopped until you answer.
 * `done` -- it finished its turn.
 */
export type Mark = 'waiting' | 'done';

/**
 * The words an agent may write, and what they mean here.
 *
 * More than one spelling per state on purpose: this file is written by a shell
 * one-liner in somebody else's config, and a hook that writes `idle` instead of
 * `done` should light the row rather than be silently ignored.
 */
const WORDS: Record<string, Mark> = {
  waiting: 'waiting',
  question: 'waiting',
  input: 'waiting',
  attention: 'waiting',
  blocked: 'waiting',
  done: 'done',
  finished: 'done',
  stop: 'done',
  idle: 'done'
};

/**
 * Where a worktree's status file lives: inside its own git directory.
 *
 * Not in the worktree itself. A file at the root would show up in `git status`,
 * in the Changes view, and in the conflict radar -- the extension would be
 * making noise in the panel it exists to keep readable. The git directory is
 * already invisible to all three, is per worktree for a linked checkout, and is
 * somewhere a hook can find without being told: `git rev-parse --git-dir` from
 * the agent's own working directory names the same file.
 */
async function statusFile(root: string): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', ['rev-parse', '--absolute-git-dir'], { cwd: root });
    return path.join(stdout.trim(), FILE);
  } catch {
    return undefined;
  }
}

/** When the file was last written, or 0 when there is no file. */
async function modified(file: string): Promise<number> {
  try {
    return (await vscode.workspace.fs.stat(vscode.Uri.file(file))).mtime;
  } catch {
    return 0;
  }
}

function parse(contents: string): Mark | undefined {
  // The first line only, so `echo done` and a hook that writes a whole
  // sentence after it both work.
  const word = contents.split('\n')[0]?.trim().toLowerCase() ?? '';
  return WORDS[word];
}

/**
 * Which sessions want you, painted from a file their agent writes.
 *
 * This is the feature that was built from the process tree and removed, and the
 * reason it was removed still holds: from outside the process, an agent that
 * asked a question and an agent that finished its turn are identical -- both
 * alive, both holding the terminal, both using no CPU. `ps wchan` is empty on
 * macOS, `ps stat` reads `S+` for both, and there is no terminal-bell event in
 * the API. A dot driven by any of those lights on every idle agent and tells
 * you nothing.
 *
 * So the agent says so itself. It already knows which it is -- that is what its
 * own notification hooks are for -- and a hook is a command it runs, not a
 * private file we read: any agent that can run a command on an event can drive
 * this, which is what keeps the contract agent-agnostic.
 *
 * Per worktree, not per terminal. The file is found from a working directory,
 * and two terminals in one worktree share that directory; a second terminal
 * there sees the same mark, which is true -- something in that checkout wants
 * you.
 */
export class SessionStatus implements vscode.Disposable {
  private readonly marks = new Map<string, Mark>();
  /**
   * The last write already accounted for, as a modification time.
   *
   * Time, not contents. A hook writes the same four bytes every time it fires,
   * so "have I shown this already" cannot be answered by comparing what is in
   * the file: an agent that finishes twice in a row writes `done` twice, and
   * the second one would be read as the first one still sitting there. Only the
   * clock distinguishes them.
   *
   * It is also what keeps yesterday's tick off the row this morning. Whatever
   * is on disk when a watcher starts is recorded as seen, so a mark means
   * something an agent did while Parallelo was watching -- never a leftover
   * from a window that closed days ago.
   */
  private readonly seen = new Map<string, number>();
  private readonly watchers = new Map<string, vscode.Disposable[]>();
  private readonly files = new Map<string, string>();
  /** Roots whose watcher is being set up, so two passes do not both make one. */
  private readonly starting = new Set<string>();

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires when a mark appears, changes or clears. */
  readonly onDidChange = this._onDidChange.event;

  /**
   * Re-read every worktree being watched.
   *
   * The watcher is the fast path, not the only one. The status file lives
   * inside `.git`, which is inside the workspace, so VS Code serves it from the
   * workspace's own recursive watcher rather than one of ours -- and what that
   * watcher ignores is a setting (`files.watcherExclude`) plus whatever the
   * platform decides. A feature that shows nothing when it misses an event is
   * indistinguishable from a broken one, and this one has already been reported
   * as broken twice.
   *
   * So it is also read on the events the extension already receives: a terminal
   * change, a git state change in a tracked repository. An agent finishing a
   * turn almost always causes one, which makes the fallback land at roughly the
   * same moment as the event it is standing in for. One `stat` per open
   * worktree, no timer.
   */
  async refresh(): Promise<void> {
    await Promise.all([...this.watchers.keys()].map(root => this.read(root)));
  }

  /** What to show on this worktree's row, or nothing. */
  get(root: string | undefined): Mark | undefined {
    return root === undefined ? undefined : this.marks.get(root);
  }

  /**
   * Watch exactly the worktrees that have sessions in them.
   *
   * Called on every session change, so it must be cheap and idempotent: the
   * git directory is asked for once per worktree and the watcher is left alone
   * on every later pass.
   */
  async sync(roots: string[]): Promise<void> {
    const on = vscode.workspace
      .getConfiguration('parallelo')
      .get<boolean>('sessionStatus', true);
    if (!on) {
      this.stop();
      return;
    }
    const wanted = new Set(roots);
    // Stop watching a worktree nothing is open in any more -- but keep what it
    // was showing. This runs on every session change, including the ones where
    // a terminal's directory is momentarily unresolved, and a mark deleted
    // there is gone for good: the re-watch a moment later records whatever is
    // on disk as already seen. That is a tick vanishing when you press refresh,
    // with nothing in the log to say why.
    for (const [root, disposables] of this.watchers) {
      if (!wanted.has(root)) {
        disposables.forEach(d => d.dispose());
        this.watchers.delete(root);
      }
    }

    let changed = false;
    for (const root of wanted) {
      // `starting` as well as `watchers`: this is called on every session
      // change, fired and forgotten, and asking git for the directory takes
      // long enough that two passes overlap. Both would find no watcher, both
      // would make one, and the second `set` would drop the first beyond the
      // reach of `dispose` -- a leaked watcher per burst, and every write read
      // twice.
      if (this.watchers.has(root) || this.starting.has(root)) {
        continue;
      }
      this.starting.add(root);
      const file = await statusFile(root);
      this.starting.delete(root);
      if (!file || !wanted.has(root) || this.watchers.has(root)) {
        // Gone, or claimed while git was answering.
        continue;
      }
      this.files.set(root, file);
      // A pattern based at the git directory, which is outside the workspace
      // for a linked worktree and often outside it entirely. A watcher created
      // with an explicit base handles that; a plain glob would only ever see
      // files in an open folder.
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), FILE)
      );
      const reread = () => void this.read(root);
      this.watchers.set(root, [
        watcher,
        watcher.onDidCreate(reread),
        watcher.onDidChange(reread),
        watcher.onDidDelete(reread)
      ]);
      log(`status: watching ${file}`);
      // Whatever is already there was written before anyone was watching --
      // but only the first time this worktree is seen. Re-watching one we were
      // watching a moment ago must not re-read its file as history, or every
      // refresh would quietly retire the mark it is meant to be repainting.
      if (!this.seen.has(root)) {
        this.seen.set(root, await modified(file));
      }
    }
    if (changed) {
      this._onDidChange.fire();
    }
  }

  /** Re-read one worktree's file after it changed on disk. */
  private async read(root: string): Promise<void> {
    const file = this.files.get(root);
    if (!file) {
      return;
    }

    const when = await modified(file);
    const before = this.marks.get(root);
    let after: Mark | undefined;
    // Only a write newer than the last one accounted for. Everything older is
    // either already on the row or already looked at.
    if (when > (this.seen.get(root) ?? 0)) {
      let contents = '';
      try {
        contents = new TextDecoder().decode(
          await vscode.workspace.fs.readFile(vscode.Uri.file(file))
        );
      } catch {
        // Deleted between the stat and the read. Nothing to show.
      }
      after = parse(contents);
    } else {
      after = before;
    }

    if (after === before) {
      return;
    }
    if (after === undefined) {
      this.marks.delete(root);
    } else {
      this.marks.set(root, after);
    }
    this._onDidChange.fire();
  }

  /**
   * The user looked at this session, so its mark has done its job.
   *
   * The file is left alone rather than deleted. It belongs to whatever wrote
   * it, and an extension that quietly removes another program's file has to be
   * right about a great deal more than this one needs to be. What is recorded
   * is the moment, so the next thing the agent writes lights the row again even
   * when it writes the same word.
   */
  async acknowledge(root: string | undefined): Promise<void> {
    if (root === undefined || !this.marks.has(root)) {
      return;
    }
    const file = this.files.get(root);
    this.seen.set(root, file ? await modified(file) : Date.now());
    this.marks.delete(root);
    this._onDidChange.fire();
  }

  /**
   * Turned off: stop watching and take every mark off the rows.
   *
   * The one place marks are thrown away wholesale, and it is deliberate --
   * somebody switching the feature off is asking for the rows to go back to
   * normal now, not at the next repaint.
   */
  private stop(): void {
    for (const disposables of this.watchers.values()) {
      disposables.forEach(d => d.dispose());
    }
    this.watchers.clear();
    this.files.clear();
    this.seen.clear();
    const painted = this.marks.size > 0;
    this.marks.clear();
    if (painted) {
      this._onDidChange.fire();
    }
  }

  dispose(): void {
    for (const disposables of this.watchers.values()) {
      disposables.forEach(d => d.dispose());
    }
    this.watchers.clear();
    this.starting.clear();
    this._onDidChange.dispose();
  }
}

/**
 * The shell a hook runs to mark a session.
 *
 * `git rev-parse` from the agent's own working directory, so one line works in
 * every repository and every worktree without being told where it is. Outside a
 * repository it writes nothing and says nothing.
 */
export function hookCommand(mark: Mark): string {
  return (
    `d=$(git rev-parse --absolute-git-dir 2>/dev/null) && ` +
    `printf '${mark}\\n' > "$d/${FILE}"`
  );
}

/** Whether a hook entry is one of ours, so setup is repeatable. */
export function isOurs(command: unknown): boolean {
  return typeof command === 'string' && command.includes(FILE);
}

export { FILE as STATUS_FILE };
