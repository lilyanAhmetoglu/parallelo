# Parallelo Session

Switch terminals, and the diff follows.

VS Code stacks every git worktree together in the Source Control panel, with no
link between the terminal you are working in and the diff you are looking at.
This extension adds that link. Focus a terminal, and the Changes and Files views
scope themselves to the worktree that terminal is sitting in.

It does not care what is running in the terminal. Claude Code, Codex, aider or a
plain shell all behave the same way, because **the working directory of the
process in the terminal is the only contract.**

## What you get

- **Changes** — staged and unstaged changes for the active terminal's worktree
  only. Click a file to open its native diff, with per-hunk staging intact.
- **Files** — a file tree rooted at that worktree, so you browse the branch you
  are actually on.
- **Sessions** — every terminal inside a worktree, with its branch, how far it
  has drifted from its upstream (`↑2 ↓1`) and its change count. Click one to
  focus its terminal, and the list follows whichever terminal you are in.
  **Drag rows to reorder them**; the order is remembered against the worktree.
  Pin the ones you care about — from the row's right-click menu — and they move
  into a **Pinned** section at the top. Once that section exists you can drag
  sessions into it to pin them and out of it to unpin, so the section boundary
  and the pin are the same thing. The headings only appear while something is
  pinned.
- **Conflict radar** — a session with *uncommitted* edits to a file another
  session has also edited uncommitted is marked on its row three ways, so it
  reads at any sidebar width: the name takes the conflict colour, a `⚠` badge
  pins to the right edge, and the row leads with `⚠ 2 conflicts`. Hover for
  which files and who else is in them. Worktrees isolate
  files, so neither agent can see the other one is in `auth.ts` too.
- **Hide Session** — takes a row out of the list without touching anything.
  The terminal keeps running and the views still follow it when it is focused;
  it is only the list that forgets it. This is the answer for the main
  checkout, which always gets a row and can never be deleted — `git worktree
  remove` refuses the main working tree, and rightly. An eye appears in the
  view title while anything is hidden, and brings it all back.
- **Delete Worktree** (bin) — deletes the worktree directory. The branch is kept,
  uncommitted changes are not. It always asks first, and tells you how many files
  are at stake. To make a session go away without deleting anything, close its
  terminal.
- **Session appearance** — every session gets its own colour straight away, and
  you can set a name, colour and icon yourself. They stick to the worktree, so
  they survive a reload.
- **Status bar** — the active session's branch and how many files it has
  touched. Click it to switch session without leaving the keyboard; the same
  picker is **Parallelo Session: Switch Session** in the command palette.
- **Start Session** — pick the agent, then say what kind of session it is. A
  **worktree session** creates the branch and worktree, copies your untracked
  config across, runs a setup command and launches the agent in it. A **normal
  session** launches the agent where you already are, which is what you want for
  an agent that makes its own worktree.

## Agents that make their own worktree

Some agents create a worktree and move themselves into it — `claude --worktree`
is the common case. The shell that owns the terminal never moves, so its working
directory still points at wherever you launched from.

Parallelo reads the working directory of the terminal's **process tree**, not
just the shell, so those sessions bind to the right worktree anyway. Turn it off
with `parallelo.followProcessCwd` if you would rather it did not inspect
processes.

Start these as a **normal session**, not a worktree session — the agent makes
the worktree, so there is no point making one first. To have it offered as its
own entry, add it to `parallelo.agents`:

```json
{ "label": "Claude Code (own worktree)", "command": "claude --worktree" }
```

Requires macOS or Linux. On Windows it falls back to shell integration, which
means `cd`-then-run works and self-chdir'ing agents do not.

## Running it

```bash
bun install
bun run compile
```

Press **F5** to launch an Extension Development Host. `Cmd+R` in that window
reloads after a rebuild.

## Things worth knowing

**`git stash` is shared across all worktrees.** `refs/stash` lives in the common
`.git` directory, so every worktree pushes onto the same stack. If two agents
stash and pop concurrently they will corrupt each other's work — one agent's
`stash pop` will happily take work the other one stashed. Have agents commit to
their session branch instead.

Parallelo watches for this and warns you once per repository per window, the
first time the stash is touched while more than one session is live. It is a
warning only; the extension deliberately has no stash feature. Turn it off with
`parallelo.stashGuard`.

**The conflict radar compares uncommitted work, and only within one
repository.** It intersects the changes VS Code already holds for each session
— unstaged, staged, untracked and mid-merge — so there is nothing to scan and
nothing to configure. Two limits are worth knowing:

- **Once an agent commits, its files leave the comparison.** The radar sees the
  working tree, not the branch, so two sessions that have both committed to
  `auth.ts` will not be flagged. Committing to the session branch is still the
  right thing to do — it is what keeps the shared stash out of trouble — but it
  moves that work out of the radar's view.
- **It knows about files, not about meaning.** Two sessions editing different
  functions in one file are flagged; two sessions editing opposite ends of the
  same API are not.

Turn it off with `parallelo.conflictRadar`.

**Removing a session worktree discards uncommitted work.** The branch is kept,
so anything an agent committed to it is safe and you can pick it up again with a
new worktree. Anything still sitting in the working tree is not on any branch and
goes with the directory. The confirmation tells you how many files that is before
you agree. Nothing is ever moved back into your main checkout -- those changes
belong to another branch, and landing them on whichever branch you happen to be
on is not a thing this extension will do to you. Use **Close Session** if you
just want the row gone.

**Worktrees isolate files, nothing else.** Ports, databases, running dev servers
and `.env` state are all shared. Two agents running the same dev server will
fight over the port.

**Terminals opened before the extension activates** are picked up on activation,
but a terminal whose shell has not reported a directory yet may take a moment to
appear.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `parallelo.agents` | Claude Code, Codex, Shell only | Agents offered when starting a session |
| `parallelo.worktreePath` | `.worktrees` | Where new worktrees go, relative to the repo root |
| `parallelo.branchPrefix` | `session/` | Prefix for branches created for new sessions |
| `parallelo.autoOpenRepository` | `true` | Register a worktree with git when a terminal enters it |
| `parallelo.followProcessCwd` | `true` | Resolve the worktree from the terminal's processes, not just the shell |
| `parallelo.autoSessionColors` | `true` | Give each session a distinct colour automatically |
| `parallelo.stashGuard` | `true` | Warn when the shared stash is used with more than one session live |
| `parallelo.conflictRadar` | `true` | Mark sessions editing the same file as another session |
| `parallelo.setupCommand` | — | Command run once in a new worktree before the agent starts |
| `parallelo.copyFiles` | `.env`, `.env.local` | Untracked files copied into each new worktree |
| `parallelo.showStatusBar` | `true` | Show the active session's branch in the status bar |

## Licence

MIT
