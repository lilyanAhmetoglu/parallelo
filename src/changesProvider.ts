import * as vscode from 'vscode';
import * as path from 'path';
import type { API as GitAPI, Change, Repository } from './git';
import { Status } from './status';
import type { Session, SessionTracker } from './sessionTracker';
import type { SessionStyles } from './sessionStyles';

type Node = GroupNode | ChangeNode;

interface GroupNode {
  kind: 'group';
  label: string;
  staged: boolean;
  changes: Change[];
}

interface ChangeNode {
  kind: 'change';
  change: Change;
  staged: boolean;
  repository: Repository;
}

const LETTERS: Record<number, string> = {
  [Status.INDEX_MODIFIED]: 'M',
  [Status.INDEX_ADDED]: 'A',
  [Status.INDEX_DELETED]: 'D',
  [Status.INDEX_RENAMED]: 'R',
  [Status.INDEX_COPIED]: 'C',
  [Status.MODIFIED]: 'M',
  [Status.DELETED]: 'D',
  [Status.UNTRACKED]: 'U',
  [Status.IGNORED]: 'I',
  [Status.INTENT_TO_ADD]: 'A',
  [Status.BOTH_MODIFIED]: '!'
};

const COLORS: Record<string, string> = {
  M: 'gitDecoration.modifiedResourceForeground',
  A: 'gitDecoration.addedResourceForeground',
  D: 'gitDecoration.deletedResourceForeground',
  R: 'gitDecoration.renamedResourceForeground',
  C: 'gitDecoration.addedResourceForeground',
  U: 'gitDecoration.untrackedResourceForeground',
  I: 'gitDecoration.ignoredResourceForeground',
  '!': 'gitDecoration.conflictingResourceForeground'
};

export class ChangesProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly tracker: SessionTracker,
    private readonly git: GitAPI,
    private readonly styles: SessionStyles
  ) {
    tracker.onDidChangeSession(() => this._onDidChangeTreeData.fire());
    styles.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  /** Title shown on the view, so you can tell sessions apart at a glance. */
  describe(session: Session | undefined): string {
    if (!session?.repository) {
      return 'Changes';
    }
    const branch = session.repository.state.HEAD?.name ?? 'detached';
    return `Changes \u2014 ${this.styles.title(session)} (${branch})`;
  }

  getChildren(element?: Node): Node[] {
    const session = this.tracker.activeSession;
    const repository = session?.repository;
    if (!repository) {
      return [];
    }

    if (!element) {
      const groups: GroupNode[] = [];
      const merge = repository.state.mergeChanges;
      const staged = repository.state.indexChanges;
      const unstaged = repository.state.workingTreeChanges;

      if (merge.length) {
        groups.push({ kind: 'group', label: 'Merge conflicts', staged: false, changes: merge });
      }
      if (staged.length) {
        groups.push({ kind: 'group', label: 'Staged', staged: true, changes: staged });
      }
      if (unstaged.length) {
        groups.push({ kind: 'group', label: 'Changes', staged: false, changes: unstaged });
      }
      return groups;
    }

    if (element.kind === 'group') {
      return element.changes.map(change => ({
        kind: 'change' as const,
        change,
        staged: element.staged,
        repository
      }));
    }

    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(
        node.label,
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.description = String(node.changes.length);
      item.contextValue = 'group';
      return item;
    }

    const uri = node.change.uri;
    const root = node.repository.rootUri.fsPath;
    const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.None);
    item.label = path.basename(uri.fsPath);

    const dir = path.dirname(path.relative(root, uri.fsPath));
    item.description = dir === '.' ? '' : dir;

    const letter = LETTERS[node.change.status] ?? '?';
    item.resourceUri = uri;
    item.contextValue = node.staged ? 'stagedChange' : 'change';
    item.tooltip = `${path.relative(root, uri.fsPath)} \u2014 ${letter}`;
    item.iconPath = new vscode.ThemeIcon(
      'circle-filled',
      new vscode.ThemeColor(COLORS[letter] ?? 'foreground')
    );
    item.command = {
      command: 'parallelo.openChange',
      title: 'Open Change',
      arguments: [node]
    };
    return item;
  }

  /** Opens the right-hand side of the diff for a change. */
  async openChange(node: ChangeNode): Promise<void> {
    const { change, staged } = node;
    const name = path.basename(change.uri.fsPath);

    if (change.status === Status.UNTRACKED || change.status === Status.INTENT_TO_ADD) {
      await vscode.commands.executeCommand('vscode.open', change.uri);
      return;
    }

    try {
      if (staged) {
        const left = this.git.toGitUri(change.originalUri, 'HEAD');
        const right = this.git.toGitUri(change.uri, '');
        await vscode.commands.executeCommand('vscode.diff', left, right, `${name} (staged)`);
      } else {
        const left = this.git.toGitUri(change.originalUri, '~');
        await vscode.commands.executeCommand('vscode.diff', left, change.uri, `${name} (working tree)`);
      }
    } catch {
      await vscode.commands.executeCommand('vscode.open', change.uri);
    }
  }
}

export type { ChangeNode };
