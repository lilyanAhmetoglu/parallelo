import * as vscode from 'vscode';
import type { Session } from './sessionTracker';

export interface SessionStyle {
  name?: string;
  /** A ThemeColor id, so it tracks the user's theme. */
  color?: string;
  /** A ThemeIcon (codicon) id. */
  icon?: string;
  /**
   * Whether `color` was allocated automatically.
   *
   * `true` -- assigned by `autoAssign`, and free to be reassigned if it ever
   * collides with another live session. `false` -- the user decided, including
   * deciding on no colour at all, so leave it alone. Absent means this session
   * has never been looked at.
   */
  autoColor?: boolean;
}

const KEY = 'parallelo.styles';

export const COLORS: { label: string; id: string }[] = [
  { label: 'Red', id: 'terminal.ansiRed' },
  { label: 'Green', id: 'terminal.ansiGreen' },
  { label: 'Yellow', id: 'terminal.ansiYellow' },
  { label: 'Blue', id: 'terminal.ansiBlue' },
  { label: 'Magenta', id: 'terminal.ansiMagenta' },
  { label: 'Cyan', id: 'terminal.ansiCyan' }
];

export const ICONS: string[] = [
  'terminal',
  'rocket',
  'beaker',
  'bug',
  'flame',
  'zap',
  'star-full',
  'tools',
  'telescope',
  'lightbulb',
  'symbol-color',
  'circle-filled'
];

/**
 * Per-session name, colour and icon.
 *
 * Keyed by worktree path rather than by terminal, because terminals do not
 * survive a window reload and the worktree is the thing the user actually
 * thinks of as "the session".
 */
export class SessionStyles implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  /** Serialises colour allocation; see the note on `queue`. */
  private assigning: Promise<void> = Promise.resolve();

  constructor(private readonly memento: vscode.Memento) {}

  private autoEnabled(): boolean {
    return vscode.workspace
      .getConfiguration('parallelo')
      .get<boolean>('autoSessionColors', true);
  }

  /**
   * Runs colour work one piece at a time.
   *
   * `onDidChangeSessions` fires in bursts -- `syncAll` alone fires it twice.
   * Two overlapping passes would each read the memento before either wrote to
   * it, compute against the same snapshot, and hand out the same colour twice.
   */
  private queue(work: () => Promise<void>): Promise<void> {
    const next = this.assigning.then(work, work);
    // The stored link must never stay rejected. A promise chain that rejects
    // once skips every later `then`, so one failed write would silently end
    // auto-colouring for the rest of the window. Callers still see the error.
    this.assigning = next.catch(() => undefined);
    return next;
  }

  /**
   * Identity for a session's saved appearance.
   *
   * Keys on the worktree root found on disk, never on `repository`. The git
   * extension registers repositories asynchronously, so keying on it meant the
   * key silently changed between "not resolved yet" and "resolved" -- styles
   * were written under one key and read back under another after every reload.
   */
  keyFor(session: Session): string {
    return session.root ?? session.cwd.fsPath;
  }

  private all(): Record<string, SessionStyle> {
    return this.memento.get<Record<string, SessionStyle>>(KEY, {});
  }

  get(session: Session): SessionStyle {
    return this.all()[this.keyFor(session)] ?? {};
  }

  async update(session: Session, patch: SessionStyle): Promise<void> {
    const all = { ...this.all() };
    const key = this.keyFor(session);
    const next: SessionStyle = { ...all[key], ...patch };

    // Drop the entry entirely once nothing is customised, rather than
    // accumulating empty records for every worktree ever opened. A record
    // saying only "the user asked for no colour" is not empty -- discarding it
    // would hand the session an automatic colour on the next pass.
    if (!next.name && !next.color && !next.icon && next.autoColor !== false) {
      delete all[key];
    } else {
      all[key] = next;
    }

    await this.memento.update(KEY, all);
    this._onDidChange.fire();
  }

  async clear(session: Session): Promise<void> {
    const all = { ...this.all() };
    delete all[this.keyFor(session)];
    await this.memento.update(KEY, all);
    this._onDidChange.fire();
  }

  /**
   * Gives every live session a colour of its own, without the user setting one.
   *
   * Manual choices always win: a colour the user picked is fixed and taken out
   * of circulation, and a session where they picked *no* colour stays bare.
   * Only automatic colours are reshuffled, and only when two live sessions
   * would otherwise wear the same one.
   */
  autoAssign(sessions: Session[]): Promise<void> {
    return this.queue(() => this.assignNow(sessions));
  }

  /**
   * Applies whatever `autoSessionColors` currently says: hand colours out, or
   * take back the ones already handed out.
   *
   * Turning the setting off has to undo its own work. The colours it assigned
   * live in the memento, so without this they would sit there for good and the
   * setting would read as broken.
   */
  syncAutoColors(sessions: Session[]): Promise<void> {
    return this.autoEnabled()
      ? this.autoAssign(sessions)
      : this.queue(() => this.dropAutoColors());
  }

  private async dropAutoColors(): Promise<void> {
    const all = { ...this.all() };
    let changed = false;

    for (const [key, style] of Object.entries(all)) {
      if (!style.autoColor) {
        continue;
      }
      changed = true;
      // A name or icon is worth keeping; a record holding only a colour we
      // chose ourselves is not.
      if (style.name || style.icon) {
        all[key] = { ...style, color: undefined, autoColor: undefined };
      } else {
        delete all[key];
      }
    }

    if (!changed) {
      return;
    }
    await this.memento.update(KEY, all);
    this._onDidChange.fire();
  }

  private async assignNow(sessions: Session[]): Promise<void> {
    if (!this.autoEnabled()) {
      return;
    }

    const all = { ...this.all() };
    const used = new Map<string, number>(COLORS.map(c => [c.id, 0]));
    const take = (id: string) => used.set(id, (used.get(id) ?? 0) + 1);

    // One entry per worktree, not per terminal -- two terminals in the same
    // worktree are one session as far as appearance is concerned.
    const live = new Map<string, Session>();
    for (const session of sessions) {
      const key = this.keyFor(session);
      if (!live.has(key)) {
        live.set(key, session);
      }
    }

    const pending: Session[] = [];

    for (const [key] of live) {
      const style = all[key];
      if (style?.color && !style.autoColor) {
        take(style.color);
      }
    }

    for (const [key, session] of live) {
      const style = all[key];
      if (style?.color && style.autoColor) {
        // Keep it unless somebody else already holds it.
        if ((used.get(style.color) ?? 0) === 0) {
          take(style.color);
        } else {
          pending.push(session);
        }
      } else if (!style?.color && style?.autoColor !== false) {
        pending.push(session);
      }
    }

    if (!pending.length) {
      return;
    }

    for (const session of pending) {
      // Lowest-index colour nobody holds. Past the sixth session every colour
      // is spoken for, so the least-used one repeats rather than clashing with
      // whichever session happens to sit next to it.
      let pick = COLORS[0].id;
      for (const { id } of COLORS) {
        if ((used.get(id) ?? 0) < (used.get(pick) ?? 0)) {
          pick = id;
        }
      }
      take(pick);
      const key = this.keyFor(session);
      all[key] = { ...all[key], color: pick, autoColor: true };
    }

    await this.memento.update(KEY, all);
    this._onDidChange.fire();
  }

  /**
   * Forgets appearance for worktrees that are no longer on disk.
   *
   * Records are keyed by worktree path and agent worktrees are created and
   * deleted constantly, so without this the store grows by one entry for every
   * worktree ever seen and never shrinks. Runs once on activation; a handful
   * of `stat` calls, and only against paths already stored.
   */
  async prune(): Promise<void> {
    const all = { ...this.all() };
    const gone: string[] = [];

    await Promise.all(
      Object.keys(all).map(async key => {
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
    gone.forEach(key => delete all[key]);
    await this.memento.update(KEY, all);
    this._onDidChange.fire();
  }

  /** What to call this session in a view title. */
  title(session: Session): string {
    return this.get(session).name || session.label;
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
