<div align="center">

<img src="https://raw.githubusercontent.com/lilyanAhmetoglu/parallelo/main/icon.png" width="128" alt="Parallelo Session logo">

# Parallelo Session

### ⚡ Switch terminals, and the diff follows.

**One window. Many agents. Each one's changes, exactly when you look at it.**

[![Marketplace](https://img.shields.io/visual-studio-marketplace/v/LilyanALDIMASHKI.parallelo-session?style=for-the-badge&label=VS%20Code&labelColor=1e1e1e&color=7C5CFC)](https://marketplace.visualstudio.com/items?itemName=LilyanALDIMASHKI.parallelo-session)
[![Open VSX](https://img.shields.io/open-vsx/v/LilyanALDIMASHKI/parallelo-session?style=for-the-badge&label=Open%20VSX&labelColor=1e1e1e&color=7C5CFC)](https://open-vsx.org/extension/LilyanALDIMASHKI/parallelo-session)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/LilyanALDIMASHKI.parallelo-session?style=for-the-badge&labelColor=1e1e1e&color=7A8291)](https://marketplace.visualstudio.com/items?itemName=LilyanALDIMASHKI.parallelo-session)
[![MIT](https://img.shields.io/badge/licence-MIT-7A8291?style=for-the-badge&labelColor=1e1e1e)](LICENSE)

<img src="https://raw.githubusercontent.com/lilyanAhmetoglu/parallelo/main/docs/demo.gif" alt="Switching between three worktree sessions: the Changes panel, the file tree, the terminal and the status bar all follow the session you pick">

</div>

---

## 😖 The problem

Run several coding agents at once — each in its own git worktree — and VS Code
stacks every worktree together in one Source Control panel. Nothing connects the
terminal you are working in to the diff you are looking at. You hunt for the
right repository entry every single time you switch.

## ✨ The fix

Parallelo adds that one missing connection. **Focus a terminal, and the Changes
and Files views scope themselves to that terminal's worktree.**

Three agents, three worktrees, one window. Pick a session and everything follows
it — the diff, the file tree, the terminal, the branch in the status bar. The ⚠
marks two sessions that are editing the same file.

It never asks what is running. Claude Code, Codex, aider and a plain shell all
behave identically, because **the working directory of the process in the
terminal is the only contract.**

## 🎁 What you get

| | |
|---|---|
| 🔍 **Changes** | One worktree's staged and unstaged files. Native diffs, per-hunk staging, discard and unstage inline. |
| 📝 **Session commits** | What this session has committed since it branched, one row per commit, files underneath. |
| ⚠️ **Conflict radar** | Two sessions editing the same file get marked before they collide. |
| 🗂️ **Sessions** | Every terminal in a worktree, with branch, drift (`↑2 ↓1`) and change count. Drag to reorder, drag to pin. |
| 🌲 **Files** | A file tree rooted at the active worktree. |
| 🚀 **Every worktree from the start** | A terminal opens in each one when the window does, so none stays invisible. |
| 🎨 **Session appearance** | Name, colour and icon per worktree, remembered across reloads. |
| 📊 **Status bar** | Active branch and change count. Click to switch session. |
| ➕ **Start Session** | Creates the branch and worktree, copies your `.env`, runs a setup command, launches the agent. |
| 🗑️ **Delete Worktree** | Removes the directory, keeps the branch, always asks first. |

## 📦 Requirements

VS Code 1.93 or newer. No runtime dependencies. Process-tree detection needs
macOS or Linux; Windows falls back to shell integration.

## 🧭 How it behaves

### 📝 Session commits

The last group in the Changes view: **the commits this worktree made**, newest
first, each with the files it touched.

It is read, not inferred. Every linked worktree keeps its own log of what
happened inside it, and Parallelo lists the entries that are commits. So:

- **Merges are never rows.** A merge that arrived by `git pull` is not a commit
  this session wrote. You see the messages somebody typed, not `Merge pull
  request #221`.
- **Nothing another branch did can appear.** A stale default branch, a branch
  already merged, an agent that leaves a mirror branch — none of them can add
  or remove a row, because none of them is in this worktree's log.

**Reset Session Baseline to Now** hides everything up to this point, for when
you have reviewed what an agent did and want to watch what it does next.

The group is for **worktree sessions only**. A terminal in the main checkout
does not get one: its log reaches back to the repository's first commit, which
is not a session.

### ⚠️ Conflict radar

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

### 🤖 Agents that make their own worktree

Some agents create a worktree and move into it — `claude --worktree` is the
common case. The shell never moves, so its working directory still points where
you launched from.

Parallelo reads the working directory of the terminal's **process tree**, not
just the shell, so those sessions bind correctly anyway. Turn it off with
`parallelo.followProcessCwd`.

Start these as a **normal session**, not a worktree session — the agent makes
the worktree, so there is no point making one first. A normal session opens in
the **main checkout**, on the base branch, whichever session you started it
from; it never lands in another session's worktree. When you do want a second
terminal in the worktree you are already in — a dev server, a test run — the
picker offers **This worktree** as its own entry. To get the agent its own
entry in the picker:

```json
{ "label": "Claude Code (own worktree)", "command": "claude --worktree" }
```

## 💡 Things worth knowing

> ⚠️ **`git stash` is shared across all worktrees.** `refs/stash` lives in the
> common `.git` directory, so every worktree pushes onto one stack — one agent's
> `stash pop` will happily take work another agent stashed. Have agents commit to
> their session branch instead.

Parallelo warns once per repository per window, the first time the stash is
touched while more than one session is live. It is a warning only; the extension
deliberately has no stash feature. Off with `parallelo.stashGuard`.

🗑️ **Deleting a worktree discards uncommitted work.** The branch is kept, so
anything committed is safe. Anything still in the working tree is on no branch
and goes with the directory — the confirmation tells you how many files that is.
Nothing is ever moved into your main checkout. Use **Close Session** if you just
want the row gone.

🔌 **Worktrees isolate files, nothing else.** Ports, databases, dev servers and
`.env` state are shared. Two agents running the same dev server will fight over
the port.

⏱️ **Terminals opened before the extension activates** are picked up on
activation, though one whose shell has not reported a directory yet may take a
moment.

## ⚙️ Settings

| Setting | Default | What it does |
|---|---|---|
| `parallelo.agents` | Claude Code, Codex, GitHub Copilot, Shell | Agents offered when starting a session |
| `parallelo.worktreePath` | `.worktrees` | Where new worktrees go, relative to the repo root |
| `parallelo.branchPrefix` | `session/` | Prefix for branches created for new sessions |
| `parallelo.autoOpenRepository` | `true` | Register a worktree with git when a terminal enters it |
| `parallelo.followProcessCwd` | `true` | Resolve the worktree from the terminal's processes, not just the shell |
| `parallelo.autoSessionColors` | `true` | Give each session a distinct colour automatically |
| `parallelo.stashGuard` | `true` | Warn when the shared stash is used with more than one session live |
| `parallelo.conflictRadar` | `true` | Mark sessions editing the same file as another session |
| `parallelo.sessionBaseline` | `true` | List the commits each worktree session has made, and count them in the conflict radar |
| `parallelo.setupCommand` | — | Command run once in a new worktree before the agent starts |
| `parallelo.copyFiles` | `.env`, `.env.local` | Untracked files copied into each new worktree |
| `parallelo.showStatusBar` | `true` | Show the active session's branch in the status bar |
| `parallelo.showMainCheckout` | `true` | List a terminal in the main checkout, not only worktree sessions |
| `parallelo.openWorktreeTerminals` | `true` | Open a terminal in every worktree when the window starts |

## 🔨 Building it

```bash
bun install
bun run compile
```

Press **F5** for an Extension Development Host. `Cmd+R` reloads it after a
rebuild.

## 📄 Licence

MIT

<div align="center">

Made for the window with too many agents in it. 🧵

</div>
