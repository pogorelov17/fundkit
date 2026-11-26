// `fundkit session [options] [-- host command]`: the private terminal step.

import { spawn } from 'node:child_process';
import { SERVICE_TOKEN_PATTERN } from '../constants.mjs';
import { sessionStatus } from '../control.mjs';
import { DopplerClient } from '../doppler.mjs';
import { exchangeLabel, normalizeExchange, PASSPHRASE_EXCHANGES } from '../exchanges.mjs';
import { readHiddenLine } from '../terminal.mjs';
import { nowIso, parseDuration } from '../util.mjs';
import { SessionDaemon } from './daemon.mjs';
import { PASSPHRASE_PROMPT_TIMEOUT_MS, passphrasePrompt } from './passphrases.mjs';

const EXIT = Object.freeze({ OK: 0, FAILED: 1, USAGE: 2, DOPPLER: 3, CANCELLED: 130 });

const DEFAULT_OPTIONS = Object.freeze({
  ttlMs: parseDuration('8h'),
  writes: false,
  maxTransfer: 10,
  maxDaily: null,
  keep: false,
  debug: false,
  passphraseExchanges: [],
  provisioning: [],
});

/** Venues whose documented address read may create an address (references/recipients.md). */
const PROVISIONING_EXCHANGES = Object.freeze(['gate', 'whitebit']);

class UsageError extends Error {}

function parseTtl(text) {
  try {
    return parseDuration(text);
  } catch (error) {
    throw new UsageError(error.message);
  }
}

/** Parse a comma-separated exchange list, keeping only `allowed` venues. */
function parseExchangeList(option, text, allowed) {
  const exchanges = String(text)
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => {
      const exchange = normalizeExchange(name);
      if (!exchange || !allowed.includes(exchange)) {
        throw new UsageError(`${option} accepts ${allowed.join(', ')}; not ${name}`);
      }
      return exchange;
    });
  return [...new Set(exchanges)];
}

/** Split argv at `--` and parse the session's own options. */
export function parseSessionArgs(argv) {
  const separator = argv.indexOf('--');
  const own = separator >= 0 ? argv.slice(0, separator) : argv;
  const hostCommand = separator >= 0 ? argv.slice(separator + 1) : null;
  const options = { ...DEFAULT_OPTIONS };
  let explicitCap = false;

  for (let index = 0; index < own.length; index += 1) {
    const option = own[index];
    const value = () => {
      index += 1;
      if (index >= own.length) throw new UsageError(`${option} needs a value`);
      return own[index];
    };
    switch (option) {
      case '--ttl':
        options.ttlMs = parseTtl(value());
        break;
      case '--writes':
        options.writes = true;
        break;
      case '--max-transfer':
        options.maxTransfer = Number(value());
        explicitCap = true;
        break;
      case '--max-daily':
        options.maxDaily = Number(value());
        break;
      case '--keep':
        options.keep = true;
        break;
      case '--debug':
        options.debug = true;
        break;
      case '--passphrase':
        options.passphraseExchanges = parseExchangeList(option, value(), PASSPHRASE_EXCHANGES);
        break;
      case '--allow-provisioning':
        options.provisioning = parseExchangeList(option, value(), PROVISIONING_EXCHANGES);
        break;
      default:
        throw new UsageError(`unknown option ${option}`);
    }
  }

  const positive = (number) => Number.isFinite(number) && number > 0;
  if (!positive(options.maxTransfer) || (options.maxDaily !== null && !positive(options.maxDaily))) {
    throw new UsageError('limits must be positive numbers');
  }
  if (options.writes && !explicitCap) throw new UsageError('--writes needs an explicit --max-transfer <USD>');
  if (hostCommand && hostCommand.length === 0) throw new UsageError('nothing to run after --');
  return { options, hostCommand };
}

function say(line) {
  process.stderr.write(`${line}\n`);
}

/** Read and check the service token; returns a DopplerClient and identity, or an exit code. */
async function acquireToken() {
  say('fundkit session: exchange credentials for this session come from one Doppler config.');
  say('Paste a read-only Doppler service token (dp.st.…). Input is hidden; Enter submits, Ctrl-C cancels.');
  let token;
  try {
    token = await readHiddenLine('Doppler service token: ');
  } catch (error) {
    if (error.code === 'NO_TTY') {
      say(
        'No terminal: run fundkit session in an interactive terminal ' +
          '(the token is never read from stdin, argv or the environment).',
      );
      return { exitCode: EXIT.USAGE };
    }
    say(`Cancelled (${error.message}). Nothing was stored.`);
    return { exitCode: EXIT.CANCELLED };
  }
  if (!SERVICE_TOKEN_PATTERN.test(token)) {
    say('That is not a Doppler service token (dp.st.…). Nothing was sent or stored.');
    return { exitCode: EXIT.USAGE };
  }
  const doppler = new DopplerClient(token);
  token = null;
  try {
    const identity = await doppler.identify();
    return { doppler, identity };
  } catch (error) {
    doppler.drop();
    say(`${error.message}. Nothing was stored.`);
    return { exitCode: EXIT.DOPPLER };
  }
}

/**
 * Ask for the API passphrases named with --passphrase, before the host starts. Enter on an empty
 * line skips one exchange; Ctrl-C cancels the whole session start. Returns null on cancel.
 */
async function acquirePassphrases(exchanges) {
  const passphrases = new Map();
  for (const exchange of exchanges) {
    try {
      const value = await readHiddenLine(passphrasePrompt(exchange), {
        allowSpace: true,
        timeoutMs: PASSPHRASE_PROMPT_TIMEOUT_MS,
      });
      if (value) passphrases.set(exchange, value);
      else say(`${exchangeLabel(exchange)}: skipped; the session asks when a profile needs it.`);
    } catch (error) {
      passphrases.clear();
      say(`Cancelled (${error.message}). Nothing was stored.`);
      return null;
    }
  }
  return passphrases;
}

/** Start the host after the prompt, without any DOPPLER_* variable of the operator's shell. */
function launchHost(hostCommand, session) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('DOPPLER_')),
  );
  const host = spawn(hostCommand[0], hostCommand.slice(1), { stdio: 'inherit', env });
  const exited = new Promise((resolve) => {
    host.once('exit', resolve);
    host.once('error', resolve);
  });
  host.once('exit', () => session.end('the host exited'));
  host.once('error', (error) => session.end(`could not start ${hostCommand[0]}: ${error.message}`));
  return exited;
}

export async function runSessionCommand(argv) {
  let parsed;
  try {
    parsed = parseSessionArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    say(error.message);
    return EXIT.USAGE;
  }
  const { options, hostCommand } = parsed;

  const running = await sessionStatus();
  if (running) {
    say(`a fundkit session is already active until ${running.expires}`);
    return EXIT.FAILED;
  }

  const { doppler, identity, exitCode } = await acquireToken();
  if (!doppler) return exitCode;
  const passphrases = await acquirePassphrases(options.passphraseExchanges);
  if (!passphrases) {
    doppler.drop();
    return EXIT.CANCELLED;
  }

  const wrapped = Boolean(hostCommand);
  const log = wrapped ? () => {} : (line) => say(`[${nowIso()}] ${line}`);
  let resolveEnded;
  const ended = new Promise((resolve) => {
    resolveEnded = resolve;
  });
  const session = new SessionDaemon(doppler, {
    ...options,
    provisioning: new Set(options.provisioning),
    passphrases,
    identity,
    wrapped,
    log,
    onEnd: resolveEnded,
  });
  try {
    await session.listen();
  } catch (error) {
    doppler.drop();
    say(error.message);
    return EXIT.FAILED;
  }

  say(
    `Session active: Doppler project ${identity.project}, config ${identity.config}; ` +
      `until ${new Date(session.expires).toISOString()}.`,
  );
  const writesLine = options.writes
    ? `writes enabled, cap ${options.maxTransfer} USD per call`
    : 'dryRun (start with --writes --max-transfer <USD> to allow real writes)';
  say(`Money-moving profiles: ${writesLine}. Deposit-only profiles always dryRun.`);
  if (options.provisioning.length > 0) {
    say(`Address reads that may create an address are allowed on: ${options.provisioning.join(', ')}.`);
  }

  for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => session.end(`signal ${signal}`));
  process.on('uncaughtException', (error) => session.end(`error: ${error?.message ?? error}`));

  let hostExited = Promise.resolve();
  if (wrapped) {
    process.on('SIGINT', () => {
      // Ctrl-C belongs to the host running in this terminal.
    });
    hostExited = launchHost(hostCommand, session);
  } else {
    process.on('SIGINT', () => session.end('signal SIGINT'));
    say(
      'Keep this terminal open. Ctrl-C (or closing it) ends the session; ' +
        'it also ends when the host session that used it closes.',
    );
    say(
      'When a profile on OKX, Bitget or KuCoin needs its API passphrase, this terminal asks for it (hidden).',
    );
  }

  const reason = await ended;
  // A session that ends early (token rejected, time limit) leaves the host running until it exits.
  await hostExited;
  say(`fundkit session ended (${reason}). Token and fetched credentials dropped; profile processes stopped.`);
  return reason.startsWith('error') || reason.includes('rejected') ? EXIT.DOPPLER : EXIT.OK;
}
