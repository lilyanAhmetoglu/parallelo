import * as vscode from 'vscode';
import type { Session } from './sessionTracker';

export interface SessionStyle {
  name?: string;
  /** A ThemeColor id, so it tracks the user's theme. */
  color?: string;
  /** A ThemeIcon (codicon) id. */
  icon?: string;
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

  constructor(private readonly memento: vscode.Memento) {}

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
    // accumulating empty records for every worktree ever opened.
    if (!next.name && !next.color && !next.icon) {
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

  /** What to call this session in a view title. */
  title(session: Session): string {
    return this.get(session).name || session.label;
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
