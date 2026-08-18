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
  status(): Promise<void>;
}

export interface RepositoryState {
  readonly HEAD: Branch | undefined;
  readonly workingTreeChanges: Change[];
  readonly indexChanges: Change[];
  readonly mergeChanges: Change[];
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
