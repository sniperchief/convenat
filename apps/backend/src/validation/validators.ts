/**
 * The deterministic validators.
 *
 * ## The division of labour this milestone exists to enforce
 *
 * A language model should read a page and say *what it says*. It should not be
 * the thing that decides whether `121340 > 120000`. Arithmetic and logical
 * comparison are what code is reliable at and what models are unreliable at, and
 * the failure is silent: a model asked to compare two numbers is right almost
 * every time, which is exactly why nobody notices the time it is not.
 *
 * So every validator here is:
 *
 * - **Pure.** Same inputs, same output, forever. No clock, no network, no model,
 *   no randomness. A challenge re-running these against the same evidence must
 *   reach the same verdict, or the challenge window means nothing.
 * - **Exact.** No floating point on any comparison path (`decimal.ts`), and no
 *   locally-interpreted timestamps (`temporal.ts`).
 * - **Refusing.** A value it cannot parse is `VALIDATION_ERROR`, never a guess
 *   and never a `false`. "The number was unreadable" and "the number was below
 *   the threshold" are different facts and settle differently.
 *
 * ## Three outcomes, and why the third is not a failure
 *
 * | Outcome | Meaning |
 * | --- | --- |
 * | `CHECK` | The validator ran and produced a `DeterministicCheck` |
 * | `NOT_APPLICABLE` | This validator has nothing to say about this plan entry. Produces no check at all |
 * | `VALIDATION_ERROR` | The validator applies but could not run — an unparseable value, a missing observation. Produces an `INDETERMINATE` check |
 *
 * `NOT_APPLICABLE` emitting *nothing* and `VALIDATION_ERROR` emitting an
 * `INDETERMINATE` check is the important distinction. A check that could not run
 * is evidence about the resolution and belongs in the package; a validator that
 * was never relevant is not, and recording it would pad the evidence with
 * non-events.
 */

import type { DeterministicCheck, DeterministicCheckType } from '@covenant/shared';

import {
  OPERATOR_SYMBOL,
  applyNumericOperator,
  compareDecimal,
  parseDecimal,
  withinInclusiveRange,
} from './decimal.js';
import { TEMPORAL_SYMBOL, applyTemporalOperator, parseInstant, type Instant } from './temporal.js';
import type { PlannedCheck } from './plan.js';

/** A value read from one source, ready to validate. */
export interface ObservedValue {
  readonly sourceId: string;
  /** Precedence position of the approved source it came from. Lower is higher. */
  readonly approvedSourceIndex: number;
  /**
   * The observation as text.
   *
   * Always text, whatever the source's JSON type was: the protocol carries every
   * value as a string so that no float and no locale-dependent rendering can
   * enter a hashed document.
   */
  readonly text: string;
}

export type ValidatorOutcome =
  | { readonly kind: 'CHECK'; readonly check: DeterministicCheck }
  | { readonly kind: 'NOT_APPLICABLE'; readonly reason: string }
  | { readonly kind: 'VALIDATION_ERROR'; readonly check: DeterministicCheck; readonly reason: string };

/**
 * A deterministic validator.
 *
 * Generic over the planned check it consumes and the observation it reads, which
 * is the `Validator<TCondition, TEvidence>` shape the milestone asked for with
 * the condition side narrowed: a validator never sees the whole `ConditionSpec`,
 * only the criterion drawn from it plus the reference values the engine resolved
 * from it. Handing each validator the entire specification would let one of them
 * quietly start reading a field nobody expects it to.
 */
export interface Validator<TPlanned extends PlannedCheck = PlannedCheck> {
  readonly name: string;
  /** True when this validator handles that planned check. */
  readonly handles: (planned: PlannedCheck) => planned is TPlanned;
  readonly run: (input: ValidatorInput<TPlanned>) => ValidatorOutcome;
}

export interface ValidatorInput<TPlanned extends PlannedCheck = PlannedCheck> {
  readonly planned: TPlanned;
  /** Null when no approved source produced a value for this observation. */
  readonly observed: ObservedValue | null;
  /** The specification's own deadline, already normalised. */
  readonly specDeadline: Instant;
  /** Every source consulted for this check, for the check's `sourceIds`. */
  readonly sourceIds: readonly string[];
}

/** Build a `DeterministicCheck` in the frozen v2.0 shape. */
function check(
  planned: PlannedCheck,
  checkType: DeterministicCheckType,
  fields: {
    readonly sourceIds: readonly string[];
    readonly expected: string;
    readonly observed: string | null;
    readonly result: 'PASS' | 'FAIL' | 'INDETERMINATE';
    readonly explanation: string | null;
  },
): DeterministicCheck {
  return {
    checkId: planned.checkId,
    checkType,
    sourceIds: [...fields.sourceIds],
    expected: fields.expected,
    observed: fields.observed,
    result: fields.result,
    explanation: fields.explanation,
  };
}

/**
 * The check a validator emits when it applies but cannot run.
 *
 * `INDETERMINATE` with a null `observed`, which the v2.0 schema requires to go
 * together — "nothing was observed" has one encoding.
 */
function indeterminate(
  planned: PlannedCheck,
  checkType: DeterministicCheckType,
  sourceIds: readonly string[],
  expected: string,
  reason: string,
): ValidatorOutcome {
  return {
    kind: 'VALIDATION_ERROR',
    reason,
    check: check(planned, checkType, {
      sourceIds,
      expected,
      observed: null,
      result: 'INDETERMINATE',
      explanation: reason,
    }),
  };
}

const verdict = (passed: boolean): 'PASS' | 'FAIL' => (passed ? 'PASS' : 'FAIL');

// ---------------------------------------------------------------------------
// Numeric comparison — threshold and equality
// ---------------------------------------------------------------------------

export const numericComparisonValidator: Validator = {
  name: 'numeric-comparison',
  handles: (planned): planned is PlannedCheck => planned.kind === 'NUMERIC_COMPARISON',
  run: (input) => {
    if (input.planned.kind !== 'NUMERIC_COMPARISON') {
      return { kind: 'NOT_APPLICABLE', reason: 'not a numeric comparison' };
    }
    const { planned } = input;

    // A price comparison is rendered under its own check type, because a price
    // carries a currency and a quotation convention a bare number does not.
    const checkType: DeterministicCheckType = planned.isPrice
      ? planned.operator === 'GREATER_THAN' || planned.operator === 'GREATER_THAN_OR_EQUAL'
        ? 'PRICE_ABOVE_THRESHOLD'
        : 'PRICE_BELOW_THRESHOLD'
      : 'NUMERIC_COMPARISON';

    const expected = `observed ${OPERATOR_SYMBOL[planned.operator]} ${planned.threshold}`;

    if (input.observed === null) {
      return indeterminate(
        planned,
        checkType,
        input.sourceIds,
        expected,
        'no approved source produced a value for this observation',
      );
    }

    const threshold = parseDecimal(planned.threshold);
    if (threshold === null) {
      return indeterminate(
        planned,
        checkType,
        input.sourceIds,
        expected,
        `the planned threshold ${planned.threshold} is not an exact decimal`,
      );
    }

    const observed = parseDecimal(input.observed.text);
    if (observed === null) {
      // Emphatically not a FAIL. "Unreadable" and "below the threshold" are
      // different facts about the world and settle differently.
      return indeterminate(
        planned,
        checkType,
        input.sourceIds,
        expected,
        `the observed value is not an exact decimal (exponent notation, symbols and separators are refused rather than interpreted)`,
      );
    }

    const passed = applyNumericOperator(compareDecimal(observed, threshold), planned.operator);

    return {
      kind: 'CHECK',
      check: check(planned, checkType, {
        sourceIds: input.sourceIds,
        expected,
        observed: observed.text,
        result: verdict(passed),
        explanation: `exact decimal comparison, ${planned.operator}`,
      }),
    };
  },
};

// ---------------------------------------------------------------------------
// Numeric range — inclusive at both ends
// ---------------------------------------------------------------------------

export const numericRangeValidator: Validator = {
  name: 'numeric-range',
  handles: (planned): planned is PlannedCheck => planned.kind === 'NUMERIC_RANGE',
  run: (input) => {
    if (input.planned.kind !== 'NUMERIC_RANGE') {
      return { kind: 'NOT_APPLICABLE', reason: 'not a numeric range' };
    }
    const { planned } = input;
    const expected = `${planned.low} <= observed <= ${planned.high}`;

    if (input.observed === null) {
      return indeterminate(
        planned,
        'NUMERIC_COMPARISON',
        input.sourceIds,
        expected,
        'no approved source produced a value for this observation',
      );
    }

    const low = parseDecimal(planned.low);
    const high = parseDecimal(planned.high);
    const observed = parseDecimal(input.observed.text);

    if (low === null || high === null) {
      return indeterminate(
        planned,
        'NUMERIC_COMPARISON',
        input.sourceIds,
        expected,
        'the planned range bounds are not exact decimals',
      );
    }
    if (observed === null) {
      return indeterminate(
        planned,
        'NUMERIC_COMPARISON',
        input.sourceIds,
        expected,
        'the observed value is not an exact decimal',
      );
    }

    return {
      kind: 'CHECK',
      check: check(planned, 'NUMERIC_COMPARISON', {
        sourceIds: input.sourceIds,
        expected,
        observed: observed.text,
        result: verdict(withinInclusiveRange(observed, low, high)),
        explanation: 'exact decimal range, inclusive at both ends',
      }),
    };
  },
};

// ---------------------------------------------------------------------------
// Temporal comparison — always against the specification's own deadline
// ---------------------------------------------------------------------------

export const temporalComparisonValidator: Validator = {
  name: 'temporal-comparison',
  handles: (planned): planned is PlannedCheck => planned.kind === 'TEMPORAL_COMPARISON',
  run: (input) => {
    if (input.planned.kind !== 'TEMPORAL_COMPARISON') {
      return { kind: 'NOT_APPLICABLE', reason: 'not a temporal comparison' };
    }
    const { planned } = input;

    const before = planned.operator === 'BEFORE' || planned.operator === 'AT_OR_BEFORE';
    const checkType: DeterministicCheckType = before
      ? 'DATE_BEFORE_DEADLINE'
      : 'DATE_AFTER_DEADLINE';

    // The reference is the specification's deadline and can be nothing else —
    // the plan schema has no literal-instant variant, so an unhashed plan cannot
    // substitute a deadline the user never approved.
    const expected = `observed ${TEMPORAL_SYMBOL[planned.operator]} ${input.specDeadline.normalized}`;

    if (input.observed === null) {
      return indeterminate(
        planned,
        checkType,
        input.sourceIds,
        expected,
        'no approved source produced a timestamp for this observation',
      );
    }

    const observed = parseInstant(input.observed.text);
    if (observed === null) {
      return indeterminate(
        planned,
        checkType,
        input.sourceIds,
        expected,
        'the observed timestamp is not RFC 3339 with an explicit offset; a local date-time is refused rather than assumed to be UTC',
      );
    }

    const passed = applyTemporalOperator(observed, input.specDeadline, planned.operator);

    return {
      kind: 'CHECK',
      check: check(planned, checkType, {
        sourceIds: input.sourceIds,
        expected,
        observed: observed.normalized,
        result: verdict(passed),
        explanation: `UTC comparison at whole-second resolution, ${planned.operator}`,
      }),
    };
  },
};

// ---------------------------------------------------------------------------
// Boolean
// ---------------------------------------------------------------------------

/**
 * Accepted spellings of a boolean.
 *
 * Deliberately short. `1`/`0` are **not** here: a source returning `1` may mean
 * true, or may mean a count of one, and deciding which is an interpretation.
 * `yes`/`no` are included because they are unambiguous in a boolean field and
 * common in real APIs.
 */
const BOOLEAN_TRUE: ReadonlySet<string> = new Set(['true', 'yes']);
const BOOLEAN_FALSE: ReadonlySet<string> = new Set(['false', 'no']);

export const booleanMatchValidator: Validator = {
  name: 'boolean-match',
  handles: (planned): planned is PlannedCheck => planned.kind === 'BOOLEAN_MATCH',
  run: (input) => {
    if (input.planned.kind !== 'BOOLEAN_MATCH') {
      return { kind: 'NOT_APPLICABLE', reason: 'not a boolean match' };
    }
    const { planned } = input;
    const expected = `observed == ${String(planned.expected)}`;

    if (input.observed === null) {
      return indeterminate(
        planned,
        'BOOLEAN_MATCH',
        input.sourceIds,
        expected,
        'no approved source produced a value for this observation',
      );
    }

    const text = input.observed.text.trim().toLowerCase();
    const isTrue = BOOLEAN_TRUE.has(text);
    const isFalse = BOOLEAN_FALSE.has(text);

    if (!isTrue && !isFalse) {
      return indeterminate(
        planned,
        'BOOLEAN_MATCH',
        input.sourceIds,
        expected,
        `the observed value is not a boolean (accepted: ${[...BOOLEAN_TRUE, ...BOOLEAN_FALSE].join(', ')}; 1 and 0 are refused as ambiguous)`,
      );
    }

    return {
      kind: 'CHECK',
      check: check(planned, 'BOOLEAN_MATCH', {
        sourceIds: input.sourceIds,
        expected,
        observed: String(isTrue),
        result: verdict(isTrue === planned.expected),
        explanation: 'boolean equality',
      }),
    };
  },
};

// ---------------------------------------------------------------------------
// Exact categorical match
// ---------------------------------------------------------------------------

export const categoricalMatchValidator: Validator = {
  name: 'categorical-match',
  handles: (planned): planned is PlannedCheck => planned.kind === 'CATEGORICAL_MATCH',
  run: (input) => {
    if (input.planned.kind !== 'CATEGORICAL_MATCH') {
      return { kind: 'NOT_APPLICABLE', reason: 'not a categorical match' };
    }
    const { planned } = input;
    const expected = `observed in [${planned.accepted.join(', ')}]${
      planned.caseSensitive ? '' : ' (case-insensitive)'
    }`;

    if (input.observed === null) {
      return indeterminate(
        planned,
        'STRING_MATCH',
        input.sourceIds,
        expected,
        'no approved source produced a value for this observation',
      );
    }

    const observed = input.observed.text.trim();
    const fold = (value: string): string =>
      planned.caseSensitive ? value : value.toLowerCase();
    const matched = planned.accepted.some((accepted) => fold(accepted) === fold(observed));

    return {
      kind: 'CHECK',
      check: check(planned, 'STRING_MATCH', {
        sourceIds: input.sourceIds,
        expected,
        observed,
        result: verdict(matched),
        explanation: planned.caseSensitive
          ? 'exact match against the accepted set'
          : 'case-insensitive match against the accepted set',
      }),
    };
  },
};

/** Every validator this build can run, in a fixed order. */
export const DEFAULT_VALIDATORS: readonly Validator[] = [
  numericComparisonValidator,
  numericRangeValidator,
  temporalComparisonValidator,
  booleanMatchValidator,
  categoricalMatchValidator,
];
