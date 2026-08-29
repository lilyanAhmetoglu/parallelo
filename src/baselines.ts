import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Repository } from './git';
import type { Session } from './sessionTracker';
import { log } from './log';

const run = promisify(execFile);

/**
 * Storage key, versioned.
 *
 * Stamps written by the first version recorded HEAD at the moment a worktree
 * was first seen, which put existing work behind the mark and showed nothing.
 * They were computed by a rule that no longer applies and there is no way to
 * tell a good one from a bad one after the fact, so the key moved and they are
 * left where they lie -- a stamp is re-derived from the branch point on sight,
 * which costs one `merge-base`.
 */
const KEY = 'parallelo.baselines.v3';

/**
 * How many commits the group lists before it starts counting instead.
 *
 * A session that has been running all day is the one this feature is for, and
 * a thousand rows is not an answer to "what did it do".
 */
const MAX_COMMITS = 100;


/** Field separator inside one `git log` record. Never occurs in a subject. */
const FIELD = '\x1f';

/**
 * An explicit "start again from here", and nothing else.
 *
 * Derived answers are never stored. Storing them is what let a wrong reading
 * survive restarts, and three fixes, in a repository that had long since been
 * re-derived correctly everywhere else.
 */
interface Baseline {
  /** Commits made before this are not this session's any more. */
  at: number;
}

/** One file touched by a commit. */
export interface BaselineFile {
  /** Path relative to the worktree root, as it is now. */
  path: string;
  /**
   * Where a renamed or copied file came from.
   *
   * Both halves matter. The new path is what the row shows and what exists on
   * disk; the old one is what the diff has to be taken against, and what
   * another session editing that file still calls it.
   */
  from?: string;
  uri: vscode.Uri;
  /** git's own status letter: M, A, D, R or C. */
  letter: string;
}

/** One commit the session has made since it started. */
export interface BaselineCommit {
  sha: string;
  /** First line of the message -- what the row is labelled with. */
  subject: string;
  author: string;
  /** Author date, milliseconds since the epoch. */
  at: number;
  /**
   * First parent, absent for the repository's very first commit.
   *
   * The diff for a file in this commit runs from here, so a commit with no
   * parent has nothing on the left and opens the file as it was written.
   */
  parent?: string;
  /** More than one parent, so this commit authored nothing of its own. */
  merge: boolean;
}

export interface BaselineState {
  /** When the baseline was last reset, or 0 if it never has been. */
  at: number;
  /**
   * HEAD when this reading was taken.
   *
   * The whole reading is a function of HEAD, so it stays valid until HEAD
   * moves -- editing a file cannot change which commits exist. That is what
   * keeps a terminal switch from spawning a git process per worktree.
   */
  head: string;
  /** Newest first, the way `git log` reads. */
  commits: BaselineCommit[];
  /**
   * Every path those commits touched, old names of renames included.
   *
   * For the conflict radar, which wants one flat set per session and has no
   * use for which commit a file was in. Merge commits are left out: a merge
   * authors nothing, and counting the several hundred files a `git merge main`
   * carries would flag every worktree against every other one.
   */
  files: Set<string>;
  /**
   * Whether there are older commits than the ones listed.
   *
   * A flag and not a count. The count would have to be a second `git
   * rev-list`, and "there are more" is the whole of what a row can usefully
   * say -- the first version claimed a number that `--max-count` made
   * structurally incapable of ever exceeding one.
   */
  more: boolean;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 50 * 1024 * 1024 });
  return stdout;
}











/**
 * Files one commit touched, as git recorded them.
 *
 * `diff-tree` rather than `git show`, because it takes the same
 * `--name-status -z` shape as everything else here and says nothing about the
 * message, which has already been read.
 *
 * `-z`: paths are NUL-separated and never quoted, so a filename with a space,
 * a quote or a newline in it parses the same as any other.
 *
 * A merge still comes back empty, which is correct and is why merge rows do
 * not open: its files belong to the commits on the branch it merged.
 */
async function filesIn(root: string, sha: string): Promise<BaselineFile[]> {
  const out = await git(root, [
    'diff-tree',
    // A commit with no parent has nothing to be compared against, and without
    // this `diff-tree` prints nothing at all for one -- so the first commit of
    // a repository listed every file it created as no files. It is reachable
    // whenever the mark is the beginning of history.
    '--root',
    '--no-commit-id',
    '--name-status',
    '-r',
    // Rename detection. `diff-tree` is plumbing and does not honour
    // `diff.renames`, so without this a rename arrives as a delete and an add
    // -- which reads as twice the work and loses the link between the two.
    '-M',
    '-z',
    sha
  ]);
  const parts = out.split('\0');
  const files: BaselineFile[] = [];
  let i = 0;
  while (i < parts.length) {
    const code = parts[i++];
    if (!code) {
      continue;
    }
    const letter = code[0];
    // A rename or a copy records two paths, old then new, and both are kept.
    let from: string | undefined;
    let relative: string;
    if (letter === 'R' || letter === 'C') {
      from = parts[i++];
      relative = parts[i++];
    } else {
      relative = parts[i++];
    }
    if (relative) {
      files.push({
        path: relative,
        from,
        uri: vscode.Uri.file(path.join(root, relative)),
        letter
      });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Commits made in this worktree since `sha`, newest first.
 *
 * `<sha>..HEAD` is what has landed here since the session started. A `git
 * pull` puts other people's commits in that range too -- they did arrive here
 * -- which reads correctly once every commit carries its own message, and is
 * why they are kept out of the radar's set rather than out of the list.
 *
 * One `git log` for the messages, then one `diff-tree` per commit. The
 * alternative -- `log --name-status -z` in a single call -- interleaves the
 * format string with NUL-separated file records and has to be parsed by
 * guessing where one ends, which is not worth saving a process per commit on a
 * list this short.
 */
/**
 * How far back through a worktree's log to look for its commits.
 *
 * Only entries still reachable from HEAD are kept, and the reachability check
 * is one `rev-list` of this depth. A session that has made a commit more than
 * this many commits ago has had `main` merged into it repeatedly; the recent
 * ones are the answer to "what is this agent doing".
 */
const REACHABLE_DEPTH = 2000;

/**
 * Every commit made *in this worktree*, newest first.
 *
 * This is the whole feature, and it is read rather than inferred. `git log -g`
 * walks the worktree's own HEAD reflog, and each entry says what changed HEAD:
 * `commit:` for a commit made here, `pull:` / `merge:` / `checkout:` /
 * `reset:` for everything else. Keeping only the `commit:` entries gives
 * exactly the commits this session authored -- which is what was asked for,
 * and what three attempts at deriving it from branch shape failed to produce.
 *
 * Two things fall out for free. A merge that arrived by `git pull` is a
 * `pull:` entry, so **merge commits never appear**: the rows are the commit
 * messages somebody wrote, not "Merge pull request #221". And a stale
 * integration branch cannot drag in work this worktree never did, because the
 * log only knows what happened here.
 *
 * `commit (merge):` is excluded too -- a merge made in this worktree is still
 * a merge, and its contents are the commits it carried, which are listed on
 * their own if they were made here.
 *
 * Reflog entries survive their commits: an amend or a reset leaves the old sha
 * behind, so entries are kept only if they are still reachable from HEAD.
 * `since` drops everything committed before an explicit baseline reset.
 */
async function commitsMadeHere(
  root: string,
  since: number | undefined
): Promise<{ commits: BaselineCommit[]; more: boolean }> {
  const format = ['%H', '%gs', '%gd', '%s', '%an', '%at', '%P'].join(FIELD);
  // `--date=unix` turns `%gd` into `HEAD@{1788026990}` -- when the entry was
  // written, which is when the commit happened *here*. That is the clock a
  // baseline reset has to be compared against: a commit's own author date can
  // predate the worktree by days after a rebase or a cherry-pick.
  const out = await git(root, ['log', '-g', '--date=unix', `--format=${format}`, 'HEAD']);

  const seen = new Set<string>();
  const candidates: BaselineCommit[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const [sha, action, entry, subject, author, at, parents] = line.split(FIELD);
    // `commit:` and `commit (initial):`, but never `commit (merge):`.
    if (!action?.startsWith('commit') || action.startsWith('commit (merge)')) {
      continue;
    }
    if (!sha || seen.has(sha)) {
      continue;
    }
    seen.add(sha);
    if (since !== undefined) {
      const happened = Number(entry?.replace(/\D/g, '')) * 1000;
      // Reflog times are whole seconds and the reset is a millisecond clock,
      // so compare at the coarser of the two. Without this a commit made in
      // the same second as the reset is dropped, which reads as the reset
      // having eaten it.
      if (happened && happened < Math.floor(since / 1000) * 1000) {
        continue;
      }
    }
    const when = Number(at) * 1000;
    const parented = parents ? parents.split(' ').filter(Boolean) : [];
    candidates.push({
      sha,
      subject: subject || '(no message)',
      author,
      at: when,
      parent: parented[0],
      merge: parented.length > 1
    });
  }

  if (!candidates.length) {
    return { commits: [], more: false };
  }

  const reachable = new Set(
    (await git(root, ['rev-list', `--max-count=${REACHABLE_DEPTH}`, 'HEAD']))
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
  );
  const live = candidates.filter(commit => reachable.has(commit.sha));

  return { commits: live.slice(0, MAX_COMMITS), more: live.length > MAX_COMMITS };
}

/** Every path a known list of commits touched, in one command. */
async function pathsIn(root: string, commits: BaselineCommit[]): Promise<Set<string>> {
  const files = new Set<string>();
  if (!commits.length) {
    return files;
  }
  const out = await git(root, [
    'log',
    // The shas are given explicitly, so walk none of their ancestors.
    '--no-walk=unsorted',
    '--no-renames',
    '--format=',
    '--name-only',
    '-z',
    ...commits.map(commit => commit.sha)
  ]);
  for (const entry of out.split('\0')) {
    const trimmed = entry.trim();
    if (trimmed) {
      files.add(trimmed);
    }
  }
  return files;
}


/**
 * What a session has committed since it started.
 *
 * The Changes view shows uncommitted work only, so an agent that has been
 * running for twenty minutes and committed three times looks idle: its output
 * left the view the moment it was committed. This stamps the commit each
 * worktree was on when it was first seen and reads the commits made since,
 * each with the files it touched.
 *
 * Commits, not a flat list of everything changed since the stamp. The first
 * attempt was that flat list and it read as a confusing near-duplicate of the
 * groups above it -- the same files again, in a different order, under a
 * heading that did not say why. Grouping by commit says what the agent did,
 * and leaves uncommitted work in the one place it was already shown.
 *
 * Keyed by worktree path for the same reason `SessionStyles` is: terminals do
 * not survive a window reload and the worktree is the thing anyone actually
 * means by "the session".
 */
export class Baselines implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  /**
   * Last reading per worktree, so a repaint is not a git call.
   *
   * Kept until HEAD moves rather than dropped on every event: the Changes view
   * asks on every redraw and the conflict radar asks for every session on
   * every scan, and both of those run on terminal switches, where nothing that
   * could change a commit list has happened.
   */
  private cache = new Map<string, BaselineState>();
  private inFlight = new Map<string, Promise<BaselineState | undefined>>();

  /**
   * Files per commit, fetched when a commit row is opened.
   *
   * Never invalidated, and safe: a commit is immutable, so the answer for a
   * given sha cannot change. Reading them all up front was a `diff-tree` per
   * commit for every worktree at once, all of it thrown away unopened.
   */
  private commitFiles = new Map<string, BaselineFile[]>();
  private commitFilesInFlight = new Map<string, Promise<BaselineFile[]>>();



  /**
   * Bumped by `invalidate`, so a read that started before it cannot write its
   * result afterwards. Without it, a `git log` in flight when the stamp is
   * reset caches a reading of the old baseline and nothing asks again.
   */
  private generation = 0;

  /**
   * Serialises writes to the memento.
   *
   * Every write is read-modify-write over one record holding every worktree.
   * `ensure` is called for all sessions at once, and `prune` reads, awaits a
   * `stat` per key, then writes back -- so without this a stamp recorded
   * during another operation's await is silently discarded by it.
   */
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly memento: vscode.Memento) {}

  dispose(): void {
    this._onDidChange.dispose();
  }

  private queue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writing.then(work, work);
    // The stored link must never stay rejected: a chain that rejects once
    // skips every later `then`, so one failed write would end all of them.
    this.writing = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  /**
   * Identity for a session's baseline.
   *
   * The same rule `SessionStyles.keyFor` uses, and for the same reason: the
   * git extension registers repositories asynchronously, so keying on
   * `repository` writes under one key and reads back under another for the
   * first moments after a reload.
   */
  keyFor(session: Session): string {
    return session.root ?? session.cwd.fsPath;
  }

  private all(): Record<string, Baseline> {
    return this.memento.get<Record<string, Baseline>>(KEY, {});
  }

  get(session: Session): Baseline | undefined {
    return this.all()[this.keyFor(session)];
  }

  /**
   * Whether to read baselines at all.
   *
   * Only reading is gated. Stamping carries on either way, so turning this
   * back on measures from where the session actually started rather than from
   * whenever the setting changed -- which would quietly be a different feature.
   */
  private enabled(): boolean {
    return vscode.workspace
      .getConfiguration('parallelo')
      .get<boolean>('sessionBaseline', true);
  }

  /** Drops every reading. The stamps themselves are untouched. */
  invalidate(): void {
    this.generation += 1;
    this.cache.clear();
    // In-flight reads too. They are keyed by worktree alone, so a read that
    // started before a reset would be handed to the caller that asked after
    // it: the generation guard keeps the stale answer out of the cache, but
    // the view still draws it and nothing asks again.
    this.inFlight.clear();
  }

  /**
   * The current reading, or nothing while one is being taken.
   *
   * Synchronous on purpose. The Changes view draws merge, staged and unstaged
   * groups from data the git extension already holds, and making the whole
   * view `await` this put those groups behind a git subprocess -- on every
   * commit an agent made, which is the moment the view matters most. Now a
   * miss returns nothing, starts the read, and `onDidChange` brings the view
   * back when there is something to add.
   */
  snapshot(session: Session): BaselineState | undefined {
    const head = session.repository?.state.HEAD?.commit;
    if (!head) {
      return undefined;
    }
    const cached = this.cache.get(this.keyFor(session));
    if (cached?.head === head) {
      return cached;
    }
    void this.read(session).then(state => {
      if (state) {
        this._onDidChange.fire();
      }
    });
    return undefined;
  }

  /**
   * The files one commit changed, cached forever.
   *
   * With `-M`, so a rename reads as one row that says where the file came
   * from rather than as an unrelated delete and add.
   */
  async filesIn(root: string, sha: string): Promise<BaselineFile[]> {
    const cached = this.commitFiles.get(sha);
    if (cached) {
      return cached;
    }
    const running = this.commitFilesInFlight.get(sha);
    if (running) {
      return running;
    }
    const work = filesIn(root, sha)
      .then(files => {
        this.commitFiles.set(sha, files);
        return files;
      })
      .catch(error => {
        log(`baseline: could not read the files in ${sha.slice(0, 8)}: ${String(error)}`);
        return [] as BaselineFile[];
      })
      .finally(() => this.commitFilesInFlight.delete(sha));
    this.commitFilesInFlight.set(sha, work);
    return work;
  }

  /**
   * Kept as a no-op: there is nothing to stamp any more.
   *
   * Every earlier version recorded where it thought a session began and read
   * that record back afterwards. That is what made the bug survive three
   * fixes -- a wrong answer written to disk is restored on every reload, so
   * the view stayed wrong in a repository long after the rule that produced
   * it was gone. A session's commits are now derived from the worktree's own
   * log on every reading, and the only thing stored is an explicit reset.
   */
  async ensure(_session: Session): Promise<void> {
    return;
  }

  /**
   * Re-arm the baseline at the session's current commit.
   *
   * HEAD here, not `startingPoint`. This is somebody saying "I have reviewed
   * that, start again from where we are", which is a different question from
   * "where did this branch begin".
   */
  async reset(session: Session): Promise<boolean> {
    if (!session.repository?.state.HEAD?.commit) {
      return false;
    }
    const key = this.keyFor(session);
    const at = Date.now();
    await this.queue(async () => {
      await this.memento.update(KEY, { ...this.all(), [key]: { at } });
    });
    this.invalidate();
    log(`baseline: ${key} re-armed, hiding commits made before now`);
    this._onDidChange.fire();
    return true;
  }

  /** Forget worktrees that are no longer on disk. */
  async prune(): Promise<void> {
    const gone: string[] = [];
    await Promise.all(
      Object.keys(this.all()).map(async key => {
        try {
          await vscode.workspace.fs.stat(vscode.Uri.file(key));
        } catch {
          gone.push(key);
        }
      })
    );
    if (!gone.length) {
      return;
    }
    await this.queue(async () => {
      // Read again after the stats. The snapshot taken before them is stale by
      // now -- activation is stamping sessions the whole time this runs -- and
      // writing it back would drop the stamps recorded during the wait.
      const all = { ...this.all() };
      gone.forEach(key => {
        delete all[key];
        this.cache.delete(key);
      });
      await this.memento.update(KEY, all);
    });
    this._onDidChange.fire();
  }

  /**
   * What this session has committed since its baseline.
   *
   * Reads through the cache, which stays good until HEAD moves, and shares one
   * in-flight read per worktree so a burst of repaints does not become a burst
   * of `git log`.
   */
  async read(session: Session): Promise<BaselineState | undefined> {
    const repository = session.repository;
    if (!repository || !this.enabled()) {
      return undefined;
    }
    const head = repository.state.HEAD?.commit;
    if (!head) {
      return undefined;
    }

    const key = this.keyFor(session);
    const cached = this.cache.get(key);
    if (cached?.head === head) {
      return cached;
    }
    if (cached) {
      this.cache.delete(key);
    }

    const running = this.inFlight.get(key);
    if (running) {
      return running;
    }

    if (session.linked !== true) {
      // The main checkout is not a session. Its log reaches back to the
      // repository's first commit, and every rule that tried to carve a
      // session out of it produced commits nobody in the window wrote.
      return undefined;
    }

    const generation = this.generation;
    const work = this.readNow(key, repository, head, generation)
      .catch(error => {
        log(`baseline: could not read ${key}: ${String(error)}`);
        return undefined;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, work);
    return work;
  }

  private async readNow(
    key: string,
    repository: Repository,
    head: string,
    generation: number
  ): Promise<BaselineState | undefined> {
    const root = repository.rootUri.fsPath;
    // The only thing ever stored is an explicit reset: "I have reviewed that,
    // start again from here". Everything else is derived on the spot, because
    // a derived answer saved to disk is a wrong answer waiting to be restored
    // -- which is exactly what survived three fixes.
    const reset = this.all()[key];
    const { commits, more } = await commitsMadeHere(root, reset?.at);
    const files = await pathsIn(root, commits);
    const state: BaselineState = {
      at: reset?.at ?? 0,
      head,
      commits,
      files,
      more
    };
    if (generation === this.generation) {
      this.cache.set(key, state);
    }
    return state;
  }

}
