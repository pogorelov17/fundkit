// `fundkit daemon`: the session daemon without a terminal, started by `fundkit unlock`.
//
// It reads one JSON line {token} from its stdin pipe (never argv, the environment or a file),
// checks the token with Doppler, opens the control socket and answers one JSON line on stdout,
// then closes both pipes and keeps running detached until `fundkit stop`, the time limit or a
// rejected token. It does not end when a host session detaches: T3 Code restarts MCP servers
// between turns, and the token must not be asked for again. It cannot prompt, so API
// passphrases arrive through `fundkit unlock --passphrase`.

import fs from 'node:fs';
import path from 'node:path';
import { SERVICE_TOKEN_PATTERN } from '../constants.mjs';
import { sessionStatus } from '../control.mjs';
import { DopplerClient } from '../doppler.mjs';
import { ensurePrivateDir, runDir } from '../paths.mjs';
import { nowIso, parseDuration } from '../util.mjs';
import { SessionDaemon } from './daemon.mjs';

const MAX_INPUT_BYTES = 8192;
const INPUT_TIMEOUT_MS = 10_000;

function readTokenLine() {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let timer = null;
    const done = (value) => {
      clearTimeout(timer);
      process.stdin.removeAllListeners('data');
      process.stdin.destroy();
      for (const chunk of chunks) chunk.fill(0);
      resolve(value);
    };
    timer = setTimeout(() => done(null), INPUT_TIMEOUT_MS);
    process.stdin.on('data', (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > MAX_INPUT_BYTES) done(null);
    });
    process.stdin.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let token = null;
      try {
        token = JSON.parse(text).token ?? null;
      } catch {
        token = null;
      }
      done(typeof token === 'string' ? token : null);
    });
  });
}

function reply(body) {
  process.stdout.on('error', () => {
    // `fundkit unlock` stopped reading; the daemon carries on.
  });
  process.stdout.write(`${JSON.stringify(body)}\n`);
  process.stdout.end();
}

function logTo(file) {
  return (line) => {
    try {
      fs.appendFileSync(file, `[${nowIso()}] ${line}\n`, { mode: 0o600 });
    } catch {
      // Logging is best effort and never holds a value.
    }
  };
}

export async function runDaemonCommand(argv) {
  let ttlMs = parseDuration('8h');
  if (argv[0] === '--ttl' && argv[1]) ttlMs = parseDuration(argv[1]);

  let token = await readTokenLine();
  if (!token || !SERVICE_TOKEN_PATTERN.test(token)) {
    token = null;
    reply({ ok: false, error: 'TOKEN_FORMAT', message: 'no Doppler service token on stdin' });
    return 2;
  }
  const doppler = new DopplerClient(token);
  token = null;
  let identity;
  try {
    identity = await doppler.identify();
  } catch (error) {
    doppler.drop();
    reply({
      ok: false,
      error: error.code ?? 'DOPPLER_ERROR',
      message: `${error.message}. Nothing was kept.`,
    });
    return 3;
  }

  ensurePrivateDir(runDir());
  const log = logTo(path.join(runDir(), 'daemon.log'));
  let resolveEnded;
  const ended = new Promise((resolve) => {
    resolveEnded = resolve;
  });
  const session = new SessionDaemon(doppler, {
    ttlMs,
    writes: false,
    maxTransfer: 10,
    maxDaily: null,
    keep: true,
    headless: true,
    wrapped: false,
    debug: false,
    provisioning: new Set(),
    passphrases: new Map(),
    identity,
    log,
    onEnd: resolveEnded,
  });
  try {
    await session.listen();
  } catch (error) {
    doppler.drop();
    const running = await sessionStatus();
    if (running) {
      reply({ ok: true, already: true, doppler: running.doppler, expires: running.expires });
      return 0;
    }
    reply({ ok: false, error: 'DAEMON_FAILED', message: error.message });
    return 1;
  }
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT']) {
    process.on(signal, () => session.end(`signal ${signal}`));
  }
  process.on('uncaughtException', (error) => session.end(`error: ${error?.message ?? error}`));
  log(`session active: Doppler project ${identity.project}, config ${identity.config}`);
  reply({ ok: true, doppler: identity, expires: new Date(session.expires).toISOString() });
  const reason = await ended;
  log(`daemon exiting (${reason})`);
  return 0;
}
