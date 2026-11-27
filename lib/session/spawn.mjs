// Start the background session daemon (`fundkit daemon`) detached from the caller.
//
// The start request ({token} or {idle: true}) goes on the daemon's stdin pipe, never argv, the
// environment or a file. The daemon answers one JSON line once its control socket is open, or
// once it has seen that another session already answers there.

import { spawn } from 'node:child_process';
import { CLI_PATH } from '../constants.mjs';
import { onJsonLines } from '../ndjson.mjs';

const DAEMON_START_TIMEOUT_MS = 40_000;

/** Resolve with the daemon's first reply ({ok, ...} or {ok: false, error, message}). */
export function startDaemon(request, ttl = '8h') {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('DOPPLER_')),
  );
  const child = spawn(process.execPath, [CLI_PATH, 'daemon', '--ttl', ttl], {
    detached: true,
    stdio: ['pipe', 'pipe', 'ignore'],
    env,
  });
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const settle = (reply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.destroy();
      child.unref();
      resolve(reply);
    };
    timer = setTimeout(
      () => settle({ ok: false, error: 'DAEMON_TIMEOUT', message: 'the session daemon did not start' }),
      DAEMON_START_TIMEOUT_MS,
    );
    child.once('error', () => settle({ ok: false, error: 'DAEMON_FAILED', message: 'could not start' }));
    child.once('exit', () =>
      settle({ ok: false, error: 'DAEMON_FAILED', message: 'the session daemon exited before it was ready' }),
    );
    onJsonLines(child.stdout, settle);
    child.stdin.on('error', () => {
      // The daemon exited early; the 'exit' handler reports it.
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}
