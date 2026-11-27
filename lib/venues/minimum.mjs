// The destination's deposit minimum and the amounts it is checked against.
//
// A minimum has a basis. `venue`: the destination venue's own published field for that coin and
// chain (Bybit `depositMin`, or a `depositMin` Binance supplies on its network row), applied
// whatever its value, 0 included. `fundkit-operator-fallback`: Fundkit's own operating
// assumption, 1 USDT, used only when the venue's healthy USDT lookup for that chain publishes no
// applicable minimum. It is never reported as the venue's figure and does not
// guarantee the credit. A field that is present but not an exact decimal, or evidence that
// contradicts the fallback, holds. Rules: references/deposit-minimum-fallback.md.

import { formatDecimal, parseDecimal } from './decimal.mjs';
import { hold } from './hold.mjs';

export const VENUE_BASIS = 'venue';
export const FALLBACK_BASIS = 'fundkit-operator-fallback';

/**
 * Fundkit's operator fallback minimum: one policy for USDT deposits into every supported CEX
 * destination. fundkit supports USDT only, so no other coin has a fallback. Which chains a venue
 * adapter can actually read is a separate question (networks.mjs and the adapters); this table
 * only says what minimum applies when a healthy read names none.
 */
export const FALLBACK_POLICY = Object.freeze({
  value: '1',
  coins: Object.freeze(['USDT']),
  venues: Object.freeze({
    binance: 'Binance',
    bybit: 'Bybit',
    okx: 'OKX',
    bitget: 'Bitget',
    gate: 'Gate',
    kucoin: 'KuCoin',
    mexc: 'MEXC',
    bingx: 'BingX',
    whitebit: 'WhiteBIT',
  }),
});

/** The fallback for this destination venue and coin, or null (no fallback outside the policy). */
export function operatorFallback(exchange, coin) {
  const venue = FALLBACK_POLICY.venues[exchange];
  if (!venue || !FALLBACK_POLICY.coins.includes(coin)) return null;
  return Object.freeze({ value: FALLBACK_POLICY.value, coin, venue, exchange });
}

/** The plan's minimum record for a venue's own value. */
export function venueMinimum(units, field, coin) {
  const value = formatDecimal(units);
  return { value, coin, basis: VENUE_BASIS, field, venueMinimum: value };
}

/** The plan's minimum record for the operator fallback. */
export function fallbackMinimum(fallback, networkLabel) {
  const { venue, coin, value } = fallback;
  return {
    value,
    coin,
    basis: FALLBACK_BASIS,
    venueMinimum: 'unknown',
    statement:
      `${venue} publishes no deposit minimum for ${coin} on ${networkLabel}. ` +
      `${value} ${coin} is Fundkit's operator fallback, not a ${venue} figure, ` +
      'and does not guarantee the credit.',
  };
}

/**
 * The destination minimum from one healthy venue read, by the policy above:
 * - `published.present` false (the venue's row has no minimum field): the operator fallback,
 *   unless `contrary` names evidence against it (then hold);
 * - present and an exact nonnegative decimal (0 included): the venue's own minimum;
 * - present otherwise (null, empty, text, negative): hold, never the fallback.
 * Returns `{ depositMin, minimum }` with `depositMin` in units.
 */
export function resolveMinimum({ exchange, coin, networkLabel, published, field, contrary }) {
  const fallback = operatorFallback(exchange, coin);
  const venue = fallback?.venue ?? exchange;
  if (published.present) {
    const units = parseDecimal(published.value);
    if (units === null) {
      throw hold(
        'DESTINATION_MINIMUM_UNREADABLE',
        `${venue} ${field} for ${coin} on ${networkLabel} is present but not an exact decimal ` +
          `(${JSON.stringify(published.value ?? null)}), so no minimum is assumed`,
      );
    }
    return { depositMin: units, minimum: venueMinimum(units, field, coin) };
  }
  if (!fallback) {
    throw hold(
      'DESTINATION_MINIMUM_UNDOCUMENTED',
      `${venue} publishes no deposit minimum for ${coin} on ${networkLabel} and no operator fallback applies`,
    );
  }
  const units = parseDecimal(fallback.value);
  const against = contrary?.(units);
  if (against) {
    throw hold(
      'DESTINATION_MINIMUM_CONTRARY',
      `${against} contradicts Fundkit's operator fallback minimum of ${fallback.value} ${coin}, ` +
        'so no minimum is assumed',
    );
  }
  return { depositMin: units, minimum: fallbackMinimum(fallback, networkLabel) };
}

/** Whether a plan relies on the operator fallback (and so is read again before submission). */
export function usesFallback(plan) {
  return plan?.destination?.minimum?.basis === FALLBACK_BASIS;
}

/**
 * What leaves the source and what arrives, in exact units. `on top`: the fee is added to the
 * debit; any other model is treated as possibly taken from the amount, so the conservative
 * credit subtracts it. The destination's deposit fee is always subtracted.
 */
export function transferAmounts({ amount, fee, feeModel, depositFee }) {
  const onTop = feeModel === 'on top';
  return {
    debit: { min: onTop ? amount + fee : amount, max: amount + fee },
    credit: { min: onTop ? amount - depositFee : amount - fee - depositFee, max: amount - depositFee },
  };
}

/**
 * Hold unless the conservative credit is positive and reaches the destination minimum
 * (inclusive). The coin is the plan's coin; every message names it.
 */
export function checkDestinationMinimum(creditMin, destination, venueLabel, coin) {
  if (destination.depositMin === null || destination.depositMin === undefined) {
    throw hold(
      'DESTINATION_MINIMUM_UNDOCUMENTED',
      destination.depositMinReason ?? `${venueLabel} names no deposit minimum`,
    );
  }
  const credit = formatDecimal(creditMin);
  if (creditMin <= 0n) {
    throw hold(
      'CREDIT_NOT_POSITIVE',
      `the expected credit after fees is ${credit} ${coin}, so nothing would arrive`,
    );
  }
  if (creditMin >= destination.depositMin) return;
  const min = formatDecimal(destination.depositMin);
  if (destination.minimum?.basis === FALLBACK_BASIS) {
    throw hold(
      'BELOW_DEPOSIT_MIN',
      `the expected credit after fees is ${credit} ${coin}, below Fundkit's operator fallback minimum of ` +
        `${min} ${coin} for ${venueLabel} (${venueLabel} publishes no minimum for this coin and network)`,
    );
  }
  throw hold(
    'BELOW_DEPOSIT_MIN',
    `${venueLabel} credits deposits from ${min} ${coin}; the expected credit after fees is ${credit} ${coin}`,
  );
}

/** A plan minimum record as the chat summary and the confirmation card show it. */
export function minimumText(minimum, coin = minimum.coin) {
  if (minimum.basis === FALLBACK_BASIS) {
    return `${minimum.value} ${coin}, Fundkit operator fallback (venue minimum: unknown). ${minimum.statement}`;
  }
  return `${minimum.value} ${coin}, venue minimum (${minimum.field})`;
}
