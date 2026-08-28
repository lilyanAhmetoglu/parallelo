# Changelog

## [Unreleased]

### Added
- **Hide Session**, on the row's right-click menu. It takes the row out of the
  Sessions list and the session picker and does nothing else — the terminal
  keeps running, and the views still follow it when it is focused. This is what
  the main checkout needed: it always gets a row and can never be deleted,
  because `git worktree remove` refuses the main working tree. An eye in the
  view title shows up while anything is hidden and puts it all back, and the
  toast that confirms a hide offers the same thing. Hiding is keyed by
  worktree, like name and colour, so it survives a reload and takes both
  terminals when a worktree holds two.
- **Close Session** is now an inline icon on rows that have no bin — the main
  checkout and any other non-worktree session. It stays out of the row where a
  bin already sits, because two icons that both make a session disappear, one
  of which deletes work, is not a choice worth making at a glance.
- **Conflict radar.** A session with uncommitted edits to a file another
  session of the same repository has also edited is marked on its row three
  ways, so none of it depends on the sidebar being wide: the session name takes
  the conflict colour and a `⚠` badge pins to the right edge — the mechanism
  git uses for modified files in the Explorer — and the description leads with
  `⚠ 2 conflicts`. The hover names it and lists which files, per worktree, and
  the session picker carries the full sentence, `⚠ 2 files also edited by
  test-b`. Worktrees isolate files, so neither agent
  can tell the other one is in `auth.ts` as well. Covers unstaged, staged,
  untracked and mid-merge files; work that has already been committed to a
  session branch is not compared. Reads what the git extension already holds
  for each session, so there is nothing to scan. Off with
  `parallelo.conflictRadar`.
- Ahead and behind counts on each session row, next to the change count, so a
  session that has drifted from its upstream says so without opening anything.
  Shown only when there is something to show: a branch with no upstream, or one
  level with it, stays quiet.
- **Reorder sessions by dragging.** The order is stored against the worktree
  alongside name, colour and icon, so it survives a reload.
- **Pin Session to Top**, for when five sessions are running and two of them
  matter. Pinned sessions move into their own **Pinned** section, and the
  section boundary is the pin: drag a session in to pin it, out to unpin. The
  headings appear only once something is pinned — two headings above a
  four-row list is chrome — so the first pin comes from the row's menu. Pins survive a reload, and **Reset Session
  Appearance** leaves them alone, because where a row sits is not appearance.
- **Switch Session** — the status bar is now a session picker rather than a
  second way to open a view that says the same thing. Also in the command
  palette. With one session running it just switches, instead of asking you to
  confirm the only option.
- Bind the active terminal to its git worktree; the Changes and Files views
  follow whichever terminal is focused.
- Resolve the worktree from the terminal's process tree, so agents that create
  their own worktree and chdir into it are tracked correctly.
- Name, colour and icon per session, persisted against the worktree.
- List every open terminal on activation, not only the focused one.
- Give each session a distinct colour on sight, so sessions are told apart
  without anyone configuring anything. A colour set by hand is never
  overwritten, and picking "No colour" stays no colour.
- Warn when the stash is used while more than one session is live. `refs/stash`
  is shared by every worktree of a repository, so one session can pop what
  another stashed. Once per repository per window, and a warning only.

- **Close Session** on a session row. It closes the terminals working in that
  worktree and nothing else: the worktree, the branch and every uncommitted
  change stay exactly where they are. Removing the worktree is now a separate
  menu entry rather than a one-click icon next to it.

- Starting a session asks what kind it is: a **worktree session** with a branch
  and worktree of its own, or a **normal session** that runs where you already
  are. An agent that makes its own worktree -- `claude --worktree`
  and the like -- has to be started where you are, and Parallelo binds to
  whatever directory it moves itself into.

### Changed
- The shared-stash warning offers **Show Log**, and the log names every worktree
  sharing that stack. The warning has no room to say which sessions are
  involved, which is the first thing worth knowing once it has fired.
- The bin is the only action on a session row again, and reads "Delete Worktree
  (Discards Uncommitted Changes)" so hovering it answers the only question worth
  asking. Closing a session without deleting anything is what closing its
  terminal already does; Close Session stays in the right-click menu for when
  a worktree has more than one terminal in it.
- The remove-worktree confirmation counts what is at stake instead of warning
  in the abstract: how many files have uncommitted changes, which branch is
  being kept, and that the branch keeps anything committed to it. A worktree
  with nothing uncommitted says so rather than threatening loss that cannot
  happen, and the confirm button reads "Remove and discard changes" only when
  there is something to discard.

### Fixed
- Switching terminals quickly no longer leaves the views on the wrong session.
  Resolving a terminal takes a filesystem walk and a `ps`, so on a burst of
  switches the answer for the terminal you left could land after the answer for
  the terminal you arrived at and overwrite it. A sync now drops its result if
  the terminal it was resolving is no longer the active one.
- The Sessions list moves its selection onto the terminal you are working in.
  Switching from the terminal panel's tab list never touched the tree, so the
  highlighted row stayed on whatever was last clicked and disagreed with the
  view titles.
- New worktrees branch off the main checkout instead of the session you happen
  to have focused. Branching from a linked worktree nested the new one inside
  it, where it showed up as untracked files in the session you branched from.
- The bin only appears on rows that are linked worktrees. It was offered on the
  main checkout too, where `git worktree remove` cannot work, so it could only
  ever fail there.
- Closing or removing a session actually drops its row. Closing a terminal is
  not immediate -- it stays listed until VS Code has finished with it -- so
  re-reading the terminal list straight afterwards put the session back and the
  row never went away.
- Two terminals in one worktree no longer read as a duplicated row. They share
  a name and colour because appearance is keyed by the worktree, so the row now
  also names its terminal when a worktree has more than one.
- Removing a locked worktree retries with `--force --force`, which is what git
  asks for and what a single `--force` will not do.
- Removing a session worktree works when it is the only repository the git
  extension knows about, and no longer runs `git worktree remove` against an
  unrelated project that happened to be open. The main checkout is resolved
  with `git rev-parse --git-common-dir` rather than guessed.
- Removing a session worktree no longer refuses while git is still registering
  the repository. It reads the worktree root found on disk, which is always
  there, instead of the repository, which is not.
- Removing a session worktree closes the terminals left sitting in it, so the
  row disappears from the Sessions view instead of pointing at a directory that
  no longer exists.
- Session name, colour and icon no longer disappear after a window reload. They
  were keyed on the git repository, which resolves asynchronously, so they were
  written under one key and read back under another.
