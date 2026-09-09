import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { hookCommand, isOurs } from './sessionStatus';

/**
 * The events, and what each one means on a session row.
 *
 * Claude Code's names. They are the two an agent already has to distinguish to
 * notify you at all, which is the whole reason this works: the agent is not
 * being asked to compute anything new, only to say what it already knows.
 */
const EVENTS: { event: string; mark: 'waiting' | 'done'; why: string }[] = [
  { event: 'Notification', mark: 'waiting', why: 'it asked you something' },
  { event: 'Stop', mark: 'done', why: 'it finished its turn' }
];

interface HookEntry {
  matcher?: string;
  hooks?: { type?: string; command?: string }[];
}

/**
 * Wires an agent's notification hooks to the session rows.
 *
 * Written into the user's own settings rather than a repository's, because the
 * command finds its own repository -- `git rev-parse` from wherever the agent
 * is -- so doing it once covers every project instead of every project needing
 * it again.
 *
 * Offered, shown in full, and merged rather than replaced. Someone with a
 * `Stop` hook that plays a sound has to keep it; a settings file is not ours to
 * rewrite, and the entries we add are recognisable enough to add exactly once.
 */
/**
 * Whether this machine has an agent whose hooks are wired to the session rows.
 *
 * Undefined means the question does not apply -- no Claude Code settings file,
 * so either another agent is in use or none is, and either way there is nothing
 * useful to say about hooks it does not have.
 */
export async function hooksWired(): Promise<boolean | undefined> {
  const file = path.join(os.homedir(), '.claude', 'settings.json');
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(
      new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(file)))
    ) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const hooks = (settings.hooks ?? {}) as Record<string, HookEntry[]>;
  return EVENTS.some(({ event }) =>
    (hooks[event] ?? []).some(entry => entry.hooks?.some(h => isOurs(h.command)))
  );
}

const OFFERED = 'parallelo.statusHooksOffered';

/**
 * Say once that the marks need wiring, rather than showing nothing forever.
 *
 * A feature that is on by default and silently does nothing until a command is
 * run is indistinguishable from one that is broken -- which is exactly how it
 * read the first time it was tried. Offered once per machine, only when there
 * is a Claude Code to offer it for, and never again whichever button is
 * pressed: a prompt that returns is worse than the silence it replaced.
 */
export async function offerStatusHooks(memento: vscode.Memento): Promise<void> {
  if (memento.get<boolean>(OFFERED, false)) {
    return;
  }
  if (!vscode.workspace.getConfiguration('parallelo').get<boolean>('sessionStatus', true)) {
    return;
  }
  if ((await hooksWired()) !== false) {
    return;
  }

  const set = 'Set Them Up';
  const never = 'Not Interested';
  const chosen = await vscode.window.showInformationMessage(
    'Sessions can show a dot when an agent asks you something and a tick when it finishes. ' +
      'It needs two hooks in your agent, which it has to write itself.',
    set,
    never
  );

  // Only an answer counts. Marking this shown before the notification is
  // answered means one that scrolled away unnoticed is never offered again --
  // and the feature is inert until it is taken up, so that reads as broken.
  // Notifications scrolling away is a mistake this project has already made
  // once, in the rooms.
  if (chosen === never) {
    await memento.update(OFFERED, true);
    return;
  }
  if (chosen === set) {
    await memento.update(OFFERED, true);
    await setUpStatusHooks();
  }
}

/**
 * The contract, in the words an agent's own configuration will need.
 *
 * Two commands and a sentence each. This is the whole of what makes a row light
 * up, and it is deliberately tied to no agent: writing a word into a file is
 * something anything can be made to do, which is the only reason this feature is
 * not Claude-only.
 */
function recipe(): string {
  return EVENTS.map(({ mark, why }) => `When ${why}:\n  ${hookCommand(mark)}`).join('\n\n');
}

/**
 * Wire up whichever agent the user runs.
 *
 * Only Claude Code's configuration is written for them, because it is the only
 * format verified against a real file. Every other agent gets the two commands
 * to paste wherever it keeps its notification settings -- Codex's `notify`, a
 * wrapper script, anything that runs a command on an event. A config format
 * guessed at from memory would put broken TOML in somebody's home directory,
 * which is worse than asking them to paste two lines.
 */
export async function setUpStatusHooks(): Promise<void> {
  const agents = vscode.workspace
    .getConfiguration('parallelo')
    .get<{ label: string; command?: string }[]>('agents', [])
    .filter(agent => agent.command?.trim());

  const claude = agents.find(agent => /(^|[^a-z])claude([^a-z]|$)/i.test(agent.command ?? ''));
  const others = agents.filter(agent => agent !== claude);

  const choices: { label: string; description?: string; detail?: string; write?: boolean }[] = [];
  if (claude) {
    choices.push({
      label: `$(check) ${claude.label}`,
      description: 'written for you',
      detail: 'Two hooks added to ~/.claude/settings.json, shown before anything is written',
      write: true
    });
  }
  choices.push({
    label: others.length
      ? `$(clippy) ${others.map(agent => agent.label).join(', ')}, or anything else`
      : '$(clippy) Any other agent',
    description: 'copy the two commands',
    detail: 'Paste them wherever your agent runs a command when it needs you, or finishes'
  });

  // Nothing to choose between when there is only one way to go.
  const picked =
    choices.length === 1
      ? choices[0]
      : await vscode.window.showQuickPick(choices, {
          title: 'Which agent should mark its sessions?'
        });
  if (!picked) {
    return;
  }

  if (!picked.write) {
    await vscode.env.clipboard.writeText(recipe());
    await vscode.window.showInformationMessage(
      'Copied the two commands. Anything that can run a command when it needs you can mark a session.',
      {
        modal: true,
        detail:
          `${recipe()}\n\n` +
          'The row reads a file and does not care what wrote it. Each command writes one word ' +
          'into the git directory of whatever repository the agent is working in, so the same ' +
          'line works in every project and shows up in no diff. In a terminal Parallelo opened, ' +
          '$PARALLELO_STATUS names that same file, for an agent whose hooks run somewhere git ' +
          'is awkward to reach from.'
      }
    );
    return;
  }

  await writeClaudeHooks();
}

/** Claude Code's own settings file, the one format verified against a real one. */
async function writeClaudeHooks(): Promise<void> {
  const file = path.join(os.homedir(), '.claude', 'settings.json');
  const uri = vscode.Uri.file(file);

  let settings: Record<string, unknown> = {};
  let existed = false;
  try {
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    settings = JSON.parse(text) as Record<string, unknown>;
    existed = true;
  } catch (error) {
    // A file that is there but unreadable is not the same as no file, and
    // overwriting the first one would throw away hooks somebody wrote.
    if (await exists(uri)) {
      vscode.window.showErrorMessage(
        `Could not read ${file}. ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
  }

  const hooks = (settings.hooks ?? {}) as Record<string, HookEntry[]>;
  const missing = EVENTS.filter(
    ({ event }) => !(hooks[event] ?? []).some(entry => entry.hooks?.some(h => isOurs(h.command)))
  );

  if (missing.length === 0) {
    vscode.window.showInformationMessage(
      'Status hooks are already set up. A session shows a dot when its agent asks ' +
        'you something, and a tick when it finishes.'
    );
    return;
  }

  const lines = missing
    .map(({ event, mark, why }) => `${event} → ${mark}, because ${why}:\n  ${hookCommand(mark)}`)
    .join('\n\n');
  const add = 'Add Them';
  const copy = 'Copy Instead';
  const chosen = await vscode.window.showInformationMessage(
    existed
      ? `Add ${missing.length === 1 ? 'one hook' : `${missing.length} hooks`} to your Claude Code settings?`
      : 'Create Claude Code settings with the status hooks?',
    {
      modal: true,
      detail:
        `${lines}\n\n` +
        `This is added to ${file}. Nothing already in it is changed or removed. ` +
        'The command writes one word into the git directory of whatever repository ' +
        'the agent is working in, so it works in every project and shows up in no diff.'
    },
    add,
    copy
  );

  if (chosen === copy) {
    await vscode.env.clipboard.writeText(
      JSON.stringify(
        Object.fromEntries(
          missing.map(({ event, mark }) => [
            event,
            [{ hooks: [{ type: 'command', command: hookCommand(mark) }] }]
          ])
        ),
        null,
        2
      )
    );
    vscode.window.showInformationMessage(
      'Copied the hooks. Any agent that can run a command when it needs you, or ' +
        'when it finishes, can drive the same file.'
    );
    return;
  }
  if (chosen !== add) {
    return;
  }

  for (const { event, mark } of missing) {
    hooks[event] = [
      ...(hooks[event] ?? []),
      { hooks: [{ type: 'command', command: hookCommand(mark) }] }
    ];
  }
  settings.hooks = hooks;

  try {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(file)));
    await vscode.workspace.fs.writeFile(
      uri,
      Buffer.from(JSON.stringify(settings, null, 2) + '\n', 'utf8')
    );
  } catch (error) {
    vscode.window.showErrorMessage(
      `Could not write ${file}. ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }

  vscode.window.showInformationMessage(
    'Status hooks added. Agents already running keep their old settings until ' +
      'they restart; the next session picks them up.'
  );
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
