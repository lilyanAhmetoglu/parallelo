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
- **Sessions** — every terminal inside a worktree, with its branch and change
  count. Click one to focus its terminal.
- **Session appearance** — every session gets its own colour straight away, and
  you can set a name, colour and icon yourself. They stick to the worktree, so
  they survive a reload.
- **Status bar** — the active session's branch and how many files it has touched.
- **Start Worktree Session** — creates the branch and worktree, copies your
  untracked config across, runs a setup command, and launches the agent you pick.

## Agents that make their own worktree

Some agents create a worktree and move themselves into it — `claude --worktree`
is the common case. The shell that owns the terminal never moves, so its working
directory still points at wherever you launched from.

Parallelo reads the working directory of the terminal's **process tree**, not
just the shell, so those sessions bind to the right worktree anyway. Turn it off
with `parallelo.followProcessCwd` if you would rather it did not inspect
processes.

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
| `parallelo.setupCommand` | — | Command run once in a new worktree before the agent starts |
| `parallelo.copyFiles` | `.env`, `.env.local` | Untracked files copied into each new worktree |
| `parallelo.showStatusBar` | `true` | Show the active session's branch in the status bar |

## Licence

MIT
