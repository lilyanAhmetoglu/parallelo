# Parallelo Session

**Switch terminals, and the diff follows.**

Run several coding agents at once — each in its own git worktree — and VS Code
stacks every worktree together in one Source Control panel. Nothing connects the
terminal you are working in to the diff you are looking at.

Parallelo adds that connection. Focus a terminal, and the Changes and Files
views scope themselves to that terminal's worktree.

It never asks what is running. Claude Code, Codex, aider and a plain shell all
behave identically, because **the working directory of the process in the
terminal is the only contract.**

## What you get

- **Changes** — one worktree's staged and unstaged files. Native diffs, per-hunk
  staging, discard and unstage inline.
- **Session commits** — what this session has committed since it branched, one
  row per commit, files underneath.
- **Conflict radar** — two sessions editing the same file get marked before they
  collide.
- **Sessions** — every terminal in a worktree, with branch, drift (`↑2 ↓1`) and
  change count. Drag to reorder, drag to pin.
- **Files** — a file tree rooted at the active worktree.
- **Every worktree from the start** — a terminal opens in each one when the
  window does, so none stays invisible.
- **Session appearance** — name, colour and icon per worktree, remembered across
  reloads.
- **Status bar** — active branch and change count. Click to switch session.
- **Start Session** — creates the branch and worktree, copies your `.env`, runs
  a setup command, launches the agent.
- **Delete Worktree** — removes the directory, keeps the branch, always asks
  first.

## Requirements

VS Code 1.93 or newer. No runtime dependencies. Process-tree detection needs
macOS or Linux; Windows falls back to shell integration.

## How it behaves

### Session commits

The last group in the Changes view. A session's origin is where its branch left
the integration branch — `origin/HEAD`, then `main`, then `master`, or whatever
`parallelo.baselineBranch` names.

The groups above lose a file the moment an agent commits it, which is exactly
when you most want to see what it did. Click any file for its diff across that
commit. **Reset Session Baseline to Now** re-arms the group once you have
reviewed.

### Conflict radar

A session that has edited a file another session has also edited *since either
of them started* is marked three ways, so it reads at any sidebar width: the
name takes the conflict colour, a `⚠` badge pins to the right edge, and the row
leads with `⚠ 2 conflicts`. Hover for the files and who else is in them.

Committing does not clear the warning — a session's own commits count, including
the old name of a renamed file. This matters, because the agent worth warning
about is the one making steady progress.

Three things it leaves out on purpose:

- **Merges** — a merge authors nothing, and would drag in every file the merged
  branch ever touched.
- **The main checkout** — a `git pull` there brings hundreds of commits nobody
  in the window wrote.
- **Meaning** — two sessions in different functions of one file are flagged; two
  sessions at opposite ends of the same API are not.

Off with `parallelo.conflictRadar`, or back to uncommitted-only with
`parallelo.sessionBaseline`.

### Agents that make their own worktree

Some agents create a worktree and move into it — `claude --worktree` is the
common case. The shell never moves, so its working directory still points where
you launched from.

Parallelo reads the working directory of the terminal's **process tree**, not
just the shell, so those sessions bind correctly anyway. Turn it off with
`parallelo.followProcessCwd`.

Start these as a **normal session**, not a worktree session — the agent makes
the worktree, so there is no point making one first. To get its own entry in the
picker:

```json
{ "label": "Claude Code (own worktree)", "command": "claude --worktree" }
```

## Things worth knowing

**`git stash` is shared across all worktrees.** `refs/stash` lives in the common
`.git` directory, so every worktree pushes onto one stack — one agent's `stash
pop` will happily take work another agent stashed. Have agents commit to their
session branch instead.

Parallelo warns once per repository per window, the first time the stash is
touched while more than one session is live. It is a warning only; the extension
deliberately has no stash feature. Off with `parallelo.stashGuard`.

**Deleting a worktree discards uncommitted work.** The branch is kept, so
anything committed is safe. Anything still in the working tree is on no branch
and goes with the directory — the confirmation tells you how many files that is.
Nothing is ever moved into your main checkout. Use **Close Session** if you just
want the row gone.

**Worktrees isolate files, nothing else.** Ports, databases, dev servers and
`.env` state are shared. Two agents running the same dev server will fight over
the port.

**Terminals opened before the extension activates** are picked up on activation,
though one whose shell has not reported a directory yet may take a moment.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `parallelo.agents` | Claude Code, Codex, Shell | Agents offered when starting a session |
| `parallelo.worktreePath` | `.worktrees` | Where new worktrees go, relative to the repo root |
| `parallelo.branchPrefix` | `session/` | Prefix for branches created for new sessions |
| `parallelo.autoOpenRepository` | `true` | Register a worktree with git when a terminal enters it |
| `parallelo.followProcessCwd` | `true` | Resolve the worktree from the terminal's processes, not just the shell |
| `parallelo.autoSessionColors` | `true` | Give each session a distinct colour automatically |
| `parallelo.stashGuard` | `true` | Warn when the shared stash is used with more than one session live |
| `parallelo.conflictRadar` | `true` | Mark sessions editing the same file as another session |
| `parallelo.sessionBaseline` | `true` | List each session's own commits, and count them in the conflict radar |
| `parallelo.baselineBranch` | — | Branch a session is taken to have left; empty means `origin/HEAD`, `main`, then `master` |
| `parallelo.setupCommand` | — | Command run once in a new worktree before the agent starts |
| `parallelo.copyFiles` | `.env`, `.env.local` | Untracked files copied into each new worktree |
| `parallelo.showStatusBar` | `true` | Show the active session's branch in the status bar |
| `parallelo.showMainCheckout` | `true` | List a terminal in the main checkout, not only worktree sessions |
| `parallelo.openWorktreeTerminals` | `true` | Open a terminal in every worktree when the window starts |

## Building it

```bash
bun install
bun run compile
```

Press **F5** for an Extension Development Host. `Cmd+R` reloads it after a
rebuild.

## Licence

MIT
