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
const KEY = 'parallelo.baselines.v2';

/**
 * How many commits the group lists before it starts counting instead.
 *
 * A session that has been running all day is the one this feature is for, and
 * a thousand rows is not an answer to "what did it do".
 */
const MAX_COMMITS = 100;

/** Field separator inside one `git log` record. Never occurs in a subject. */
const FIELD = '\x1f';

interface Baseline {
  /** Commit the worktree was on the first time this session was seen. */
  sha: string;
  /** When it was stamped, so the view can say what "since" means. */
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
  /** The stamped commit this reading is measured from. */
  sha: string;
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
  /**
   * Whether the stamped commit is no longer in the repository.
   *
   * A hard reset, a branch deleted and recreated, or a worktree removed and
   * remade under the same path all leave a sha nothing can be diffed against.
   * There is nothing to show and nothing wrong with the code, so it is a state
   * to report and offer a reset for, not an error.
   */
  missing: boolean;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 50 * 1024 * 1024 });
  return stdout;
}

/**
 * Whether a commit is still in this repository.
 *
 * `^{commit}` rather than a bare sha so a tag or a tree object cannot pass for
 * one, and `cat-file -e` because it says yes or no without printing anything.
 */
async function commitExists(root: string, sha: string): Promise<boolean> {
  try {
    await git(root, ['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Refs tried, in order, as the branch this session diverged from.
 *
 * `origin/HEAD` is the remote's default branch and is the right answer
 * whenever there is a remote. The two local names are for a repository that
 * has never had one, which is most test fixtures and some real work.
 *
 * The branch's own upstream is deliberately not consulted. It is unset on a
 * fresh session branch, and once the agent pushes it becomes that same branch
 * -- so the merge base would be HEAD and the whole list would empty out at the
 * moment the work was published.
 */
const INTEGRATION_REFS = ['refs/remotes/origin/HEAD', 'refs/heads/main', 'refs/heads/master'];

/**
 * Where this session's work began.
 *
 * Not HEAD. Stamping HEAD means a worktree that already has commits when it is
 * first seen starts with an empty range: the work is behind the mark, the
 * group shows nothing, and the feature looks broken at exactly the moment
 * somebody is trying it. That is not a rare case -- it is every worktree the
 * extension did not watch being created.
 *
 * So: the point where this branch left the integration branch. Not the branch
 * the main *worktree* is currently on, which was the first attempt and is
 * wrong in a way that is easy to miss -- anyone who checks out a feature
 * branch in their main checkout moves the origin of every session stamped
 * afterwards, and the range then fills with commits nobody in this window
 * wrote. Refs are shared by every worktree of a repository, so the branch can
 * be named from in here without going and finding its directory.
 *
 * Falls back to HEAD when none of the candidates exist, or when the histories
 * are unrelated, or when this session is the integration branch itself -- and
 * there the merge base is HEAD anyway.
 */
async function startingPoint(root: string): Promise<string | undefined> {
  let head: string;
  try {
    head = (await git(root, ['rev-parse', 'HEAD'])).trim();
  } catch {
    // No commits at all. There is nothing to measure from yet.
    return undefined;
  }

  for (const ref of INTEGRATION_REFS) {
    try {
      await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    } catch {
      continue;
    }
    try {
      const base = (await git(root, ['merge-base', 'HEAD', ref])).trim();
      if (base) {
        return base;
      }
    } catch {
      // Unrelated histories. Another candidate will not do better.
      break;
    }
  }
  return head;
}

/**
 * Every path this session's own commits touched, in one command.
 *
 * The radar needs a flat set and nothing else, so it does not pay for the
 * per-commit breakdown the tree shows. It used to: one `diff-tree` per commit,
 * a hundred of them at once, times a worktree each -- enough concurrent
 * processes to hit `EMFILE`, which arrived as baselines silently not working.
 *
 * `--no-renames` on purpose, the opposite of the tree's `-M`. Rename detection
 * would report only the new name, and the old one is exactly what another
 * session still calls the file it is editing -- the conflict most worth
 * catching. Without detection a rename arrives as a delete and an add, so both
 * names land in the set.
 *
 * `--no-merges` and `--first-parent` for the reasons in `commitsSince`: a
 * merge authors nothing, and the branch it carried is not this session's work.
 */
async function pathsTouched(root: string, sha: string): Promise<Set<string>> {
  const out = await git(root, [
    'log',
    '--first-parent',
    '--no-merges',
    '--no-renames',
    '--format=',
    '--name-only',
    '-z',
    `${sha}..HEAD`
  ]);
  const files = new Set<string>();
  for (const entry of out.split('\0')) {
    const trimmed = entry.trim();
    if (trimmed) {
      files.add(trimmed);
    }
  }
  return files;
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
 */
async function filesIn(root: string, sha: string): Promise<BaselineFile[]> {
  const out = await git(root, [
    'diff-tree',
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
async function commitsSince(
  root: string,
  sha: string
): Promise<{ commits: BaselineCommit[]; more: boolean }> {
  const format = ['%H', '%s', '%an', '%at', '%P'].join(FIELD);
  const out = await git(root, [
    'log',
    `--format=${format}`,
    // This branch's own line of development. Without it, merging `main` in
    // lists every commit that came with it as though the session had made
    // them, and puts their files into the radar's set -- flagging this
    // worktree against every other one that has touched any of them. With it,
    // the merge appears as the single commit it is.
    '--first-parent',
    // One more than the cap, purely to find out whether there are more.
    `--max-count=${MAX_COMMITS + 1}`,
    `${sha}..HEAD`
  ]);

  const lines = out.split('\n').filter(line => line.trim() !== '');
  const more = lines.length > MAX_COMMITS;

  const commits = lines.slice(0, MAX_COMMITS).map(line => {
    const [commit, subject, author, at, parents] = line.split(FIELD);
    const parented = parents ? parents.split(' ').filter(Boolean) : [];
    return {
      sha: commit,
      subject: subject || '(no message)',
      author,
      at: Number(at) * 1000,
      parent: parented[0],
      merge: parented.length > 1
    };
  });

  return { commits, more };
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

  /** Worktrees currently working out where they began; see `ensure`. */
  private stamping = new Set<string>();

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
   * Stamp this session's starting commit, if it has never been stamped.
   *
   * The commit stamped is where the branch diverged, not HEAD -- see
   * `startingPoint`, and the whole reason it exists.
   *
   * Silent when the repository has not resolved yet or has no commits at all:
   * an empty repository has no HEAD to record, and stamping the wrong thing is
   * worse than stamping later.
   */
  async ensure(session: Session): Promise<void> {
    const repository = session.repository;
    if (!repository?.state.HEAD?.commit) {
      return;
    }
    const key = this.keyFor(session);
    // `onDidChangeSessions` arrives in bursts, and the guard below only closes
    // once the queued write has landed -- so without this every burst re-runs
    // three git commands for every session that is not stamped yet.
    if (this.all()[key] || this.stamping.has(key)) {
      return;
    }
    this.stamping.add(key);
    try {
      const sha = await startingPoint(repository.rootUri.fsPath);
      if (!sha) {
        return;
      }
      await this.queue(async () => {
        // Read again inside the queue: another stamp may have landed while
        // this one waited, and this record holds every worktree.
        const all = this.all();
        if (all[key]) {
          return;
        }
        await this.memento.update(KEY, { ...all, [key]: { sha, at: Date.now() } });
        log(`baseline: ${key} starts at ${sha.slice(0, 8)}`);
        this._onDidChange.fire();
      });
    } finally {
      this.stamping.delete(key);
    }
  }

  /**
   * Re-arm the baseline at the session's current commit.
   *
   * HEAD here, not `startingPoint`. This is somebody saying "I have reviewed
   * that, start again from where we are", which is a different question from
   * "where did this branch begin".
   */
  async reset(session: Session): Promise<boolean> {
    const sha = session.repository?.state.HEAD?.commit;
    if (!sha) {
      return false;
    }
    const key = this.keyFor(session);
    await this.queue(async () => {
      await this.memento.update(KEY, { ...this.all(), [key]: { sha, at: Date.now() } });
    });
    this.invalidate();
    log(`baseline: ${key} re-armed at ${sha.slice(0, 8)}`);
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
    const stamp = this.all()[key];
    if (!stamp) {
      return undefined;
    }
    const root = repository.rootUri.fsPath;

    const state: BaselineState = (await commitExists(root, stamp.sha))
      ? await this.readCommits(root, stamp, head)
      : {
          sha: stamp.sha,
          at: stamp.at,
          head,
          commits: [],
          files: new Set<string>(),
          more: false,
          missing: true
        };

    // A reading invalidated while it was running describes a baseline that no
    // longer applies, and caching it would hide the change until the next one.
    if (generation === this.generation) {
      this.cache.set(key, state);
    }
    return state;
  }

  private async readCommits(
    root: string,
    stamp: Baseline,
    head: string
  ): Promise<BaselineState> {
    const [{ commits, more }, files] = await Promise.all([
      commitsSince(root, stamp.sha),
      pathsTouched(root, stamp.sha)
    ]);
    return { sha: stamp.sha, at: stamp.at, head, commits, files, more, missing: false };
  }
}
