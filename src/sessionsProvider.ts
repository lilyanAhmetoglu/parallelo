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

  getTreeItem(session: Session): vscode.TreeItem {
    const active = this.tracker.activeSession?.terminal === session.terminal;
    const style = this.styles.get(session);
    const item = new vscode.TreeItem(
      style.name || session.terminal.name,
      vscode.TreeItemCollapsibleState.None
    );

    const branch = session.repository?.state.HEAD?.name;
    const dirty =
      (session.repository?.state.workingTreeChanges.length ?? 0) +
      (session.repository?.state.indexChanges.length ?? 0);

    item.description = [branch ?? session.label, dirty ? `${dirty} changed` : '']
      .filter(Boolean)
      .join(' \u00b7 ');
    item.iconPath = new vscode.ThemeIcon(
      style.icon || (active ? 'circle-filled' : 'terminal'),
      style.color ? new vscode.ThemeColor(style.color) : undefined
    );
    item.tooltip = style.name
      ? `${style.name}\n${session.cwd.fsPath}`
      : session.cwd.fsPath;
    item.contextValue = 'session';
    item.command = {
      command: 'parallelo.focusTerminal',
      title: 'Focus Session Terminal',
      arguments: [session]
    };
    return item;
  }
}
