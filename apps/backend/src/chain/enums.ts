/**
 * Solidity enum ordinals ↔ names.
 *
 * The single conversion in the backend. `MarketTypes.sol` documents these enums
 * as protocol surface decoded by ordinal, so the arrays below are ordered, not
 * alphabetised, and their order is asserted against the contract's own source in
 * `test/abi-parity.test.ts`.
 *
 * An unknown ordinal throws rather than defaulting. A market whose state cannot
 * be named is a market this build does not understand, and guessing `OPEN`
 * because it happens to be index 0 would let a newer contract be misread as an
 * older one.
 */

import { ChainDataError } from '../errors.js';
import type {
  OnChainCancellationReason,
  OnChainOutcome,
  OnChainState,
} from './types.js';

export const MARKET_STATES: readonly OnChainState[] = [
  'OPEN',
  'CLOSED',
  'RESOLUTION_PROPOSED',
  'CHALLENGED',
  'FINALIZED',
  'SETTLED',
  'CANCELLED',
];

export const OUTCOMES: readonly OnChainOutcome[] = ['UNSET', 'YES', 'NO', 'INVALID'];

export const CANCELLATION_REASONS: readonly OnChainCancellationReason[] = [
  'NONE',
  'NO_RESOLUTION',
  'NO_REVIEW',
  'RESOLVED_INVALID',
];

function decode<T extends string>(table: readonly T[], ordinal: number, label: string): T {
  const value = table[ordinal];
  if (value === undefined) {
    throw new ChainDataError(
      `The chain reported ${label} ordinal ${ordinal}, which this build does not know. ` +
        'The deployed contract is probably newer than this backend.',
    );
  }
  return value;
}

export const toMarketState = (ordinal: number): OnChainState =>
  decode(MARKET_STATES, ordinal, 'a market state');

export const toOutcome = (ordinal: number): OnChainOutcome =>
  decode(OUTCOMES, ordinal, 'an outcome');

export const toCancellationReason = (ordinal: number): OnChainCancellationReason =>
  decode(CANCELLATION_REASONS, ordinal, 'a cancellation reason');

/** Name → ordinal, for the one write the backend performs (`proposeResolution`). */
export function outcomeOrdinal(outcome: OnChainOutcome): number {
  const index = OUTCOMES.indexOf(outcome);
  if (index < 0) throw new ChainDataError(`Unknown outcome "${outcome}".`);
  return index;
}
