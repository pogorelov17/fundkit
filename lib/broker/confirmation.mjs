// The one human confirmation of a transfer plan.
//
// ccxt-mcp's own form (one required boolean `confirm`) does not show `params`, the plan id or the
// expiry, and some hosts cannot answer it at all: T3 Code fills an accepted form's content
// itself and cancels any form with a required field it cannot fill (a boolean without a default
// or enum). The broker therefore shows that same form to the human as a card with every plan
// field, the plan id and hash, and a single-option field T3 can fill (`decision: "approve"`),
// then maps the human's answer back. The text is unique per plan, so a host's "always allow"
// grant for one card never matches another transfer.
//
// The card's labels are fixed English. The agent explains the plan in the user's own language in
// the chat before the card opens; the card itself is never relabelled by host-supplied text.

import { exchangeLabel } from '../exchanges.mjs';
import { minimumText, UNPUBLISHED_BASIS } from '../venues/minimum.mjs';

const LABELS = Object.freeze({
  title: 'Confirm transfer',
  until: 'valid until',
  route: 'Route',
  network: 'Network',
  contract: 'USDT contract',
  amount: 'Amount (withdrawal amount)',
  fee: 'Withdrawal fee',
  debit: 'Leaves the source',
  credit: 'Arrives',
  recipient: 'Recipient address',
  recipientSource: 'read from your account',
  memo: 'Memo/tag',
  minimum: 'Destination minimum',
  none: 'none',
  params: 'Exact call',
  approve: 'Approve this exact transfer',
  once: 'One withdrawal only. Declining or closing this card sends nothing.',
});

function range(bounds) {
  return bounds.min === bounds.max ? bounds.max : `${bounds.min}–${bounds.max}`;
}

/**
 * The destination minimum on the card: the venue's figure with its field, or, when the venue
 * publishes none, the plan's own disclosure line (the same text the chat showed before the card).
 */
function minimumLines(plan) {
  const minimum = plan.destination?.minimum;
  if (!minimum) return [];
  if (minimum.basis === UNPUBLISHED_BASIS) return [minimum.notice];
  return [`${LABELS.minimum}: ${minimumText(minimum, plan.coin)}`];
}

/** The card text: every immutable plan field, the plan id, its hash and the expiry. */
export function confirmationText(plan) {
  const l = LABELS;
  const from = exchangeLabel(plan.from);
  const to = exchangeLabel(plan.to);
  return [
    `${l.title} ${plan.planId} (${l.until} ${plan.expiresAt})`,
    `${l.route}: ${from} (${plan.sourceWallet.wallet}) → ${to}, ${plan.coin}`,
    `${l.network}: ${plan.network.label}; ${from} ${plan.network.sourceId} → ${to} ${plan.network.destinationId}`,
    `${l.contract}: ${plan.network.contract}`,
    `${l.amount}: ${plan.amount} ${plan.coin}`,
    `${l.fee}: ${plan.fee.value} ${plan.fee.asset} (${plan.fee.model})`,
    `${l.debit}: ${range(plan.debit)} ${plan.coin}; ${l.credit}: ${range(plan.credit)} ${plan.coin}`,
    `${l.recipient} (${l.recipientSource} ${to}): ${plan.recipient.address}`,
    `${l.memo}: ${plan.recipient.memo ?? l.none}`,
    ...minimumLines(plan),
    `${l.params}: withdraw ${JSON.stringify(plan.args)}`,
    l.once,
    `plan hash ${plan.hash}`,
  ].join('\n');
}

export function confirmationSchema() {
  const l = LABELS;
  return {
    type: 'object',
    properties: {
      decision: { type: 'string', title: l.approve, enum: ['approve'], enumNames: [l.approve] },
    },
    required: ['decision'],
  };
}

/**
 * Whether ccxt-mcp's own form describes exactly the plan's withdrawal. Its message is
 * `Confirm: withdrawal on <exchange> (account "<alias>", LIVE)` followed by a JSON preview.
 */
export function previewMatchesPlan(message, plan) {
  if (typeof message !== 'string') return false;
  const start = message.indexOf('\n{');
  if (start < 0) return false;
  let preview;
  try {
    preview = JSON.parse(message.slice(start + 1));
  } catch {
    return false;
  }
  const header = message.slice(0, start);
  const { args } = plan;
  return (
    header.startsWith(`Confirm: withdrawal on ${plan.from} `) &&
    header.includes(`(account ${JSON.stringify(args.account)}, LIVE)`) &&
    preview.currency === args.code &&
    preview.amount === args.amount &&
    preview.destinationAddress === args.address &&
    (preview.tag ?? null) === (args.tag ?? null) &&
    preview.network === args.network &&
    preview.environment === 'live'
  );
}
