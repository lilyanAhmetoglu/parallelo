# Changelog

## [Unreleased]

### Added
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
