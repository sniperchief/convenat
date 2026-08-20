/**
 * Instant comparison, in UTC, at whole-second resolution.
 *
 * ## Never the server's clock, and never the server's timezone
 *
 * Two rules, both of which exist because the alternative fails silently:
 *
 * 1. **An observed timestamp must carry an explicit offset.** A bare
 *    `2026-09-01T23:59:59` is refused, not assumed to be UTC. Guessing a
 *    timezone is precisely the ambiguity this product exists to eliminate, and a
 *    resolver that guessed would decide a deadline wrongly for every source
 *    reporting local time — correctly for sources in UTC, which is what makes it
 *    hard to notice.
 * 2. **Nothing here reads `Date.now()`.** Both operands come from documents: the
 *    deadline from the approved `ConditionSpec`, the observation from a
 *    retrieved source. A validator whose answer depended on when it ran would
 *    not be deterministic, and re-running it during a challenge would be able to
 *    reach a different verdict from the same evidence.
 *
 * ## Why the shared primitive rather than a new parser
 *
 * `utcInstantSchema` from `@covenant/shared` already defines the protocol's
 * instant: RFC 3339 with a mandatory offset, normalised to UTC, truncated to
 * whole seconds. Reusing it means a timestamp that validates here is the same
 * one that would validate inside a hashed document — a second parser would
 * eventually disagree with the first, and the disagreement would surface as a
 * market resolving differently from how it verifies.
 *
 * Second resolution is deliberate and inherited: the protocol's granularity
 * matches block timestamps, so two instants a millisecond apart are the same
 * instant. `deadline − 1s`, `deadline`, `deadline + 1s` is therefore the real
 * boundary, and it is what the tests walk.
 */

import { utcInstantSchema } from '@covenant/shared';

/** A normalised instant and the seconds since the epoch it denotes. */
export interface Instant {
  /** Canonical `YYYY-MM-DDTHH:MM:SSZ`. */
  readonly normalized: string;
  readonly epochSeconds: number;
  /** The text this was parsed from, preserved verbatim for `observed`. */
  readonly text: string;
}

/**
 * Parse an instant, or return null if it is not a well-formed one carrying an
 * explicit offset.
 *
 * Delegates acceptance entirely to the shared schema, so "what counts as an
 * instant" has exactly one definition in this codebase.
 */
export function parseInstant(text: string): Instant | null {
  const trimmed = text.trim();
  const result = utcInstantSchema.safeParse(trimmed);
  if (!result.success) return null;

  const normalized = result.data;
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds)) return null;

  const epochSeconds = Math.floor(milliseconds / 1000);
  if (!Number.isSafeInteger(epochSeconds)) return null;

  return { normalized, epochSeconds, text: trimmed };
}

/** The temporal comparisons a check may perform. */
export const TEMPORAL_OPERATORS = [
  /** Strictly before. At exactly the deadline this is false. */
  'BEFORE',
  /** Before or exactly at. */
  'AT_OR_BEFORE',
  /** Strictly after. At exactly the deadline this is false. */
  'AFTER',
  /** At or after. */
  'AT_OR_AFTER',
] as const;

export type TemporalOperator = (typeof TEMPORAL_OPERATORS)[number];

export const TEMPORAL_SYMBOL: Readonly<Record<TemporalOperator, string>> = {
  BEFORE: '<',
  AT_OR_BEFORE: '<=',
  AFTER: '>',
  AT_OR_AFTER: '>=',
};

/**
 * Apply a temporal operator.
 *
 * The inclusive/exclusive distinction is not decoration. "Delivered before
 * 1 September" and "delivered by 1 September" are different agreements, and a
 * shipment arriving on the deadline second settles differently under each. The
 * `ConditionSpec` says which one was approved; this records which one was
 * applied.
 */
export function applyTemporalOperator(
  observed: Instant,
  reference: Instant,
  operator: TemporalOperator,
): boolean {
  const delta = observed.epochSeconds - reference.epochSeconds;
  switch (operator) {
    case 'BEFORE':
      return delta < 0;
    case 'AT_OR_BEFORE':
      return delta <= 0;
    case 'AFTER':
      return delta > 0;
    case 'AT_OR_AFTER':
      return delta >= 0;
  }
}
