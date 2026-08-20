# Parallelo Session — Roadmap & Competitive Notes

Working doc for the pre-launch feature branch. Everything needed to build the
next round is here: what the competition ships, what is worth taking, what is
deliberately out of scope, and the implementation notes for each new feature.

**Status as of 2026-08-18**

| | |
|---|---|
| Extension id | `parallelo-session` ("Parallelo Session") |
| Built and compiling | container rename, nested-worktree resolution, process-cwd binding, all-terminal sync, session name/colour/icon, auto-colours, stash guard |
| **Unverified** | **per-hunk staging (see §7) — nothing below should ship before this is settled** |
| Repo | `main` on github.com/lilyanAhmetoglu/parallelo; `feat/activity` merged as PR #1 |

---

## 1. The gap we own

Everything in this space makes you **pick a row**. Nothing follows the active
terminal automatically.

That is the whole product, and every feature below either strengthens that
binding or gets cut. The contract, restated after this week's findings:

> **The working directory of the process in the terminal is the only contract.**

Note "of the process" — the original wording said only "the working directory",
which turned out to be wrong for agents that create their own worktree
(`claude --worktree` and equivalents). They chdir themselves and leave the
shell behind. See `src/processCwd.ts`.

---

## 2. Competitive landscape

Pulled from marketplace READMEs, 2026-08-18.

| Extension | Installs | Position |
|---|---|---|
| `vana123.vswt` — Worktree Sessions for Claude Code | 47 | Closest competitor. Full worktree lifecycle + Claude session history |
| `petar-s-dimov.argus-worktree-agent-sessions` — Argus | 1 | Worktree discovery + Claude/Codex launch. macOS ARM only |
| `Acycai.agent-worktree-trace` | 20 | Cross-worktree activity tracking + conflict prediction |
| `zarritas.agent-sessions` | 37 | Holds the "Agent Sessions" name |
| `Gregor-von-Vitek.agent-sessions-sync` | 28 | Session sync |
| `eric-mountain.agent-terminal-sessions` | 6 | Terminal-oriented sessions |

Also relevant: **VS Code 1.133 ships a built-in "Agent Sessions"** feature and
reserves the `agentSessions` view-container id behind the `chatSessionsProvider`
API proposal. That collision is what forced our container rename to
`worktreeSessions`. Microsoft is in this space now — assume they keep moving.

### `vana123.vswt` in detail — the one to watch

Worktree create / rename / remove / **pin to top** · status badges (`●N` dirty,
`↑N` ahead, `↓N` behind) · Changes node per worktree · pull / push / fetch ·
Create PR via `gh` · "Finish" lifecycle (push → checkout target → pull → merge)
· lists historical Claude sessions from `~/.claude/projects` with click-to-resume
· running-vs-historical detection · live refresh via file watcher · reuses an
existing terminal when reopening a session.

**Their weakness is their coupling.** Session history and resume are read out of
Claude's private directory, so none of it works for Codex, aider, or anything
else. We stay agent-agnostic; that is the trade we are making on purpose.

### `Acycai.agent-worktree-trace` in detail

Tracks agent activity across parallel worktrees live, and **flags potential
merge conflicts before they happen**. The only genuinely novel idea in the
category. Implemented as a separate scanning subsystem; for us the same result
falls out of data we already hold.

---

## 3. Copy list — ranked

Things competitors have that we should take.

### 3.1 Ahead / behind badges — **S**
`↑N ↓N` next to the existing dirty count. Every extension in the category has
this and we look thin without it.

*Implementation:* `repository.state.HEAD.ahead` / `.behind`, rendered in
`sessionsProvider.ts` `getTreeItem` alongside the current dirty count.

### 3.2 Pin to top — **S**
Matters as soon as you run five sessions.

*Implementation:* add `pinned?: boolean` to `SessionStyle` in
`src/sessionStyles.ts` — it is already keyed by worktree path and already
persists. Sort in `SessionsProvider.getChildren()`.

### 3.3 Quick-switch — **S**
Click the status bar → QuickPick of sessions → focus the terminal.

*Implementation:* one command; `tracker.allSessions` for the picker,
`session.terminal.show()` on pick. Point `status.command` at it instead of the
view container.

### 3.4 Reuse the existing terminal — **S**
Already effectively done via `focusTerminal`. Verify it holds when a session is
reopened rather than switched to.

---

## 4. Net-new features — nobody has these

Ranked by value to someone running several agents at once and not wanting to
think about git.

### 4.1 Busy / waiting indicator — **ATTEMPTED, DROPPED 2026-08-18**

Built and removed. Do not rebuild it without a new signal.

The plan was to read CPU from the terminal's process tree and mark sessions
that had gone quiet. It works, in the sense that it correctly separates a busy
agent from an idle one -- measured at roughly 2% CPU against 0.5%. The problem
is that this is not the question worth answering.

**An agent that asked you a question and an agent that finished its turn are
indistinguishable from outside the process.** Both sit alive, holding the
terminal foreground, using almost no CPU. So the dot appeared on every idle
agent and told you nothing you could act on.

Signals checked and ruled out on macOS:
- `ps wchan` is empty; Linux exposes a wait channel that would separate
  blocked-on-tty from blocked-on-network, macOS does not
- `ps stat` reads `S+` for both busy and idle agents
- no terminal-bell event in the stable extension API
- shell integration's execution events fire when a *command* ends, which for a
  long-lived interactive agent is never

Reading the agent's output or its private session state would answer it, and
that is the Claude-only trade this project refuses. Revisit only if VS Code
exposes a terminal-bell or an idle-input event.

What survived: the process-snapshot hardening in `src/processCwd.ts`, and the
session-key fix in `src/sessionStyles.ts`.

### 4.1b Original plan, for reference — *superseded*

**Problem.** Four agents running. Which is still working, and which has been
waiting on a question for six minutes? Today you click all four to find out.

**Why we can do it agent-agnostically.** We already walk the process tree. A
terminal holding only a shell is waiting on you; a terminal with a live child
consuming CPU is working. Competitors get this by reading Claude's private
session files, which is exactly why theirs is Claude-only.

**Implementation.**
- Extend `src/processCwd.ts` to also return `comm` and `%cpu`
  (`ps -axo pid=,ppid=,pcpu=,comm=`) — same single `ps` call, already cached
  750ms and shared across terminals.
- A terminal is *working* if it has a descendant that is not the shell itself.
  Refine with a CPU threshold if idle agents prove noisy.
- Render in `sessionsProvider.ts`: `$(loading~spin)` working, `$(circle-outline)`
  waiting. **Waiting is the state worth surfacing** — that is the one blocking
  the user.
- Needs a light poll (~2s) while the view is visible; there is no event for a
  child process going idle. Stop polling when the view is hidden.

**Risk.** Polling cost, and a wrapper process could read as "working" forever.
Ship behind `parallelo.showActivity`, default on.

### 4.2 Session baseline diff — "show me everything this agent did" — **M/L**

**Problem.** The agent ran twenty minutes and made three commits. The Changes
view shows uncommitted work only, so its actual output is invisible. This is the
single most common way people lose the thread with a parallel agent.

**Implementation.**
- Stamp the worktree's HEAD sha the first time a session is seen. Store it in
  the same worktree-keyed memento as styles (`sessionStyles.ts` pattern).
- One command diffs the working tree against that baseline:
  `git.toGitUri(uri, baselineSha)` on the left, the file on disk on the right —
  the same URI mechanism `changesProvider.openChange` already uses.
- Offer "reset baseline to now" so it can be re-armed after a review.

**Depends on §7 being settled.** This feature is built entirely on those URIs.

### 4.3 Conflict radar — **M** — **DONE 2026-08-20** (`feat/conflict-radar`)

**Problem.** Two sessions editing `auth.ts` at once. You find out at merge time.

**Implementation.** Intersect `repository.state.workingTreeChanges` across all
tracked sessions — data we already hold, no scanning subsystem needed. Render as
`⚠ 2 files also edited by test-b` in the row description, with the file list in
the tooltip.

Shipped as `src/conflictRadar.ts`, behind `parallelo.conflictRadar`. Unstaged,
staged, untracked and merge changes all count — an agent that staged a file has
still edited it, and a session mid-conflict on `auth.ts` is the one you least
want a second agent walking into. Untracked files sit in `workingTreeChanges`
only under the default `git.untrackedChanges: mixed`, so `untrackedChanges` is
read as well; ignored files do not count.

**The radar compares working trees, not branches.** Once an agent commits, its
files leave the comparison — which is a real hole, because committing to the
session branch is the advice the stash guard gives. The committed half belongs
to §4.2: "everything this agent did since its baseline" is exactly what that
feature computes, and its resettable baseline is also the answer to the noise
problem a plain merge-base diff would create (a session branch forty commits
deep would overlap with everything, permanently). **When §4.2 lands, feed its
per-session file set into `editedFiles` here.** Until then the README says
"uncommitted" and means it.

Comparison is per worktree, not per session: two terminals in one worktree
share a working tree and cannot collide, and the row already says another
terminal is in there. Worktrees are grouped by `git rev-parse
--git-common-dir` so only worktrees of one repository are ever compared —
without that, two unrelated projects each holding a dirty `src/index.ts` read
as a conflict. That call was already in `stashGuard`; it now lives in
`src/gitCommonDir.ts` and both use it.

The radar keeps a snapshot and fires only when the overlap actually changes.
It recomputes on `onDidChangeSessions`, which the tracker fires on every git
state change of every tracked repository — repainting the tree on each of those
would drag the selection about for no new information.

Naming lives in the radar rather than the view because three surfaces show it —
the row, the decoration hover and the session picker — and a warning that named
the worktree in one and the renamed session in another would not read as the
same thing.

**The mark is deliberately in three places, and each earns it.** The row
description alone was the first version and it failed in practice: the
description is truncated from the right, so at a normal sidebar width the
warning was invisible. A `FileDecorationProvider` on a `parallelo-session:`
uri fixes visibility — the colour lands on the name and the badge pins right —
but a badge says only that *something* is wrong. The description then led with
the filename, which was the second thing to fail in practice: `⚠ alpha.txt`
reads as a filename, not as a warning — there is nothing in it that says what
is wrong. So the row says `⚠ 2 conflicts`, which carries the meaning in the
same space, and the hover names it and lists the files per worktree. Do not
collapse these back into one; each covers a width the others do not.

The hover says **possible** conflict. Nothing has conflicted yet — git will
have no opinion until the branches meet — and naming a failure that has not
happened is exactly what the copy rules forbid.

### 4.4 Shared-stash guard — **S** — **DONE 2026-08-18** (`feat/stash-guard-auto-colours`)

**Problem.** `refs/stash` lives in the common `.git` directory, so **every
worktree pushes onto one stack**. Two agents stashing concurrently corrupt each
other's work. Completely invisible today. (CLAUDE.md gotcha 2.)

**Implementation.** Watch `refs/stash` in the common git dir. When it changes
while more than one session is live, warn once per window.

Shipped as `src/stashGuard.ts`, behind `parallelo.stashGuard`. Verified against
a real repo: `refs/stash` is written to the common `.git`, never to
`.git/worktrees/<name>/`, and a pop from one worktree does take the stash
another worktree pushed.

Attribution is only offered on a *push*. A pop deletes its own reflog entry, so
the branch named in the last remaining line of `logs/refs/stash` belongs to
somebody else — reading it after a pop names the wrong session. The guard
compares reflog depth against the previous reading to tell the two apart, and
says "applied or dropped" without a branch when the log shrank.

Never add a stash *feature*. This is a warning only.

### 4.5 Auto-distinct colours — **S** — **DONE 2026-08-18** (`feat/stash-guard-auto-colours`)

Manual colours exist; vibe coders will not set them. Assign each new session the
next unused colour from `COLORS` automatically, manual override wins.

*Implementation:* on first sight of a worktree in `SessionStyles`, allocate the
lowest-index colour not currently in use.

Shipped as `SessionStyles.autoAssign`, behind `parallelo.autoSessionColors`.
`SessionStyle.autoColor` marks who chose: `true` automatic and reshufflable,
`false` the user decided — *including* deciding on no colour, which is why the
empty-record cleanup in `update()` keeps a record holding only `autoColor:
false`. The colour picker grew an "Automatic" entry to hand a session back.

### 4.6 Considered and cut

- **Session notes** — sounds useful, nobody writes them.
- **Port / `.env` collision detection** — too speculative, high false-positive rate.
  Document the caveat in the README instead (CLAUDE.md gotcha 5).

---

## 5. Non-goals — do not build these

Unchanged from CLAUDE.md, restated because every competitor drifted into them:

- Worktree management as a feature surface (create / list / prune UI) beyond the
  one convenience command
- Merge, rebase, pull, push, fetch, Create PR, "Finish" lifecycle — that is a git
  client, and GitLens plus VS Code 1.103's built-in worktree support own it
- **Reading `~/.claude/projects` or any agent's private state** — the moment we do
  this we are Claude-only, which is the entire trade we are refusing
- Cross-agent memory, message bus, MCP server
- Agent orchestration or dispatching prompts
- Reimplementing the diff editor — always delegate to `vscode.diff`
- Telemetry, license gating, paid tiers

---

## 6. Launch checklist

| Item | State |
|---|---|
| `publisher` — currently `your-publisher-id` | **blocker** |
| `repository.url` — currently `your-name/...` | done |
| `LICENSE` file (manifest claims MIT) | done |
| 128×128 PNG icon | done |
| `.vscodeignore` (else the vsix ships `src/` + `node_modules/`) | done |
| `.gitignore` | done |
| `CHANGELOG.md` | done |
| `git init` + first commit | done |
| `vscode:prepublish` uses npm, should use bun | done |
| README rewritten for the new name, with GIF | to do |
| Publish to Open VSX (Cursor / Windsurf audience) | to do |
| Document: shared stash, no port/`.env` isolation, macOS+Linux only process cwd | to do |

---

## 7. Unverified assumptions

**Per-hunk staging has never been tested.** CLAUDE.md calls it "the highest-value
behavior to verify; it means the git URIs are correct."

Test: terminal into a worktree → click a changed file in the Changes view →
click inside one hunk → `Git: Stage Selected Ranges` → confirm with
`git diff --cached` that **only that hunk** is staged.

Everything built so far assumes `changesProvider.openChange` produces correct
git URIs. §4.2 depends on it entirely. If it fails, the fix is in `openChange`,
not in anything else built this week.

The old fixture lived in a session scratchpad and is gone. Rebuild it with:

```bash
git init -b main testrepo && cd testrepo
seq 1 40 > alpha.txt && seq 1 40 > beta.txt
git add -A && git commit -m base
git worktree add .worktrees/test-a -b session/test-a
git worktree add .worktrees/test-b -b session/test-b
```

Then edit lines 3 and 35 of `test-a/alpha.txt` and lines 5 and 30 of
`test-b/beta.txt` — two separate hunks each, nothing staged.

---

## 8. Asset briefs

### 8.1 Icon prompt

> Design a 128×128 PNG icon for a VS Code extension called **Parallelo Session**.
> It binds the active terminal to its git worktree, so the diff panel follows
> whichever terminal you are focused on. Concept: **two or three parallel tracks,
> one of them clearly active.** Suggested form — three horizontal rounded bars
> stacked with even spacing, the middle one brighter/filled and slightly
> extended, the others dimmed, with a small terminal prompt chevron `>` at the
> left edge of the active bar. Flat vector, no gradients, no text, no drop
> shadows. Bold single-weight geometric strokes that stay legible at 32×32 and
> 16×16. Must read clearly on both a dark (#1e1e1e) and light (#ffffff)
> background — no pure white or pure black as the primary colour. Palette: one
> saturated accent (electric blue or violet) plus one neutral grey. Square
> canvas, ~10% padding, transparent background. Deliver as 128×128 PNG.

### 8.2 Demo GIF

Must be a **real screen recording**. Its whole purpose is proving the diff
follows the terminal; a mocked animation would misrepresent the product.

~8 seconds, no narration, looping:

1. Two terminals visible, both in worktrees, Changes showing `alpha.txt` — hold 1s
2. Click the test-b terminal → Changes repaints to `beta.txt`, title changes — hold 1s
3. Click back to test-a → repaints again — hold 1s
4. Click `alpha.txt` → native diff opens with red/green — hold 2s

Capture with `Cmd+Shift+5` or Kap, then:

```bash
ffmpeg -i demo.mov -vf "fps=12,scale=900:-1:flags=lanczos" -f gif - \
  | gifsicle -O3 > demo.gif
```

Keep under 3MB. Crop tight to sidebar + terminal — the full window at 900px
makes the panel unreadable.

---

## 9. Suggested branch order

1. `git init`, commit everything currently on disk — **do this first, today's work is unversioned**
2. Settle §7
3. ~~Branch `feat/activity` → §4.1 busy/waiting~~ — merged; §4.1 dropped, see above.
   §4.4 and §4.5 landed after it on `feat/stash-guard-auto-colours`.
4. Branch `feat/badges` → §3.1, §3.2, §3.3
5. Branch `feat/baseline` → §4.2, then §4.3
6. Packaging pass → §6
