import * as vscode from 'vscode';
import type { GitExtension, API as GitAPI } from './git';
import { SessionTracker } from './sessionTracker';
import { ChangesProvider, type ChangeNode } from './changesProvider';
import { FilesProvider } from './filesProvider';
import { SessionsProvider } from './sessionsProvider';
import { newSession, removeWorktree } from './worktree';
import type { Session } from './sessionTracker';
import { SessionStyles, COLORS, ICONS } from './sessionStyles';

async function getGitApi(): Promise<GitAPI | undefined> {
  const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!extension) {
    return undefined;
  }
  const exports = extension.isActive ? extension.exports : await extension.activate();
  return exports.enabled ? exports.getAPI(1) : undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const git = await getGitApi();
  if (!git) {
    vscode.window.showWarningMessage(
      'Agent Sessions needs the built-in Git extension. Enable it and reload the window.'
    );
    return;
  }

  const tracker = new SessionTracker(git);
  const styles = new SessionStyles(context.globalState);
  const changes = new ChangesProvider(tracker, git, styles);
  const files = new FilesProvider(tracker);
  const sessions = new SessionsProvider(tracker, styles);

  const changesView = vscode.window.createTreeView('worktreeSessions.changes', {
    treeDataProvider: changes,
    showCollapseAll: true
  });
  const filesView = vscode.window.createTreeView('worktreeSessions.files', {
    treeDataProvider: files,
    showCollapseAll: true
  });
  const sessionsView = vscode.window.createTreeView('worktreeSessions.sessions', {
    treeDataProvider: sessions
  });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'workbench.view.extension.worktreeSessions';

  const paint = (session: Session | undefined) => {
    changesView.title = changes.describe(session);
    filesView.title = session ? `Files \u2014 ${styles.title(session)}` : 'Files';

    const show = vscode.workspace
      .getConfiguration('parallelo')
      .get<boolean>('showStatusBar', true);
    if (!show || !session?.repository) {
      status.hide();
      return;
    }
    const branch = session.repository.state.HEAD?.name ?? 'detached';
    const dirty =
      session.repository.state.workingTreeChanges.length +
      session.repository.state.indexChanges.length;
    status.text = `$(git-branch) ${branch}${dirty ? ` $(diff) ${dirty}` : ''}`;
    status.tooltip = `${styles.title(session)}\n${session.cwd.fsPath}`;
    status.show();
  };

  paint(tracker.activeSession);

  context.subscriptions.push(
    tracker,
    changesView,
    filesView,
    sessionsView,
    status,
    styles,
    tracker.onDidChangeSession(paint),
    styles.onDidChange(() => paint(tracker.activeSession)),

    vscode.commands.registerCommand('parallelo.refresh', async () => {
      await tracker.syncAll();
      await tracker.activeSession?.repository?.status();
      changes.refresh();
      files.refresh();
      sessions.refresh();
    }),

    vscode.commands.registerCommand('parallelo.newSession', () =>
      newSession(git, tracker)
    ),

    vscode.commands.registerCommand('parallelo.openChange', (node: ChangeNode) =>
      changes.openChange(node)
    ),

    vscode.commands.registerCommand('parallelo.focusTerminal', (session: Session) => {
      session.terminal.show(false);
    }),

    vscode.commands.registerCommand('parallelo.stageAll', async () => {
      const repo = tracker.activeSession?.repository;
      if (!repo) {
        vscode.window.showInformationMessage('No session is active.');
        return;
      }
      const paths = repo.state.workingTreeChanges.map(c => c.uri.fsPath);
      if (!paths.length) {
        vscode.window.showInformationMessage('This session has nothing to stage.');
        return;
      }
      await repo.add(paths);
    }),

    vscode.commands.registerCommand('parallelo.revealInScm', async () => {
      const repo = tracker.activeSession?.repository;
      if (!repo) {
        return;
      }
      await vscode.commands.executeCommand('workbench.view.scm');
      await vscode.commands.executeCommand('scm.repositories.focus', repo.rootUri);
    }),

    vscode.commands.registerCommand('parallelo.customizeSession', async (session?: Session) => {
      const target = session ?? tracker.activeSession;
      if (!target) {
        vscode.window.showInformationMessage('No session is active.');
        return;
      }
      const style = styles.get(target);
      const picked = await vscode.window.showQuickPick(
        [
          {
            label: '$(edit) Rename',
            description: style.name ?? target.terminal.name,
            command: 'parallelo.renameSession'
          },
          {
            label: '$(symbol-color) Color',
            description: style.color ? style.color.replace('terminal.ansi', '') : 'none',
            command: 'parallelo.setSessionColor'
          },
          {
            label: '$(symbol-event) Icon',
            description: style.icon ?? 'default',
            command: 'parallelo.setSessionIcon'
          },
          {
            label: '$(discard) Reset appearance',
            description: '',
            command: 'parallelo.resetSessionStyle'
          }
        ],
        { placeHolder: `Customize ${styles.title(target)}` }
      );
      if (picked) {
        await vscode.commands.executeCommand(picked.command, target);
      }
    }),

    vscode.commands.registerCommand('parallelo.renameSession', async (session?: Session) => {
      const target = session ?? tracker.activeSession;
      if (!target) {
        vscode.window.showInformationMessage('No session is active.');
        return;
      }
      const name = await vscode.window.showInputBox({
        prompt: 'Name for this session',
        value: styles.get(target).name ?? target.terminal.name,
        placeHolder: target.label
      });
      if (name === undefined) {
        return;
      }
      await styles.update(target, { name: name.trim() || undefined });
    }),

    vscode.commands.registerCommand('parallelo.setSessionColor', async (session?: Session) => {
      const target = session ?? tracker.activeSession;
      if (!target) {
        vscode.window.showInformationMessage('No session is active.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        [
          ...COLORS.map(c => ({ label: c.label, id: c.id as string | undefined })),
          { label: 'No colour', id: undefined }
        ],
        { placeHolder: 'Colour for this session' }
      );
      if (!picked) {
        return;
      }
      await styles.update(target, { color: picked.id });
    }),

    vscode.commands.registerCommand('parallelo.setSessionIcon', async (session?: Session) => {
      const target = session ?? tracker.activeSession;
      if (!target) {
        vscode.window.showInformationMessage('No session is active.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        [
          ...ICONS.map(id => ({ label: `$(${id}) ${id}`, id: id as string | undefined })),
          { label: 'Default icon', id: undefined }
        ],
        { placeHolder: 'Icon for this session' }
      );
      if (!picked) {
        return;
      }
      await styles.update(target, { icon: picked.id });
    }),

    vscode.commands.registerCommand('parallelo.resetSessionStyle', async (session?: Session) => {
      const target = session ?? tracker.activeSession;
      if (target) {
        await styles.clear(target);
      }
    }),

    vscode.commands.registerCommand('parallelo.removeWorktree', (session: Session) => {
      const root = session?.repository?.rootUri.fsPath;
      if (!root) {
        vscode.window.showInformationMessage('This session is not in a worktree.');
        return;
      }
      return removeWorktree(git, root);
    })
  );
}

export function deactivate(): void {
  // Everything is registered through context.subscriptions.
}
