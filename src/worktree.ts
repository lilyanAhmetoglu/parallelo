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

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

/** Picks the repository new worktrees are branched from. */
function baseRepoRoot(gitApi: GitAPI, tracker: SessionTracker): string | undefined {
  const active = tracker.activeSession?.repository?.rootUri.fsPath;
  if (active) {
    return active;
  }
  return gitApi.repositories[0]?.rootUri.fsPath;
}

export async function newSession(
  gitApi: GitAPI,
  tracker: SessionTracker
): Promise<void> {
  const base = baseRepoRoot(gitApi, tracker);
  if (!base) {
    vscode.window.showErrorMessage('Open a git repository to start a session.');
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

  const terminal = vscode.window.createTerminal({
    name: name,
    cwd: worktreePath,
    iconPath: new vscode.ThemeIcon('robot')
  });
  terminal.show();

  const setup = config.get<string>('setupCommand', '').trim();
  if (setup) {
    terminal.sendText(setup);
  }
  const command = agent.agent?.command?.trim();
  if (command) {
    terminal.sendText(command);
  }

  await tracker.sync();
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

export async function removeWorktree(worktreeRoot: string): Promise<boolean> {
  const base = await mainCheckoutOf(worktreeRoot);
  if (!base) {
    vscode.window.showErrorMessage(
      `Could not find the main checkout for ${path.basename(worktreeRoot)}. ` +
        'It may be the main checkout itself rather than a linked worktree.'
    );
    return false;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Remove the worktree at ${path.basename(worktreeRoot)}?`,
    {
      modal: true,
      detail:
        'Uncommitted changes in this worktree will be lost. The branch is kept, ' +
        'and the terminals working in it are closed.'
    },
    'Remove'
  );
  if (confirm !== 'Remove') {
    return false;
  }

  try {
    await git(base, ['worktree', 'remove', '--force', worktreeRoot]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Could not remove the worktree. ${message.trim()}`);
    return false;
  }

  vscode.window.showInformationMessage(`Removed worktree ${path.basename(worktreeRoot)}.`);
  return true;
}
