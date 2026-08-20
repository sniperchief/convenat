/**
 * The validation plan: the machine-readable criteria a deterministic validator
 * needs, and which **`ConditionSpec` v1.0 cannot express.**
 *
 * ## The gap this exists to fill, stated plainly
 *
 * `resolutionMethod` has a member called `deterministic_numeric_threshold`,
 * documented as "a number from an approved source compared against a fixed
 * threshold". The schema has nowhere to put that threshold. The only
 * machine-readable criteria in the whole of `ConditionSpec` v1.0 are `deadline`
 * (a normalised instant) and `edgeCases[].outcome`. Everything else — the
 * number, the operator, the expected status string — lives in
 * `successCondition`, which is prose written for a human.
 *
 * So there were three ways to get a threshold, and two of them are unacceptable:
 *
 * 1. **Parse it out of `successCondition` with a regex.** This is inventing
 *    acceptance criteria from prose. It would work on the fixtures and fail on
 *    the first real market phrased slightly differently, and its failure mode is
 *    a confidently wrong number.
 * 2. **Ask a model for it.** Forbidden here, and wrong anyway: it puts a
 *    model-chosen number inside the arithmetic that settles a market, which is
 *    the exact inversion of "AI interprets, code computes".
 * 3. **Take it as an explicit, validated, separately-supplied input.** This
 *    file.
 *
 * A plan is **not** part of the agreement and is **not** hashed. That is a real
 * limitation, not a design win: it means the numeric criteria a market settles
 * on are currently operator-supplied rather than user-approved, and a user
 * approving a `rulesHash` is not approving the threshold. Closing that requires
 * `ConditionSpec` v1.1 carrying the criteria inside the hash. It is recorded in
 * BUILD_STATE as the milestone's headline finding.
 *
 * ## What a plan may not do
 *
 * Because a plan is unhashed, it is constrained to reference the agreement
 * rather than restate it:
 *
 * - Every `sourceId` must name a source the specification approved.
 * - A deadline comparison **must** use `{ kind: 'spec_deadline' }` and may not
 *   use a literal instant. Otherwise an unhashed plan could quietly substitute a
 *   different deadline for the one the user agreed to, which is the single most
 *   valuable thing an attacker could change.
 */

import { z } from 'zod';

import { NUMERIC_OPERATORS, compareDecimal, parseDecimal } from './decimal.js';
import { TEMPORAL_OPERATORS } from './temporal.js';

/**
 * Where a validator reads an observed value.
 *
 * `pointer: null` uses the snapshot's `selection` — the value at the
 * specification's own approved `dataPath`, which is the preferred form because
 * the locator is then part of the hashed agreement. An explicit pointer is
 * available for a second value from the same document, and is resolved against
 * the snapshot's canonical JSON.
 */
export const observationSchema = z
  .object({
    sourceId: z.string().regex(/^source-\d+$/, 'must name an approved source, e.g. source-0'),
    pointer: z.string().trim().min(1).max(500).nullable().default(null),
  })
  .strict();

export type Observation = z.infer<typeof observationSchema>;

const literalSchema = z.string().trim().min(1).max(500);

/** A numeric threshold, equality or inequality against a fixed value. */
const numericComparisonSchema = z
  .object({
    checkId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    kind: z.literal('NUMERIC_COMPARISON'),
    observation: observationSchema,
    operator: z.enum(NUMERIC_OPERATORS),
    /** Exact decimal text. Never a JSON number — see `decimal.ts`. */
    threshold: literalSchema,
    /**
     * Renders the check as `PRICE_ABOVE_THRESHOLD` / `PRICE_BELOW_THRESHOLD`
     * rather than the general `NUMERIC_COMPARISON`, when the quantity is a
     * price. The vocabulary keeps both because a price carries a currency and a
     * quotation convention a bare number does not.
     */
    isPrice: z.boolean().default(false),
  })
  .strict();

/** A numeric range, inclusive at both ends. */
const numericRangeSchema = z
  .object({
    checkId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    kind: z.literal('NUMERIC_RANGE'),
    observation: observationSchema,
    low: literalSchema,
    high: literalSchema,
  })
  .strict();

/**
 * A comparison against an instant.
 *
 * `reference` has no literal variant on purpose: the only instant a check may be
 * measured against is the one inside the hashed specification.
 */
const temporalComparisonSchema = z
  .object({
    checkId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    kind: z.literal('TEMPORAL_COMPARISON'),
    observation: observationSchema,
    operator: z.enum(TEMPORAL_OPERATORS),
    reference: z.literal('spec_deadline'),
  })
  .strict();

/** An exact boolean match. */
const booleanMatchSchema = z
  .object({
    checkId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    kind: z.literal('BOOLEAN_MATCH'),
    observation: observationSchema,
    expected: z.boolean(),
  })
  .strict();

/**
 * An exact categorical match against a closed set of accepted values.
 *
 * `caseSensitive` defaults to **true**. A status field is an identifier, not
 * prose, and deciding that `Delivered` and `delivered` are the same value is an
 * interpretation — one that is usually right and occasionally wrong, which is
 * the worst kind. A specification that means them to be equivalent says so by
 * listing both, or by opting out explicitly.
 */
const categoricalMatchSchema = z
  .object({
    checkId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    kind: z.literal('CATEGORICAL_MATCH'),
    observation: observationSchema,
    accepted: z.array(literalSchema).min(1).max(32),
    caseSensitive: z.boolean().default(true),
  })
  .strict();

export const plannedCheckSchema = z.discriminatedUnion('kind', [
  numericComparisonSchema,
  numericRangeSchema,
  temporalComparisonSchema,
  booleanMatchSchema,
  categoricalMatchSchema,
]);

export type PlannedCheck = z.infer<typeof plannedCheckSchema>;
export type PlannedCheckKind = PlannedCheck['kind'];

export const validationPlanSchema = z
  .object({
    checks: z.array(plannedCheckSchema).min(1).max(32),
    /**
     * Which of the specification's two conditions these checks were written to
     * test.
     *
     * Added in M5.4, because a verdict is not an outcome: `SATISFIED` on checks
     * written against the *failure* condition means `NO`, and a layer that
     * assumed otherwise would invert a settlement silently. The mapping lives in
     * `resolution/outcome.ts`.
     *
     * Defaulted rather than required, so that a plan written before this field
     * existed keeps its meaning — every one of them encodes the success
     * condition. Like the thresholds above, it is **unhashed operator input**
     * and not part of what the user approved; what keeps it honest is that the
     * model reads both condition texts independently and a disagreement produces
     * `NEEDS_REVIEW` rather than an inverted payout.
     */
    encodes: z.enum(['successCondition', 'failureCondition']).default('successCondition'),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const seen = new Map<string, number>();
    plan.checks.forEach((check, index) => {
      const previous = seen.get(check.checkId);
      if (previous !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['checks', index, 'checkId'],
          message: `duplicates the checkId at position ${previous}; a package requires unique check ids`,
        });
        return;
      }
      seen.set(check.checkId, index);
    });

    // An unparseable or inverted range is caught here rather than at evaluation,
    // so it is a configuration error with a field path instead of a check that
    // can never pass for reasons nobody can see.
    plan.checks.forEach((check, index) => {
      if (check.kind !== 'NUMERIC_RANGE') return;

      const low = parseDecimal(check.low);
      const high = parseDecimal(check.high);

      if (low === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['checks', index, 'low'],
          message: 'must be an exact decimal, with no exponent notation',
        });
      }
      if (high === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['checks', index, 'high'],
          message: 'must be an exact decimal, with no exponent notation',
        });
      }
      if (low !== null && high !== null && compareDecimal(low, high) > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['checks', index, 'high'],
          message: `must not be below low (${check.low}); the range would accept nothing`,
        });
      }
    });

    // Same reasoning for a threshold: an unparseable one is a broken plan, not a
    // check that fails at run time against every possible observation.
    plan.checks.forEach((check, index) => {
      if (check.kind !== 'NUMERIC_COMPARISON') return;
      if (parseDecimal(check.threshold) !== null) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['checks', index, 'threshold'],
        message: 'must be an exact decimal, with no exponent notation',
      });
    });
  });

export type ValidationPlan = z.infer<typeof validationPlanSchema>;
export type ValidationPlanInput = z.input<typeof validationPlanSchema>;

/** Parse a plan, returning either the normalised plan or field-anchored issues. */
export function validateValidationPlan(
  input: unknown,
): { readonly ok: true; readonly plan: ValidationPlan } | {
  readonly ok: false;
  readonly issues: ReadonlyArray<{ readonly path: string; readonly message: string }>;
} {
  const result = validationPlanSchema.safeParse(input);
  if (result.success) return { ok: true, plan: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  };
}

/** The approved-source index a `source-N` id refers to, or null. */
export function approvedIndexOf(sourceId: string): number | null {
  const match = /^source-(\d+)$/.exec(sourceId);
  if (match === null) return null;
  const index = Number.parseInt(match[1] ?? '', 10);
  return Number.isSafeInteger(index) ? index : null;
}
