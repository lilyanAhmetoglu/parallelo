import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

/**
 * Writes to the Parallelo Session output channel.
 *
 * Most of what this extension does happens in response to events nobody can
 * see -- a terminal reporting a directory, git noticing a ref moved -- so when
 * something does not happen there is nothing to look at. This is that
 * something. It costs nothing until the channel is opened.
 */
export function log(message: string): void {
  channel ??= vscode.window.createOutputChannel('Parallelo Session');
  const now = new Date();
  const stamp = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map(part => String(part).padStart(2, '0'))
    .join(':');
  channel.appendLine(`${stamp}.${String(now.getMilliseconds()).padStart(3, '0')} ${message}`);
}

export function showLog(): void {
  log('--- opened by request ---');
  channel?.show(true);
}

export function disposeLog(): void {
  channel?.dispose();
  channel = undefined;
}
