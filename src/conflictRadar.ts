import * as vscode from 'vscode';
import * as path from 'path';
import type { Repository } from './git';
import { Status } from './status';
import { isListed, type Session, type SessionTracker } from './sessionTracker';
import type { SessionStyles } from './sessionStyles';
import type { Baselines } from './baselines';
import type { Seeded } from './seeded';
import { commonDirFor } from './gitCommonDir';
import { log } from './log';

/** What one worktree has in common with the others working beside it. */
export interface Overlap {
  /** Repo-relative paths changed here that another worktree has changed too. */
  files: string[];
  /** The other worktrees, and which of those files each one touches. */
  others: { root: string; files: string[] }[];
}

/** How many files a tooltip lists before it starts counting instead. */
const LISTED = 10;

/**
 * Scheme for the `resourceUri` a session row carries.
 *
 * A tree row only gets a file decoration if it has a `resourceUri`, and it
 * must not be the worktree directory itself -- that is a real path, and the
 * git extension decorates it with its own status. A scheme of our own means
 * only this provider ever answers for it.
 */
const SCHEME = 'parallelo-session';

/** The row identity for a worktree, as a uri decorations can be hung on. */
export function sessionUri(root: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: root });
}

/**
 * Every path this worktree has touched, relative to its own root.
 *
 * Staged as well as unstaged: an agent that has already staged a file has
 * still edited it. Untracked files count too -- two agents both creating
 * `src/thing.ts` collide exactly as hard as two agents both editing it -- and
 * they live in `workingTreeChanges` only under the default
 * `git.untrackedChanges: mixed`, so both groups have to be read or the setting
 * silently switches half the feature off.
 *
 * Merge changes matter most of all: a session sitting on a conflicted
 * `auth.ts` is the one you least want a second agent walking into, and those
 * files are in neither of the other two groups.
 *
 * What the worktree was *created* holding does not count. Parallelo copies the
 * base checkout's untracked files into every new worktree, and the ones git is
 * not ignoring land there as untracked files -- so without this, two sessions
 * branched from the same checkout warn about each other over a `notes.md`
 * neither agent has opened. Only while the path is still untracked: staging it
 * makes it that session's work by any reading.
 */
function editedFiles(repository: Repository, seeded: Set<string>): Set<string> {
  const root = repository.rootUri.fsPath;
  const files = new Set<string>();
  for (const change of [
    ...repository.state.workingTreeChanges,
    ...repository.state.indexChanges,
    ...repository.state.mergeChanges,
    ...(repository.state.untrackedChanges ?? [])
  ]) {
    if (change.status === Status.IGNORED) {
      continue;
    }
    // git speaks in forward slashes everywhere, including on Windows, and the
    // baseline's paths come straight from git. `path.relative` does not, so
    // without this the same file arrives twice under two spellings and one
    // shared file reads as two conflicts.
    const file = path.relative(root, change.uri.fsPath).split(path.sep).join('/');
    if (change.status === Status.UNTRACKED && seeded.has(file)) {
      continue;
    }
    files.add(file);
  }
  return files;
}

/** A value to compare two readings by, so a repaint only follows a real change. */
function signature(overlaps: Map<string, Overlap>): string {
  return [...overlaps]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([root, overlap]) =>
        `${root}>${overlap.others
          .map(other => `${other.root}=${other.files.join(',')}`)
          .join(';')}`
    )
    .join('|');
}

/**
 * Says when two sessions are editing the same file, before merge time does.
 *
 * Worktrees isolate files, which is the whole reason for running agents in
 * them -- and it means neither agent, and neither git, has any idea the other
 * one is in `auth.ts` as well. You find out when you merge.
 *
 * The comparison runs from each session's baseline, not from its working
 * tree, so a file does not leave it the moment an agent commits. That hole was
 * the radar's known weakness: the agent most worth warning about is the one
 * making steady commits, and it was the one that disappeared from the
 * comparison fastest. Working tree changes are still unioned in, because a
 * worktree seen for the first time has a baseline of its own HEAD and nothing
 * committed since.
 */
export class ConflictRadar implements vscode.Disposable, vscode.FileDecorationProvider {
  private readonly disposables: vscode.Disposable[] = [];
  private overlaps = new Map<string, Overlap>();

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires when what overlaps with what has actually changed. */
  readonly onDidChange = this._onDidChange.event;

  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  private scanning = false;
  /** An event that arrived mid-scan, so the scan repeats rather than losing it. */
  private again = false;

  constructor(
    private readonly tracker: SessionTracker,
    private readonly styles: SessionStyles,
    private readonly baselines: Baselines,
    private readonly seeded: Seeded
  ) {
    this.disposables.push(
      // Fires on terminal changes and on any git state change in a tracked
      // repository, which is exactly when the set of edited files moves.
      tracker.onDidChangeSessions(() => void this.scan()),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('parallelo.conflictRadar')) {
          void this.scan();
        }
      })
    );
    void this.scan();
  }

  /**
   * What this session shares with the others, ready to render.
   *
   * Naming lives here rather than in the view because two views show it -- the
   * row and the session picker -- and a warning that named a worktree in one
   * and a renamed session in the other would not read as the same thing.
   */
  describe(session: Session):
    | { mark: string; summary: string; tooltip: string }
    | undefined {
    const root = session.repository?.rootUri.fsPath;
    const overlap = root ? this.overlaps.get(root) : undefined;
    if (!overlap) {
      return undefined;
    }

    return {
      mark: this.markFor(overlap),
      summary: this.summaryFor(overlap),
      // Leads with the word, then the evidence. "Possible" because nothing has
      // conflicted yet -- git will not have an opinion until these branches
      // meet -- and saying otherwise would name a failure that has not
      // happened.
      tooltip: [
        `\u26a0 Possible conflict \u2014 ${this.summaryFor(overlap).replace('\u26a0 ', '')}`,
        ''
      ]
        .concat(
          overlap.others
            .map(other =>
              [
                `Also being edited in ${this.nameFor(other.root)}:`,
                ...other.files.slice(0, LISTED).map(file => `  ${file}`),
                other.files.length > LISTED
                  ? `  and ${other.files.length - LISTED} more`
                  : ''
              ]
                .filter(Boolean)
                .join('\n')
            )
          // A blank line between them, or two worktrees' file lists run
          // together into one block that reads as a single list.
          .join('\n\n')
        )
        .join('\n')
    };
  }

  /**
   * The shortest thing worth putting in a row.
   *
   * It has to say what is wrong, not just that something is. A filename alone
   * was the first attempt and it reads as a filename -- there is nothing in
   * `alpha.txt` to tell you it is a warning. The word carries that on its own,
   * and it is short enough to survive a narrow sidebar, which the full
   * sentence is not. Which file, and who else is in it, are in the tooltip.
   */
  private markFor(overlap: Overlap): string {
    const count = overlap.files.length;
    return `\u26a0 ${count} conflict${count === 1 ? '' : 's'}`;
  }

  /** One line saying what this overlap is, for a hover or a picker row. */
  private summaryFor(overlap: Overlap): string {
    const names = overlap.others.map(other => this.nameFor(other.root));
    // Two names is as much as a hover wants to carry. Past that the count says
    // more than a list does.
    const who = names.length <= 2 ? names.join(', ') : `${names.length} other sessions`;
    const count = overlap.files.length;
    return `\u26a0 ${count} file${count === 1 ? '' : 's'} also edited by ${who}`;
  }

  /**
   * The mark on a conflicted row.
   *
   * The description is the first thing VS Code truncates, so a sidebar at its
   * usual width hid the warning entirely -- which is no use for the one thing
   * in the row you need to see without looking. A decoration is what git uses
   * for the same job in the Explorer: the badge pins to the right edge and the
   * colour lands on the session name itself, so both survive any width.
   */
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== SCHEME) {
      return undefined;
    }
    const overlap = this.overlaps.get(uri.path);
    if (!overlap) {
      return undefined;
    }
    return {
      badge: '\u26a0',
      // The colour the diff already uses for a conflicted file, so it means
      // the same thing in the Sessions view as it does in Changes.
      color: new vscode.ThemeColor('gitDecoration.conflictingResourceForeground'),
      tooltip: this.summaryFor(overlap),
      // A section heading is not in conflict just because a row under it is.
      propagate: false
    };
  }

  /** What the row for `root` is called, so the warning matches the list. */
  private nameFor(root: string): string {
    const session = this.tracker.allSessions.find(
      other => other.repository?.rootUri.fsPath === root
    );
    // The expression the rows use, not `styles.title`. A session nobody has
    // renamed is labelled by its terminal, so naming it by its worktree here
    // would point at a row that calls itself something else -- and a terminal
    // the user cd'd into a worktree themselves is exactly that case.
    return session
      ? this.styles.get(session).name || session.terminal.name
      : path.basename(root);
  }

  private enabled(): boolean {
    return vscode.workspace
      .getConfiguration('parallelo')
      .get<boolean>('conflictRadar', true);
  }

  /** Recompute now. For a setting change that alters what counts as edited. */
  rescan(): void {
    void this.scan();
  }

  private async scan(): Promise<void> {
    if (this.scanning) {
      // Resolving a common directory spawns git, so a burst of session events
      // overlaps easily. Go round again rather than dropping the last one and
      // leaving the views showing a reading that has already moved on.
      this.again = true;
      return;
    }
    this.scanning = true;
    try {
      const next = this.enabled() ? await this.compute() : new Map<string, Overlap>();
      if (signature(next) !== signature(this.overlaps)) {
        // Both readings: a row that has stopped conflicting needs its badge
        // taken off just as much as a new one needs it put on.
        const touched = [...new Set([...this.overlaps.keys(), ...next.keys()])];
        this.overlaps = next;
        log(
          next.size
            ? `conflicts: ${[...next]
                .map(([root, overlap]) => `${path.basename(root)} shares ${overlap.files.length}`)
                .join(', ')}`
            : 'conflicts: nothing shared between sessions'
        );
        this._onDidChange.fire();
        this._onDidChangeFileDecorations.fire(touched.map(sessionUri));
      }
    } catch (error) {
      // A repository can close underneath this -- a worktree removed while its
      // session is still listed reads its state mid-scan. Swallowing it here
      // rather than rejecting is what lets the queued scan below still run: a
      // rejection would leave `again` latched true, and every later scan would
      // then run twice, for ever, as an unhandled rejection nobody sees.
      log(`conflicts: scan failed -- ${error}`);
    } finally {
      this.scanning = false;
    }

    if (this.again) {
      this.again = false;
      await this.scan();
    }
  }

  /**
   * Everything this session has touched since it started.
   *
   * The baseline half is what keeps a committed file in the comparison; the
   * working tree half covers the moments the baseline cannot -- a session
   * stamped seconds ago, or one whose starting commit has gone and whose
   * baseline reads as missing. Neither is a superset of the other in every
   * state, so both are read.
   */
  private async touchedIn(entry: {
    repository: Repository;
    session: Session;
  }): Promise<Set<string>> {
    const files = editedFiles(
      entry.repository,
      this.seeded.get(entry.repository.rootUri.fsPath)
    );

    // Linked worktrees only. The main checkout is where `git pull` happens,
    // and every commit a pull brings in is a commit made here since this
    // session started -- two hundred files that nobody in this window wrote,
    // flagged against every worktree that has touched any of them.
    if (entry.session.linked !== true) {
      return files;
    }

    const baseline = await this.baselines.read(entry.session);
    for (const file of baseline?.files ?? []) {
      files.add(file);
    }
    return files;
  }

  private async compute(): Promise<Map<string, Overlap>> {
    // One entry per worktree. Two terminals in the same worktree share a
    // working tree, so they cannot collide with each other -- that is a plain
    // git race, and the row already says another terminal is in there.
    const worktrees = new Map<string, { repository: Repository; session: Session }>();
    for (const session of this.tracker.allSessions) {
      // A session with no row is one the user cannot see or switch to, so
      // naming it as the other half of a conflict points at nothing.
      if (session.repository && isListed(session)) {
        worktrees.set(session.repository.rootUri.fsPath, {
          repository: session.repository,
          session
        });
      }
    }
    if (worktrees.size < 2) {
      return new Map();
    }

    // Only worktrees of one repository can collide. Two unrelated projects
    // both holding a modified `src/index.ts` is a coincidence, not a warning.
    const groups = new Map<string, string[]>();
    for (const root of worktrees.keys()) {
      const common = await commonDirFor(root);
      if (!common) {
        continue;
      }
      const sharing = groups.get(common);
      if (sharing) {
        sharing.push(root);
      } else {
        groups.set(common, [root]);
      }
    }

    const overlaps = new Map<string, Overlap>();
    for (const roots of groups.values()) {
      if (roots.length < 2) {
        continue;
      }
      const edited = new Map(
        await Promise.all(
          roots.map(
            async root =>
              [
                root,
                await this.touchedIn(
                  worktrees.get(root) as { repository: Repository; session: Session }
                )
              ] as const
          )
        )
      );

      for (const root of roots) {
        const mine = edited.get(root) as Set<string>;
        if (!mine.size) {
          continue;
        }
        const shared = new Set<string>();
        const others: { root: string; files: string[] }[] = [];

        // Sorted, so the same overlap always produces the same reading and a
        // repaint follows a change in the facts rather than in session order.
        for (const other of [...roots].sort()) {
          if (other === root) {
            continue;
          }
          const theirs = edited.get(other) as Set<string>;
          const files = [...mine].filter(file => theirs.has(file)).sort();
          if (!files.length) {
            continue;
          }
          files.forEach(file => shared.add(file));
          others.push({ root: other, files });
        }

        if (others.length) {
          overlaps.set(root, { files: [...shared].sort(), others });
        }
      }
    }
    return overlaps;
  }

  dispose(): void {
    this.disposables.forEach(disposable => disposable.dispose());
    this._onDidChange.dispose();
    this._onDidChangeFileDecorations.dispose();
  }
}
