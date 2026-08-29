# Changelog

## [0.1.4] - 2026-08-29

### Fixed
- **Session commits, properly this time.** Three releases tried to work out
  what a session had committed by reasoning about branches — where this branch
  left `main`, or `origin/HEAD`, or every other branch. Every one of them was
  wrong somewhere, because a branch is not a session. The reports that came
  back: a repository whose whole history was listed, a worktree showing 74
  commits after a restart, a checkout that had committed nothing showing three
  merges.

  It is now read rather than inferred. Every linked worktree keeps its own log
  of what happened inside it, and the group lists the entries that are commits.
  Nothing else can affect it.

  Three things follow, all of them reported:

  - **Merges are never listed.** A merge that arrived by `git pull` is not a
    commit this session wrote, so the rows are the messages somebody typed
    rather than `Merge pull request #221`.
  - **A terminal in the main checkout has no group at all.** It is not a
    session, and its log reaches back to the repository's first commit.
  - **A wrong answer can no longer survive a restart.** Nothing derived is
    written to disk any more. Storing the answer is what let one repository
    stay wrong across three fixes; the only thing saved now is an explicit
    baseline reset.

### Removed
- `parallelo.baselineBranch`. There is no branch to name any more.


## [0.1.3] - 2026-08-29

### Fixed
- **Session commits listed a hundred commits nobody in the session wrote.**
  0.1.2 narrowed this and did not close it. The remaining hole was that the
  session was still being inferred from branch shape, and branch shape lies in
  three ordinary situations: a branch already merged into the integration
  branch has nothing unique left, an agent that leaves a mirror branch makes
  every commit look shared, and a repository whose `origin/HEAD` points at a
  branch the team stopped merging into hands back a fork point hundreds of
  commits stale. The last one was the reported case: `origin/HEAD` was 141
  commits behind the branch actually being developed, so all 141 were listed as
  one worktree's work.

  A worktree's commits are now read from git's record of *that worktree*. Every
  linked worktree keeps its own HEAD log, written when it is created and
  appended to by each commit made in it, so the session's start is something
  git wrote down at the time rather than something inferred afterwards. It
  cannot be dragged backwards by a stale branch and cannot be emptied by a
  merge or a mirror.

  The main checkout is excluded, deliberately: its log reaches back to the
  repository's first commit, which is not a session.


## [0.1.2] - 2026-08-29

### Fixed
- **Session commits listed a whole repository as one session's work.** Opening
  the extension in an existing project could put a hundred and fifty commits of
  somebody's history under a heading that claims they belong to this session.
  Two things caused it.

  The branch a session is measured from was looked up by name — `origin/HEAD`,
  `main`, `master` — and a repository that uses none of those got no answer, at
  which point the range became the entire history. Parallelo now asks git where
  the branch left every *other* branch, which needs no naming convention, so
  `develop`, `trunk` and house styles anchor correctly. `origin/main` and
  `origin/master` are consulted too, for clones that have neither `origin/HEAD`
  nor a local copy of the default branch.

  When there is genuinely nothing to fork from — a single branch and no remote
  — the group now says **whole branch** and lists the twenty most recent
  commits rather than everything. That case is real, but a long list stated
  confidently is not an answer to it; a short one that says what it is showing
  is.

- **An unresolved starting point was permanent.** A repository seen before its
  first remote, or mid-clone, was marked as having nothing to measure from and
  kept that mark for good — so the view never recovered once the anchor
  existed. Provisional marks are now re-derived, at most once a minute per
  worktree, until they resolve.

### Added
- **GitHub Copilot** in the default agent list, beside Claude Code and Codex.

### Changed
- **The icon is 512×512 and centred.** It was 128×128, so every surface that
  drew it larger drew it blurred, and the artwork sat four pixels from the left
  edge against eighteen on the right. The white square it was painted on is
  gone too, so it sits on whatever background it is given.

## [0.1.1] - 2026-08-29

### Changed
- **The store listing reads as a summary again.** Every entry under *What you
  get* had grown into a paragraph, so the section a visitor skims first ran to
  most of a screen. Each is one line now, and the detail moved into a *How it
  behaves* section below it. No behaviour changed.

## [0.1.0] - 2026-08-29

First release.

### Added
- **Session commits.** The Changes view shows uncommitted work only, so an
  agent that has been running twenty minutes and committed three times looks
  idle — its output left the view the moment it was committed, which is the
  most common way of losing the thread with a parallel agent. Parallelo now
  marks where each worktree's branch left the main checkout's branch, and a
  **Session commits** group lists what it has committed since: one row per
  commit, labelled with its message and carrying the files it touched. Click a
  file for the diff across that commit — its parent on the left, the commit
  itself on the right — so you see what that commit did rather than everything
  that has happened since.

  Commits, not "everything changed since the session started". The first
  version was that flat list and it read as a confusing near-duplicate of the
  groups above: the same files again, differently ordered, under a heading that
  did not explain itself. The committed half is what was missing from the view,
  and a commit is the unit the work arrives in.

  The mark is where the branch left the integration branch — `origin/HEAD`, or
  `main`, or `master`, whichever the repository has, or whatever
  **`parallelo.baselineBranch`** names for a repository that integrates into
  something else — rather than wherever HEAD
  happened to be when the worktree was first seen. Stamping HEAD looked
  reasonable and was wrong in the most ordinary case there is: a worktree with
  work already committed put all of it behind the mark, so the group showed
  nothing and read as broken. Anchoring instead to whatever branch the main
  *worktree* was on was wrong in a quieter way — checking out a feature branch
  there moved the origin of every session stamped afterwards.

  A repository with none of those — no remote, no `main`, no `master`, which
  is every repository that has just been started — marks the beginning of
  history instead. There is nothing to have branched from, so everything on the
  branch is the session's work. Falling back to HEAD there reintroduced the
  original bug in the one place nobody would look for it.

  A commit's files are read when its row is opened, not up front. Reading them
  all in advance meant one `git diff-tree` per commit for every worktree at
  once, which is enough concurrent processes to start failing outright.

  Merges are marked and read differently, because their files came from the
  branch they merged rather than from this session. **Reset Session Baseline to
  Now** re-arms the group after a review. If the starting commit is gone — a
  hard reset, or a worktree remade under the same path — the group says so and
  offers the reset instead of reporting an error, because nothing is wrong.
- **The conflict radar no longer forgets a committed file.** It compared
  uncommitted work, so a file left the comparison the moment an agent committed
  it: the agent most worth warning about, the one making steady commits, was
  the one that disappeared fastest. It now counts a session's own commits too,
  including the *old* name of a renamed file, which is the name another session
  still knows it by and a guaranteed conflict the previous version could not
  see. Merges are excluded, and so is the main checkout — a `git pull` brings
  hundreds of commits nobody in this window wrote, and counting them would flag
  every worktree against every other one.
- **`parallelo.sessionBaseline`**, on by default. Turns both of the above off.
  Only reading is gated; stamping carries on, so switching it back on measures
  from where the session actually started rather than from where the setting
  changed.
- **Every worktree opens with a terminal.** The Sessions list used to show a
  worktree only once a terminal was already inside it, which meant a worktree
  you had not visited was invisible and you had to know it existed and `cd`
  there by hand. On startup Parallelo now asks git for the repository's linked
  worktrees and opens a terminal in each one that does not have one, so the
  list is complete before you touch anything. It also closes a hole that was
  never named: a worktree with no terminal was not watched by the conflict
  radar, so an agent working in one raised no warning at all. Linked worktrees
  only — the main checkout is already open, and including it would put an
  unasked-for terminal in every ordinary single-checkout repository. Terminals
  are created but not shown; one `show()` per worktree would steal focus that
  many times and leave whichever came last in front. When more than twelve
  terminals would be created it opens none and asks first — one shell per
  worktree is cheap at four and hostile at forty — and it counts the terminals
  actually missing, so thirteen worktrees with twelve terminals open still get
  the thirteenth. A worktree already occupied is left alone, including when the
  terminal sits in a subdirectory of it or reached it through a symlink.
  **Open a Terminal in Every Worktree** runs the same pass by hand, from the
  Sessions title bar, the empty-list message or the palette, and
  **`parallelo.openWorktreeTerminals`** turns the startup pass off.
- **Discard Changes** and **Unstage Changes** on a row in the Changes view, so
  a change can be thrown away where you are looking at it rather than in the
  Source Control panel. Discarding asks first and names what it is about to do:
  a modified file is restored from the index, an untracked file is **deleted**,
  and those are two different git commands with two different costs. Unstaging
  asks nothing, because nothing is lost. Neither a staged file nor one in a
  merge conflict can be discarded in one step — the same rule the Source
  Control panel follows, because `clean` looks only at the working tree and
  untracked groups — and each says so rather than appearing to do nothing.
- **`parallelo.showMainCheckout`**, on by default. Turn it off to list only
  worktree sessions. A terminal in the main checkout always gets a row and can
  never be removed — `git worktree remove` refuses the main working tree — so
  for anyone working entirely in worktrees it was a permanent row with nothing
  to do about it. One setting rather than a per-row hide, deliberately: a row
  that is absent while its terminal runs is state to remember, and a session
  left out of the list is also left out of the conflict radar, which is exactly
  what you do not want to do to a running agent by accident.
- **Close Session** is an inline icon on rows that have no bin — the main
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
- A directory whose `.git` exists but is unusable no longer resolves as a
  session. Only a stat was done, so a `.git` with its `HEAD` deleted — which is
  what temp cleanup does to a repository under `/tmp` — bound a session, listed
  a row, and made every git call against it fail. The walk now checks that the
  git directory has a `HEAD`, following the pointer for a linked worktree or
  submodule, and keeps walking up so a broken `.git` nested in a healthy
  checkout finds the healthy parent.
- Starting a worktree session in a folder with no git offers to create one
  instead of passing git's "not a git repository" through raw. Someone opening
  a fresh codebase gets one prompt with **Initialize Repository** on it, not
  the same error over and over. It asks rather than doing it, because a
  repository appearing in a folder is a real change on disk, and it is asked
  only when a session is started. `git init` writes what is missing and leaves
  any existing objects alone, so the same offer covers a `.git` git cannot
  read; the wording is chosen from what is actually on disk rather than from
  how git failed.
- `Stage All Changes in Session` stages untracked files and resolved merge
  conflicts, not only the working tree. Under `git.untrackedChanges: separate`
  a session whose work was all new files reported nothing to stage while the
  view listed them.
- The change count on a session row, in the status bar and in the session
  picker counts what the Changes view lists. All three had their own copy of
  the arithmetic and all three disagreed with the view.
- A symlinked `.git` is read as a file rather than a directory. `FileType` is a
  bitmask, so a symlink to a file reports `File | SymbolicLink` and an equality
  test missed it — losing the worktree's Delete Worktree action.
- The Changes view lists untracked files under `git.untrackedChanges` set to
  `separate`. They are in a group of their own there rather than in the working
  tree, so reading one group dropped them from the view entirely.
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
