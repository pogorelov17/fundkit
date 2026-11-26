// `fundkit unlock`: hand a host-delivered secret to the session, without a terminal.
//
//   fundkit unlock --token-file <path> [--ttl 8h]
//       Consume the Doppler service token the host wrote to <path> (T3 Code: request_secret with
//       delivery "file"), then start the background session daemon with it, or report the
//       session that is already active.
//   fundkit unlock --passphrase <okx|bitget|kucoin> --secret-file <path>
//       Consume an API passphrase the same way and give it to the running session.
//
// Every outcome is one JSON line on stdout without any value. The token goes to the daemon on
// its stdin pipe and the passphrase over the private control socket; neither ever appears in
// argv, the environment, a log or a file written by fundkit.

import { spawn } from 'node:child_process';
import { CLI_PATH, SERVICE_TOKEN_PATTERN } from './constants.mjs';
import { requestSession, sessionStatus } from './control.mjs';
import { exchangeLabel, needsPassphrase, normalizeExchange, PASSPHRASE_EXCHANGES } from './exchanges.mjs';
import { consumeSecretFile } from './handoff.mjs';
import { onJsonLines } from './ndjson.mjs';
import { parseDuration } from './util.mjs';

const EXIT = Object.freeze({ OK: 0, FAILED: 1, USAGE: 2, DOPPLER: 3 });
const DAEMON_START_TIMEOUT_MS = 40_000;

function report(body) {
  process.stdout.write(`${JSON.stringify(body)}\n`);
}

function fail(code, message, exitCode = EXIT.FAILED, extra = {}) {
  report({ ok: false, error: code, message, ...extra });
  return exitCode;
}

function parseUnlockArgs(argv) {
  const options = { tokenFile: null, secretFile: null, passphrase: null, ttl: '8h' };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${option} needs a value`);
      return argv[index];
    };
    switch (option) {
      case '--token-file':
        options.tokenFile = value();
        break;
      case '--secret-file':
        options.secretFile = value();
        break;
      case '--passphrase':
        options.passphrase = value();
        break;
      case '--ttl':
        options.ttl = value();
        break;
      default:
        throw new Error(`unknown option ${option}`);
    }
  }
  parseDuration(options.ttl);
  const tokenMode = options.tokenFile !== null;
  const passphraseMode = options.passphrase !== null || options.secretFile !== null;
  if (tokenMode === passphraseMode) {
    throw new Error('use either --token-file <path> or --passphrase <exchange> --secret-file <path>');
  }
  if (passphraseMode && (options.passphrase === null || options.secretFile === null)) {
    throw new Error('--passphrase needs --secret-file <path>');
  }
  return options;
}

/** Start `fundkit daemon` detached, give it the token on its stdin, and wait for its first line. */
function startDaemon(token, ttl) {
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
    child.stdin.end(`${JSON.stringify({ token })}\n`);
  });
}

async function unlockToken(options) {
  let buffer;
  try {
    buffer = consumeSecretFile(options.tokenFile);
  } catch (error) {
    return fail(error.code ?? 'FILE_UNSAFE', error.message);
  }
  let token = buffer.toString('utf8');
  buffer.fill(0);
  if (!SERVICE_TOKEN_PATTERN.test(token)) {
    token = null;
    return fail(
      'TOKEN_FORMAT',
      'the value is not a Doppler service token (dp.st.…); it was deleted and not sent anywhere',
      EXIT.USAGE,
    );
  }
  const running = await sessionStatus();
  if (running) {
    token = null;
    report({
      ok: true,
      session: 'active',
      already: true,
      doppler: running.doppler,
      expires: running.expires,
      note: 'a session was already active; the delivered token was deleted unused',
    });
    return EXIT.OK;
  }
  const reply = await startDaemon(token, options.ttl);
  token = null;
  if (!reply.ok) {
    const code = reply.error === 'TOKEN_REJECTED' ? EXIT.DOPPLER : EXIT.FAILED;
    return fail(reply.error, reply.message, code);
  }
  report({ ok: true, session: 'active', doppler: reply.doppler, expires: reply.expires });
  return EXIT.OK;
}

async function unlockPassphrase(options) {
  const exchange = normalizeExchange(options.passphrase);
  if (!exchange || !needsPassphrase(exchange)) {
    return fail('NO_PASSPHRASE', `--passphrase accepts ${PASSPHRASE_EXCHANGES.join(', ')}`, EXIT.USAGE);
  }
  let buffer;
  try {
    buffer = consumeSecretFile(options.secretFile, { keepSpaces: true });
  } catch (error) {
    return fail(error.code ?? 'FILE_UNSAFE', error.message);
  }
  let value = buffer.toString('utf8');
  buffer.fill(0);
  if (!(await sessionStatus())) {
    value = null;
    return fail('NO_SESSION', 'no fundkit session is active; the passphrase was deleted unused');
  }
  const reply = await requestSession({ t: 'passphrase', exchange, value });
  value = null;
  if (reply?.t !== 'passphrase-stored') {
    return fail(
      reply?.code ?? 'NO_SESSION',
      reply?.message ?? 'the session did not answer; nothing was kept',
    );
  }
  report({
    ok: true,
    exchange,
    note: `${exchangeLabel(exchange)} API passphrase is in the session's memory only`,
    replaced: reply.replaced,
  });
  return EXIT.OK;
}

export async function runUnlockCommand(argv) {
  let options;
  try {
    options = parseUnlockArgs(argv);
  } catch (error) {
    return fail('USAGE', error.message, EXIT.USAGE);
  }
  return options.tokenFile !== null ? unlockToken(options) : unlockPassphrase(options);
}
