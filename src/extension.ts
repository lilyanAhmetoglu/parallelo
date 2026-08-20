import * as vscode from 'vscode';
import type { GitExtension, API as GitAPI } from './git';
import { SessionTracker } from './sessionTracker';
import { ChangesProvider, type ChangeNode } from './changesProvider';
import { FilesProvider } from './filesProvider';
import { SessionsProvider } from './sessionsProvider';
import { newSession, removeWorktree } from './worktree';
import type { Session } from './sessionTracker';
import { SessionStyles, COLORS, ICONS } from './sessionStyles';
import { StashGuard } from './stashGuard';
import { ConflictRadar } from './conflictRadar';
import { log, showLog, disposeLog } from './log';

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
      'Parallelo Session needs the built-in Git extension. Enable it and reload the window.'
    );
    return;
  }

  const tracker = new SessionTracker(git);
  const styles = new SessionStyles(context.globalState);
  const changes = new ChangesProvider(tracker, git, styles);
  const files = new FilesProvider(tracker);
  const radar = new ConflictRadar(tracker, styles);
  const sessions = new SessionsProvider(tracker, styles, radar);
  const stashGuard = new StashGuard(tracker);

  const changesView = vscode.window.createTreeView('worktreeSessions.changes', {
    treeDataProvider: changes,
    showCollapseAll: true
  });
  const filesView = vscode.window.createTreeView('worktreeSessions.files', {
    treeDataProvider: files,
    showCollapseAll: true
  });
  const sessionsView = vscode.window.createTreeView('worktreeSessions.sessions', {
    treeDataProvider: sessions,
    dragAndDropController: sessions,
    canSelectMany: true
  });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  // The status bar already says which session is active, so the useful thing to
  // do with it is change session, not open a view that says the same again.
  status.command = 'parallelo.quickSwitch';

  /** Terminal whose row is already selected, so it is only revealed once. */
  let revealed: vscode.Terminal | undefined;

  const paint = (session: Session | undefined) => {
    changesView.title = changes.describe(session);
    filesView.title = session ? `Files \u2014 ${styles.title(session)}` : 'Files';

    // Move the selection onto the row for the focused terminal. Switching
    // terminals from the panel's tab list is a terminal event and never touches
    // the tree, so without this the list stays on whatever was last clicked and
    // stops agreeing with the titles above. `focus: false` leaves the keyboard
    // where it was -- selecting a row does not run its command, so this cannot
    // bounce focus back into the terminal.
    //
    // Only on an actual switch. This runs on every git state change of the
    // active repository too, and re-selecting on each one would drag the
    // highlight back off whatever row the user had just arrowed onto.
    // A hidden session has no row to select. Asking anyway rejects with "Data
    // tree node not found", and the catch below clears `revealed` so the next
    // event tries again -- and this runs on every git state change of the
    // active repository, so working in a hidden session would spin that retry
    // continuously and fill the log with it.
    if (!session || styles.isHidden(session)) {
      revealed = undefined;
    } else if (session.terminal !== revealed && sessionsView.visible) {
      revealed = session.terminal;
      void Promise.resolve(
        sessionsView.reveal(session, { select: true, focus: false })
      ).catch(error => {
        // Nothing retries this, so let the next switch back onto this terminal
        // try again rather than treating it as already selected.
        revealed = undefined;
        log(`sessions: could not select the row for ${session.terminal.name} -- ${error}`);
      });
    }

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

  // Gates the "Show Hidden Sessions" button. Without this the view title
  // would carry a permanent button for a state almost nobody is ever in.
  const syncHiddenContext = () => {
    void vscode.commands.executeCommand(
      'setContext',
      'parallelo.hasHiddenSessions',
      styles.hiddenAmong(tracker.allSessions).length > 0
    );
  };

  paint(tracker.activeSession);
  syncHiddenContext();
  void styles.prune().then(() => styles.autoAssign(tracker.allSessions));

  context.subscriptions.push(
    tracker,
    stashGuard,
    radar,
    changesView,
    filesView,
    sessionsView,
    status,
    styles,
    tracker.onDidChangeSession(paint),
    tracker.onDidChangeSessions(() => void styles.autoAssign(tracker.allSessions)),
    tracker.onDidChangeSessions(syncHiddenContext),
    styles.onDidChange(() => paint(tracker.activeSession)),
    styles.onDidChange(syncHiddenContext),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('parallelo.autoSessionColors')) {
        void styles.syncAutoColors(tracker.allSessions);
      }
    }),

    // The conflict mark on a session row. Registered rather than a view
    // option because file decorations are window-wide.
    vscode.window.registerFileDecorationProvider(radar),

    vscode.commands.registerCommand('parallelo.showLog', () => showLog()),
    new vscode.Disposable(() => disposeLog()),

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

    vscode.commands.registerCommand('parallelo.openChange', (node?: ChangeNode) =>
      changes.openChange(node)
    ),

    vscode.commands.registerCommand('parallelo.discardChange', (node?: ChangeNode) =>
      changes.discardChange(node)
    ),

    vscode.commands.registerCommand('parallelo.unstageChange', (node?: ChangeNode) =>
      changes.unstageChange(node)
    ),

    vscode.commands.registerCommand('parallelo.focusTerminal', (session?: Session) => {
      (session ?? tracker.activeSession)?.terminal.show(false);
    }),

    vscode.commands.registerCommand('parallelo.pinSession', async (session?: Session) => {
      const target = session ?? tracker.activeSession;
      if (!target) {
        vscode.window.showInformationMessage('No session is active.');
        return;
      }
      // Position clears with the group. An `order` means a place inside one
      // section, so carrying it into the other one drops the row at an
      // arbitrary height; the end of the section it just joined is at least
      // somewhere the user can predict.
      await styles.update(target, { pinned: true, order: undefined });
    }),

    vscode.commands.registerCommand('parallelo.unpinSession', async (session?: Session) => {
      const target = session ?? tracker.activeSession;
      if (!target) {
        vscode.window.showInformationMessage('No session is active.');
        return;
      }
      await styles.update(target, { pinned: undefined, order: undefined });
    }),

    vscode.commands.registerCommand('parallelo.hideSession', async (session?: Session) => {
      const target = session ?? tracker.activeSession;
      if (!target) {
        vscode.window.showInformationMessage('No session is active.');
        return;
      }
      // Hiding is keyed by worktree, like every other bit of appearance, so a
      // worktree with two terminals in it goes as one thing rather than
      // leaving half of itself behind.
      await styles.update(target, { hidden: true });
      const undo = 'Show It Again';
      void vscode.window
        .showInformationMessage(
          `${styles.title(target)} is hidden. Its terminal is still running.`,
          undo
        )
        .then(
          choice => {
            if (choice === undo) {
              void styles.update(target, { hidden: undefined });
            }
          },
          () => {
            // The window is going away.
          }
        );
    }),

    vscode.commands.registerCommand('parallelo.showHiddenSessions', async () => {
      await styles.unhideAll();
    }),

    vscode.commands.registerCommand('parallelo.quickSwitch', async () => {
      // The same list the view shows. A hidden session appearing in the picker
      // would be the row you just asked to stop seeing, offered back.
      const live = styles.arrange(tracker.allSessions);
      const ordered = live.filter(session => !styles.isHidden(session));
      if (!ordered.length) {
        // Hiding the only session is the case this feature was built for, and
        // the status bar still names it -- so saying nothing is running would
        // contradict the thing that was just clicked to get here.
        if (live.length) {
          const show = 'Show Hidden Sessions';
          const choice = await vscode.window.showInformationMessage(
            live.length === 1
              ? 'The only session is hidden. Its terminal is still running.'
              : `All ${live.length} sessions are hidden. Their terminals are still running.`,
            show
          );
          if (choice === show) {
            await vscode.commands.executeCommand('parallelo.showHiddenSessions');
          }
          return;
        }
        vscode.window.showInformationMessage(
          'No sessions are running. Start one from the Sessions view.'
        );
        return;
      }

      const active = tracker.activeSession;
      // One session, and it is the one you are already in. A picker would
      // offer the only thing you have, and focusing it would do nothing at
      // all, so show the list it lives in instead.
      if (ordered.length === 1) {
        if (ordered[0].terminal === active?.terminal) {
          await vscode.commands.executeCommand(
            'workbench.view.extension.worktreeSessions'
          );
        } else {
          ordered[0].terminal.show(false);
        }
        return;
      }

      const picked = await vscode.window.showQuickPick(
        ordered.map(session => {
          const style = styles.get(session);
          const head = session.repository?.state.HEAD;
          const dirty =
            (session.repository?.state.workingTreeChanges.length ?? 0) +
            (session.repository?.state.indexChanges.length ?? 0);
          // Two terminals in one worktree share a name, and choosing between
          // terminals is this picker's entire job -- so name the terminal too,
          // exactly as the rows do.
          const shared =
            session.root !== undefined &&
            ordered.filter(other => other.root === session.root).length > 1;
          return {
            // The same expression the rows use. `styles.title` would label the
            // picker by worktree and the row by terminal, and then nothing
            // connects the two.
            label: `${style.pinned ? '$(pinned) ' : ''}${style.name || session.terminal.name}`,
            description: [
              head?.name,
              head?.ahead ? `\u2191${head.ahead}` : '',
              head?.behind ? `\u2193${head.behind}` : '',
              shared ? session.terminal.name : '',
              dirty ? `${dirty} changed` : '',
              // Worth knowing before you switch, not after -- and the picker
              // is where you choose which session to go and look at.
              radar.describe(session)?.summary ?? '',
              session.terminal === active?.terminal ? 'current' : ''
            ]
              .filter(Boolean)
              .join(' \u00b7 '),
            detail: session.cwd.fsPath,
            session
          };
        }),
        {
          placeHolder: 'Switch to a session',
          matchOnDescription: true,
          matchOnDetail: true
        }
      );
      picked?.session.terminal.show(false);
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
            description: style.color
              ? `${style.color.replace('terminal.ansi', '')}${style.autoColor ? ' (automatic)' : ''}`
              : 'none',
            command: 'parallelo.setSessionColor'
          },
          {
            label: '$(symbol-event) Icon',
            description: style.icon ?? 'default',
            command: 'parallelo.setSessionIcon'
          },
          {
            label: style.pinned ? '$(pin) Unpin from top' : '$(pinned) Pin to top',
            description: style.pinned ? 'currently pinned' : '',
            command: style.pinned ? 'parallelo.unpinSession' : 'parallelo.pinSession'
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
          { label: 'No colour', id: undefined },
          // Offering this with auto colours switched off would just clear the
          // colour and leave no way back except finding the setting.
          ...(styles.autoColorsEnabled()
            ? [{ label: 'Automatic', description: 'let Parallelo choose', id: undefined, auto: true }]
            : [])
        ],
        { placeHolder: 'Colour for this session' }
      );
      if (!picked) {
        return;
      }
      // Choosing a colour, or choosing none, is a decision autoAssign has to
      // leave alone. Only "Automatic" hands the session back to it.
      await styles.update(target, {
        color: picked.id,
        autoColor: 'auto' in picked ? undefined : false
      });
      // Always re-run: picking Automatic needs a colour handing out, and
      // picking a concrete one may have taken it off a session that held it
      // automatically. Either way, waiting for the next session change would
      // leave two rows the same colour in the meantime.
      await styles.autoAssign(tracker.allSessions);
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
        // Reset means back to automatic, so hand out a colour again now.
        await styles.autoAssign(tracker.allSessions);
      }
    }),

    // Closing the terminal is the non-destructive way to make a session go
    // away: the worktree, the branch and every uncommitted change stay put.
    // Without this the only action on a row was the one that deletes the lot.
    vscode.commands.registerCommand('parallelo.closeSession', async (session?: Session) => {
      const target = session ?? tracker.activeSession;
      if (!target) {
        vscode.window.showInformationMessage('No session is active.');
        return;
      }
      // Every terminal in that worktree, so a worktree with two terminals in
      // it does not leave a second row behind that looks like a duplicate.
      const doomed = target.root
        ? tracker.allSessions.filter(other => other.root === target.root)
        : [target];
      doomed.forEach(other => tracker.close(other.terminal));
    }),

    vscode.commands.registerCommand('parallelo.removeWorktree', async (session: Session) => {
      // `root` comes off the filesystem and is always there; `repository` is
      // registered asynchronously and is undefined for the first moments after
      // a reload. Reading only the latter refused to remove a perfectly real
      // worktree whenever git had not caught up yet.
      const root = session?.root ?? session?.repository?.rootUri.fsPath;
      if (!root) {
        vscode.window.showInformationMessage('This session is not in a worktree.');
        return;
      }

      if (!(await removeWorktree(root))) {
        return;
      }

      // The directory is gone, so every terminal still sitting in it is
      // pointing at nothing. Close them: that is what drops the rows from the
      // Sessions view, which otherwise keeps showing a worktree that no longer
      // exists.
      tracker.allSessions
        .filter(other => other.root === root || other.repository?.rootUri.fsPath === root)
        .forEach(other => tracker.close(other.terminal));

      // Appearance is keyed by worktree path, so a removed worktree would
      // otherwise leave a record behind for good.
      await styles.clear(session);
    })
  );
}

export function deactivate(): void {
  // Everything is registered through context.subscriptions.
}
