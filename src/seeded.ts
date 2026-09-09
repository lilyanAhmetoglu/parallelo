import type { Memento } from 'vscode';
import { log } from './log';

const KEY = 'parallelo.seeded';

/**
 * How many paths are remembered per worktree.
 *
 * A guard on the memento rather than a judgement about the copy: a base
 * checkout with thousands of untracked files is unusual, and storing all of
 * them in global state to keep a badge honest is a bad trade. Past the cap the
 * radar simply sees them as edits again, which is the behaviour before any of
 * this existed.
 */
const CAP = 2000;

/**
 * The files a worktree was created holding, rather than ones an agent wrote.
 *
 * `git worktree add` checks out tracked content only, so Parallelo copies the
 * untracked files across -- and the ones git is not ignoring arrive in the new
 * worktree as untracked files, which is precisely what the conflict radar reads
 * as "this session edited that". Two sessions branched from the same checkout
 * would then be seeded with the same paths and warn about each other before
 * either agent had typed anything.
 *
 * So the copy says what it copied, and the radar subtracts it. Kept in global
 * state and keyed by worktree path, like styles and baselines, because the
 * files outlive the window that made them.
 *
 * The subtraction only holds while a path is still untracked. Once an agent
 * stages it, it is that session's work by any reading, and it counts again.
 */
export class Seeded {
  constructor(private readonly memento: Memento) {}

  private all(): Record<string, string[]> {
    return this.memento.get<Record<string, string[]>>(KEY, {});
  }

  /** Repo-relative paths, forward-slashed, as git spells them. */
  get(worktreeRoot: string): Set<string> {
    return new Set(this.all()[worktreeRoot] ?? []);
  }

  async record(worktreeRoot: string, files: string[]): Promise<void> {
    const all = this.all();
    if (files.length > CAP) {
      log(`seed: ${files.length} files copied into ${worktreeRoot}, remembering none`);
      delete all[worktreeRoot];
    } else if (files.length === 0) {
      delete all[worktreeRoot];
    } else {
      all[worktreeRoot] = files;
    }
    await this.memento.update(KEY, all);
  }
}
