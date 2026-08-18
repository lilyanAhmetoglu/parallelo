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
 * The main checkout a worktree belongs to.
 *
 * `--git-common-dir` is the `.git` shared by every worktree of the repository,
 * so its parent is the main working tree. Asking git beats guessing from the
 * registered repositories: there may be only one -- the worktree itself -- and
 * picking "some other repository" can land on an unrelated project entirely.
 */
async function mainCheckoutOf(worktreeRoot: string): Promise<string | undefined> {
  try {
    const common = await git(worktreeRoot, ['rev-parse', '--git-common-dir']);
    const root = path.dirname(path.resolve(worktreeRoot, common));
    return root === worktreeRoot ? undefined : root;
  } catch {
    return undefined;
  }
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
): Promise<string | undefined> {
  const candidate =
    tracker.activeSession?.root ??
    tracker.activeSession?.repository?.rootUri.fsPath ??
    gitApi.repositories[0]?.rootUri.fsPath;
  if (!candidate) {
    return undefined;
  }
  return (await mainCheckoutOf(candidate)) ?? candidate;
}

export async function newSession(
  gitApi: GitAPI,
  tracker: SessionTracker
): Promise<void> {
  const base = await baseRepoRoot(gitApi, tracker);
  if (!base) {
    vscode.window.showErrorMessage('Open a git repository to start a session.');
    return;
  }

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
  // (`claude --worktree` and the like) needs to be started where you already
  // are, and Parallelo binds to whatever directory it moves itself into.
  const here = tracker.activeSession?.root ?? base;
  const scope = await vscode.window.showQuickPick(
    [
      {
        label: '$(new-folder) New worktree',
        detail: `Branch off ${path.basename(base)} and work in a directory of its own`,
        fresh: true
      },
      {
        label: '$(folder-active) Stay in this one',
        detail: `Run it in ${path.basename(here)}, with no new branch or worktree`,
        fresh: false
      }
    ],
    { title: 'Where should this session work?' }
  );
  if (!scope) {
    return;
  }

  if (!scope.fresh) {
    launch(here, agent.agent?.label ?? 'Session', command, config);
    await tracker.sync();
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

  launch(worktreePath, name, command, config);
  await tracker.sync();
}

/** Opens the terminal for a session and starts the agent in it. */
function launch(
  cwd: string,
  name: string,
  command: string | undefined,
  config: vscode.WorkspaceConfiguration
): void {
  const terminal = vscode.window.createTerminal({
    name,
    cwd,
    iconPath: new vscode.ThemeIcon('robot')
  });
  terminal.show();

  const setup = config.get<string>('setupCommand', '').trim();
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
      .catch(() => 0),
    git(worktreeRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')
  ]);

  const kept = branch
    ? `The branch ${branch} is kept, so anything committed to it is safe.`
    : 'The branch is kept, so anything committed to it is safe.';
  const detail = dirty
    ? `${dirty} ${dirty === 1 ? 'file has' : 'files have'} uncommitted changes. ` +
      `They are not on any branch and will be lost. ${kept} ` +
      'The terminals working here are closed.'
    : `Nothing is uncommitted here. ${kept} The terminals working here are closed.`;

  const confirm = await vscode.window.showWarningMessage(
    `Remove the worktree at ${path.basename(worktreeRoot)}?`,
    { modal: true, detail },
    dirty ? 'Remove and discard changes' : 'Remove'
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
