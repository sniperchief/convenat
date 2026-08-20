/**
 * Exact decimal comparison. **No floating point, anywhere on this path.**
 *
 * A threshold comparison is the arithmetic a market settles on, so it gets the
 * same treatment as a token amount: text in, `BigInt` in the middle, a verdict
 * out. `Number` never touches a value being compared.
 *
 * Why this is not paranoia. `121340.10 > 121340.1` is `false` in IEEE-754 only
 * by luck of representation, `0.1 + 0.2 !== 0.3`, and `parseFloat("1e999")` is
 * `Infinity`. Any of those decides a market wrongly, silently, and only for some
 * inputs — the worst failure shape there is. The protocol already bans floats
 * from every hashed document (ADR-0003); this extends the same ban to the
 * comparison that produces the check.
 *
 * ## Representation
 *
 * A decimal is `sign × digits / 10^scale`, with `digits` a `BigInt`. Comparison
 * rescales both operands to a common scale and compares integers, so
 * `1.50` and `1.5` compare equal while remaining textually distinguishable —
 * which matters, because `observed` in a `DeterministicCheck` records what the
 * source actually said, not a re-rendered form of it.
 *
 * ## Accepted syntax
 *
 * ```
 * -?  (0 | [1-9][0-9]*)  ( . [0-9]+ )?
 * ```
 *
 * Deliberately narrower than JSON's number grammar, and the exclusions are the
 * point:
 *
 * - **No exponent notation.** `1e3` is refused rather than parsed. It is
 *   ambiguous to a human reading an evidence package, and the retrieval layer
 *   already refuses floats in JSON payloads, so a real price arrives either as an
 *   integer or as a decimal *string* — never as `1.2134e5`.
 * - **No leading `+`, no leading zeros, no bare `.5`, no thousands separators,
 *   no currency symbols.** Each would be a small act of interpretation, and
 *   interpretation is the thing this layer exists to avoid.
 * - **No `Infinity`, no `NaN`.**
 *
 * Anything outside the grammar is a `VALIDATION_ERROR`, never a guess.
 */

/** An exact decimal: `(negative ? -1 : 1) × digits / 10^scale`. */
export interface Decimal {
  readonly negative: boolean;
  /** Unscaled magnitude. Always non-negative. */
  readonly digits: bigint;
  /** Number of decimal places. */
  readonly scale: number;
  /** The text this was parsed from, preserved verbatim for `observed`. */
  readonly text: string;
}

const DECIMAL_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

/**
 * How many digits a decimal may carry.
 *
 * Bounded because `BigInt` is not: a source returning a megabyte of digits would
 * otherwise turn a comparison into an unbounded computation, which is a denial
 * of service wearing the costume of a very precise number.
 */
export const MAX_DECIMAL_DIGITS = 64;

/** Parse an exact decimal, or return null if the text is not one. */
export function parseDecimal(text: string): Decimal | null {
  const trimmed = text.trim();
  if (!DECIMAL_PATTERN.test(trimmed)) return null;

  const negative = trimmed.startsWith('-');
  const magnitude = negative ? trimmed.slice(1) : trimmed;
  const [whole = '', fraction = ''] = magnitude.split('.');

  if (whole.length + fraction.length > MAX_DECIMAL_DIGITS) return null;

  const digits = BigInt(`${whole}${fraction}`);

  // `-0` and `0` are one value. Normalising the sign here keeps `compareDecimal`
  // from having to special-case it, and stops `-0 < 0` from ever being true.
  return {
    negative: negative && digits !== 0n,
    digits,
    scale: fraction.length,
    text: trimmed,
  };
}

/** Signed magnitude, rescaled to `scale` decimal places. */
function scaled(value: Decimal, scale: number): bigint {
  const lifted = value.digits * 10n ** BigInt(scale - value.scale);
  return value.negative ? -lifted : lifted;
}

/**
 * Compare two decimals exactly.
 *
 * @returns negative if `a < b`, zero if equal, positive if `a > b`.
 */
export function compareDecimal(a: Decimal, b: Decimal): number {
  const scale = Math.max(a.scale, b.scale);
  const left = scaled(a, scale);
  const right = scaled(b, scale);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** The comparison operators a numeric check may perform. */
export const NUMERIC_OPERATORS = [
  'GREATER_THAN',
  'GREATER_THAN_OR_EQUAL',
  'LESS_THAN',
  'LESS_THAN_OR_EQUAL',
  'EQUAL',
  'NOT_EQUAL',
] as const;

export type NumericOperator = (typeof NUMERIC_OPERATORS)[number];

/** The mathematical symbol for an operator, for rendering `expected`. */
export const OPERATOR_SYMBOL: Readonly<Record<NumericOperator, string>> = {
  GREATER_THAN: '>',
  GREATER_THAN_OR_EQUAL: '>=',
  LESS_THAN: '<',
  LESS_THAN_OR_EQUAL: '<=',
  EQUAL: '==',
  NOT_EQUAL: '!=',
};

/**
 * Apply an operator to a comparison result.
 *
 * Split from `compareDecimal` so the boundary behaviour is stated in one place
 * and can be read without tracing arithmetic: at exactly the threshold,
 * `GREATER_THAN` is false and `GREATER_THAN_OR_EQUAL` is true. That distinction
 * is the whole reason both exist, and it is the single most likely place for a
 * market to be decided wrongly, so the tests walk it at
 * `threshold − 1`, `threshold`, `threshold + 1`.
 */
export function applyNumericOperator(comparison: number, operator: NumericOperator): boolean {
  switch (operator) {
    case 'GREATER_THAN':
      return comparison > 0;
    case 'GREATER_THAN_OR_EQUAL':
      return comparison >= 0;
    case 'LESS_THAN':
      return comparison < 0;
    case 'LESS_THAN_OR_EQUAL':
      return comparison <= 0;
    case 'EQUAL':
      return comparison === 0;
    case 'NOT_EQUAL':
      return comparison !== 0;
  }
}

/** True when `value` lies within `[low, high]`, inclusive at both ends. */
export function withinInclusiveRange(value: Decimal, low: Decimal, high: Decimal): boolean {
  return compareDecimal(value, low) >= 0 && compareDecimal(value, high) <= 0;
}
