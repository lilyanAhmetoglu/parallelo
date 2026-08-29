import * as vscode from 'vscode';
import * as path from 'path';
import type { API as GitAPI, Change, Repository } from './git';
import { Status } from './status';
import type { Session, SessionTracker } from './sessionTracker';
import type { SessionStyles } from './sessionStyles';
import type { BaselineCommit, BaselineFile, Baselines } from './baselines';

type Node = GroupNode | ChangeNode | CommitsNode | CommitNode | BaselineFileNode;

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

/**
 * The session's own commits, newest first.
 *
 * Commits and not "everything changed since the session started". The first
 * version was the latter and it read as a near-duplicate of the groups above:
 * the same files again, differently ordered, under a heading that did not
 * explain itself. What was actually missing from the view was the committed
 * work, and a commit is the unit that work arrives in.
 */
interface CommitsNode {
  kind: 'commits';
  commits: BaselineCommit[];
  /** There are older commits than the ones listed. */
  more: boolean;
}

interface CommitNode {
  kind: 'commit';
  commit: BaselineCommit;
}

interface BaselineFileNode {
  kind: 'baselineFile';
  file: BaselineFile;
  /** The commit this file was changed in. */
  commit: BaselineCommit;
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

/**
 * How long ago, short enough for a tree row's description.
 *
 * Rounded down and never more than one unit: the row says roughly when, and
 * the exact timestamp is in the tooltip for anyone who needs it.
 */
function ago(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) {
    return 'just now';
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

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
    private readonly styles: SessionStyles,
    private readonly baselines: Baselines
  ) {
    tracker.onDidChangeSession(() => this._onDidChangeTreeData.fire());
    styles.onDidChange(() => this._onDidChangeTreeData.fire());
    baselines.onDidChange(() => this._onDidChangeTreeData.fire());
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

  getChildren(element?: Node): Node[] | Promise<Node[]> {
    const session = this.tracker.activeSession;
    const repository = session?.repository;
    if (!repository || !session) {
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
      // Under `hidden` git runs with `-uno` and neither group has them.
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

      // Last, and collapsed. The groups above are this session's uncommitted
      // work and this is the committed half, so it is the part of the answer
      // that was missing rather than a second copy of the part that was not.
      // Synchronous. A miss starts the read and brings the view back through
      // `onDidChange`, rather than holding the groups above -- which are the
      // point of the view -- behind a git subprocess.
      const baseline = this.baselines.snapshot(session);
      if (baseline && baseline.commits.length) {
        return [
          ...groups,
          { kind: 'commits' as const, commits: baseline.commits, more: baseline.more }
        ];
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

    if (element.kind === 'commits') {
      return element.commits.map(commit => ({ kind: 'commit' as const, commit }));
    }

    if (element.kind === 'commit') {
      // Fetched here rather than up front: this is one git command for the one
      // commit somebody opened, instead of a hundred for the ninety-nine they
      // did not.
      const commit = element.commit;
      return this.baselines
        .filesIn(repository.rootUri.fsPath, commit.sha)
        .then(files =>
          files.map(file => ({
            kind: 'baselineFile' as const,
            file,
            commit,
            repository
          }))
        );
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

    if (node.kind === 'commits') {
      return this.commitsItem(node);
    }

    if (node.kind === 'commit') {
      return this.commitItem(node);
    }

    if (node.kind === 'baselineFile') {
      return this.baselineFileItem(node);
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

  private commitsItem(node: CommitsNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      'Session commits',
      vscode.TreeItemCollapsibleState.Collapsed
    );
    const count = node.commits.length;
    item.description = node.more
      ? `${count}+ commits`
      : `${count} commit${count === 1 ? '' : 's'}`;
    item.tooltip = new vscode.MarkdownString(
      'Commits made in this worktree, newest first. Read from git\'s own record ' +
        'of this worktree, so a merge that arrived by `git pull` is not one of ' +
        'them and neither is anything another branch did.\n\n' +
        (node.more ? 'Older commits are not listed.\n\n' : '') +
        'Uncommitted work is in the groups above.\n\n' +
        'Use **Reset Session Baseline to Now** to hide everything up to this point.'
    );
    item.iconPath = new vscode.ThemeIcon('git-commit');
    item.contextValue = 'commits';
    return item;
  }

  private commitItem(node: CommitNode): vscode.TreeItem {
    const { commit } = node;
    // A merge has no files of its own -- `diff-tree` prints nothing for one --
    // so it does not open. Everything else does, and its files are fetched
    // then. There is no count up front and that is the trade: one git command
    // per commit somebody actually opens.
    const item = new vscode.TreeItem(
      commit.subject,
      commit.merge
        ? vscode.TreeItemCollapsibleState.None
        : vscode.TreeItemCollapsibleState.Collapsed
    );
    item.id = `commit:${commit.sha}`;
    item.description = `${commit.sha.slice(0, 7)} \u00b7 ${ago(commit.at)}`;
    item.tooltip = new vscode.MarkdownString(
      `${commit.subject}\n\n\`${commit.sha.slice(0, 8)}\` \u2014 ${commit.author}, ` +
        `${new Date(commit.at).toLocaleString()}` +
        (commit.merge
          ? '\n\nA merge. It lists no files of its own \u2014 they belong to the ' +
            'commits on the branch it merged.'
          : '')
    );
    item.iconPath = new vscode.ThemeIcon(commit.merge ? 'git-merge' : 'git-commit');
    item.contextValue = 'commit';
    return item;
  }

  private baselineFileItem(node: BaselineFileNode): vscode.TreeItem {
    const { file } = node;
    const item = new vscode.TreeItem(file.uri, vscode.TreeItemCollapsibleState.None);
    item.label = path.basename(file.path);

    const dir = path.dirname(file.path);
    // A rename says where it came from, which is more use in the row than the
    // directory it now sits in.
    item.description = file.from ? `\u2190 ${file.from}` : dir === '.' ? '' : dir;
    item.resourceUri = file.uri;
    item.contextValue = 'baselineFile';
    item.tooltip = `${file.path} \u2014 ${file.letter}`;
    item.iconPath = new vscode.ThemeIcon(
      'circle-filled',
      new vscode.ThemeColor(COLORS[file.letter] ?? 'foreground')
    );
    item.command = {
      command: 'parallelo.openChange',
      title: 'Open Change',
      arguments: [node]
    };
    return item;
  }

  /**
   * Diffs one file across the commit it was changed in.
   *
   * The same URI mechanism as `openChange`, with the commit's parent on the
   * left and the commit itself on the right, so the diff is what that commit
   * did rather than everything that has happened since. A file added by the
   * commit has no left-hand side, a deleted one has no right-hand side, and
   * the repository's first commit has no parent at all -- each of those opens
   * the one side that exists rather than a diff against nothing.
   */
  private async openBaselineChange(node: BaselineFileNode): Promise<void> {
    const { file, commit } = node;
    const name = path.basename(file.path);
    const right = this.git.toGitUri(file.uri, commit.sha);

    if (file.letter === 'A' || !commit.parent) {
      await vscode.commands.executeCommand('vscode.open', right);
      return;
    }

    try {
      // A rename did not exist under its new name in the parent, so the left
      // side has to be the old path or the diff shows the whole file as added.
      const before = file.from
        ? vscode.Uri.file(path.join(node.repository.rootUri.fsPath, file.from))
        : file.uri;
      const left = this.git.toGitUri(before, commit.parent);

      if (file.letter === 'D') {
        await vscode.commands.executeCommand('vscode.open', left);
        return;
      }
      await vscode.commands.executeCommand(
        'vscode.diff',
        left,
        right,
        `${name} (${commit.sha.slice(0, 7)})`
      );
    } catch {
      await vscode.commands.executeCommand('vscode.open', file.uri);
    }
  }

  /** Opens the right-hand side of the diff for a change. */
  async openChange(node: ChangeNode | BaselineFileNode | undefined): Promise<void> {
    if (!node) {
      return;
    }
    if (node.kind === 'baselineFile') {
      await this.openBaselineChange(node);
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

export type { ChangeNode, BaselineFileNode };
