import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { API as GitAPI } from './git';
import { isLinkedWorktree, type SessionTracker } from './sessionTracker';
import { canonical } from './worktreeTerminals';
import { copyUntrackedFiles, detectInstallCommand } from './worktreeSeed';
import type { Seeded } from './seeded';
import { log } from './log';

const run = promisify(execFile);

export interface AgentChoice {
  label: string;
  command?: string;
  /** Models this agent can be asked for. Omit, or give one, and nothing is asked. */
  models?: { label: string; value?: string }[];
  /** How this agent takes a model. Defaults to `--model`. */
  modelFlag?: string;
  /**
   * Flags this agent needs in a brainstorming room, and nowhere else: the ones
   * that point it at the room's MCP server, put its brief in its system prompt,
   * and take away its file tools. They are per agent because they are agent
   * syntax -- Claude Code's are not Codex's -- and they ship with a working
   * default rather than being something to copy in by hand, because a room
   * whose flags are missing opens two terminals that cannot reach each other
   * and looks exactly like one that is thinking.
   */
  roomArgs?: string;
}

/** git's own wording, without the command line execFile prepends to it. */
function clean(message: string): string {
  return message.replace(/^Command failed:.*\n?/, '').trim();
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * The main working tree of the repository `dir` belongs to, whether or not
 * `dir` is already that tree.
 *
 * `--git-common-dir` is the `.git` shared by every worktree of the repository,
 * so its parent is the main working tree. Asking git beats guessing from the
 * registered repositories: there may be only one -- the worktree itself -- and
 * picking "some other repository" can land on an unrelated project entirely.
 *
 * undefined means the question could not be answered, never "`dir` is the main
 * checkout". Conflating those is what let a session promise the main checkout
 * and open in the worktree it was started from instead.
 */
async function resolveMainCheckout(dir: string): Promise<string | undefined> {
  try {
    // The first entry `git worktree list` prints is always the main worktree.
    // Deriving it from --git-common-dir instead only works for a plain or
    // linked checkout: inside a submodule the common dir is
    // `<super>/.git/modules/<name>`, whose parent is not a working tree at all,
    // and creating a worktree there plants a checkout inside `.git`.
    const listed = await git(dir, ['worktree', 'list', '--porcelain']);
    const first = listed
      .split('\n')
      .find(line => line.startsWith('worktree '))
      ?.slice('worktree '.length)
      .trim();
    if (!first) {
      return undefined;
    }
    // Inside a submodule git names the module's git dir as the main worktree
    // -- `<super>/.git/modules/<name>` -- which is not a working tree at all.
    // Branching from there would plant a whole checkout inside `.git`.
    if (path.resolve(first).split(path.sep).includes('.git')) {
      return undefined;
    }
    return first;
  } catch {
    return undefined;
  }
}

/**
 * The main checkout a *linked* worktree belongs to, or undefined when this is
 * not a linked worktree -- which is what `removeWorktree` needs to know, since
 * git refuses to remove the main working tree.
 */
async function mainCheckoutOf(worktreeRoot: string): Promise<string | undefined> {
  const main = await resolveMainCheckout(worktreeRoot);
  if (!main) {
    return undefined;
  }
  return path.resolve(main) === path.resolve(worktreeRoot) ? undefined : main;
}

/**
 * The main checkout new worktrees are branched from.
 *
 * Never the active session's own root. Branching from a linked worktree puts
 * the new worktree *inside* it -- `.worktrees/a/.worktrees/b` -- where it shows
 * up as untracked files in the session you branched from. Resolve to the main
 * checkout however we got here.
 */
async function baseRepoRoot(
  gitApi: GitAPI,
  tracker: SessionTracker
): Promise<{ root: string; isMain: boolean } | { damaged: string } | undefined> {
  const candidate =
    tracker.activeSession?.root ??
    tracker.activeSession?.repository?.rootUri.fsPath ??
    gitApi.repositories[0]?.rootUri.fsPath;
  if (!candidate) {
    return undefined;
  }

  // Ask git before building anything on this path. A `.git` that git rejects
  // -- one whose HEAD has been deleted, which is what temp cleanup does to a
  // repository under /tmp -- used to get all the way to `git branch --list`
  // and report "not a git repository" as though the user had typed it.
  if (!(await isRepository(candidate))) {
    return { damaged: candidate };
  }

  // `isMain` is what the picker is allowed to claim. When git cannot say which
  // working tree is the main one -- a submodule, a repository it refuses -- the
  // candidate is all there is, and that candidate may well be the worktree the
  // session was started from. Falling back is right; calling the fallback the
  // main checkout is not.
  const main = await resolveMainCheckout(candidate);
  const root = main ?? candidate;
  // The main checkout is a different path, so it is worth the same question.
  return (await isRepository(root))
    ? { root, isMain: main !== undefined }
    : { damaged: root };
}

/**
 * Makes a repository where there is none, so starting a session just works.
 *
 * A folder that is not a repository is not an error worth stopping for: `git
 * init` is what anyone would do next, and refusing until they do it by hand
 * only moves the same work somewhere less convenient. Someone opening a fresh
 * codebase should be offered the fix, not told the same thing repeatedly.
 *
 * Asked rather than done, because a git repository appearing in a folder is a
 * real change to what is on disk. Modal because the session they just asked
 * for cannot continue until this is answered -- and it is asked only when they
 * start a session, never on a timer.
 *
 * `init` creates nothing it can destroy: it writes the files a git directory
 * is missing and leaves any objects alone, so it is also the right answer for
 * a `.git` git currently refuses, where it reinitialises rather than replaces.
 *
 * Modern git infers `--orphan` when adding a worktree to a repository with no
 * commits, so there is no need to manufacture an initial commit here.
 */
async function initRepository(
  gitApi: GitAPI,
  tracker: SessionTracker,
  damaged: string | undefined
): Promise<string | undefined> {
  const fallback = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  let target =
    damaged ??
    tracker.activeSession?.root ??
    tracker.activeSession?.cwd.fsPath ??
    fallback;

  // git failing here does not have to mean the repository is broken -- the
  // directory may simply be gone, which is what a worktree removed from
  // another terminal looks like while its row is still listed. Offering to
  // initialise a path that no longer exists would recreate it as a side
  // effect, so fall back to the folder that is actually open.
  if (target && !(await pathExists(target))) {
    target = fallback;
  }

  if (!target) {
    // Nothing open and no terminal to take a directory from. There is no
    // sensible place to put a repository, and guessing one would be worse.
    vscode.window.showErrorMessage(
      'Open a folder before starting a session, so there is somewhere to put it.'
    );
    return undefined;
  }

  // What to say is decided by what is on disk, not by how git failed. A
  // missing repository and an unreadable one need different sentences, and
  // `git rev-parse` failing does not say which it was.
  const unreadable = await pathExists(path.join(target, '.git'));

  const start = 'Initialize Repository';
  const chosen = await vscode.window.showInformationMessage(
    unreadable
      ? `${path.basename(target)} has a .git that git cannot read.`
      : `${path.basename(target)} is not a git repository yet.`,
    {
      modal: true,
      detail: unreadable
        ? 'Parallelo needs a working repository to branch a session from. ' +
          'Initializing writes the files the git directory is missing and leaves ' +
          'anything already stored there alone.'
        : 'Parallelo needs a repository to branch a session from. This runs ' +
          'git init here. Nothing is committed and none of your files change.'
    },
    start
  );
  if (chosen !== start) {
    return undefined;
  }

  try {
    await git(target, ['init']);
  } catch (error) {
    vscode.window.showErrorMessage(
      `Could not start a git repository in ${path.basename(target)}. ${clean(
        error instanceof Error ? error.message : String(error)
      )}`
    );
    return undefined;
  }

  // Register it, or the Changes view has nothing to read until something else
  // makes the git extension notice the new repository.
  try {
    await gitApi.openRepository(vscode.Uri.file(target));
  } catch {
    // It will be picked up on the next scan.
  }

  return target;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(target));
    return true;
  } catch {
    return false;
  }
}

/** Whether git will work in this directory at all. */
async function isRepository(dir: string): Promise<boolean> {
  try {
    return (await git(dir, ['rev-parse', '--is-inside-work-tree'])) === 'true';
  } catch {
    return false;
  }
}

/**
 * The branch a checkout is on, so the picker can name it.
 *
 * `--abbrev-ref HEAD` prints the literal string HEAD when detached, and fails
 * outright in a repository with no commits yet. Neither is a branch worth
 * showing, so both come back undefined and the copy leaves the branch out.
 */
async function currentBranch(dir: string): Promise<string | undefined> {
  try {
    const branch = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return branch && branch !== 'HEAD' ? branch : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A session with no row is a session you cannot get back to.
 *
 * `showMainCheckout` hides the main checkout's row, and someone working
 * entirely in worktrees is exactly who turns it off. A normal session lands
 * there on purpose, so leaving it unlisted would answer the request with a
 * terminal that appears in neither the Sessions view nor Switch Session.
 *
 * Offered rather than done: the setting was set deliberately, and one session
 * is not a reason to overrule it silently. Written back to the workspace when
 * that is where it was set, or a workspace `false` would keep winning over a
 * global `true` and the row would still not appear.
 *
 * No resource is passed and no folder target is considered. `showMainCheckout`
 * is window-scoped -- it declares no `scope`, and `window` is the default --
 * so VS Code neither applies it from folder settings nor reports one from
 * `inspect`. Scoping the read here would only be safe if `isListed` were
 * scoped to the same folder, and the two disagreeing is worse than neither
 * being scoped: the offer would read `true` and stay silent while the row read
 * `false` and stayed hidden.
 */
async function offerToShowMainCheckout(): Promise<void> {
  const config = vscode.workspace.getConfiguration('parallelo');
  if (config.get<boolean>('showMainCheckout', true)) {
    return;
  }

  // Says what happens rather than where the session is. The trigger is "this
  // will not be a linked worktree", which covers a submodule root as well as
  // the main checkout, and naming the wrong one of those is the conflation
  // this release set out to stop.
  const show = 'Show It';
  const chosen = await vscode.window.showInformationMessage(
    'This session has no worktree of its own, and the Sessions list is set to leave those rows out.',
    show
  );
  if (chosen !== show) {
    return;
  }

  const set = config.inspect<boolean>('showMainCheckout');
  const target =
    set?.workspaceValue !== undefined
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  await config.update('showMainCheckout', true, target);
}

/**
 * The checkout a new session or room branches from, initialising a repository
 * first if there is not one yet. Undefined means the user backed out or there
 * was nowhere to put one.
 */
export async function resolveBase(
  gitApi: GitAPI,
  tracker: SessionTracker
): Promise<{ base: string; isMain: boolean } | undefined> {
  const located = await baseRepoRoot(gitApi, tracker);
  const base =
    located && 'root' in located
      ? located.root
      : await initRepository(gitApi, tracker, located?.damaged);
  if (!base) {
    return undefined;
  }
  // A repository we just initialised is a main checkout by construction.
  return { base, isMain: located && 'root' in located ? located.isMain : true };
}

export async function newSession(
  gitApi: GitAPI,
  tracker: SessionTracker,
  seeded?: Seeded
): Promise<void> {
  const located = await resolveBase(gitApi, tracker);
  if (!located) {
    return;
  }
  const { base, isMain } = located;

  const config = vscode.workspace.getConfiguration('parallelo');

  // Not every session wants a worktree of its own. An agent that makes its own
  // (`claude --worktree` and the like) needs a checkout to make it from, and
  // Parallelo binds to whatever directory it moves itself into.
  //
  // That checkout is the base one, never whichever worktree the picker happened
  // to be opened from. Starting there put the agent on another session's
  // branch, editing its files, and any worktree it then made for itself nested
  // inside that one -- the same trap `baseRepoRoot` exists to keep the worktree
  // session out of. A session with no worktree of its own belongs on the base
  // branch.
  //
  // The worktree you are in is still offered, as an entry that says so. A
  // second terminal in a session an agent is already working in -- a dev
  // server, a test run -- is a real thing to want; it just is not what "no
  // worktree of its own" means.
  //
  // Compared canonically. `base` is whatever `git worktree list` printed, which
  // is the real path, while `here` is the path the terminal was given. On macOS
  // `/tmp/x` and `/private/tmp/x` are one directory that never compares equal,
  // and the difference alone would conjure a "This worktree" entry pointing at
  // the same place as the entry above it.
  const here = tracker.activeSession?.root;
  const [canonicalBase, canonicalHere] = await Promise.all([
    canonical(base),
    here === undefined ? Promise.resolve(undefined) : canonical(here)
  ]);
  const elsewhere = here !== undefined && canonicalHere !== canonicalBase ? here : undefined;
  const [baseBranch, hereBranch] = await Promise.all([
    currentBranch(base),
    elsewhere ? currentBranch(elsewhere) : Promise.resolve(undefined)
  ]);
  const baseName = path.basename(base);
  const on = (dir: string, branch: string | undefined) =>
    branch ? `${path.basename(dir)} on ${branch}` : path.basename(dir);

  const choices: {
    label: string;
    description: string;
    detail: string;
    cwd?: string;
    room?: boolean;
  }[] = [
    {
      label: '$(new-folder) Worktree session',
      description: 'isolated',
      detail:
        `New branch and worktree off ${baseName}, so this agent ` +
        'cannot touch what the others are editing'
    },
    {
      label: '$(folder-active) Normal session',
      description: on(base, baseBranch),
      detail:
        // Only say "the main checkout" when git actually confirmed one.
        `Run it in ${isMain ? 'the main checkout' : baseName}` +
        `${baseBranch ? `, on ${baseBranch}` : ''}, with no worktree of its own. ` +
        'Pick this for an agent that makes one itself, such as claude --worktree',
      cwd: base
    }
  ];
  if (elsewhere) {
    choices.push({
      label: '$(folder) This worktree',
      description: on(elsewhere, hereBranch),
      detail:
        'Another terminal in the session you opened this from. It shares that ' +
        'branch and its uncommitted changes',
      cwd: elsewhere
    });
  }

  choices.push({
    label: '$(comment-discussion) Brainstorming room',
    description: 'two agents',
    detail:
      'Two agents in one new worktree, arguing through a plan and writing a ' +
      'spec at the end. Pick the two on the next screen',
    room: true
  });

  const scope = await vscode.window.showQuickPick(choices, {
    title: 'What kind of session is this?'
  });
  if (!scope) {
    return;
  }
  if (scope.room) {
    await vscode.commands.executeCommand('parallelo.newRoom');
    return;
  }

  const agents = config.get<AgentChoice[]>('agents', []);
  const agent =
    agents.length > 1
      ? await vscode.window.showQuickPick(
          agents.map(a => ({ label: a.label, description: a.command || 'no command', agent: a })),
          { title: 'Which agent runs in this session?' }
        )
      : { agent: agents[0] };
  if (!agent) {
    return;
  }
  const command = agent.agent?.command?.trim();

  if (scope.cwd) {
    launch(scope.cwd, agent.agent?.label ?? 'Session', command, config, false);
    await tracker.sync();
    // `isListed` keys on `linked`, not on "is the main checkout", so everything
    // that is not a linked worktree is hidden by the same setting -- a
    // submodule root, or any checkout git would not answer for. Ask the
    // question `isListed` asks rather than a narrower one that misses those.
    if (!(await isLinkedWorktree(vscode.Uri.file(scope.cwd)))) {
      await offerToShowMainCheckout();
    }
    return;
  }

  const name = await vscode.window.showInputBox({
    title: 'Start worktree session',
    prompt: 'Name this session. It becomes the branch and the worktree folder.',
    placeHolder: 'checkout-refactor',
    validateInput: value =>
      /^[\w.\-\/]+$/.test(value) ? undefined : 'Use letters, numbers, dot, dash, underscore or slash.'
  });
  if (!name) {
    return;
  }

  const worktreePath = await createWorktree(gitApi, base, name, config, seeded);
  // Read from the base checkout, which is the one with the lockfile. Asking the
  // new worktree would work too, but only because the same file was just
  // checked out into it -- and not at all in the monorepo case where the
  // session is opened deeper than the lockfile lives.
  const install = config.get<boolean>('installDependencies', true)
    ? await detectInstallCommand(base)
    : undefined;
  launch(worktreePath, name, command, config, true, install);
  await tracker.sync();
}

/**
 * Add the worktree for `name`, copy the untracked files that do not come with
 * it, and register it with the git extension. Reuses the branch if it already
 * exists. Reports its own failure and rethrows.
 */
export async function createWorktree(
  gitApi: GitAPI,
  base: string,
  name: string,
  config: vscode.WorkspaceConfiguration,
  seeded?: Seeded
): Promise<string> {
  const dir = config.get<string>('worktreePath', '.worktrees');
  const prefix = config.get<string>('branchPrefix', 'session/');
  const worktreePath = path.isAbsolute(dir)
    ? path.join(dir, name)
    : path.join(base, dir, name);
  const branch = `${prefix}${name}`;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Creating worktree ${name}`,
      // Copying untracked files is the step with no known size -- an ignored
      // `vendor` or a directory of fixtures can be anything -- so there has to
      // be a way out that is not force-quitting the window.
      cancellable: true
    },
    async (progress, token) => {
      try {
        const branches = await git(base, ['branch', '--list', branch]);
        const args = branches
          ? ['worktree', 'add', worktreePath, branch]
          : ['worktree', 'add', '-b', branch, worktreePath];
        await git(base, args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Could not create the worktree. ${message}`);
        throw error;
      }

      // Untracked config never comes along with a worktree, so copy it over.
      // The named list first and unconditionally: it is how someone says "this
      // one, whatever else you decide", and it still works with the broad copy
      // turned off or the file sitting inside an excluded directory.
      for (const file of config.get<string[]>('copyFiles', [])) {
        const target = path.resolve(worktreePath, file);
        // A `..` in the setting would otherwise create directories outside the
        // worktree as a side effect of starting a session. Before there was a
        // `createDirectory` here the copy simply failed; now it has to be said.
        const relative = path.relative(worktreePath, target);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          log(`seed: copyFiles entry leaves the worktree, skipped: ${file}`);
          continue;
        }
        try {
          await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(target)));
          await vscode.workspace.fs.copy(
            vscode.Uri.file(path.join(base, file)),
            vscode.Uri.file(target),
            { overwrite: false }
          );
        } catch {
          // Missing source or existing target is fine.
        }
      }

      // Then everything else git does not track. A named list only covers the
      // files someone thought to name, and the one that stops the session
      // working is always the one they did not.
      if (config.get<boolean>('copyUntrackedFiles', true)) {
        progress.report({ message: 'Copying local files' });
        const copied = await copyUntrackedFiles(base, worktreePath, config, token, log);
        log(
          `seed: copied ${copied.length} untracked ` +
            `${copied.length === 1 ? 'file' : 'files'} into ${name}`
        );
        // What was copied is not what this session edited. Untracked files that
        // git is not ignoring arrive in the worktree as untracked files, which
        // is exactly what the conflict radar counts -- so it is told, and
        // subtracts them until an agent stages one.
        await seeded?.record(worktreePath, copied);
      }

      progress.report({ message: 'Registering with source control' });
      await gitApi.openRepository(vscode.Uri.file(worktreePath));
    }
  );
  return worktreePath;
}

/** Opens the terminal for a session and starts the agent in it. */
function launch(
  cwd: string,
  name: string,
  command: string | undefined,
  config: vscode.WorkspaceConfiguration,
  fresh: boolean,
  install?: string
): void {
  const terminal = vscode.window.createTerminal({
    name,
    cwd,
    iconPath: new vscode.ThemeIcon('robot')
  });
  terminal.show();

  // Only in a worktree we just made. The setting is "run once in a new
  // worktree"; re-running `bun install` in the checkout somebody is already
  // working in is not what they asked for.
  //
  // `setupCommand` wins when it is set. Someone who wrote out the command to
  // run here has already answered the question the lockfile is being read to
  // guess at, and running both would install twice.
  const setup = fresh ? config.get<string>('setupCommand', '').trim() || install || '' : '';
  if (setup) {
    terminal.sendText(setup);
  }
  if (command) {
    terminal.sendText(command);
  }
}

/**
 * What the confirmation came back with.
 *
 * `kept` covers cancelling and failing alike: both leave the worktree where it
 * was, which is the only thing the caller has to know. `closeSession` is the
 * way out of the dialog for someone who wanted one row gone, not the directory
 * -- see the note on the shared-worktree copy below.
 */
export type RemoveOutcome = 'removed' | 'closeSession' | 'kept';

/**
 * Removes a linked worktree, after saying what that costs.
 *
 * `sessions` is how many terminals are working in this worktree, the clicked
 * row included. It is not decoration: a worktree is one directory, so two rows
 * in it are two views of the same files, and removing it takes both. The
 * dialog has to say so, and has to offer the action the person probably meant.
 */
export async function removeWorktree(
  worktreeRoot: string,
  sessions = 1
): Promise<RemoveOutcome> {
  const base = await mainCheckoutOf(worktreeRoot);
  if (!base) {
    vscode.window.showErrorMessage(
      `Could not find the main checkout for ${path.basename(worktreeRoot)}. ` +
        'It may be the main checkout itself rather than a linked worktree.'
    );
    return 'kept';
  }

  // Say what is actually at stake. `git status --porcelain` counts staged,
  // unstaged and untracked in one go, which is exactly the set `--force`
  // throws away.
  const [dirty, branch] = await Promise.all([
    git(worktreeRoot, ['status', '--porcelain'])
      .then(out => out.split('\n').filter(Boolean).length)
      // A failed status is not a clean worktree. An agent that died holding
      // index.lock leaves exactly this, and treating it as "nothing to lose"
      // would drop the warning right when it matters most.
      .catch(() => undefined),
    git(worktreeRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')
  ]);

  // `--abbrev-ref HEAD` prints the literal string HEAD when detached. Commits
  // made there are on no branch, so removing the worktree loses them for good
  // -- the opposite of what the usual reassurance says.
  const detached = !branch || branch === 'HEAD';
  const kept = detached
    ? 'This worktree is not on a branch, so any commits made here are lost too.'
    : `The branch ${branch} is kept, so anything committed to it is safe.`;

  // What happens to the other rows, said before it happens.
  //
  // A row stands for a terminal, so two terminals in one worktree are two
  // rows -- and a worktree is one directory, so those two rows are two views
  // of the same files. Removing it therefore takes both, which is exactly the
  // surprise worth spending a sentence on: someone who deletes one of two rows
  // means to be rid of that row, not of the work behind both.
  const shared =
    sessions > 1
      ? `${sessions} terminals are working here and they share the same files, ` +
        `so all ${sessions} sessions go with the worktree.`
      : 'The terminal working here is closed.';

  const detail =
    dirty === undefined
      ? `Could not read the status of this worktree, so there may be uncommitted ` +
        `changes. Anything not committed will be lost. ${kept} ${shared}`
      : dirty
        ? `${dirty} ${dirty === 1 ? 'file has' : 'files have'} uncommitted changes. ` +
          `They are not on any branch and will be lost. ${kept} ${shared}`
        : `Nothing is uncommitted here. ${kept} ${shared}`;

  const remove = dirty === 0 && !detached ? 'Remove' : 'Remove and discard changes';
  const closeInstead = 'Close This Session';

  // The safe option comes first, so it is the one the dialog defaults to.
  // Only when the worktree is shared: with a single session there is nothing
  // to disentangle, and offering the choice there would put a second button in
  // front of everyone to solve a problem they do not have.
  const confirm = await vscode.window.showWarningMessage(
    `Remove the worktree at ${path.basename(worktreeRoot)}?`,
    { modal: true, detail },
    ...(sessions > 1 ? [closeInstead, remove] : [remove])
  );
  if (confirm === closeInstead) {
    return 'closeSession';
  }
  if (confirm !== remove) {
    return 'kept';
  }

  try {
    await git(base, ['worktree', 'remove', '--force', worktreeRoot]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A locked worktree needs the flag twice; one --force is not enough and
    // git says so rather than doing it.
    if (/locked working tree/i.test(message)) {
      try {
        await git(base, ['worktree', 'remove', '--force', '--force', worktreeRoot]);
      } catch (retry) {
        const failure = retry instanceof Error ? retry.message : String(retry);
        vscode.window.showErrorMessage(`Could not remove the worktree. ${clean(failure)}`);
        return 'kept';
      }
      vscode.window.showInformationMessage(`Removed worktree ${path.basename(worktreeRoot)}.`);
      return 'removed';
    }
    vscode.window.showErrorMessage(`Could not remove the worktree. ${clean(message)}`);
    return 'kept';
  }

  vscode.window.showInformationMessage(`Removed worktree ${path.basename(worktreeRoot)}.`);
  return 'removed';
}
