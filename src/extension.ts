import * as vscode from 'vscode';
import type { GitExtension, API as GitAPI } from './git';
import { SessionTracker, changeCount, isListed } from './sessionTracker';
import {
  ChangesProvider,
  type ChangeNode,
  type GroupNode,
  type BaselineFileNode
} from './changesProvider';
import { FilesProvider } from './filesProvider';
import { SessionsProvider } from './sessionsProvider';
import { newSession, removeWorktree } from './worktree';
import { newRoom, sendKickoff, showTranscript } from './room';
import {
  canonical,
  openWorktreeTerminals,
  openWorktreeTerminalsOnStartup
} from './worktreeTerminals';
import type { Session } from './sessionTracker';
import { SessionStyles, COLORS, ICONS } from './sessionStyles';
import { Baselines } from './baselines';
import { StashGuard } from './stashGuard';
import { ConflictRadar } from './conflictRadar';
import { Seeded } from './seeded';
import { SessionStatus } from './sessionStatus';
import { setUpStatusHooks } from './statusHooks';
import { log, showLog, disposeLog } from './log';

/**
 * How long git gets to come up before Parallelo says anything about it.
 *
 * Long enough that an ordinary slow start stays silent, short enough that
 * someone whose git really is unavailable is not left guessing.
 */
const GIT_GRACE_MS = 20_000;

/** Set once the views and commands are in place, so a retry only runs once. */
let started = false;
/** Said at most once per window, however many times the retry re-arms. */
let warned = false;
/** The armed retry. One at a time, so a chatty event cannot pile them up. */
let pending: vscode.Disposable | undefined;

/**
 * Arms one retry of activation, for either way git can be missing.
 *
 * Both ways look identical from here and recover identically: the built-in git
 * extension may not be registered in this window yet, or it may be registered
 * and not yet enabled -- `enabled` stays false until it has located git and
 * built its model. Parallelo read whichever one applied, exactly once, and
 * returned.
 *
 * That return is what made this hard to place, because nothing downstream of
 * it runs and both halves of the failure are silent. No command is ever
 * registered, so every one of them answers "command not found" -- and the
 * startup pass never runs, so no worktree gets its terminal either. Neither
 * says a word about git.
 *
 * So listen for the thing that was missing and start when it arrives. The
 * listener is disposed before it re-activates, and `started` closes the door
 * behind a successful run, so this cannot register anything twice.
 */
function waitForGit(
  context: vscode.ExtensionContext,
  event: vscode.Event<unknown>,
  waitingFor: string
): undefined {
  log(`git: ${waitingFor}; waiting for it`);

  pending?.dispose();
  const waiting = event(() => {
    if (started) {
      waiting.dispose();
      return;
    }
    waiting.dispose();
    pending = undefined;
    void activate(context);
  });
  pending = waiting;
  context.subscriptions.push(new vscode.Disposable(() => waiting.dispose()));

  // Only if the wait turns out to be a real one. The old line told people to
  // enable an extension that was already enabled, which sent them looking in
  // the wrong place -- so name what is actually being waited on, and say that
  // it resolves itself.
  if (!warned) {
    warned = true;
    const timer = setTimeout(() => {
      if (!started) {
        vscode.window.showWarningMessage(
          'Parallelo Session is waiting for the built-in Git extension to start. ' +
            'It picks up on its own as soon as git is available.'
        );
      }
    }, GIT_GRACE_MS);
    context.subscriptions.push(new vscode.Disposable(() => clearTimeout(timer)));
  }

  return undefined;
}

/** The git extension's API, waited for rather than given up on. */
async function getGitApi(context: vscode.ExtensionContext): Promise<GitAPI | undefined> {
  const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!extension) {
    // `onDidChange` is the extension registry changing, which is what happens
    // when the missing extension turns up.
    return waitForGit(
      context,
      vscode.extensions.onDidChange,
      'the built-in git extension is not registered in this window'
    );
  }

  const exports = extension.isActive ? extension.exports : await extension.activate();
  if (exports.enabled) {
    return exports.getAPI(1);
  }

  // `onDidChangeEnablement` is the git extension announcing that its model has
  // arrived. Someone who has genuinely set `git.enabled` to false never fires
  // it, which is what the grace period above is for.
  return waitForGit(
    context,
    exports.onDidChangeEnablement,
    'the built-in git extension is registered but not enabled yet'
  );
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const git = await getGitApi(context);
  if (!git) {
    return;
  }
  started = true;

  const tracker = new SessionTracker(git);
  const styles = new SessionStyles(context.globalState);
  const baselines = new Baselines(context.globalState);
  const seeded = new Seeded(context.globalState);
  const changes = new ChangesProvider(tracker, git, styles, baselines);
  const files = new FilesProvider(tracker);
  const radar = new ConflictRadar(tracker, styles, baselines, seeded);
  const sessionStatus = new SessionStatus();
  const sessions = new SessionsProvider(tracker, styles, radar, sessionStatus);
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
    // A session with no row cannot be selected. Asking anyway rejects with
    // "Data tree node not found", and the catch below clears `revealed` so the
    // next event tries again -- and this runs on every git state change of the
    // active repository, so working in one would spin that retry continuously
    // and fill the log with it.
    if (!session || !isListed(session)) {
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
    const dirty = changeCount(session.repository);
    status.text = `$(git-branch) ${branch}${dirty ? ` $(diff) ${dirty}` : ''}`;
    status.tooltip = `${styles.title(session)}\n${session.cwd.fsPath}`;
    status.show();
  };

  /**
   * Stamp the starting commit of every session that has not got one.
   *
   * Has to run on every change rather than once: a session's repository
   * resolves asynchronously, and a worktree entered ten minutes from now still
   * wants a baseline from the moment it was first seen rather than from
   * whenever somebody asks.
   */
  const findIn = async (view: string): Promise<void> => {
    await vscode.commands.executeCommand(`${view}.focus`);
    await vscode.commands.executeCommand('list.find');
  };

  /**
   * Opens the find box whenever a list becomes visible, so it is there without
   * being asked for.
   *
   * VS Code will not keep that box open on its own -- there is no option for
   * it, and it closes on Escape -- so the nearest thing is to reopen it each
   * time the view appears. Opening it also focuses it, which is the cost, and
   * why this is a setting rather than simply how the views behave.
   *
   * Visibility, not session change: this fires when the view is expanded or
   * its container shown, not every time you click between terminals, so it
   * does not take the keyboard away while you are working in one.
   */
  const autoFind = (view: vscode.TreeView<unknown>, id: string): vscode.Disposable =>
    view.onDidChangeVisibility(event => {
      if (!event.visible) {
        return;
      }
      const on = vscode.workspace
        .getConfiguration('parallelo')
        .get<boolean>('alwaysShowFind', true);
      if (on) {
        void findIn(id);
      }
    });

  const stampBaselines = async (): Promise<void> => {
    await Promise.all(
      tracker.allSessions.filter(isListed).map(session => baselines.ensure(session))
    );
  };

  paint(tracker.activeSession);
  void styles.prune().then(() => styles.autoAssign(tracker.allSessions));
  void baselines
    .prune()
    .then(stampBaselines)
    .catch(error => log(`baseline: could not prepare baselines: ${String(error)}`));

  /**
   * The startup pass, run as the git extension registers repositories.
   *
   * It cannot simply run once here: git discovers repositories
   * asynchronously, so `repositories` is usually still empty during
   * activation. Nor can a single latch do it -- in a multi-root workspace the
   * second repository registers after the first has already been handled, and
   * a latch means its worktrees are never opened at all. So the pass runs
   * again for each repository not yet accounted for, and does nothing when
   * they all are. `openWorktreeTerminals` serialises its own runs, so
   * overlapping registrations cannot open a worktree twice.
   */
  const scanned = new Set<string>();
  const openStartupTerminals = async (): Promise<void> => {
    const fresh = git.repositories
      .map(repository => repository.rootUri.fsPath)
      .filter(root => !scanned.has(root));
    if (!fresh.length) {
      return;
    }
    for (const root of fresh) {
      scanned.add(root);
    }
    try {
      await openWorktreeTerminalsOnStartup(git, tracker);
    } catch (error) {
      log(`worktrees: startup pass failed: ${String(error)}`);
    }
  };
  void openStartupTerminals();

  context.subscriptions.push(
    git.onDidOpenRepository(() => void openStartupTerminals()),
    autoFind(changesView as vscode.TreeView<unknown>, 'worktreeSessions.changes'),
    autoFind(filesView as vscode.TreeView<unknown>, 'worktreeSessions.files'),
    tracker,
    stashGuard,
    radar,
    changesView,
    filesView,
    sessionsView,
    status,
    styles,
    baselines,
    tracker.onDidChangeSession(paint),
    tracker.onDidChangeSessions(() => void styles.autoAssign(tracker.allSessions)),
    // Deliberately no `baselines.invalidate()` here. This fires on every
    // terminal switch and every git state change, and a commit list only
    // changes when HEAD moves -- which `Baselines.read` checks for itself.
    // Dropping the cache here spawned a git process per worktree for clicking
    // between terminals.
    tracker.onDidChangeSessions(() => void stampBaselines()),
    sessionStatus,
    // Watch exactly the worktrees that have sessions in them, and no others.
    tracker.onDidChangeSessions(
      () =>
        void sessionStatus.sync([
          ...new Set(
            tracker.allSessions
              .map(session => session.root)
              .filter((root): root is string => root !== undefined)
          )
        ])
    ),
    // Looking at the session is the acknowledgement. A tick that stayed after
    // you had read it would be on every row by lunchtime and would stop meaning
    // anything -- and there is no other moment that honestly says "seen".
    tracker.onDidChangeSession(session => void sessionStatus.acknowledge(session?.root)),
    styles.onDidChange(() => paint(tracker.activeSession)),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('parallelo.sessionStatus')) {
        void sessionStatus.sync([
          ...new Set(
            tracker.allSessions
              .map(session => session.root)
              .filter((root): root is string => root !== undefined)
          )
        ]);
      }
      if (event.affectsConfiguration('parallelo.autoSessionColors')) {
        void styles.syncAutoColors(tracker.allSessions);
      }
      if (event.affectsConfiguration('parallelo.showMainCheckout')) {
        // Nothing else repaints on this. The Sessions view listens to session
        // and style events only, so accepting "Show It" after starting a normal
        // session used to write the setting and leave the row missing until an
        // unrelated terminal switch happened to refresh it.
        sessions.refresh();
      }
      if (event.affectsConfiguration('parallelo.sessionBaseline')) {
        baselines.invalidate();
        changes.refresh();
        // The radar counts baseline files too, so turning this off has to take
        // the marks off the rows rather than leaving them until some unrelated
        // git event happens to repaint.
        radar.rescan();
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

    vscode.commands.registerCommand('parallelo.newRoom', () => newRoom(git, tracker, seeded)),
    vscode.commands.registerCommand('parallelo.setUpStatusHooks', () => void setUpStatusHooks()),
    vscode.commands.registerCommand('parallelo.sendRoomBrief', () => sendKickoff()),
    vscode.commands.registerCommand('parallelo.showRoomTranscript', () => showTranscript(tracker)),
    vscode.commands.registerCommand('parallelo.newSession', () =>
      newSession(git, tracker, seeded)
    ),

    vscode.commands.registerCommand('parallelo.resetBaseline', async () => {
      const session = tracker.activeSession;
      if (!session?.repository) {
        vscode.window.showInformationMessage(
          'No session is active, so there is no baseline to reset.'
        );
        return;
      }
      if (!(await baselines.reset(session))) {
        vscode.window.showInformationMessage(
          'This worktree has no commits yet, so there is nothing to start from.'
        );
        return;
      }
      const sha = session.repository.state.HEAD?.commit ?? '';
      vscode.window.showInformationMessage(
        `Session baseline is now ${sha.slice(0, 8)}. Everything before it is out of view.`
      );
      changes.refresh();
      // The radar counts this session's commits, and the reset just changed
      // which ones those are. Without this the rows keep marks worked out from
      // the old, wider baseline until some unrelated git event repaints them.
      radar.rescan();
    }),

    vscode.commands.registerCommand('parallelo.openAllWorktrees', async () => {
      const result = await openWorktreeTerminals(git, tracker);
      if (result.opened) {
        return;
      }
      // Three different nothings, and saying the wrong one sends someone
      // looking for a worktree that was never there, or leaves a git failure
      // sitting in a log nobody opens.
      if (result.unreadable) {
        vscode.window.showErrorMessage(
          'Could not read the worktree list from git. Parallelo Session: Show Log has the reason.'
        );
      } else if (!result.worktrees) {
        vscode.window.showInformationMessage(
          'This repository has no linked worktrees. Start Worktree Session makes one.'
        );
      } else {
        vscode.window.showInformationMessage('Every worktree already has a terminal.');
      }
    }),

    vscode.commands.registerCommand(
      'parallelo.openChange',
      (node?: ChangeNode | BaselineFileNode) => changes.openChange(node)
    ),

    vscode.commands.registerCommand('parallelo.discardChange', (node?: ChangeNode) =>
      changes.discardChange(node)
    ),

    vscode.commands.registerCommand('parallelo.unstageChange', (node?: ChangeNode) =>
      changes.unstageChange(node)
    ),

    vscode.commands.registerCommand('parallelo.stageChange', (node?: ChangeNode) =>
      changes.stageChange(node)
    ),

    /**
     * Opens VS Code's own find box on one of our views.
     *
     * Not a filter of our own. Every tree view already has this -- Cmd+F over a
     * focused list -- and it filters as you type, inside the panel, with a
     * highlight/filter toggle, none of which is worth rebuilding. The only
     * thing missing was a way to discover it, so this is a button that focuses
     * the view and asks VS Code for the box.
     *
     * One command per view, because a `view/title` button cannot pass an
     * argument saying which view it sits in. `<viewId>.focus` is registered by
     * VS Code for every contributed view, and `list.find` acts on whatever list
     * has focus, so the order of the two matters.
     */
    vscode.commands.registerCommand('parallelo.findInFiles', () =>
      findIn('worktreeSessions.files')
    ),

    vscode.commands.registerCommand('parallelo.findInChanges', () =>
      findIn('worktreeSessions.changes')
    ),

    vscode.commands.registerCommand('parallelo.stageGroup', (node?: GroupNode) =>
      changes.stageGroup(node)
    ),

    vscode.commands.registerCommand('parallelo.unstageGroup', (node?: GroupNode) =>
      changes.unstageGroup(node)
    ),

    vscode.commands.registerCommand('parallelo.discardGroup', (node?: GroupNode) =>
      changes.discardGroup(node)
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

    vscode.commands.registerCommand('parallelo.quickSwitch', async () => {
      // The same list the view shows.
      const live = styles.arrange(tracker.allSessions);
      const ordered = live.filter(isListed);
      if (!ordered.length) {
        // The status bar can still be naming a session that the list leaves
        // out, and it is the status bar that was clicked to get here -- so
        // saying nothing is running would contradict it.
        if (live.length) {
          vscode.window.showInformationMessage(
            'Only the main checkout has a session, and the list is set to leave it out. ' +
              'Turn on parallelo.showMainCheckout to see it.'
          );
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
          const dirty = changeCount(session.repository);
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
      // Every group the Changes view lists. Reading only the working tree
      // meant a session whose work was all new files, or a resolved conflict,
      // reported nothing to stage while the view showed the files.
      const paths = [
        ...repo.state.workingTreeChanges,
        ...repo.state.mergeChanges,
        ...(repo.state.untrackedChanges ?? [])
      ].map(c => c.uri.fsPath);
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
    vscode.commands.registerCommand('parallelo.closeSession', (session?: Session) => {
      const target = session ?? tracker.activeSession;
      if (!target) {
        vscode.window.showInformationMessage('No session is active.');
        return;
      }
      // This terminal, and no other. A session *is* a terminal -- that is what
      // the Map is keyed by, and what each row stands for -- so closing one row
      // closes one terminal. Closing every terminal that shared the directory
      // took out a shell somebody was still using, from a row that gave no hint
      // it spoke for anything but itself. Two rows in one worktree are two
      // sessions, not a duplicate to tidy up.
      tracker.close(target.terminal);
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

      // Worked out before the removal, not after. `realpath` cannot resolve a
      // directory that is gone, so once the worktree is removed both sides of
      // the comparison fall back to `resolve` -- the raw string compare that
      // misses `/tmp/x` against `/private/tmp/x` and leaves a row alive
      // pointing at nothing. A session's root is whatever its terminal was
      // given; git's is the real path.
      const removed = await canonical(root);
      const doomed = (
        await Promise.all(
          tracker.allSessions.map(async other => {
            const at = other.root ?? other.repository?.rootUri.fsPath;
            return at && (await canonical(at)) === removed ? other : undefined;
          })
        )
      ).filter((other): other is Session => other !== undefined);

      // The count the dialog quotes, and the reason it has a second button.
      // `doomed` is every session in this directory, the clicked one included,
      // so its length is what someone looking at the Sessions view can count
      // for themselves.
      const outcome = await removeWorktree(root, Math.max(doomed.length, 1));

      // They meant this row, not the directory behind it. Closing the terminal
      // leaves the worktree, the branch and every uncommitted change exactly
      // where they were -- and leaves the other sessions in it alone, which is
      // the whole point of offering this.
      if (outcome === 'closeSession') {
        tracker.close(session.terminal);
        return;
      }
      if (outcome !== 'removed') {
        return;
      }

      // The directory is gone, so every terminal still sitting in it is
      // pointing at nothing. Close them: that is what drops the rows from the
      // Sessions view, which otherwise keeps showing a worktree that no longer
      // exists. Close Session no longer does this, so it is the only path that
      // still clears a whole worktree.
      doomed.forEach(other => tracker.close(other.terminal));

      // Appearance is keyed by worktree path, so a removed worktree would
      // otherwise leave a record behind for good.
      await styles.clear(session);
    })
  );
}

export function deactivate(): void {
  // Everything is registered through context.subscriptions.
}
