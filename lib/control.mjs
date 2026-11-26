// One-shot requests to a running session over its control socket.

import net from 'node:net';
import { onJsonLines, writeJsonLine } from './ndjson.mjs';
import { socketPath } from './paths.mjs';

const DEFAULT_TIMEOUT_MS = 1500;

/**
 * Send one message and resolve with the first reply, or null when no session answers
 * (no socket, a stale socket, or no reply within `timeoutMs`).
 */
export function requestSession(message, { timeoutMs = DEFAULT_TIMEOUT_MS, path = socketPath() } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect(path);
    let timer = null;
    const settle = (reply) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(reply);
    };
    timer = setTimeout(() => settle(null), timeoutMs);
    socket.on('error', () => settle(null));
    socket.on('connect', () => writeJsonLine(socket, { id: 1, ...message }));
    onJsonLines(socket, (reply) => settle(reply));
  });
}

/** The running session's public state, or null. */
export async function sessionStatus(options) {
  const reply = await requestSession({ t: 'status' }, options);
  return reply ? (reply.session ?? {}) : null;
}
