import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { API as GitAPI } from './git';
import type { SessionTracker } from './sessionTracker';
import { createWorktree, resolveBase, type AgentChoice } from './worktree';
import type { Seeded } from './seeded';
import { detectInstallCommand } from './worktreeSeed';
import { statusFile } from './sessionStatus';
import { release, reserve } from './worktreeTerminals';
import { log } from './log';

const run = promisify(execFile);

type Seat = 'lead' | 'peer';

interface SeatTerminal {
  seat: Seat;
  terminal: vscode.Terminal;
  kickoff: string;
}

/** The most recent room, held so its brief can be sent once the seats are ready. */
let pending:
  | { room: string; roomDir: string; cwd: string; spec?: string; seats: SeatTerminal[] }
  | undefined;

/** An agent with a model chosen: what to run, and what to call it. */
interface Seated {
  label: string;
  command: string;
  /** The agent's own room flags, used unless the setting overrides them. */
  roomArgs: string;
  /** What the lead seat uses instead, when this agent gives the lead more. */
  leadRoomArgs: string;
}

/**
 * A brainstorming room: two agents in one checkout, taking turns through a
 * transcript on disk until they agree or run out of rounds.
 *
 * The extension does not implement any of that. The protocol lives in the
 * `roundtable` MCP server, which the agents talk to and Parallelo only starts.
 * What Parallelo contributes is the part it already knows how to do -- make a
 * worktree, open terminals in it, bind them to the diff -- plus the one thing
 * the server cannot do for itself: give each terminal a different seat.
 *
 * Both agents share one checkout on purpose. They are reading the same code and
 * arguing about it; two worktrees would give them two different repositories to
 * disagree about, and two transcripts that never meet.
 */
/**
 * Where the spec goes, as a path relative to the worktree.
 *
 * A list rather than an input box, because "somewhere in the files" is a
 * folder you recognise when you see it, not a path you want to spell. Browsing
 * shows the *base* checkout: the new worktree does not exist yet, and it will
 * hold the same tracked directories anyway, so picking `docs/specs` there means
 * `docs/specs` in the room.
 *
 * Undefined means the user backed out, at any step.
 */
async function chooseSpecPath(base: string, name: string): Promise<string | undefined> {
  const file = `SPEC-${name}.md`;
  const suggestions: { label: string; description?: string; detail?: string; value?: string; browse?: boolean; type?: boolean }[] = [
    {
      label: `$(file) ${file}`,
      description: 'worktree root',
      detail: 'Where a room has always put it, and the only thing git will show you',
      value: file
    }
  ];

  // Offered only where it would land somewhere that exists. A suggestion
  // pointing at a directory this repository does not have is a guess wearing
  // the clothes of a convention.
  for (const dir of ['docs/specs', 'docs', 'specs']) {
    if (await isDirectory(path.join(base, dir))) {
      suggestions.push({
        label: `$(folder) ${dir}/${file}`,
        description: 'existing folder',
        value: `${dir}/${file}`
      });
      break;
    }
  }

  suggestions.push(
    {
      label: '$(folder-opened) Choose a folder...',
      detail: 'Browse the checkout. The file is still named after the room',
      browse: true
    },
    { label: '$(edit) Type a path...', detail: 'Relative to the worktree', type: true }
  );

  const picked = await vscode.window.showQuickPick(suggestions, {
    title: 'Where should the spec go?'
  });
  if (!picked) {
    return undefined;
  }
  if (picked.value) {
    return picked.value;
  }

  if (picked.browse) {
    const chosen = await vscode.window.showOpenDialog({
      title: 'Choose a folder for the spec',
      defaultUri: vscode.Uri.file(base),
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Put the spec here'
    });
    const folder = chosen?.[0]?.fsPath;
    if (!folder) {
      return undefined;
    }
    // The dialog can go anywhere on the disk. A spec is a plan about this
    // repository and has to land inside it, so a folder outside says so rather
    // than being quietly rewritten to somewhere the user did not pick.
    const relative = path.relative(base, folder);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      vscode.window.showErrorMessage(
        `${path.basename(folder)} is outside ${path.basename(base)}. ` +
          'The spec is written inside the room\'s own worktree.'
      );
      return undefined;
    }
    return relative ? `${relative}/${file}` : file;
  }

  return vscode.window.showInputBox({
    title: 'Where should the spec go?',
    prompt: 'Relative to the worktree.',
    value: file,
    valueSelection: [0, `SPEC-${name}`.length],
    validateInput: value => {
      const wanted = value.trim();
      if (!wanted) {
        return 'A room writes one file. Name it.';
      }
      if (path.isAbsolute(wanted) || path.normalize(wanted).split(path.sep).includes('..')) {
        return 'Keep it inside the worktree -- the spec is a plan about this repository.';
      }
      return undefined;
    }
  });
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(target));
    return (stat.type & vscode.FileType.Directory) !== 0;
  } catch {
    return false;
  }
}

export async function newRoom(
  gitApi: GitAPI,
  tracker: SessionTracker,
  seeded?: Seeded
): Promise<void> {
  const config = vscode.workspace.getConfiguration('parallelo');
  const binary = config.get<string>('roundtable.command', 'roundtable').trim() || 'roundtable';

  const located = await resolveBase(gitApi, tracker);
  if (!located) {
    return;
  }
  const { base } = located;

  const topic = await vscode.window.showInputBox({
    title: 'Brainstorming room',
    prompt: 'What should the two agents work out? Be specific -- this is the whole brief.',
    placeHolder: 'Whether the changes view should page for very large diffs',
    validateInput: value => (value.trim() ? undefined : 'A room needs a topic.')
  });
  if (!topic) {
    return;
  }

  // Any agent can take any seat, including the same one twice. Nothing here
  // knows what an agent is; the seat is set by the terminal's environment and
  // the server never learns who is sitting in it.
  const agents = config.get<AgentChoice[]>('agents', []).filter(a => a.command?.trim());
  if (agents.length === 0) {
    vscode.window.showErrorMessage(
      'No agents are configured with a command. Add one in the parallelo.agents setting.'
    );
    return;
  }
  const lead = await pickSeat(agents, 'lead', 'Who leads? This seat drives and writes the spec.');
  if (!lead) {
    return;
  }
  const peer = await pickSeat(agents, 'peer', 'Who pushes back? Picking the same agent is fine.');
  if (!peer) {
    return;
  }

  // Refuse a room that cannot work rather than opening one that looks like it
  // does. Without flags a seat launches as a plain agent: no MCP config, so no
  // server, so no way to reach the other seat -- and a terminal sitting there
  // with nothing to do is indistinguishable from one that is thinking. This is
  // the failure this feature kept having, so it is checked, not hoped for.
  const override = config.get<string>('roundtable.agentArgs', '').trim();
  const unwired = [lead, peer].filter(s => !override && !s.roomArgs.trim());
  if (unwired.length > 0) {
    const names = [...new Set(unwired.map(s => s.label))].join(' and ');
    vscode.window.showErrorMessage(
      `${names} has no room flags, so it cannot reach the other seat. Set ` +
        'parallelo.roundtable.agentArgs, or give that agent a roomArgs in parallelo.agents.'
    );
    return;
  }

  const name = await vscode.window.showInputBox({
    title: 'Brainstorming room',
    prompt: 'Name the room. It becomes the branch, the worktree folder and the transcript folder.',
    placeHolder: 'diff-paging',
    validateInput: value =>
      /^[\w.\-]+$/.test(value) ? undefined : 'Use letters, numbers, dot, dash or underscore.'
  });
  if (!name) {
    return;
  }

  // Where the room's one output goes. Asked rather than assumed, because a spec
  // belongs wherever this repository keeps its plans, and that is not something
  // the extension can know -- `docs/specs/` in one repo, the root in the next.
  //
  // Still exactly one output. The choice is where the file lands, never which
  // of two files was the real one.
  const specPath = await chooseSpecPath(base, name);
  if (!specPath) {
    return;
  }

  const budget = config.get<number>('roundtable.budget', 8);

  // Claim the worktree before it exists, so the startup pass does not drop a
  // bare shell into it while the seed below is still running.
  const dir = config.get<string>('worktreePath', '.worktrees');
  await reserve(path.isAbsolute(dir) ? path.join(dir, name) : path.join(base, dir, name));

  let cwd: string;
  try {
    cwd = await createWorktree(gitApi, base, name, config, seeded);
  } catch {
    // createWorktree has already said what went wrong.
    await release(path.isAbsolute(dir) ? path.join(dir, name) : path.join(base, dir, name));
    return;
  }

  // Seeding writes the role prompts into the room, with the topic filled in, so
  // the terminals can point at a file instead of the extension keeping its own
  // copy of a prompt that belongs to the server.
  const wantedSpec = specPath.trim();
  let spec = wantedSpec;
  try {
    const { stdout } = await run(binary, [
      'seed',
      '--room', name,
      '--topic', topic,
      '--budget', String(budget),
      '--cwd', cwd,
      '--spec', wantedSpec
    ]);
    // The server decides, and says so. It is the one that writes the file and
    // the one that filled the path into each seat's brief, so its answer is
    // the only one worth believing.
    const written = JSON.parse(stdout) as { spec?: string };
    if (written.spec) {
      spec = written.spec;
    }
    // A roundtable without `--spec` parses the flag, ignores it, and reports
    // the default. Left unsaid, the spec quietly appears somewhere else and
    // the room looks like it disobeyed.
    if (spec !== wantedSpec) {
      vscode.window.showWarningMessage(
        `This roundtable does not take a spec location, so the room writes ${spec}. ` +
          'Update it with: bun add -g roundtable-mcp'
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const install = 'Install roundtable';
    const choice = await vscode.window.showErrorMessage(
      `Could not start the room: ${binary} did not run. ${message}`,
      install
    );
    if (choice === install) {
      vscode.env.clipboard.writeText('bun add -g roundtable-mcp');
      vscode.window.showInformationMessage(
        'Copied "bun add -g roundtable-mcp" to the clipboard. The worktree is still there; run the command again once it is installed.'
      );
    }
    return;
  }

  // The room's MCP config lives inside the room, not at the worktree root.
  // Every seat is launched with `--strict-mcp-config` pointed straight at this
  // file, so a `.mcp.json` beside it would never be read -- and writing one
  // puts scaffolding in `git status`, or worse, edits a `.mcp.json` the repo
  // already tracks. The spec is the only thing a room leaves behind.
  await vscode.workspace.fs.writeFile(
    vscode.Uri.file(path.join(cwd, '.roundtable', name, 'mcp.json')),
    Buffer.from(JSON.stringify({ mcpServers: { roundtable: { command: binary, args: [] } } }, null, 2) + '\n', 'utf8')
  );

  // A room's worktree is a checkout like any other, and someone reads the code
  // in it afterwards -- so it gets the same install a session would, once, in
  // the lead's terminal. It was skipped entirely on the grounds that a seat
  // never runs the code it is planning, which was true of the seats and wrong
  // about the worktree they leave behind.
  const setup =
    config.get<string>('setupCommand', '').trim() ||
    (config.get<boolean>('installDependencies', true)
      ? (await detectInstallCommand(base)) ?? ''
      : '');

  const status = await statusFile(cwd);
  const roomDir = path.join('.roundtable', name);
  const seats = [
    open(cwd, name, 'lead', lead, roomDir, topic, budget, config, setup, status),
    open(cwd, name, 'peer', peer, roomDir, topic, budget, config, undefined, status)
  ];
  pending = { room: name, roomDir, cwd, seats };
  await release(cwd);
  await tracker.sync();

  pending.spec = spec;
  vscode.window.showInformationMessage(
    `Room "${name}": ${lead.label} leads, ${peer.label} responds, ${budget} rounds. ` +
      `It ends with ${spec}.`
  );

  // Brief each seat the moment it is actually ready, rather than asking the
  // user to say when. An agent cannot be told anything until its own startup is
  // finished, and no delay knows when that is -- but the server does: a seat
  // appears in `seats` as soon as its MCP client has connected, which cannot
  // happen before the agent is up. So wait for that, per seat, and send.
  void brief(binary, name, cwd);
}

/**
 * Wait for each seat to connect to the server, then send it its opening line.
 *
 * Per seat, not both at once: two agents do not finish starting together, and
 * making the faster one wait for the slower is how the brief used to land in a
 * terminal that was not listening yet.
 *
 * This used to be a button on a notification. A required step behind a
 * notification is a step that gets missed -- notifications scroll away, and a
 * room that was never briefed looks exactly like a room that is thinking.
 * `parallelo.sendRoomBrief` remains for the case where a seat is restarted by
 * hand.
 */
async function brief(binary: string, room: string, cwd: string): Promise<void> {
  const current = pending;
  if (!current) {
    return;
  }
  const waiting = new Set(current.seats.map(s => s.seat as string));
  const deadline = Date.now() + 120_000;

  while (waiting.size > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1_500));
    if (pending !== current) {
      return;
    }
    let connected: { seat: string }[];
    try {
      const { stdout } = await run(binary, ['seats', '--room', room, '--cwd', cwd]);
      connected = JSON.parse(stdout) as { seat: string }[];
    } catch {
      continue;
    }
    for (const entry of connected) {
      if (!waiting.has(entry.seat)) {
        continue;
      }
      const seat = current.seats.find(s => s.seat === entry.seat);
      if (!seat) {
        continue;
      }
      waiting.delete(entry.seat);
      log(`room: ${entry.seat} connected, sending its brief`);
      await type(seat.terminal, seat.kickoff);
    }
  }

  if (waiting.size === 0) {
    log(`room: both seats briefed`);
    void confirmSeatsStarted(room);
    return;
  }

  // A seat that never connected never launched its agent -- the command failed,
  // or the binary is not there. Name it; the terminal has the error in it.
  const stuck = [...waiting].join(' and ');
  const show = 'Show the terminal';
  const choice = await vscode.window.showWarningMessage(
    `The ${stuck} seat never reached the room, so it was not briefed. Its terminal will say why.`,
    show
  );
  if (choice === show) {
    current.seats.find(s => waiting.has(s.seat))?.terminal.show();
  }
}

/**
 * Type a line into a terminal and press Enter as a separate keystroke.
 *
 * `sendText(text)` emits the text and its newline in one burst, and an agent
 * TUI reading that fast treats it as a paste: the line lands in the input box
 * and sits there unsent, which is indistinguishable from never sending it. A
 * shell does not care; a TUI does.
 */
async function type(terminal: vscode.Terminal, line: string): Promise<void> {
  terminal.sendText(line, false);
  await new Promise(resolve => setTimeout(resolve, 400));
  terminal.sendText('', true);
}

/**
 * Pick the agent for a seat, then which model it runs.
 *
 * The model is asked separately rather than being baked into the agent entry,
 * because "Claude Code" and "Claude Code on Opus 5" are the same tool, and a
 * room is usually two of the same agent on different models. The chosen model
 * goes into the seat's label as well as its command line, so the transcript
 * records which model said what.
 */
async function pickSeat(
  agents: AgentChoice[],
  seat: Seat,
  detail: string
): Promise<Seated | undefined> {
  const picked = await vscode.window.showQuickPick(
    agents.map(a => ({ label: a.label, description: a.command, agent: a })),
    { title: `Brainstorming room: the ${seat} seat`, placeHolder: detail }
  );
  if (!picked) {
    return undefined;
  }
  const agent = picked.agent;
  const command = agent.command ?? '';

  const models = agent.models ?? [];
  if (models.length < 2) {
    const only = models[0];
    const flags = agent.roomArgs ?? '';
    const leadFlags = agent.leadRoomArgs ?? '';
    return only?.value
      ? {
          label: `${agent.label} · ${only.label}`,
          command: `${command} ${flag(agent)} ${only.value}`,
          roomArgs: flags,
          leadRoomArgs: leadFlags
        }
      : { label: agent.label, command, roomArgs: flags, leadRoomArgs: leadFlags };
  }

  const model = await vscode.window.showQuickPick(
    models.map(m => ({ label: m.label, description: m.value || "the agent's own default", model: m })),
    { title: `Brainstorming room: which model for the ${seat}?`, placeHolder: agent.label }
  );
  if (!model) {
    return undefined;
  }
  const value = model.model.value;
  const flags = agent.roomArgs ?? '';
  const leadFlags = agent.leadRoomArgs ?? '';
  return value
    ? {
        label: `${agent.label} · ${model.model.label}`,
        command: `${command} ${flag(agent)} ${value}`,
        roomArgs: flags,
        leadRoomArgs: leadFlags
      }
    : { label: agent.label, command, roomArgs: flags, leadRoomArgs: leadFlags };
}

function flag(agent: AgentChoice): string {
  return agent.modelFlag?.trim() || '--model';
}

/**
 * Markers an agent leaves in the environment to say "a session is already
 * running here".
 *
 * A terminal inherits the editor's environment, and the editor inherits
 * whatever launched it. Launch VS Code from a shell that is itself inside an
 * agent -- which is an ordinary thing to do -- and every seat starts as a child
 * of that session instead of a session of its own: one shared session id across
 * both seats and the parent, transcripts turned off, and permissions answered
 * somewhere the user cannot see. Two seats that are the same session cannot
 * hold a conversation.
 *
 * Only the per-session markers are cleared. Configuration a user meant to set
 * -- an API key, a provider, a model default -- is left alone.
 */
const SESSION_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CLAUDE_EFFORT'
];

/** Every session marker present in the editor's environment, set to be removed. */
function unparent(): Record<string, null> {
  const cleared: Record<string, null> = {};
  for (const key of SESSION_MARKERS) {
    if (process.env[key] !== undefined) {
      cleared[key] = null;
      log(`room: clearing inherited ${key}`);
    }
  }
  return cleared;
}

/**
 * The flags a seat needs to be in a room at all.
 *
 * They come from the agent entry, because they are that agent's own syntax --
 * Claude Code's `--append-system-prompt-file` means nothing to Codex. The
 * `roundtable.agentArgs` setting overrides them for anyone whose agent is not
 * described by the defaults.
 *
 * This used to be settings-only, defaulting to empty. That default opened two
 * terminals holding plain agents with no MCP config and no brief -- a room that
 * could not possibly work, and looked from the outside exactly like one that
 * was thinking. Never let the room's own wiring be something a person has to
 * supply before the feature does anything.
 */
function roomArgs(
  config: vscode.WorkspaceConfiguration,
  agent: Seated,
  roomDir: string,
  room: string,
  seat: Seat
): string {
  const override = config.get<string>('roundtable.agentArgs', '').trim();
  // The lead's own list when it has one. Only the lead: the peer's tools are
  // deliberately narrower, and a seat that can act is a seat that will.
  const own = seat === 'lead' && agent.leadRoomArgs.trim() ? agent.leadRoomArgs : agent.roomArgs;
  return (override || own)
    .replaceAll('${roomDir}', roomDir)
    .replaceAll('${room}', room)
    .replaceAll('${seat}', seat)
    .trim();
}

/**
 * Open one seat's terminal.
 *
 * The seat travels in the environment rather than in the MCP config, because
 * both seats share a checkout and therefore share one `.mcp.json`. The server
 * subprocess inherits its client's environment, so this is what tells two
 * otherwise identical agents which one of them is which.
 */
function open(
  cwd: string,
  room: string,
  seat: Seat,
  agent: Seated,
  roomDir: string,
  topic: string,
  budget: number,
  config: vscode.WorkspaceConfiguration,
  setup?: string,
  status?: string
): SeatTerminal {
  const terminal = vscode.window.createTerminal({
    name: `${room} · ${seat}`,
    cwd,
    iconPath: new vscode.ThemeIcon('comment-discussion'),
    env: {
      ...unparent(),
      ROUNDTABLE_ROOM: room,
      ROUNDTABLE_SEAT: seat,
      ROUNDTABLE_AGENT: agent.label,
      ROUNDTABLE_TOPIC: topic,
      ROUNDTABLE_BUDGET: String(budget),
      ROUNDTABLE_CWD: cwd,
      // Both seats share a worktree and so share one status file. A mark says
      // something in this room wants you, which is the true statement available.
      ...(status ? { PARALLELO_STATUS: status } : {})
    }
  });
  terminal.show();

  // In one seat's terminal only -- the caller decides which, and it is the
  // lead. Both seats share a checkout, so running an install in each of them
  // means two package managers writing one `node_modules` at the same time.
  // That is not a slower install, it is a broken one.
  if (setup) {
    terminal.sendText(setup);
  }

  // A room only works while the agent can call the server without stopping to
  // ask. The peer spends most of its life parked inside `wait_for_message`, and
  // an approval prompt in front of that call is a conversation that never
  // starts. `agentArgs` is where the user puts whatever their agent wants to
  // hear about that -- it is not this extension's business which flag it is.
  // `${roomDir}` and `${room}` let a static setting name a path that only exists
  // once the room does -- which is what lets an agent be pointed straight at the
  // room's own MCP config instead of discovering the worktree's and asking
  // whether the user trusts it.
  const extra = roomArgs(config, agent, roomDir, room, seat);

  // The kickoff goes in as an argument to the agent rather than typed after it,
  // so there is no race against a TUI that has not finished starting. Agents
  // that do not take an opening prompt positionally will simply print their
  // usage, and the instruction is still on screen to paste.
  // The seat's instructions travel in its system prompt (see `agentArgs`), not
  // in this line, because a startup dialog eats typed input and a seat that
  // never read its brief is indistinguishable from one waiting properly. All
  // this has to do is start the turn -- and if it is lost, anything the user
  // types does the same job, because the agent already knows what it is.
  const kickoff =
    `Begin. You are the ${seat} in a planning room about: ` +
    `${topic.replace(/\s+/g, ' ').trim()}. Follow your room instructions.`;
  const line = `${agent.command}${extra ? ` ${extra}` : ''}`;
  log(`room: ${seat} runs: ${line}`);
  terminal.sendText(line);
  return { seat, terminal, kickoff };
}

/**
 * Type each seat's brief into its terminal.
 *
 * Separate from opening the seats because the agents are not ready to be told
 * anything until whoever is watching has cleared their startup dialogs.
 */
export async function sendKickoff(): Promise<void> {
  if (!pending) {
    vscode.window.showInformationMessage('No brainstorming room is waiting for its brief.');
    return;
  }
  for (const { seat, terminal, kickoff } of pending.seats) {
    terminal.show();
    log(`room: ${seat} brief: ${kickoff}`);
    await type(terminal, kickoff);
  }
  const room = pending.room;
  const spec = pending.spec ?? 'a spec file';
  vscode.window.showInformationMessage(
    `Sent the brief to both seats. The room ends with ${spec}; ` +
      `follow it with: roundtable watch --room ${room}`
  );
  void confirmSeatsStarted(room);
}

/**
 * Check, a minute later, that the brief actually landed.
 *
 * Typing into a terminal is not the same as an agent receiving it: if a seat was
 * still on its startup dialog the text went into the dialog instead, and the
 * seat sits there having read nothing. That is invisible -- the terminal looks
 * busy either way -- so ask the server who has actually called it, and say
 * plainly which seat never started.
 */
async function confirmSeatsStarted(room: string): Promise<void> {
  const current = pending;
  if (!current) {
    return;
  }
  await new Promise(resolve => setTimeout(resolve, 60_000));
  if (pending !== current) {
    return;
  }
  const config = vscode.workspace.getConfiguration('parallelo');
  const binary = config.get<string>('roundtable.command', 'roundtable').trim() || 'roundtable';
  let started: { seat: string; calls: number }[];
  try {
    const { stdout } = await run(binary, ['seats', '--room', room, '--cwd', current.cwd]);
    started = JSON.parse(stdout) as { seat: string; calls: number }[];
  } catch {
    return;
  }
  const silent = current.seats
    .map(s => s.seat)
    .filter(seat => !started.some(entry => entry.seat === seat && entry.calls > 0));
  if (silent.length === 0) {
    return;
  }
  const again = 'Send it again';
  const choice = await vscode.window.showWarningMessage(
    `The ${silent.join(' and ')} seat never started -- it has called the room zero times, so it did ` +
      'not receive the brief. That happens when the text lands on a startup dialog instead of the ' +
      'agent. Clear the prompt in that terminal, then resend.',
    again
  );
  if (choice === again) {
    await sendKickoff();
  }
}



/**
 * Show the discussion behind a spec.
 *
 * The spec is the decision, written for someone who was not in the room. How
 * the room got there -- what the peer objected to, what the lead conceded -- is
 * a different document for a different moment, so it is not a second file in
 * the worktree and it is not appended to the spec. It is rendered on demand,
 * into the system temp directory, and opened.
 *
 * Reading it must not require an assistant to do it for you. `roundtable
 * transcript` renders any room, whoever sat in the seats; this command only
 * finds the room and opens what comes back.
 */
export async function showTranscript(tracker: SessionTracker): Promise<void> {
  const cwd = tracker.activeSession?.cwd.fsPath;
  if (!cwd) {
    vscode.window.showInformationMessage(
      'Focus a terminal in a room worktree first -- the transcript is found from there.'
    );
    return;
  }

  const roomsDir = path.join(cwd, '.roundtable');
  let names: string[];
  try {
    names = (await vscode.workspace.fs.readDirectory(vscode.Uri.file(roomsDir)))
      .filter(([, kind]) => kind === vscode.FileType.Directory)
      .map(([name]) => name);
  } catch {
    names = [];
  }
  if (names.length === 0) {
    vscode.window.showInformationMessage(`No brainstorming room in ${path.basename(cwd)}.`);
    return;
  }

  // One room is the normal case; a worktree reused for a second room is not.
  const room =
    names.length === 1
      ? names[0]
      : await vscode.window.showQuickPick(names, { title: 'Which room?' });
  if (!room) {
    return;
  }

  const config = vscode.workspace.getConfiguration('parallelo');
  const binary = config.get<string>('roundtable.command', 'roundtable').trim() || 'roundtable';
  let text: string;
  try {
    const { stdout } = await run(binary, ['transcript', '--room', room, '--cwd', cwd], {
      maxBuffer: 32 * 1024 * 1024
    });
    text = stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Could not read the transcript: ${message}`);
    return;
  }

  // Outside the worktree on purpose: a room leaves one file behind, and this is
  // not it.
  const file = vscode.Uri.file(path.join(os.tmpdir(), `roundtable-${room}.md`));
  await vscode.workspace.fs.writeFile(file, Buffer.from(text, 'utf8'));
  await vscode.commands.executeCommand('markdown.showPreview', file);
}
