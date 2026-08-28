/**
 * Minimal typings for the built-in `vscode.git` extension API.
 * Full definitions live in the VS Code repo at extensions/git/src/api/git.d.ts
 */
import { Uri, Event, Disposable } from 'vscode';

export interface GitExtension {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: Event<boolean>;
  getAPI(version: 1): API;
}

export interface API {
  readonly state: 'uninitialized' | 'initialized';
  readonly onDidChangeState: Event<string>;
  readonly repositories: Repository[];
  readonly onDidOpenRepository: Event<Repository>;
  readonly onDidCloseRepository: Event<Repository>;
  toGitUri(uri: Uri, ref: string): Uri;
  getRepository(uri: Uri): Repository | null;
  openRepository(root: Uri): Promise<Repository | null>;
}

export interface Repository {
  readonly rootUri: Uri;
  readonly state: RepositoryState;
  add(paths: string[]): Promise<void>;
  /**
   * Unstages. `git reset HEAD -- <paths>`, despite the name -- it does not
   * touch the working tree, so it is the safe half of the pair below.
   */
  revert(paths: string[]): Promise<void>;
  /**
   * Discards working tree changes.
   *
   * Two different git commands depending on the file: a modified tracked file
   * is restored with `git checkout -- `, an untracked one is **deleted** by
   * `git clean -f`. Paths that are not in the working tree or untracked groups
   * -- a staged-only change, for one -- are silently ignored.
   */
  clean(paths: string[]): Promise<void>;
  status(): Promise<void>;
}

export interface RepositoryState {
  readonly HEAD: Branch | undefined;
  readonly workingTreeChanges: Change[];
  readonly indexChanges: Change[];
  readonly mergeChanges: Change[];
  /**
   * Untracked files, when `git.untrackedChanges` is `separate`.
   *
   * Under the default `mixed` they sit in `workingTreeChanges` instead, and
   * under `hidden` git is run with `-uno` so neither group has them and this
   * is always empty. Optional on purpose: declaring it required would let a
   * build against an older git extension read a property that is not there.
   */
  readonly untrackedChanges?: Change[];
  readonly onDidChange: Event<void>;
}

export interface Branch {
  readonly name?: string;
  readonly commit?: string;
  readonly ahead?: number;
  readonly behind?: number;
}

export interface Change {
  readonly uri: Uri;
  readonly originalUri: Uri;
  readonly renameUri: Uri | undefined;
  /** Compare against the Status enum in status.ts. */
  readonly status: number;
}

export { Disposable };
