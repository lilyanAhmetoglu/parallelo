import * as vscode from 'vscode';
import * as path from 'path';
import type { API as GitAPI, Repository } from './git';
import { processCwds, forgetProcess } from './processCwd';
import { log } from './log';

export interface Session {
  /** The terminal driving this session. */
  terminal: vscode.Terminal;
  /** Working directory the terminal is currently in. */
  cwd: vscode.Uri;
  /**
   * Worktree root containing `cwd`, found by walking up for `.git`.
   *
   * Deliberately independent of `repository`: it resolves from the filesystem
   * immediately, whereas the git extension registers a repository
   * asynchronously. Anything that needs a stable identity for this session --
   * persisted settings, for one -- must key on this, not on `repository`,
   * which is undefined for the first moments after a reload.
   */
  root?: string;
  /**
   * Whether `root` is a linked worktree rather than the main checkout.
   *
   * In a linked worktree `.git` is a file pointing at the common directory; in
   * the main checkout it is a directory. Only a linked worktree can be removed
   * with `git worktree remove`, so this decides whether the row offers it.
   */
  linked?: boolean;
  /** Git repository (worktree) containing that directory, once resolved. */
  repository?: Repository;
  /** Label shown in the Sessions view. */
  label: string;
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Watches the active terminal and works out which git worktree it is sitting in.
 * Everything else in the extension listens to `onDidChangeSession`.
 */
export class SessionTracker implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly sessions = new Map<vscode.Terminal, Session>();
  /** Terminals told to close, ignored until VS Code stops listing them. */
  private readonly closing = new Set<vscode.Terminal>();
  private readonly repoStateListeners = new Map<Repository, vscode.Disposable>();
  private current: Session | undefined;

  private readonly _onDidChangeSession = new vscode.EventEmitter<Session | undefined>();
  /** Fires when the active session changes, or when its git state changes. */
  readonly onDidChangeSession = this._onDidChangeSession.event;

  private readonly _onDidChangeSessions = new vscode.EventEmitter<void>();
  /** Fires when the set of known sessions changes. */
  readonly onDidChangeSessions = this._onDidChangeSessions.event;

  constructor(private readonly git: GitAPI) {
    this.disposables.push(
      vscode.window.onDidChangeActiveTerminal(() => void this.sync()),
      vscode.window.onDidOpenTerminal(() => void this.syncAll()),
      // Shell integration reports the cwd, and updates it on every `cd`.
      vscode.window.onDidChangeTerminalShellIntegration(() => void this.sync()),
      vscode.window.onDidCloseTerminal(t => {
        this.closing.delete(t);
        this.forget(t);
      }),
      this.git.onDidOpenRepository(() => void this.sync()),
      this.git.onDidCloseRepository(repo => {
        this.repoStateListeners.get(repo)?.dispose();
        this.repoStateListeners.delete(repo);
      })
    );

    void this.syncAll();
  }

  get activeSession(): Session | undefined {
    return this.current;
  }

  get allSessions(): Session[] {
    return [...this.sessions.values()];
  }

  /** Resolves one terminal into a session, without changing which is active. */
  private async track(terminal: vscode.Terminal): Promise<Session | undefined> {
    if (this.closing.has(terminal)) {
      return undefined;
    }
    const located = await this.resolveCwd(terminal);
    if (!located) {
      return undefined;
    }
    const { cwd, root } = located;

    const repository = await this.resolveRepository(cwd, root);
    const label = repository
      ? path.basename(repository.rootUri.fsPath)
      : path.basename((root ?? cwd).fsPath);

    const session: Session = {
      terminal,
      cwd,
      root: root?.fsPath,
      linked: root ? await this.isLinkedWorktree(root) : undefined,
      repository,
      label
    };
    this.sessions.set(terminal, session);

    if (repository) {
      this.watchRepository(repository);
    } else if (root) {
      // The stash guard and the Changes view both need a repository, so a
      // worktree git never registered is worth saying out loud.
      log(`session: ${terminal.name} is in ${root.fsPath} but git has not registered it`);
    }
    return session;
  }

  /** Re-reads the active terminal and updates the current session. */
  async sync(): Promise<void> {
    const terminal = vscode.window.activeTerminal;
    if (!terminal) {
      this.setCurrent(undefined);
      return;
    }

    const session = await this.track(terminal);
    if (!session) {
      if (this.closing.has(terminal)) {
        this.setCurrent(undefined);
        return;
      }
      // The directory has not been reported yet. Keep the last session
      // rather than blanking the views on every terminal switch.
      return;
    }

    this.setCurrent(session);
    this._onDidChangeSessions.fire();
  }

  /**
   * Resolves every open terminal, not just the active one.
   *
   * Terminals that already existed when the extension activated -- after a
   * window reload, say -- never fire an event of their own, so they used to
   * stay invisible until clicked. Reading their cwd from the process tree
   * does not need them to be focused, so they can all be listed up front.
   */
  async syncAll(): Promise<void> {
    await Promise.all(vscode.window.terminals.map(terminal => this.track(terminal)));
    await this.sync();
    this._onDidChangeSessions.fire();
  }

  /**
   * Where this terminal is really working.
   *
   * The shell reports its own cwd, which is right when the user cd'd into a
   * worktree and wrong when an agent was told to make its own -- the agent
   * moves itself and leaves the shell behind. So gather every candidate and
   * let the deepest git root win, which covers both without caring what is
   * running in the terminal.
   */
  private async resolveCwd(
    terminal: vscode.Terminal
  ): Promise<{ cwd: vscode.Uri; root: vscode.Uri | undefined } | undefined> {
    const candidates: string[] = [];

    const fromShell = terminal.shellIntegration?.cwd;
    if (fromShell) {
      candidates.push(fromShell.fsPath);
    } else {
      const created = terminal.creationOptions as vscode.TerminalOptions;
      if (created?.cwd) {
        candidates.push(typeof created.cwd === 'string' ? created.cwd : created.cwd.fsPath);
      }
    }

    const followProcesses = vscode.workspace
      .getConfiguration('parallelo')
      .get<boolean>('followProcessCwd', true);

    if (followProcesses) {
      try {
        const pid = await terminal.processId;
        if (pid) {
          candidates.push(...(await processCwds(pid)));
        }
      } catch {
        // Process inspection is unavailable. The shell's cwd still stands.
      }
    }

    return this.deepestWorktree(candidates);
  }

  /**
   * Of the directories this terminal touches, returns the one sitting in the
   * most deeply nested git worktree. A shell in the main checkout with an
   * agent running in `.worktrees/foo` resolves to the worktree, not the parent.
   */
  private async deepestWorktree(
    candidates: string[]
  ): Promise<{ cwd: vscode.Uri; root: vscode.Uri | undefined } | undefined> {
    let best: { cwd: string; root: vscode.Uri } | undefined;

    for (const cwd of [...new Set(candidates)]) {
      const root = await this.findGitRoot(vscode.Uri.file(cwd));
      if (!root) {
        continue;
      }
      if (!best || root.fsPath.length > best.root.fsPath.length) {
        best = { cwd, root };
      }
    }

    if (best) {
      return { cwd: vscode.Uri.file(best.cwd), root: best.root };
    }
    // Nothing was in a repository. Keep the shell's own directory so the
    // session still shows up, just without git state.
    return candidates.length
      ? { cwd: vscode.Uri.file(candidates[0]), root: undefined }
      : undefined;
  }

  /**
   * Finds the repository for `cwd`. The cwd's own git root wins outright.
   *
   * A linked worktree normally sits inside the main checkout (`.worktrees/foo`,
   * `.claude/worktrees/foo`), so matching by containment alone always returns
   * the parent and shows the wrong diffs. VS Code does not scan hidden
   * directories, so those worktrees stay unregistered until we register them
   * here -- which is why this runs before any containment matching.
   */
  private async resolveRepository(
    cwd: vscode.Uri,
    root: vscode.Uri | undefined
  ): Promise<Repository | undefined> {
    if (root) {
      const exact = this.git.repositories.find(
        repo => repo.rootUri.fsPath === root.fsPath
      );
      if (exact) {
        return exact;
      }

      const autoOpen = vscode.workspace
        .getConfiguration('parallelo')
        .get<boolean>('autoOpenRepository', true);
      if (autoOpen) {
        try {
          const opened = await this.git.openRepository(root);
          if (opened) {
            return opened;
          }
        } catch {
          // Registering failed. Fall back to containment matching below.
        }
      }
    }

    // No git root above the cwd, or opening it failed. Use the deepest
    // registered repository that contains the cwd.
    let best: Repository | undefined;
    for (const repo of this.git.repositories) {
      if (isInside(repo.rootUri.fsPath, cwd.fsPath)) {
        if (!best || repo.rootUri.fsPath.length > best.rootUri.fsPath.length) {
          best = repo;
        }
      }
    }
    return best;
  }

  /**
   * Whether `root` is a linked worktree.
   *
   * A `.git` file alone does not say so: a submodule has one too, and points at
   * `<super>/.git/modules/<name>` where a linked worktree points at
   * `<main>/.git/worktrees/<name>`. `git worktree remove` works on the second
   * and not the first, so read the file rather than just stat it -- and read it
   * rather than spawning git for every terminal.
   */
  private async isLinkedWorktree(root: vscode.Uri): Promise<boolean> {
    const dotGit = vscode.Uri.joinPath(root, '.git');
    try {
      const stat = await vscode.workspace.fs.stat(dotGit);
      if (stat.type !== vscode.FileType.File) {
        return false;
      }
      const pointer = Buffer.from(await vscode.workspace.fs.readFile(dotGit)).toString('utf8');
      return /^gitdir:\s*.*[\\/]worktrees[\\/]/m.test(pointer);
    } catch {
      return false;
    }
  }

  /** Walks up from `start` looking for a `.git` entry (a dir, or a file in a worktree). */
  private async findGitRoot(start: vscode.Uri): Promise<vscode.Uri | undefined> {
    let dir = start;
    for (let depth = 0; depth < 24; depth++) {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.joinPath(dir, '.git'));
        return dir;
      } catch {
        const parent = vscode.Uri.file(path.dirname(dir.fsPath));
        if (parent.fsPath === dir.fsPath) {
          return undefined;
        }
        dir = parent;
      }
    }
    return undefined;
  }

  private watchRepository(repository: Repository): void {
    if (this.repoStateListeners.has(repository)) {
      return;
    }
    const listener = repository.state.onDidChange(() => {
      if (this.current?.repository === repository) {
        this._onDidChangeSession.fire(this.current);
      }
      this._onDidChangeSessions.fire();
    });
    this.repoStateListeners.set(repository, listener);
    this.disposables.push(listener);
  }

  private setCurrent(session: Session | undefined): void {
    const same =
      this.current?.terminal === session?.terminal &&
      this.current?.cwd.fsPath === session?.cwd.fsPath;
    this.current = session;
    if (!same) {
      this._onDidChangeSession.fire(session);
    }
  }

  /**
   * Closes a terminal and drops its session now.
   *
   * `dispose` is not immediate -- the terminal stays in
   * `vscode.window.terminals` until it has actually gone, and
   * `onDidCloseTerminal` arrives later still. Anything that re-reads the
   * terminal list in between puts the session straight back, so drop it here
   * rather than waiting for the event.
   */
  close(terminal: vscode.Terminal): void {
    this.closing.add(terminal);
    terminal.dispose();
    // Drop the session now, but leave the terminal in `closing`. Clearing it
    // here would undo the guard in the same breath as setting it, and the
    // syncAll that follows would re-track a terminal VS Code is still listing
    // -- against a directory that may no longer exist, so it resolves to the
    // parent repo and comes back as a bogus row. `onDidCloseTerminal` clears
    // it, once the terminal has really gone.
    this.forget(terminal);
  }

  private forget(terminal: vscode.Terminal): void {
    void terminal.processId.then(pid => {
      if (pid) {
        forgetProcess(pid);
      }
    });
    this.sessions.delete(terminal);
    if (this.current?.terminal === terminal) {
      this.setCurrent(undefined);
    }
    this._onDidChangeSessions.fire();
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this._onDidChangeSession.dispose();
    this._onDidChangeSessions.dispose();
  }
}
