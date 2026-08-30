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
- Any cross-agent memory, message bus, or MCP server
- Agent orchestration, dispatching prompts, or headless agent runs
- Reimplementing the diff editor — always delegate to `vscode.diff`
- Replacing the built-in Source Control panel — this lives beside it, not instead of it
- Telemetry, license gating, or paid tiers

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

**Commands:** `newSession`, `refresh`, `focusTerminal`, `openChange`, `stageAll`, `revealInScm`, `removeWorktree`.

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
