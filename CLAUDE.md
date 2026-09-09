# Agent Sessions — VS Code Extension

## What this is

A VS Code extension that binds the **active integrated terminal** to its **git worktree**, so the changes panel follows whichever terminal you are focused on.

One sentence: *switch terminals, and the diff follows.*

## Why it exists

When you run several coding agents in parallel (Claude Code in one terminal, Codex in another), each in its own git worktree, VS Code shows every worktree stacked together in the Source Control Repositories view. There is no link between the terminal you are working in and the diff you are looking at. You have to hunt for the right repository entry every time you switch.

This extension adds that one missing binding.

It is agent-agnostic by design. It never knows or cares what is running in the terminal — Claude Code, Codex, aider, or a plain shell all behave identically, because **the working directory is the only contract.**

## What already exists (do not rebuild these)

Verify assumptions against these before adding anything:

- **VS Code 1.103+ has built-in worktree support.** `Git: Create Worktree`, `Git: Open Worktree in New Window`, `Git: Delete Worktree`, and worktree actions in the Source Control Repositories view. Each worktree already appears there as a separate repository with working diffs and staging.
- **At least five worktree manager extensions** already ship on the marketplace (PhilStainer's `git-worktree`, kaih2o's `worktrees`, Verition Worktree Manager, `git-worktree-menu`, jackiotyu's `git-worktree-manager`).
- **Cross-agent memory MCP servers** are a crowded category (Memorix, evalops/shared-memory-mcp, Statewave, and ~176 others).

**The gap this fills is narrow and specific: nothing watches the active terminal and repaints the SCM view to match.** Everything else in this space requires manual selection. Stay in that gap.

## Non-goals

Do not build these. They are either solved elsewhere or belong in a separate project:

- Worktree management as a feature surface (creation, listing, pruning UI) beyond the one convenience command below
- Any cross-agent memory, or an MCP server *implemented in this extension* --
  see the amendment below
- Agent orchestration beyond starting terminals, or headless agent runs
- Reimplementing the diff editor — always delegate to `vscode.diff`
- Replacing the built-in Source Control panel — this lives beside it, not instead of it
- Telemetry, license gating, or paid tiers

### Amendment: brainstorming rooms (2026-09-06)

Rooms cross the old "no MCP server, no dispatching prompts" line, deliberately
and with a boundary drawn:

- **The protocol is not in this extension.** It lives in `roundtable-mcp`, a
  separate package with its own repo, invoked as an external binary. Parallelo
  never implements a message bus and never speaks MCP itself. If that stops
  being true, the feature has gone wrong.
- **What Parallelo contributes is what it already did**: make a worktree, open
  terminals in it, bind them to the diff. Plus one thing the server cannot do
  for itself -- put a different `ROUNDTABLE_SEAT` in each terminal's
  environment, which is what lets two identical agents know which is which.
- **Both seats share one checkout.** They are arguing about the same code. Two
  worktrees would give them two repositories and two transcripts that never
  meet.
- The kickoff is one line pointing at a prompt file the server wrote. The
  extension keeps no copy of the prompts; they belong to the protocol.

- **A seat's brief goes in its system prompt, never as typed input.** Terminal
  text is eaten by whatever dialog the agent shows at startup, and a seat that
  never read its brief is indistinguishable from one waiting properly -- three
  rooms died this way before the cause was found. `--append-system-prompt-file`
  with a `${seat}` placeholder is the delivery mechanism; the typed line only
  starts the turn.
- **The seats are read-only, and that is enforced, not requested.** An agent
  holding a file tool will implement rather than plan -- a Haiku lead given
  `Write` and `Bash` wrote the whole feature and never opened the room. So the
  room's tools are the only way to produce anything: `write_spec` lives on the
  server and `close_room` refuses until it has been called. Never solve this
  with prompt wording alone; wording is what failed.
- **Scrub the parent agent's session markers from a seat's environment.** A
  terminal inherits the editor's environment and the editor inherits whatever
  launched it, so opening VS Code from a shell inside an agent makes every seat
  a *child of that session* -- one session id shared by both seats and the
  parent, transcripts off, permissions answered out of sight. Two seats that are
  the same session cannot argue with each other. Clear the per-session markers
  only; leave real configuration alone.
- **Never put a seat in plan mode.** It sounds right and it is measured wrong:
  `--permission-mode plan` overrides `--allowedTools` and puts an approval
  prompt in front of every action-shaped tool, `post` included, so the lead
  cannot speak and the peer waits forever. Same room, same flags, budget 1:
  plan mode reached 0 tool calls in ten minutes; without it, 9 calls, both
  seats, spec written, room closed. What plan mode is wanted for is already
  guaranteed more strictly -- the seats hold no `Write`, `Edit`, `NotebookEdit`
  or `Bash` at all, so implementing is impossible rather than merely gated.
- **Brief a seat when the server says it connected, never on a timer or a
  button.** An agent registers with the room as soon as it has finished
  starting, and that is the only honest readiness signal available. It was a
  button on a notification once; notifications scroll away, and a room that was
  never briefed looks exactly like a room that is thinking.
- **Type the brief and press Enter as two separate writes.** `sendText(text)`
  emits the text and its newline in one burst, and an agent TUI reading that
  fast treats it as a paste: the brief lands in the input box and sits there
  unsent. That is indistinguishable from never having sent it, and it is what
  "the peer is idle at the input box" actually was. `sendText(text, false)`,
  a short pause, then `sendText('', true)`. Shells do not care; TUIs do.
- **The room's wiring ships with the agent, not with the user.** The flags that
  point a seat at the MCP server and at its brief live in `roomArgs` on the
  agent entry, with a working default for Claude Code, and a seat with no flags
  is refused rather than opened. They were a settings-only value defaulting to
  empty, which meant the whole feature did nothing at all unless a 400-character
  string had been copied in by hand -- and two plain agents with no server look
  exactly like two agents thinking. Never let a room open in a state where it
  cannot possibly work.
- **Claude Code's trust is inherited from a parent directory.** A worktree under
  an already-trusted repo shows no startup dialog; one outside it shows a dialog
  in every seat. This is the reason `worktreePath` must stay inside the repo for
  rooms, and it was measured, not assumed.

- **A room writes nothing at the worktree root but the spec.** No `.mcp.json`:
  the seats are launched with `--strict-mcp-config` pointed at the room's own
  config, so a copy beside it is never read, shows up in `git status`, and in a
  repo that already tracks one would edit a tracked file. Deny the indirect
  write paths too, not just `Write` and `Edit` -- a subagent (`Task`), a slash
  command, or `MultiEdit` all reach the disk by another door.

- **The transcript is not a second output, and not part of the spec.** It is
  rendered on demand by `roundtable transcript` into the temp directory and
  opened -- never written into the worktree, never appended to the spec, which
  is for someone who was not in the room and has to find the decision fast.

- **A room has exactly one output**: a spec, written by the lead, defaulting to
  `SPEC-<room>.md` at the worktree root. Everything else -- prompts, server
  config, transcript -- lives under `.roundtable/`, which ignores itself so the
  spec is the only thing git ever shows. Never add a second output, and never
  make the user choose which file was the real one.

  **Where that one file goes is asked at creation** and settled in `room.json`
  by `roundtable seed --spec`, which is where the briefs, `write_spec` and the
  closing message all read it from. One place decides, or the lead is told to
  write somewhere the server does not look. The path stays inside the worktree:
  absolute paths and `..` fall back to the default, in the server rather than in
  the dialog, because the dialog is not the only caller. Choosing a location is
  not choosing between two outputs -- that rule stands.

The rest of the non-goals stand. Rooms plan, they do not implement.

## Architecture

Single source of truth is `SessionTracker`. Everything else is a passive view that re-reads from it on an event.

```
onDidChangeActiveTerminal ─┐
onDidChangeTerminalShell.. ─┼─> SessionTracker.sync()
git.onDidOpenRepository   ─┘        │
                                    │ 1. read terminal.shellIntegration.cwd
                                    │ 2. longest-prefix match vs git.repositories
                                    │ 3. no match? walk up for .git, openRepository()
                                    │ 4. fire onDidChangeSession
                                    ▼
                    ┌───────────────┼───────────────┐
              ChangesProvider  FilesProvider  SessionsProvider
                    │               │               │
                    └──────── status bar item ──────┘
```

A `Session` is `{ terminal, cwd, repository?, label }`. Sessions are keyed by `vscode.Terminal` object identity in a `Map`.

### The critical trick

When a terminal enters a worktree that is **not** part of the workspace, call `gitApi.openRepository(uri)` to register it with the built-in git extension. This is what lets worktree diffs appear **without the user adding folders to their workspace**. Without it, the whole thing only works for multi-root workspaces, which defeats the purpose.

Walk up a maximum of 24 parent directories looking for a `.git` entry. In a linked worktree `.git` is a *file*, not a directory, so use `fs.stat` and do not check the type.

### Deepest match wins

When matching a cwd against `gitApi.repositories`, prefer the repository with the **longest** `rootUri.fsPath`. A worktree at `<repo>/.worktrees/foo` is inside the main checkout, so a naive first-match returns the parent and shows the wrong diffs.

## Load-bearing API facts

These are verified. Do not guess alternatives.

**Git extension access:**
```ts
const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
const exports = ext.isActive ? ext.exports : await ext.activate();
const git = exports.enabled ? exports.getAPI(1) : undefined;
```

**Used from the git API:** `repositories`, `onDidOpenRepository`, `onDidCloseRepository`, `openRepository(root)`, `toGitUri(uri, ref)`, and per-repository `state.HEAD`, `state.workingTreeChanges`, `state.indexChanges`, `state.mergeChanges`, `state.onDidChange`, `add(paths)`, `status()`.

**Terminal cwd:** `terminal.shellIntegration?.cwd` returns a `Uri`. Stable API since VS Code 1.93. Falls back to `terminal.creationOptions.cwd`, which is always set for terminals the extension creates itself.

**Diff refs for `toGitUri`:** `'HEAD'` for the committed version, `'~'` for the index, `''` also resolves to the index. Staged files diff `HEAD` against `~`. Unstaged files diff `~` against the real file URI on disk.

**Engine floor:** `"vscode": "^1.93.0"` — required by the shell integration API.

**No runtime dependencies.** Dev deps only: `typescript`, `@types/vscode`, `@types/node`.

## Gotchas that will cost you an hour each

1. **The `Status` enum must exist twice.** `git.d.ts` is a declaration file, so a `const enum` in it vanishes at compile time and comparisons fail with TS2367. Type `Change.status` as `number` in the `.d.ts` and keep a real runtime `enum Status` in a separate `status.ts`. This is not redundancy, it is required.

2. **`git stash` is shared across all worktrees.** `refs/stash` lives in the common `.git` directory, so every worktree pushes onto one stack. If two agents stash and pop concurrently they will corrupt each other's work. Warn about this in the README and tell users to have agents commit to their session branch instead. Never add a stash feature to this extension.

3. **Do not blank the views when cwd is unresolved.** Shell integration reports the cwd asynchronously. If `sync()` finds no cwd, return early and keep the previous session, or the panel flickers empty on every terminal switch.

4. **Terminals opened before activation are invisible** until focused or until a command runs in them. Document it, do not fight it.

5. **Worktrees do not isolate ports, databases, or `.env` state.** Only files. Say so in the README.

## File layout

```
src/
  extension.ts        entry point: git API, wiring, commands, status bar
  sessionTracker.ts   the binding — everything depends on this
  changesProvider.ts  TreeDataProvider for the active worktree's diff
  filesProvider.ts    TreeDataProvider for a tree rooted at the worktree
  sessionsProvider.ts TreeDataProvider listing terminals + branch + dirty count
  worktree.ts         newSession / removeWorktree via child_process git
  status.ts           runtime Status enum
  git.d.ts            minimal typings for the built-in git extension API
resources/sessions.svg
.vscode/launch.json   F5 debugging
```

## Contributed surface

**Activity bar container `agentSessions`, three views:**
- `agentSessions.sessions` — one row per terminal in a worktree. Description shows branch and dirty count. Click focuses the terminal.
- `agentSessions.changes` — merge conflicts, staged, unstaged groups for the active session only. Click a file to open its diff.
- `agentSessions.files` — file tree rooted at the active worktree. Collapsed by default.

**Commands:** `newSession`, `newRoom`, `refresh`, `focusTerminal`, `openChange`, `stageAll`, `revealInScm`, `removeWorktree`.

`stageAll` and `revealInScm` are speculative. Cut them if they do not earn their place in real use.

**Settings (`agentSessions.*`):** `agents` (label + command pairs), `worktreePath` (default `.worktrees`), `branchPrefix` (default `session/`), `autoOpenRepository` (default true), `setupCommand`, `copyFiles` (default `.env`, `.env.local`), `showStatusBar`.

**View titles are dynamic.** Set `treeView.title` on session change to include the worktree name and branch — that is how the user confirms at a glance which session they are looking at.

## Conventions

- TypeScript `strict`, plus `noUnusedLocals` and `noImplicitReturns`.
- Everything disposable goes into `context.subscriptions`.
- Delegate to built-in commands wherever possible (`vscode.diff`, `vscode.open`, `workbench.view.scm`). Never reimplement editor UI.
- Use `ThemeIcon` and `ThemeColor` with git decoration color IDs (`gitDecoration.modifiedResourceForeground` etc.) so it matches the user's theme.
- **Copy:** plain language, no exclamation marks, no "Oops". Empty states say what to do next, not that something is missing. Error messages name the actual failure.

## Commands

```bash
npm install
npm run compile      # tsc -p ./
npm run watch        # recompile on save
```

Press **F5** to launch an Extension Development Host. `Cmd+R` in that window reloads after a rebuild.

## Manual test procedure

In the Extension Development Host, inside a real repo:

```bash
git worktree add .worktrees/test-a -b session/test-a
git worktree add .worktrees/test-b -b session/test-b
```

1. Open two terminals, `cd` one into each worktree.
2. Edit a different file in each.
3. Click between the terminals — the Changes view must repaint each time.
4. Click a changed file — the native diff editor opens with red/green.
5. Confirm gutter decorations appear when opening a worktree file normally.
6. Confirm **Stage Selected Ranges** works inside the diff (per-hunk staging). This is the highest-value behavior to verify; it means the git URIs are correct.
7. Close a terminal — its session disappears from the list.

## Publishing

Free, no review queue.

```bash
npm i -g @vscode/vsce
vsce login <publisher-id>
vsce publish
```

Publisher created at `marketplace.visualstudio.com/manage`. Needs an Azure DevOps PAT scoped `Marketplace > Manage` with organization set to *all accessible organizations*.

Also publish to **Open VSX** (`npx ovsx publish -p <token>`) — that is the registry Cursor and Windsurf use, and those are the likely users.

Before first publish: set a real `publisher`, add a 128×128 PNG `icon`, add a LICENSE file, and confirm the extension name is not taken.

**Version numbers are permanent and cannot be reused.** Never publish to test.

**Bump the VS Code badge in the README with the version.** shields.io retired
its Visual Studio Marketplace endpoints, so that badge is a static one reading
`VS%20Code-v<version>`. It is the one thing in the release that does not follow
`package.json` on its own, and a stale one says the wrong version on the store
page. The Open VSX badge is live and needs nothing.

## Reality check to keep in mind

Microsoft shipped worktree support in 1.103 and their own docs cite parallel agent sessions as a motivating use case. Terminal-to-SCM binding is a plausible next increment for them. This is a personal tool that may be published for free, **not** a product. Do not add monetization, telemetry, or a landing page.
