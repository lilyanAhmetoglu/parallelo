import * as vscode from 'vscode';
import type { Session, SessionTracker } from './sessionTracker';
import type { SessionStyles } from './sessionStyles';

export class SessionsProvider implements vscode.TreeDataProvider<Session> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly tracker: SessionTracker,
    private readonly styles: SessionStyles
  ) {
    tracker.onDidChangeSessions(() => this._onDidChangeTreeData.fire());
    tracker.onDidChangeSession(() => this._onDidChangeTreeData.fire());
    styles.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getChildren(): Session[] {
    return this.tracker.allSessions;
  }

  /**
   * Required by `TreeView.reveal`, which is how the selected row follows the
   * focused terminal. The list is flat, so every session is a root.
   */
  getParent(): undefined {
    return undefined;
  }

  getTreeItem(session: Session): vscode.TreeItem {
    const active = this.tracker.activeSession?.terminal === session.terminal;
    const style = this.styles.get(session);
    const item = new vscode.TreeItem(
      style.name || session.terminal.name,
      vscode.TreeItemCollapsibleState.None
    );

    // Without this the tree matches rows by object identity, and a `Session`
    // is a fresh object after every re-resolve -- so a pending selection would
    // be looking for a row that no longer exists.
    item.id = session.id;

    const branch = session.repository?.state.HEAD?.name;
    const dirty =
      (session.repository?.state.workingTreeChanges.length ?? 0) +
      (session.repository?.state.indexChanges.length ?? 0);

    // Appearance is keyed by the worktree, so two terminals in one worktree
    // wear the same name and colour and read as a duplicated row. Name the
    // terminal on both so they can be told apart -- and acted on separately.
    const shared =
      session.root !== undefined &&
      this.tracker.allSessions.filter(other => other.root === session.root).length > 1;

    item.description = [
      branch ?? session.label,
      shared ? session.terminal.name : '',
      dirty ? `${dirty} changed` : ''
    ]
      .filter(Boolean)
      .join(' \u00b7 ');
    item.iconPath = new vscode.ThemeIcon(
      style.icon || (active ? 'circle-filled' : 'terminal'),
      style.color ? new vscode.ThemeColor(style.color) : undefined
    );
    item.tooltip = [
      style.name,
      session.cwd.fsPath,
      shared ? `Terminal: ${session.terminal.name}` : '',
      shared ? 'Another terminal is working in this same worktree.' : ''
    ]
      .filter(Boolean)
      .join('\n');
    // Only a linked worktree can be removed; the main checkout cannot, and
    // offering a bin that always fails on it is worse than not offering one.
    item.contextValue = session.linked ? 'worktreeSession' : 'session';
    item.command = {
      command: 'parallelo.focusTerminal',
      title: 'Focus Session Terminal',
      arguments: [session]
    };
    return item;
  }
}
