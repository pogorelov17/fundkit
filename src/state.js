// Chat-carried state. There is no database: every step prints one `FUNDKIT_STATE {...}` line,
// the agent keeps the latest line in the conversation, and `fundkit resume --state '<line>'`
// continues from it. State is only a hint — every fact in it is re-verified against Bybit
// and the chain before money-relevant decisions. It never contains API keys or secrets.

export const STATE_PREFIX = 'FUNDKIT_STATE ';
export const STATE_KIND = 'okx-bsc-usdt-to-bybit';

export const PHASES = [
  'link_issued', // signing link produced, waiting for the wallet tx hash
  'tx_submitted', // hash captured, waiting for on-chain receipt
  'tx_failed', // receipt status 0 — safe to issue a fresh link for the same intent
  'tx_confirmed', // on-chain transfer verified, waiting for Bybit credit
  'deposit_credited', // Bybit deposit success, deciding funding->unified transfer
  'transfer_pending', // inter-transfer submitted, waiting for SUCCESS
  'done',
  'needs_attention', // stop: something did not match; a human must look
];

export function formatState(state) {
  return STATE_PREFIX + JSON.stringify(state);
}

export function parseState(input) {
  if (!input) throw new Error('missing state');
  let s = String(input).trim();
  const idx = s.lastIndexOf(STATE_PREFIX.trim());
  if (idx >= 0) s = s.slice(idx + STATE_PREFIX.trim().length).trim();
  const state = JSON.parse(s);
  if (state.v !== 1 || state.kind !== STATE_KIND) throw new Error('not a fundkit v1 state line');
  if (!PHASES.includes(state.phase)) throw new Error(`unknown phase ${state.phase}`);
  return state;
}

export function transition(state, phase, event, detail) {
  if (!PHASES.includes(phase)) throw new Error(`unknown phase ${phase}`);
  const next = { ...state, phase, updatedAt: new Date().toISOString() };
  next.history = [...(state.history || []), [next.updatedAt, event, ...(detail ? [detail] : [])]].slice(-30);
  return next;
}

export function note(state, event, detail) {
  return transition(state, state.phase, event, detail);
}

export function summarize(state) {
  const lines = [
    `intent ${state.intentId}: ${state.amount} USDT (BSC) -> Bybit ${state.target}`,
    `phase: ${state.phase}`,
  ];
  if (state.txHash) lines.push(`tx: ${state.txHash}`);
  if (state.deposit) lines.push(`bybit deposit: status=${state.deposit.status} amount=${state.deposit.amount}`);
  if (state.transfer) lines.push(`funding->unified: ${JSON.stringify(state.transfer)}`);
  const last = state.history?.at(-1);
  if (last) lines.push(`last: ${last.join(' ')}`);
  return lines.join('\n');
}
