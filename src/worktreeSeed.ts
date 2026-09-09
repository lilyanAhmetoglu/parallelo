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
 * The ignored files in the base checkout, as few entries as git will give.
 *
 * Ignored, not merely untracked. A worktree checks out tracked content and
 * nothing else, and the gap that matters is `.gitignore`'s: `.env`,
 * `.dev.vars`, a local settings file -- the machine's half of the project,
 * which the agent you just started cannot work without. Files that are simply
 * un-added are your own work in progress; carrying them across would start
 * every new session with someone else's scratch file already in its diff.
 *
 * `--directory` is what makes this affordable. A wholly ignored directory
 * prints as `node_modules/` instead of its forty thousand files, so nothing
 * walks into it before the exclude list has had its say.
 */
async function ignoredEntries(base: string): Promise<string[]> {
  const listed = entries(
    await git(base, [
      'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'
    ])
  )
    .map(entry => entry.replace(/\/+$/, ''))
    .filter(Boolean);

  // git repeats itself: it prints the collapsed `.claude/` *and* the
  // `.claude/settings.local.json` inside it. Keeping only the outermost entry
  // of each branch is what stops a directory being handled twice.
  const outermost: string[] = [];
  for (const entry of [...new Set(listed)].sort((a, b) => a.length - b.length)) {
    if (!outermost.some(kept => entry === kept || entry.startsWith(`${kept}/`))) {
      outermost.push(entry);
    }
  }
  return outermost;
}

/**
 * The ignored files inside one directory, named individually.
 *
 * A collapsed entry is not a promise that everything under it is ignored: git
 * prints `packages/` for a directory holding no tracked files, and what is
 * inside may be a mix. Copying such a directory wholesale would carry files
 * git is not ignoring -- exactly what this is supposed to leave behind -- so
 * the directory is asked about again without `--directory`, which names only
 * the ignored ones. Affordable because the directories that reach here are
 * small: the big ones were excluded by name before anything was opened.
 */
async function ignoredWithin(base: string, dir: string): Promise<string[]> {
  return entries(
    await git(base, [
      'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', dir
    ])
  ).filter(Boolean);
}

/** Whether `child` is `parent` or sits underneath it. */
function within(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Copies one file into the worktree, recording it if it lands.
 *
 * `stat` follows a link and ORs the bits, so a symlink to a directory arrives
 * as Directory | SymbolicLink. Those are skipped: the target is usually outside
 * the repository -- a cache, a shared data mount -- so nothing under it was
 * ever weighed against the exclude list, and copying it drags an unbounded tree
 * into the worktree. A symlink to a file is copied as the file it names, which
 * is what it is for.
 */
async function copyOne(
  from: string,
  to: string,
  rel: string,
  copied: string[],
  log: (message: string) => void
): Promise<void> {
  let type: vscode.FileType;
  try {
    type = (await vscode.workspace.fs.stat(vscode.Uri.file(from))).type;
  } catch (error) {
    log(`seed: skipped ${rel}: ${error}`);
    return;
  }
  if ((type & vscode.FileType.Directory) !== 0) {
    log(`seed: skipped ${rel}: symlink to a directory`);
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
 * Copies the base checkout's ignored files into a new worktree.
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
export async function copyIgnoredFiles(
  base: string,
  worktreePath: string,
  config: vscode.WorkspaceConfiguration,
  token: vscode.CancellationToken,
  log: (message: string) => void
): Promise<string[]> {
  const excludes = config.get<string[]>('copyExclude', []).map(matcher);
  const excluded = (rel: string) =>
    rel.split('/').some(segment => excludes.some(exclude => exclude.test(segment)));

  // Where worktrees live, so a new one is never seeded with its siblings.
  // `.worktrees` is ignored in most repositories, which means git lists it as
  // one directory and a plain copy would put every existing session --
  // checkouts, `.git` files and all -- inside the session being created.
  const dir = config.get<string>('worktreePath', '.worktrees');
  const container = path.isAbsolute(dir) ? dir : path.join(base, dir);

  let listed: string[];
  try {
    listed = await ignoredEntries(base);
  } catch (error) {
    log(`seed: could not list ignored files: ${error}`);
    return [];
  }

  const copied: string[] = [];
  for (const rel of listed) {
    if (token.isCancellationRequested) {
      break;
    }
    if (rel === '.git' || excluded(rel)) {
      continue;
    }
    const from = path.join(base, rel);
    // Either direction: the container may be inside a listed directory as
    // easily as the other way round when `worktreePath` is nested.
    if (within(container, from) || within(from, container) || within(from, worktreePath)) {
      continue;
    }

    let directory = false;
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(from));
      // A symlink is a file to git and has to stay one here, or a link to a
      // directory would be enumerated and followed out of the repository.
      directory =
        (stat.type & vscode.FileType.Directory) !== 0 &&
        (stat.type & vscode.FileType.SymbolicLink) === 0;
    } catch (error) {
      log(`seed: skipped ${rel}: ${error}`);
      continue;
    }

    if (!directory) {
      await copyOne(from, path.join(worktreePath, rel), rel, copied, log);
      continue;
    }

    let inside: string[];
    try {
      inside = await ignoredWithin(base, rel);
    } catch (error) {
      log(`seed: skipped ${rel}: ${error}`);
      continue;
    }
    for (const file of inside) {
      if (token.isCancellationRequested) {
        break;
      }
      if (excluded(file)) {
        continue;
      }
      await copyOne(path.join(base, file), path.join(worktreePath, file), file, copied, log);
    }
  }
  return copied;
}

/**
 * One language's dependency manager, and how to tell it is this project's.
 *
 * Ordered within an ecosystem because a repository can hold two markers: a
 * `package-lock.json` left behind after a move to pnpm is common, and a
 * `Cargo.lock` is more certain than a `Cargo.toml`. The first that exists wins,
 * and the rest of that ecosystem is not asked about.
 *
 * Separate ecosystems are not exclusive. A repository with a Python service and
 * a web front end needs both installs, and picking one would leave half the
 * project unable to start.
 */
interface Ecosystem {
  name: string;
  /** Marker file, then the command its presence implies. */
  markers: { file: string; install: string }[];
}

const ECOSYSTEMS: Ecosystem[] = [
  {
    name: 'node',
    markers: [
      { file: 'bun.lock', install: 'bun install' },
      { file: 'bun.lockb', install: 'bun install' },
      { file: 'pnpm-lock.yaml', install: 'pnpm install' },
      { file: 'yarn.lock', install: 'yarn install' },
      { file: 'package-lock.json', install: 'npm install' },
      { file: 'npm-shrinkwrap.json', install: 'npm install' }
    ]
  },
  {
    name: 'deno',
    markers: [{ file: 'deno.lock', install: 'deno install' }]
  },
  {
    name: 'python',
    markers: [
      { file: 'uv.lock', install: 'uv sync' },
      { file: 'poetry.lock', install: 'poetry install' },
      { file: 'pdm.lock', install: 'pdm install' },
      { file: 'Pipfile.lock', install: 'pipenv install' },
      { file: 'requirements.txt', install: 'pip install -r requirements.txt' }
    ]
  },
  {
    name: 'rust',
    markers: [
      { file: 'Cargo.lock', install: 'cargo fetch' },
      { file: 'Cargo.toml', install: 'cargo fetch' }
    ]
  },
  {
    name: 'go',
    markers: [
      { file: 'go.sum', install: 'go mod download' },
      { file: 'go.mod', install: 'go mod download' }
    ]
  },
  {
    name: 'ruby',
    markers: [
      { file: 'Gemfile.lock', install: 'bundle install' },
      { file: 'Gemfile', install: 'bundle install' }
    ]
  },
  {
    name: 'php',
    markers: [
      { file: 'composer.lock', install: 'composer install' },
      { file: 'composer.json', install: 'composer install' }
    ]
  },
  {
    name: 'elixir',
    markers: [{ file: 'mix.lock', install: 'mix deps.get' }]
  },
  {
    name: 'swift',
    markers: [{ file: 'Package.resolved', install: 'swift package resolve' }]
  },
  {
    name: 'java',
    markers: [
      // The wrapper, never a bare `gradle` -- a project that ships one expects
      // you to use it, and it is the only version anyone can be sure of.
      { file: 'gradlew', install: './gradlew dependencies' },
      { file: 'pom.xml', install: 'mvn dependency:go-offline' }
    ]
  }
];

/** How `packageManager` in package.json names a manager, when it is set. */
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
 * The node install, which is the one case a marker file cannot settle alone.
 *
 * `packageManager: "pnpm@9.1.0"` is corepack's field and says outright which
 * one the project uses, so it outranks every lockfile. Without it, and without
 * a lockfile, nothing is run: `npm install` in a bun project writes a
 * `package-lock.json` into the fresh worktree and builds a `node_modules` the
 * project disagrees with, and a `package.json` kept only for tooling in a Go or
 * Rust repo is the same story. Guessing wrong here is a change on disk, not a
 * wasted line.
 */
async function nodeInstall(base: string): Promise<string | undefined> {
  const manifest = await readFile(path.join(base, 'package.json'));
  if (manifest === undefined) {
    return undefined;
  }
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
  return undefined;
}

/**
 * Dart and Flutter share a manifest and do not share a command.
 *
 * `flutter pub get` in a plain Dart package fails, and `dart pub get` in a
 * Flutter app silently misses the platform dependencies. The manifest itself is
 * what distinguishes them.
 */
async function dartInstall(base: string): Promise<string | undefined> {
  const manifest = await readFile(path.join(base, 'pubspec.yaml'));
  if (manifest === undefined) {
    return undefined;
  }
  return /^\s*(sdk:\s*flutter|flutter:)/m.test(manifest) ? 'flutter pub get' : 'dart pub get';
}

/** .NET is found by a solution or project file, whatever it happens to be called. */
async function dotnetInstall(base: string): Promise<string | undefined> {
  try {
    const listing = await vscode.workspace.fs.readDirectory(vscode.Uri.file(base));
    const found = listing.some(([name]) => /\.(sln|csproj|fsproj|vbproj)$/i.test(name));
    return found ? 'dotnet restore' : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a fresh worktree needs run in it before anything will work.
 *
 * A worktree checks out tracked files and nothing else, and every language
 * keeps its dependencies out of the repository -- `node_modules`, `.venv`,
 * `vendor`, `target`. So an agent's first command in a new session is an
 * install it should not have had to think about, and which install it is
 * depends on a language this extension has no business assuming.
 *
 * Read from the base checkout, where the lockfiles the project maintains live,
 * and only ever *suggested*: it is typed into the terminal like anything else,
 * so a wrong guess is one visible line you can stop, not a hidden step.
 *
 * More than one is joined with `&&`. A repository holding a Python service and
 * a web front end needs both, and running only the first would leave half of it
 * unable to start.
 */
export async function detectInstallCommand(base: string): Promise<string | undefined> {
  const found: string[] = [];

  const node = await nodeInstall(base);
  if (node) {
    found.push(node);
  }

  for (const ecosystem of ECOSYSTEMS) {
    if (ecosystem.name === 'node' && node) {
      continue;
    }
    for (const marker of ecosystem.markers) {
      if (await exists(path.join(base, marker.file))) {
        found.push(marker.install);
        break;
      }
    }
  }

  for (const detect of [dartInstall, dotnetInstall]) {
    const install = await detect(base);
    if (install) {
      found.push(install);
    }
  }

  return found.length ? found.join(' && ') : undefined;
}
