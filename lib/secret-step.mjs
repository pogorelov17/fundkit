// What the agent shows the user when fundkit needs credentials only the user can give.
//
// fundkit cannot open a dialog itself: an MCP server does not see its host's own tools. It
// therefore returns two kinds of step for the agent to carry out:
//
//   choiceStep  one explicit, non-secret question before any secret card: connect with a
//               Doppler Service Token (first, the default) or enter the exchange API credentials
//               manually. Only the option the operator selects runs.
//   secretStep  exactly one private card (T3 Code: `request_secret` with `delivery: "file"`) for
//               one value. The agent passes the returned file path to fundkit_secret_submit; the
//               session daemon reads the file once and deletes it. The value never reaches the
//               model, an MCP message, argv, the environment or a log.

import { dopplerNames, exchangeLabel } from './exchanges.mjs';
import { fieldLabel, manualFields } from './credentials.mjs';

export const FILE_PLACEHOLDER = '<FILE>';

const HOST_WITHOUT_CARD =
  'This host gives the agent no private secret card with file delivery, so no secret can be entered ' +
  'from this chat: say so plainly and never ask for a value in the chat. On this machine the operator ' +
  'can instead run `fundkit session` in a private terminal (Doppler, hidden input) or register their ' +
  'own ccxt-mcp profile files (references/security.md, scheme C). Do not ask the user to run anything else.';

const SECRET_RULES = Object.freeze([
  'Open exactly this one private card, with `request` as given (you may translate `reason` into the ' +
    "user's language, never the label), and ask nothing else before or in between.",
  `Then call \`submit\` with ${FILE_PLACEHOLDER} replaced by the file path the card returned, unchanged, ` +
    'in the same turn. Never read, print, copy or cat the file: fundkit reads it once and deletes it.',
  'If the card is cancelled, dismissed or times out, call `ifCancelled`. Do not open another card on your own.',
  'Never ask for the value in the chat. Do not ask the user to run a command, write a file or say they are done.',
]);

function names(exchanges) {
  return exchanges.map(exchangeLabel).join(', ');
}

/** The one question before any secret card. `exchanges` are the venues that lack credentials. */
export function choiceStep({ exchanges, credentials = null, resume = null, why = null }) {
  const venues = names(exchanges);
  const base = { exchanges, ...(credentials ? { credentials } : {}), ...(resume ? { resume } : {}) };
  const dopplerNameList = exchanges.flatMap(dopplerNames).join(', ');
  const manualFieldsText = exchanges
    .map((exchange) => manualFields(exchange).map((field) => fieldLabel(exchange, field)))
    .flat()
    .join(', ');
  return {
    hostTool:
      "the host's own single-choice question (T3 Code and Codex: request_user_input; Claude Code: " +
      'AskUserQuestion). With no such tool, ask the same question in the chat as a plain choice between ' +
      'the two options.',
    ...(why ? { why } : {}),
    question: `${venues} ${exchanges.length === 1 ? 'is' : 'are'} not connected. How should fundkit get the API credentials for this session?`,
    options: [
      {
        id: 'doppler',
        label: 'Doppler Service Token',
        default: true,
        description:
          `Recommended. One private card for a read-only Doppler Service Token; fundkit then reads only ` +
          `${dopplerNameList} from that Doppler config.`,
        then: { tool: 'fundkit_credentials', arguments: { provider: 'doppler', ...base } },
      },
      {
        id: 'manual',
        label: 'Enter exchange API credentials manually',
        default: false,
        description:
          `No Doppler. Private cards, one value at a time: ${manualFieldsText}. Kept in fundkit's memory ` +
          'for this chat only; never a wallet private key or seed phrase.',
        then: { tool: 'fundkit_credentials', arguments: { provider: 'manual', ...base } },
      },
    ],
    rules: [
      'Ask this one question with exactly these two options in this order, the Doppler Service Token first ' +
        "and marked as the default. Translate the question and descriptions into the user's language; " +
        'keep the label "Doppler Service Token".',
      "Wait for the operator's selection, then call that option's `then` at once. No answer, a timeout, a " +
        'cancel or a dismissal selects nothing: say that nothing was connected and stop. Never pick an ' +
        'option yourself.',
      'The question itself holds no secret. Never ask for a token, key, secret or passphrase in the chat; ' +
        'only the private card of the next step takes them.',
      'Ask once per request. When the operator already chose for this same request, follow that choice ' +
        "without asking again. If the user's own ccxt-mcp profiles already cover these exchanges, skip this " +
        'and use them.',
    ],
    hostWithoutCard: HOST_WITHOUT_CARD,
  };
}

function secretStep(step, request, extra = {}) {
  return {
    stepId: step.id,
    hostTool: 'request_secret',
    request: { ...request, delivery: 'file' },
    submit: { tool: 'fundkit_secret_submit', arguments: { stepId: step.id, file: FILE_PLACEHOLDER } },
    ifCancelled: { tool: 'fundkit_secret_cancel', arguments: { stepId: step.id } },
    expiresAt: new Date(step.expiresAt).toISOString(),
    ...extra,
    rules: SECRET_RULES,
    hostWithoutCard: HOST_WITHOUT_CARD,
  };
}

/** The card for a Doppler Service Token. */
export function tokenSecretStep(step) {
  const scope = step.exchanges.length
    ? `the config that holds ${step.exchanges.flatMap(dopplerNames).join(', ')}`
    : 'your fundkit Doppler config';
  return secretStep(step, {
    label: 'Doppler Service Token',
    reason:
      `Read-only Doppler Service Token (dp.st.…) for ${scope}. It goes straight to fundkit on this ` +
      'machine; the assistant never sees it.',
    placeholder: 'dp.st.…',
  });
}

/** The card for an API passphrase on the Doppler path (it is never stored in Doppler). */
export function passphraseSecretStep(step) {
  const label = exchangeLabel(step.exchange);
  return secretStep(step, {
    label: `${label} API passphrase`,
    reason:
      `The passphrase of the ${label} API key in ${step.exchange.toUpperCase()}_APIKEY. It is not stored in ` +
      "Doppler and stays in fundkit's memory for this session only; the assistant never sees it.",
  });
}

/** The card for one field of a manual entry. */
export function manualSecretStep(step, { remaining }) {
  const fields = manualFields(step.exchange);
  const index = fields.indexOf(step.field);
  const next = fields[index + 1];
  const label = exchangeLabel(step.exchange);
  const what = {
    apiKey: `The API key of your own ${label} account`,
    secret: `The API secret of that same ${label} API key`,
    passphrase: `The passphrase you set for that same ${label} API key`,
  }[step.field];
  return secretStep(
    step,
    {
      label: fieldLabel(step.exchange, step.field),
      reason:
        `${what} (never a wallet private key or seed phrase). It goes straight to fundkit on this machine and ` +
        "stays in its memory for this chat's session only; the assistant never sees it." +
        (next ? ` Next: the ${fieldLabel(step.exchange, next)}.` : ''),
    },
    {
      progress: `${label}: ${index + 1} of ${fields.length}`,
      remaining: remaining.map(exchangeLabel),
    },
  );
}
