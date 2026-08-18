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

### Fixed
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
