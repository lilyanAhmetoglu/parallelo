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

export async function removeWorktree(
  gitApi: GitAPI,
  worktreeRoot: string
): Promise<void> {
  const base = gitApi.repositories.find(
    r => r.rootUri.fsPath !== worktreeRoot
  )?.rootUri.fsPath;
  if (!base) {
    vscode.window.showErrorMessage('Could not find the main checkout for this worktree.');
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Remove the worktree at ${path.basename(worktreeRoot)}?`,
    { modal: true, detail: 'Uncommitted changes in this worktree will be lost. The branch is kept.' },
    'Remove'
  );
  if (confirm !== 'Remove') {
    return;
  }

  try {
    await git(base, ['worktree', 'remove', '--force', worktreeRoot]);
    vscode.window.showInformationMessage(`Removed worktree ${path.basename(worktreeRoot)}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Could not remove the worktree. ${message}`);
  }
}
