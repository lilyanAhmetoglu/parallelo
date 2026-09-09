import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** NUL-separated `-z` output, without the empty tail. */
function entries(stdout: string): string[] {
  return stdout.split('\0').filter(Boolean);
}

/**
 * One exclude pattern, matched against a single path segment.
 *
 * Segment-wise rather than whole-path, so `dist` excludes `dist/` at the root
 * and `packages/ui/dist/` alike -- in a monorepo the build output is never at
 * the top, and a list that only worked at the root would look like it was doing
 * something while copying every `dist` in the tree.
 */
function matcher(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${escaped}$`);
}

/**
 * Everything in the base checkout that git does not track: ignored files --
 * `.env`, `.dev.vars`, a local settings file -- and files never added.
 *
 * A worktree checks out tracked content and nothing else, which is the whole
 * reason this exists: the agent you just started is looking at a repository
 * that cannot reach its own database, because the file holding the URL was
 * never git's to copy.
 *
 * Two listings rather than one. `--others` alone gives untracked-but-not-
 * ignored; adding `--ignored` gives only the ignored ones. `git status
 * --porcelain --ignored` would answer in a single call and also drag in every
 * modified tracked file, which belongs to the branch, not to the machine.
 *
 * `--directory` is what makes this affordable. A wholly untracked directory
 * prints as `node_modules/` instead of its forty thousand files, so nothing
 * walks into it before the exclude list has had its say.
 */
async function untrackedEntries(base: string): Promise<string[]> {
  const [ignored, others] = await Promise.all([
    git(base, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']),
    git(base, ['ls-files', '--others', '--exclude-standard', '--directory', '-z'])
  ]);
  const listed = [...entries(ignored), ...entries(others)]
    .map(entry => entry.replace(/\/+$/, ''))
    .filter(Boolean);

  // The two listings overlap, and each one repeats itself: git prints the
  // collapsed `.claude/` *and* the `.claude/settings.local.json` inside it.
  // Keeping only the outermost entry of each branch is what stops a directory
  // being copied once as a whole and again file by file.
  const outermost: string[] = [];
  for (const entry of [...new Set(listed)].sort((a, b) => a.length - b.length)) {
    if (!outermost.some(kept => entry === kept || entry.startsWith(`${kept}/`))) {
      outermost.push(entry);
    }
  }
  return outermost;
}

/** Whether `child` is `parent` or sits underneath it. */
function within(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Copies one listed entry, descending into it if it is a directory.
 *
 * The descent is ours rather than a single `fs.copy` of the whole directory
 * because a collapsed entry hides its own exclusions: git prints `packages/`
 * for a directory whose only contents are ignored, and copying that in one call
 * would carry the `packages/ui/dist` inside it however plainly `dist` is
 * excluded. Directories that reach this point are small -- the expensive ones
 * were excluded by name before anything was opened.
 *
 * Appends what it copied to `copied`, repo-relative and forward-slashed, which
 * is how git spells paths and so how the radar will look them up.
 */
async function copyTree(
  from: string,
  to: string,
  rel: string,
  excluded: (name: string) => boolean,
  token: vscode.CancellationToken,
  copied: string[],
  log: (message: string) => void
): Promise<void> {
  if (token.isCancellationRequested) {
    return;
  }

  let type: vscode.FileType;
  try {
    type = (await vscode.workspace.fs.stat(vscode.Uri.file(from))).type;
  } catch (error) {
    log(`seed: skipped ${rel}: ${error}`);
    return;
  }

  // `stat` follows the link and ORs the bits, so a symlink to a directory
  // arrives as Directory | SymbolicLink. It is skipped rather than copied: the
  // target is usually outside the repository -- a cache, a shared data mount --
  // so nothing under it was ever weighed against the exclude list, and copying
  // it drags an unbounded tree into the worktree. A symlink to a file is
  // copied as the file it names, which is what it is for.
  const isLink = (type & vscode.FileType.SymbolicLink) !== 0;
  const isDirectory = (type & vscode.FileType.Directory) !== 0;
  if (isLink && isDirectory) {
    log(`seed: skipped ${rel}: symlink to a directory`);
    return;
  }

  if (isDirectory) {
    let children: [string, vscode.FileType][];
    try {
      children = await vscode.workspace.fs.readDirectory(vscode.Uri.file(from));
    } catch (error) {
      log(`seed: skipped ${rel}: ${error}`);
      return;
    }
    for (const [name] of children) {
      if (!excluded(name)) {
        await copyTree(
          path.join(from, name),
          path.join(to, name),
          `${rel}/${name}`,
          excluded,
          token,
          copied,
          log
        );
      }
    }
    return;
  }

  try {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(to)));
    await vscode.workspace.fs.copy(vscode.Uri.file(from), vscode.Uri.file(to), {
      overwrite: false
    });
    copied.push(rel);
  } catch (error) {
    // A source that vanished, or a name the checkout already holds. Neither is
    // worth interrupting the session for.
    log(`seed: skipped ${rel}: ${error}`);
  }
}

/**
 * Copies the base checkout's untracked files into a new worktree.
 *
 * Returns the paths copied, repo-relative, so the conflict radar can tell them
 * apart from anything an agent wrote. Never throws: a session that starts
 * without its `.env` is worth a line in the log, not a failed worktree.
 *
 * Cancellable, and it means it. There is no way to know in advance how much an
 * ignored directory holds -- `vendor`, `.terraform`, a directory of fixtures --
 * and a session creation that cannot be stopped is worse than one that copies
 * nothing.
 */
export async function copyUntrackedFiles(
  base: string,
  worktreePath: string,
  config: vscode.WorkspaceConfiguration,
  token: vscode.CancellationToken,
  log: (message: string) => void
): Promise<string[]> {
  const excludes = config.get<string[]>('copyExclude', []).map(matcher);
  const excluded = (name: string) => excludes.some(exclude => exclude.test(name));

  // Where worktrees live, so a new one is never seeded with its siblings.
  // `.worktrees` is ignored in most repositories, which means git lists it as
  // one untracked directory and a plain copy would put every existing session
  // -- checkouts, `.git` files and all -- inside the session being created.
  const dir = config.get<string>('worktreePath', '.worktrees');
  const container = path.isAbsolute(dir) ? dir : path.join(base, dir);

  let listed: string[];
  try {
    listed = await untrackedEntries(base);
  } catch (error) {
    log(`seed: could not list untracked files: ${error}`);
    return [];
  }

  const copied: string[] = [];
  for (const rel of listed) {
    if (token.isCancellationRequested) {
      break;
    }
    if (rel === '.git' || rel.split('/').some(excluded)) {
      continue;
    }
    const from = path.join(base, rel);
    // Either direction: the container may be inside a listed directory as
    // easily as the other way round when `worktreePath` is nested.
    if (within(container, from) || within(from, container) || within(from, worktreePath)) {
      continue;
    }
    await copyTree(from, path.join(worktreePath, rel), rel, excluded, token, copied, log);
  }
  return copied;
}

/**
 * Lockfiles, most specific first, and the install each one implies.
 *
 * Ordered rather than a map because a repository can hold two: a `package-
 * lock.json` left behind after a move to pnpm is common, and the file the
 * project actually maintains is the one to believe. `packageManager` in
 * `package.json` outranks all of them -- it is the field that exists to answer
 * exactly this question.
 */
const LOCKFILES: { file: string; install: string }[] = [
  { file: 'bun.lock', install: 'bun install' },
  { file: 'bun.lockb', install: 'bun install' },
  { file: 'pnpm-lock.yaml', install: 'pnpm install' },
  { file: 'yarn.lock', install: 'yarn install' },
  { file: 'package-lock.json', install: 'npm install' },
  { file: 'npm-shrinkwrap.json', install: 'npm install' }
];

const INSTALL_BY_NAME: Record<string, string> = {
  bun: 'bun install',
  pnpm: 'pnpm install',
  yarn: 'yarn install',
  npm: 'npm install'
};

async function readFile(file: string): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(file));
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(file));
    return true;
  } catch {
    return false;
  }
}

/**
 * The install command a fresh worktree needs, or undefined when this is not a
 * node project.
 *
 * A worktree checks out `package.json` and leaves `node_modules` behind --
 * it is ignored, and it is the one ignored thing too big to copy -- so an
 * agent's first command in a new session is an install it should not have had
 * to think about.
 *
 * Read from the base checkout, which is where the lockfile the project
 * maintains lives, and only ever *suggested*: it is typed into the terminal
 * like anything else, so a wrong guess is one visible line, not a hidden step.
 */
export async function detectInstallCommand(base: string): Promise<string | undefined> {
  const manifest = await readFile(path.join(base, 'package.json'));
  if (manifest === undefined) {
    return undefined;
  }

  // `packageManager: "pnpm@9.1.0"` is corepack's field and says so outright.
  try {
    const declared = JSON.parse(manifest)?.packageManager;
    if (typeof declared === 'string') {
      const name = declared.split('@')[0].trim();
      // `hasOwn`, not truthiness: the field is copied out of someone's
      // package.json, and `constructor@1` would otherwise resolve through the
      // prototype and hand back a function to type into a terminal.
      if (Object.hasOwn(INSTALL_BY_NAME, name)) {
        return INSTALL_BY_NAME[name];
      }
    }
  } catch {
    // An unparseable package.json is still a node project; fall through to the
    // lockfiles rather than giving up on the whole question.
  }

  for (const { file, install } of LOCKFILES) {
    if (await exists(path.join(base, file))) {
      return install;
    }
  }

  // A manifest and no lockfile and no declared manager. Nothing here says
  // which package manager this project uses, and the wrong guess is not a
  // wasted line -- `npm install` in a bun project writes a `package-lock.json`
  // into the new worktree and builds a `node_modules` the project disagrees
  // with. A `package.json` that exists only for tooling, in a Go or Rust repo,
  // is the same story. `setupCommand` is how someone says what to run when the
  // repository does not.
  return undefined;
}
