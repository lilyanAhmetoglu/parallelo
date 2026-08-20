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
  /**
   * A file in a merge or rebase conflict.
   *
   * Its own flag rather than a status check: the git extension keeps these in
   * a group of their own and `clean` looks only at the working tree and
   * untracked groups, so discarding a conflicted file finds nothing to act on.
   */
  merge?: boolean;
  changes: Change[];
}

interface ChangeNode {
  kind: 'change';
  change: Change;
  staged: boolean;
  merge?: boolean;
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
      // Empty under the default `git.untrackedChanges: mixed`, where these sit
      // in the working tree group instead. Under `separate` they are only
      // here, and reading one group would drop them from the view entirely.
      const untracked = repository.state.untrackedChanges ?? [];

      if (merge.length) {
        groups.push({
          kind: 'group',
          label: 'Merge conflicts',
          staged: false,
          merge: true,
          changes: merge
        });
      }
      if (staged.length) {
        groups.push({ kind: 'group', label: 'Staged', staged: true, changes: staged });
      }
      if (unstaged.length) {
        groups.push({ kind: 'group', label: 'Changes', staged: false, changes: unstaged });
      }
      if (untracked.length) {
        groups.push({ kind: 'group', label: 'Untracked', staged: false, changes: untracked });
      }
      return groups;
    }

    if (element.kind === 'group') {
      return element.changes.map(change => ({
        kind: 'change' as const,
        change,
        staged: element.staged,
        merge: element.merge,
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
    // Untracked is its own kind. Discarding a modified file restores it;
    // discarding an untracked one deletes it, and the row has to be able to
    // say so before it is clicked.
    const untracked =
      node.change.status === Status.UNTRACKED || node.change.status === Status.IGNORED;
    item.contextValue = node.merge
      ? 'mergeChange'
      : node.staged
        ? 'stagedChange'
        : untracked
          ? 'untrackedChange'
          : 'change';
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

  /**
   * Throws away a working tree change, after saying what that costs.
   *
   * Modal, unlike the stash warning: that one reports something already done,
   * and this one is about to destroy work that is on no branch and in no
   * commit. There is a decision to make, so it is worth the interruption.
   */
  async discardChange(node: ChangeNode | undefined): Promise<void> {
    if (!node) {
      return;
    }
    const { change, repository, staged } = node;
    const name = path.basename(change.uri.fsPath);

    // `clean` only looks at the working tree and untracked groups, so a staged
    // path would be quietly ignored -- the row would sit there afterwards
    // looking as though the click missed.
    if (staged) {
      vscode.window.showInformationMessage(
        `${name} is staged. Unstage it first, then discard it.`
      );
      return;
    }

    // Same reason: a conflicted file lives in the merge group and nowhere
    // else, so `clean` would find nothing and the row would sit there looking
    // as though the click had missed -- after a modal that promised otherwise.
    if (node.merge) {
      vscode.window.showInformationMessage(
        `${name} is in a merge conflict. Resolve it, or undo the merge, before discarding it.`
      );
      return;
    }

    // The same two statuses the git extension dispatches on: it sends these
    // to `git clean -f`, which deletes, and everything else to
    // `git checkout -- `, which restores. The warning has to match what will
    // actually happen, not what the file looks like.
    const untracked =
      change.status === Status.UNTRACKED || change.status === Status.IGNORED;
    const detail = untracked
      ? `${name} is not tracked by git, so discarding it deletes the file. ` +
        'There is nothing to restore it from.'
      : `The changes to ${name} are not committed and not on any branch. ` +
        'They cannot be recovered.';

    const confirm = await vscode.window.showWarningMessage(
      untracked ? `Delete ${name}?` : `Discard changes to ${name}?`,
      { modal: true, detail },
      untracked ? 'Delete File' : 'Discard Changes'
    );
    if (!confirm) {
      return;
    }

    try {
      await repository.clean([change.uri.fsPath]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Could not discard ${name}. ${message}`);
    }
  }

  /** Takes a change back out of the index. Nothing is lost. */
  async unstageChange(node: ChangeNode | undefined): Promise<void> {
    if (!node) {
      return;
    }
    const { change, repository } = node;
    try {
      await repository.revert([change.uri.fsPath]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(
        `Could not unstage ${path.basename(change.uri.fsPath)}. ${message}`
      );
    }
  }

  /** Opens the right-hand side of the diff for a change. */
  async openChange(node: ChangeNode | undefined): Promise<void> {
    if (!node) {
      return;
    }
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
