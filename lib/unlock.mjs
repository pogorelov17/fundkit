// `fundkit unlock`: hand a host-delivered secret to the session, without a terminal.
//
//   fundkit unlock --token-file <path> [--ttl 8h]
//       Consume a Doppler Service Token written to <path> (a private 0600 file), then start the
//       background session daemon with it, add it to a running session that has no Doppler yet,
//       or report the session that already has one. In a T3 Code chat the agent does not run
//       this: it passes the card's file path to the fundkit_secret_submit tool instead.
//   fundkit unlock --passphrase <okx|bitget|kucoin> --secret-file <path>
//       Consume an API passphrase the same way and give it to the running session.
//
// Every outcome is one JSON line on stdout without any value. The token goes to the daemon on
// its stdin pipe and the passphrase over the private control socket; neither ever appears in
// argv, the environment, a log or a file written by fundkit.

import { SERVICE_TOKEN_PATTERN } from './constants.mjs';
import { requestSession, sessionStatus } from './control.mjs';
import { exchangeLabel, needsPassphrase, normalizeExchange, PASSPHRASE_EXCHANGES } from './exchanges.mjs';
import { consumeSecretFile } from './handoff.mjs';
import { startDaemon } from './session/spawn.mjs';
import { parseDuration } from './util.mjs';

const EXIT = Object.freeze({ OK: 0, FAILED: 1, USAGE: 2, DOPPLER: 3 });

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
  if (running && !running.doppler) {
    // A session without Doppler (manual credentials only): add the token to it.
    const added = await requestSession({ t: 'token', value: token }, { timeoutMs: 30_000 });
    token = null;
    if (added?.t !== 'token-stored') {
      const code = added?.code === 'TOKEN_REJECTED' ? EXIT.DOPPLER : EXIT.FAILED;
      return fail(added?.code ?? 'NO_SESSION', added?.message ?? 'the session did not answer', code);
    }
    report({ ok: true, session: 'active', doppler: added.doppler, expires: running.expires });
    return EXIT.OK;
  }
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
  const reply = await startDaemon({ token }, options.ttl);
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
