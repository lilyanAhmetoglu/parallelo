import * as vscode from 'vscode';
import * as path from 'path';
import type { SessionTracker } from './sessionTracker';

interface Entry {
  uri: vscode.Uri;
  type: vscode.FileType;
}

const HIDDEN = new Set(['.git', 'node_modules', '.DS_Store']);

/**
 * A file tree rooted at the active session's worktree, so the files you browse
 * belong to the branch the terminal is on.
 */
export class FilesProvider implements vscode.TreeDataProvider<Entry> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly tracker: SessionTracker) {
    tracker.onDidChangeSession(() => this._onDidChangeTreeData.fire());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  private get root(): vscode.Uri | undefined {
    const session = this.tracker.activeSession;
    return session?.repository?.rootUri ?? session?.cwd;
  }

  async getChildren(element?: Entry): Promise<Entry[]> {
    const dir = element?.uri ?? this.root;
    if (!dir) {
      return [];
    }

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return [];
    }

    return entries
      .filter(([name]) => !HIDDEN.has(name))
      .sort((a, b) => {
        const aDir = a[1] === vscode.FileType.Directory ? 0 : 1;
        const bDir = b[1] === vscode.FileType.Directory ? 0 : 1;
        return aDir - bDir || a[0].localeCompare(b[0]);
      })
      .map(([name, type]) => ({ uri: vscode.Uri.joinPath(dir, name), type }));
  }

  getTreeItem(entry: Entry): vscode.TreeItem {
    const isDir = entry.type === vscode.FileType.Directory;
    const item = new vscode.TreeItem(
      entry.uri,
      isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
    item.label = path.basename(entry.uri.fsPath);
    if (!isDir) {
      item.command = {
        command: 'vscode.open',
        title: 'Open File',
        arguments: [entry.uri]
      };
    }
    return item;
  }
}
