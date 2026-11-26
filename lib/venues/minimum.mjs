// The destination's deposit minimum and the amounts it is checked against.
//
// A minimum has a basis. `venue`: the destination venue's own field (Bybit `depositMin`, or a
// minimum Binance supplies on its network row). `fundkit-operator-fallback`: Fundkit's own
// operating assumption, used for exactly one route below and only when the venue supplies no
// minimum and every other read is verified and healthy. It is not the venue's figure and does
// not guarantee the credit. Rules: references/binance-bep20-minimum-fallback.md.

import { formatDecimal } from './decimal.mjs';
import { hold } from './hold.mjs';

export const VENUE_BASIS = 'venue';
export const FALLBACK_BASIS = 'fundkit-operator-fallback';

/** Fundkit's operator fallback minimums, by `<exchange>:<network code>`. USDT only. */
const OPERATOR_FALLBACKS = Object.freeze({
  'binance:BEP20': Object.freeze({ value: '5', venue: 'Binance', network: 'BNB Smart Chain (BEP20)' }),
});

/** The fallback for this destination and network, or null (every other route has none). */
export function operatorFallback(exchange, networkCode) {
  return OPERATOR_FALLBACKS[`${exchange}:${networkCode}`] ?? null;
}

/** The plan's minimum record for a venue's own value. */
export function venueMinimum(units, field) {
  const value = formatDecimal(units);
  return { value, basis: VENUE_BASIS, field, venueMinimum: value };
}

/** The plan's minimum record for the operator fallback. */
export function fallbackMinimum(fallback) {
  return {
    value: fallback.value,
    basis: FALLBACK_BASIS,
    venueMinimum: 'unknown',
    statement:
      `${fallback.venue} supplies no deposit minimum for USDT on ${fallback.network}. ` +
      `${fallback.value} USDT is Fundkit's operator fallback, not a ${fallback.venue} figure, ` +
      'and does not guarantee the credit.',
  };
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

/** Hold unless the conservative credit reaches the destination minimum (inclusive). */
export function checkDestinationMinimum(creditMin, destination, venueLabel) {
  if (destination.depositMin === null || destination.depositMin === undefined) {
    throw hold('DESTINATION_MINIMUM_UNDOCUMENTED', destination.depositMinReason);
  }
  if (creditMin >= destination.depositMin) return;
  const credit = formatDecimal(creditMin);
  const min = formatDecimal(destination.depositMin);
  if (destination.minimum?.basis === FALLBACK_BASIS) {
    throw hold(
      'BELOW_DEPOSIT_MIN',
      `the expected credit after fees is ${credit} USDT, below Fundkit's operator fallback minimum of ` +
        `${min} USDT for ${venueLabel} (${venueLabel} supplies no minimum for this network)`,
    );
  }
  throw hold(
    'BELOW_DEPOSIT_MIN',
    `${venueLabel} credits deposits from ${min} USDT; the expected credit after fees is ${credit} USDT`,
  );
}

/** A plan minimum record as the chat summary and the confirmation card show it. */
export function minimumText(minimum) {
  if (minimum.basis === FALLBACK_BASIS) {
    return `${minimum.value} USDT, Fundkit operator fallback (venue minimum: unknown). ${minimum.statement}`;
  }
  return `${minimum.value} USDT, venue minimum (${minimum.field})`;
}
