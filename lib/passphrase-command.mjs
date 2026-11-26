// `fundkit passphrase <exchange>`: type an API passphrase for the running session from any other
// terminal of the operator. Needed when the session runs the host in its own terminal
// (`fundkit session -- claude`), and handy to replace a mistyped one.

import { requestSession, sessionStatus } from './control.mjs';
import { exchangeLabel, needsPassphrase, normalizeExchange, PASSPHRASE_EXCHANGES } from './exchanges.mjs';
import { PASSPHRASE_PROMPT_TIMEOUT_MS, passphrasePrompt } from './session/passphrases.mjs';
import { readHiddenLine } from './terminal.mjs';

const EXIT = Object.freeze({ OK: 0, FAILED: 1, USAGE: 2, CANCELLED: 130 });

function say(line) {
  process.stderr.write(`${line}\n`);
}

export async function runPassphraseCommand(argv) {
  const exchange = normalizeExchange(argv[0]);
  if (argv.length !== 1 || !exchange || !needsPassphrase(exchange)) {
    say(`usage: fundkit passphrase <${PASSPHRASE_EXCHANGES.join('|')}>`);
    return EXIT.USAGE;
  }
  if (!(await sessionStatus())) {
    say('no fundkit session: start one with fundkit session first');
    return EXIT.FAILED;
  }
  const label = exchangeLabel(exchange);
  say(
    `${label} API passphrase for the running fundkit session. Input is hidden; Enter submits, Ctrl-C cancels.`,
  );
  let value;
  try {
    value = await readHiddenLine(passphrasePrompt(exchange), {
      allowSpace: true,
      timeoutMs: PASSPHRASE_PROMPT_TIMEOUT_MS,
    });
  } catch (error) {
    say(
      error.code === 'NO_TTY'
        ? 'No terminal: run fundkit passphrase in an interactive terminal (never from stdin, argv or the environment).'
        : `Cancelled (${error.message}). Nothing was sent.`,
    );
    return error.code === 'NO_TTY' ? EXIT.USAGE : EXIT.CANCELLED;
  }
  if (!value) {
    say('Empty input: nothing was sent.');
    return EXIT.CANCELLED;
  }
  const reply = await requestSession({ t: 'passphrase', exchange, value });
  value = null;
  if (reply?.t !== 'passphrase-stored') {
    say(reply ? `The session refused it: ${reply.message}` : 'The session did not answer; nothing was kept.');
    return EXIT.FAILED;
  }
  say(
    `${label} passphrase is in the running session's memory only. Go back to the chat and say you are done.`,
  );
  if (reply.replaced && reply.running.length > 0) {
    say(
      `Running ${reply.running.join(', ')} keep the previous one until the agent disconnects and reconnects them.`,
    );
  }
  return EXIT.OK;
}
