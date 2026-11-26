// What the agent does when the session needs a secret only the user can give.
//
// fundkit cannot open a private card itself: an MCP server does not see its host's own tools.
// On a host that gives the agent a private secret card with file delivery (T3 Code:
// `request_secret` with `delivery: "file"`), the agent opens exactly one card and runs one fixed
// command with the returned path; the value never reaches the model. Other hosts are told so.

import { CLI_PATH } from './constants.mjs';
import { exchangeLabel } from './exchanges.mjs';

/** Quote one argument for a POSIX shell. */
export function shellQuote(text) {
  return `'${String(text).replaceAll("'", "'\\''")}'`;
}

const FILE_PLACEHOLDER = '<FILE>';

function command(args) {
  return [process.execPath, CLI_PATH, ...args]
    .map(shellQuote)
    .join(' ')
    .replace(shellQuote(FILE_PLACEHOLDER), '"<FILE>"');
}

const HOST_WITHOUT_CARD =
  'This host gives the agent no private secret card with file delivery: say so plainly. Where the ' +
  'operator has a terminal on this machine, the alternative is `fundkit session` there (hidden ' +
  'input). Never ask for the value in the chat.';

/** The one step that starts a session from a Doppler service token. */
export function tokenSecretStep() {
  return {
    hostTool: 'request_secret',
    request: {
      label: 'Doppler service token',
      reason:
        'Connects your exchange accounts for this session. The token goes straight to fundkit on this ' +
        'machine; the assistant never sees it.',
      placeholder: 'dp.st.…',
      delivery: 'file',
    },
    then: `${command(['unlock', '--token-file', FILE_PLACEHOLDER])}`,
    replace: `${FILE_PLACEHOLDER} is the \`file\` path request_secret returned, unchanged`,
    afterwards: 'call the same fundkit tool again with the same arguments, in the same turn',
    rules: [
      'Exactly one card for the token. Do not ask the user anything else first or in between.',
      'Never read, print, copy or cat the file; only the command above uses it, and it deletes it.',
      'Do not ask the user to confirm they are done or to run anything.',
    ],
    hostWithoutCard: HOST_WITHOUT_CARD,
  };
}

/** The one step that gives the session an exchange's API passphrase. */
export function passphraseSecretStep(exchange) {
  const label = exchangeLabel(exchange);
  return {
    hostTool: 'request_secret',
    request: {
      label: `${label} API passphrase`,
      reason: `${label} API keys need their passphrase; it is not stored in Doppler and stays in memory only.`,
      delivery: 'file',
    },
    then: `${command(['unlock', '--passphrase', exchange, '--secret-file', FILE_PLACEHOLDER])}`,
    replace: `${FILE_PLACEHOLDER} is the \`file\` path request_secret returned, unchanged`,
    afterwards: 'call the same fundkit tool again with the same arguments, in the same turn',
    rules: [
      'One card per exchange and session, only because this exchange needs it.',
      'Never read, print, copy or cat the file.',
    ],
    hostWithoutCard: HOST_WITHOUT_CARD,
  };
}
