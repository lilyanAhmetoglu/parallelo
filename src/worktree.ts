import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { API as GitAPI } from './git';
import type { SessionTracker } from './sessionTracker';

const run = promisify(execFile);

interface AgentChoice {
  label: string;
  command?: string;
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
 * is not a reason to overrule it silently. Written back wherever it was set,
 * or a workspace value would keep winning over the update and the row would
 * still not appear.
 */
async function offerToShowMainCheckout(): Promise<void> {
  const config = vscode.workspace.getConfiguration('parallelo');
  if (config.get<boolean>('showMainCheckout', true)) {
    return;
  }

  const show = 'Show It';
  const chosen = await vscode.window.showInformationMessage(
    'This session runs in the main checkout, and the Sessions list is set to leave that row out.',
    show
  );
  if (chosen !== show) {
    return;
  }

  const set = config.inspect<boolean>('showMainCheckout');
  const target =
    set?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : set?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
  await config.update('showMainCheckout', true, target);
}

export async function newSession(
  gitApi: GitAPI,
  tracker: SessionTracker
): Promise<void> {
  const located = await baseRepoRoot(gitApi, tracker);
  const base =
    located && 'root' in located
      ? located.root
      : await initRepository(gitApi, tracker, located?.damaged);
  if (!base) {
    return;
  }
  // A repository we just initialised is a main checkout by construction.
  const isMain = located && 'root' in located ? located.isMain : true;

  const config = vscode.workspace.getConfiguration('parallelo');
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
  const here = tracker.activeSession?.root;
  const elsewhere =
    here !== undefined && path.resolve(here) !== path.resolve(base) ? here : undefined;
  const [baseBranch, hereBranch] = await Promise.all([
    currentBranch(base),
    elsewhere ? currentBranch(elsewhere) : Promise.resolve(undefined)
  ]);
  const baseName = path.basename(base);
  const on = (dir: string, branch: string | undefined) =>
    branch ? `${path.basename(dir)} on ${branch}` : path.basename(dir);

  const choices: { label: string; description: string; detail: string; cwd?: string }[] = [
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

  const scope = await vscode.window.showQuickPick(choices, {
    title: 'What kind of session is this?'
  });
  if (!scope) {
    return;
  }

  if (scope.cwd) {
    launch(scope.cwd, agent.agent?.label ?? 'Session', command, config, false);
    await tracker.sync();
    // Only the main checkout's row can be switched off, and only a session
    // landing there can go missing because of it.
    if (scope.cwd === base && isMain) {
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

  const dir = config.get<string>('worktreePath', '.worktrees');
  const prefix = config.get<string>('branchPrefix', 'session/');
  const worktreePath = path.isAbsolute(dir)
    ? path.join(dir, name)
    : path.join(base, dir, name);
  const branch = `${prefix}${name}`;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Creating worktree ${name}` },
    async progress => {
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
      for (const file of config.get<string[]>('copyFiles', [])) {
        const from = vscode.Uri.file(path.join(base, file));
        const to = vscode.Uri.file(path.join(worktreePath, file));
        try {
          await vscode.workspace.fs.copy(from, to, { overwrite: false });
        } catch {
          // Missing source or existing target is fine.
        }
      }

      progress.report({ message: 'Registering with source control' });
      await gitApi.openRepository(vscode.Uri.file(worktreePath));
    }
  );

  launch(worktreePath, name, command, config, true);
  await tracker.sync();
}

/** Opens the terminal for a session and starts the agent in it. */
function launch(
  cwd: string,
  name: string,
  command: string | undefined,
  config: vscode.WorkspaceConfiguration,
  fresh: boolean
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
  const setup = fresh ? config.get<string>('setupCommand', '').trim() : '';
  if (setup) {
    terminal.sendText(setup);
  }
  if (command) {
    terminal.sendText(command);
  }
}

export async function removeWorktree(worktreeRoot: string): Promise<boolean> {
  const base = await mainCheckoutOf(worktreeRoot);
  if (!base) {
    vscode.window.showErrorMessage(
      `Could not find the main checkout for ${path.basename(worktreeRoot)}. ` +
        'It may be the main checkout itself rather than a linked worktree.'
    );
    return false;
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

  const detail =
    dirty === undefined
      ? `Could not read the status of this worktree, so there may be uncommitted ` +
        `changes. Anything not committed will be lost. ${kept} ` +
        'The terminals working here are closed.'
      : dirty
        ? `${dirty} ${dirty === 1 ? 'file has' : 'files have'} uncommitted changes. ` +
          `They are not on any branch and will be lost. ${kept} ` +
          'The terminals working here are closed.'
        : `Nothing is uncommitted here. ${kept} The terminals working here are closed.`;

  const confirm = await vscode.window.showWarningMessage(
    `Remove the worktree at ${path.basename(worktreeRoot)}?`,
    { modal: true, detail },
    dirty === 0 && !detached ? 'Remove' : 'Remove and discard changes'
  );
  if (!confirm) {
    return false;
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
        return false;
      }
      vscode.window.showInformationMessage(`Removed worktree ${path.basename(worktreeRoot)}.`);
      return true;
    }
    vscode.window.showErrorMessage(`Could not remove the worktree. ${clean(message)}`);
    return false;
  }

  vscode.window.showInformationMessage(`Removed worktree ${path.basename(worktreeRoot)}.`);
  return true;
}
