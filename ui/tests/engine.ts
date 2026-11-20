/**
 * Stand-ins for an engine, for tests that need the control plane to have seen
 * a command or an approval request. Both speak the engine's own protocol: JSON
 * lines on the control plane's sockets.
 */
import crypto from 'node:crypto';
import net from 'node:net';

/**
 * Report one finished command the way an engine does: JSON lines on the stream
 * socket, which is the approval socket's path with `.stream` appended
 * (streamSocketPath in src/live-stream.js). It then shows on the Live page and,
 * once ended, in Activity → Commands.
 */
export async function reportCommand(approvalSocket: string, command: string, output: string) {
  const socketPath = `${approvalSocket}.stream`;
  const id = crypto.randomUUID();
  const events = [
    { id, server: 'fixture', type: 'start', command, ts: new Date().toISOString() },
    { id, server: 'fixture', type: 'data', channel: 'stdout', chunk: output },
    { id, server: 'fixture', type: 'end', code: 0, ts: new Date().toISOString() },
  ];
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once('error', reject);
    socket.once('close', () => resolve());
    socket.end(events.map(event => `${JSON.stringify(event)}\n`).join(''));
  });
}

/**
 * Ask for approval the way an engine does, and wait for the answer. The request
 * shows on the Waiting page until it is decided, then in Activity → Decisions.
 * @returns The id to decide on, and the decision once it is made.
 */
export function requestApproval(
  approvalSocket: string,
  command: string | undefined,
  /** A tool other than ssh_execute, and the arguments the engine would send with it. */
  extra: { tool?: string; args?: Record<string, unknown> } = {},
) {
  const id = crypto.randomUUID();
  const decision = new Promise<{ decision: string }>((resolve, reject) => {
    let buffer = '';
    const socket = net.createConnection(approvalSocket, () => {
      socket.write(`${JSON.stringify({ id, server: 'fixture', tool: extra.tool ?? 'ssh_execute', command, args: extra.args })}\n`);
    });
    socket.once('error', reject);
    socket.on('data', chunk => { buffer += chunk; });
    socket.once('close', () => {
      try { resolve(JSON.parse(buffer)); } catch { reject(new Error(`No decision received: ${buffer}`)); }
    });
  });
  return { id, decision };
}
