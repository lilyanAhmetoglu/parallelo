import * as vscode from 'vscode';
import type { Session, SessionTracker } from './sessionTracker';
import type { SessionStyles } from './sessionStyles';
import { sessionUri, type ConflictRadar } from './conflictRadar';

/**
 * A heading in the Sessions list.
 *
 * Only present once something is pinned. A permanent pair of headings would be
 * chrome above a list that is usually four rows long.
 */
interface SectionNode {
  kind: 'section';
  label: string;
  pinned: boolean;
  sessions: Session[];
}

type Node = SectionNode | Session;

function isSection(node: Node): node is SectionNode {
  return (node as SectionNode).kind === 'section';
}

/** The view's own drag type. Has to be the view id, lowercased. */
const MIME = 'application/vnd.code.tree.worktreesessions.sessions';

export class SessionsProvider
  implements vscode.TreeDataProvider<Node>, vscode.TreeDragAndDropController<Node>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  readonly dragMimeTypes = [MIME];
  readonly dropMimeTypes = [MIME];

  /** Discarded on every repaint; see `layout`. */
  private cached: { flat: Session[]; sections?: SectionNode[] } | undefined;

  constructor(
    private readonly tracker: SessionTracker,
    private readonly styles: SessionStyles,
    private readonly radar: ConflictRadar
  ) {
    tracker.onDidChangeSessions(() => this.refresh());
    tracker.onDidChangeSession(() => this.refresh());
    styles.onDidChange(() => this.refresh());
    radar.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this.cached = undefined;
    this._onDidChangeTreeData.fire();
  }

  /**
   * The shape of the list right now, worked out once per repaint.
   *
   * `getChildren` and `getParent` both need it and VS Code calls them in either
   * order, so recomputing per call would hand back sections that are equal but
   * not identical -- and the selection would not resolve against them.
   */
  private layout(): { flat: Session[]; sections?: SectionNode[] } {
    if (this.cached) {
      return this.cached;
    }

    // Hidden rows come out before anything else looks at the list, so they
    // take no part in the sections, the ordering or the drag arithmetic.
    const flat = this.styles
      .arrange(this.tracker.allSessions)
      .filter(session => !this.styles.isHidden(session));
    const pinned = flat.filter(session => this.styles.get(session).pinned);

    // Both headings, or neither. With everything pinned there still has to be
    // somewhere to drag a session in order to unpin it.
    this.cached = pinned.length
      ? {
          flat,
          sections: [
            { kind: 'section', label: 'Pinned', pinned: true, sessions: pinned },
            {
              kind: 'section',
              label: 'Sessions',
              pinned: false,
              sessions: flat.filter(session => !this.styles.get(session).pinned)
            }
          ]
        }
      : { flat };
    return this.cached;
  }

  getChildren(element?: Node): Node[] {
    if (element) {
      return isSection(element) ? element.sessions : [];
    }
    const { flat, sections } = this.layout();
    return sections ?? flat;
  }

  /**
   * Required by `TreeView.reveal`, which is how the selection follows the
   * focused terminal. Matches on id rather than object identity, because a
   * `Session` is rebuilt every time its terminal is re-resolved.
   */
  getParent(node: Node): Node | undefined {
    if (isSection(node)) {
      return undefined;
    }
    return this.layout().sections?.find(section =>
      section.sessions.some(candidate => candidate.id === node.id)
    );
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return isSection(node) ? this.sectionItem(node) : this.sessionItem(node);
  }

  private sectionItem(section: SectionNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      section.label,
      vscode.TreeItemCollapsibleState.Expanded
    );
    item.id = section.pinned ? 'section.pinned' : 'section.sessions';
    item.contextValue = 'sessionSection';
    item.description = String(section.sessions.length);
    if (section.pinned) {
      item.iconPath = new vscode.ThemeIcon('pinned');
    }
    item.tooltip = section.pinned
      ? 'Drag a session here to pin it. Pinned sessions stay at the top.'
      : 'Drag a session here to unpin it.';
    return item;
  }

  private sessionItem(session: Session): vscode.TreeItem {
    const active = this.tracker.activeSession?.terminal === session.terminal;
    const style = this.styles.get(session);
    const item = new vscode.TreeItem(
      style.name || session.terminal.name,
      vscode.TreeItemCollapsibleState.None
    );

    // Without this the tree matches rows by object identity, and a `Session`
    // is a fresh object after every re-resolve -- so a pending selection would
    // be looking for a row that no longer exists.
    item.id = session.id;

    const head = session.repository?.state.HEAD;
    // Only what is actually true: a branch with no upstream reports neither,
    // and a branch level with its upstream reports zeroes worth no space.
    const ahead = head?.ahead ? `↑${head.ahead}` : '';
    const behind = head?.behind ? `↓${head.behind}` : '';
    const tracking = [ahead, behind].filter(Boolean).join(' ');
    const branch = [head?.name ?? session.label, tracking].filter(Boolean).join(' ');
    const dirty =
      (session.repository?.state.workingTreeChanges.length ?? 0) +
      (session.repository?.state.indexChanges.length ?? 0);

    // Appearance is keyed by the worktree, so two terminals in one worktree
    // wear the same name and colour and read as a duplicated row. Name the
    // terminal on both so they can be told apart -- and acted on separately.
    const shared =
      session.root !== undefined &&
      this.tracker.allSessions.filter(other => other.root === session.root).length > 1;

    const conflict = this.radar.describe(session);

    // The conflict goes first, and short. The description is truncated from
    // the right, so a warning at the end is the first thing a narrow sidebar
    // drops -- and it is the one part of the row that is news. The decoration
    // on the resourceUri below carries the badge and the colour; this says
    // which file, which is the part you cannot get from a badge.
    item.description = [
      conflict?.mark ?? '',
      branch,
      shared ? session.terminal.name : '',
      dirty ? `${dirty} changed` : ''
    ]
      .filter(Boolean)
      .join(' · ');
    item.iconPath = new vscode.ThemeIcon(
      style.icon || (active ? 'circle-filled' : 'terminal'),
      style.color ? new vscode.ThemeColor(style.color) : undefined
    );
    // What the conflict decoration hangs on. A scheme of our own, not the
    // worktree path: a real directory uri would pick up the git extension's
    // own decorations as well, and the session colour already lives on the
    // icon -- this only ever carries the conflict mark.
    // Keyed on the repository root, the same expression the radar keys its
    // overlaps by. `session.root` is normally the same path, but it is found
    // on disk rather than reported by git, and a row whose uri disagreed with
    // the map would simply never light up.
    const root = session.repository?.rootUri.fsPath ?? session.root;
    if (root) {
      item.resourceUri = sessionUri(root);
    }
    item.tooltip = [
      style.name,
      session.cwd.fsPath,
      // Same rule as the row: say only what is true, so a branch that is level
      // with its upstream does not read "0 ahead, 0 behind".
      [
        head?.ahead ? `${head.ahead} ahead` : '',
        head?.behind ? `${head.behind} behind` : ''
      ]
        .filter(Boolean)
        .join(', '),
      shared ? `Terminal: ${session.terminal.name}` : '',
      shared ? 'Another terminal is working in this same worktree.' : '',
      conflict?.tooltip ?? ''
    ]
      .filter(Boolean)
      .join('\n');
    // Only a linked worktree can be removed; the main checkout cannot, and
    // offering a bin that always fails on it is worse than not offering one.
    // The pin suffix is what lets the menu offer Pin or Unpin rather than both.
    item.contextValue =
      (session.linked ? 'worktreeSession' : 'session') + (style.pinned ? 'Pinned' : '');
    item.command = {
      command: 'parallelo.focusTerminal',
      title: 'Focus Session Terminal',
      arguments: [session]
    };
    return item;
  }

  handleDrag(source: readonly Node[], dataTransfer: vscode.DataTransfer): void {
    // A heading is a drop target, never something you pick up.
    const ids = source
      .filter((node): node is Session => !isSection(node))
      .map(session => session.id);
    if (ids.length) {
      dataTransfer.set(MIME, new vscode.DataTransferItem(ids.join(',')));
    }
  }

  async handleDrop(
    target: Node | undefined,
    dataTransfer: vscode.DataTransfer
  ): Promise<void> {
    const carried = dataTransfer.get(MIME);
    if (!carried) {
      return;
    }
    const ids = new Set(String(carried.value).split(',').filter(Boolean));

    // Dropped on itself. The arithmetic below would send it to the end of its
    // own section, which is a visible move for a gesture that meant nothing.
    if (target && !isSection(target) && ids.has(target.id)) {
      return;
    }

    const arranged = this.styles.arrange(this.tracker.allSessions);
    const moved = arranged.filter(session => ids.has(session.id));
    if (!moved.length) {
      return;
    }
    const rest = arranged.filter(session => !ids.has(session.id));
    const isPinned = (session: Session) => Boolean(this.styles.get(session).pinned);

    // Where it landed, as a position in `rest`. `rest` is already pinned-first,
    // so the pinned rows are a prefix and their count is the boundary.
    let pinned: boolean;
    let at: number;
    if (target && isSection(target)) {
      // Dropped on a heading rather than between two rows: the end of that
      // section, which is also how a drop into an empty section has to read.
      pinned = target.pinned;
      at = pinned ? rest.filter(isPinned).length : rest.length;
    } else if (target) {
      pinned = isPinned(target);
      // By id, not by object. `track()` replaces a `Session` on every sync,
      // and sync runs whenever a command starts in the terminal -- so an agent
      // working in the row you are dropping onto can replace it between the
      // render and the drop, and identity matching would silently miss.
      const index = rest.findIndex(session => session.id === target.id);
      at = index < 0 ? rest.length : index;
    } else {
      // Empty space below the list.
      pinned = false;
      at = rest.length;
    }

    const next = [...rest.slice(0, at), ...moved, ...rest.slice(at)];
    await this.styles.setArrangement(
      next.map(session => ({
        session,
        pinned: ids.has(session.id) ? pinned : isPinned(session)
      }))
    );
  }
}
