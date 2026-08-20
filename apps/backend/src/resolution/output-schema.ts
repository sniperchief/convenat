/**
 * The resolver's model output contract.
 *
 * Two representations of one shape, for two jobs — the same split the compiler
 * uses (`compiler/output-schema.ts`), for the same reason:
 *
 * - `resolutionOutputJsonSchema` goes to the provider to constrain generation.
 *   It makes well-formed output *likely*.
 * - `resolutionOutputSchema` (Zod) validates what comes back. It makes malformed
 *   output *impossible to use*.
 *
 * The second is the gate. A provider-side schema is a generation aid: a
 * truncated response, a provider that ignores the constraint, or a model that
 * wraps its JSON in prose all produce output that satisfies nothing.
 *
 * ## What the model is not asked for
 *
 * Not asked for, and rejected if volunteered, because `.strict()` refuses
 * unknown keys rather than stripping them:
 *
 * | Absent | Why |
 * | --- | --- |
 * | `rulesHash` | Derived from the specification by `@covenant/shared`. A model-supplied hash is the exact failure this protocol exists to prevent |
 * | `evidenceHash` | Computed from the assembled package, after this output has been validated |
 * | `settlement`, any amount | The model has no view of money and no reason to name one |
 * | `claimId`, `sourceId` | Identifiers are assigned by the system. A model that invents one can collide with a deterministic claim |
 * | `extraction` | Stamped by the assembler as `MODEL_EXTRACTION`. A model must not be able to label its own reading as a reproducible `JSON_POINTER` |
 * | `deterministicChecks` | Facts handed *to* the model. It explains them; it does not restate or recompute them |
 *
 * Stripping instead of rejecting would hide the misunderstanding until it
 * mattered. A model that returns a `rulesHash` has misunderstood its role, and
 * that is worth failing over.
 *
 * ## The outcome vocabulary
 *
 * `RESOLVED_YES | RESOLVED_NO | NEEDS_REVIEW`, and deliberately not the on-chain
 * `Outcome` enum. Two consequences:
 *
 * 1. `NEEDS_REVIEW` is available to the model as a first-class answer, so
 *    abstaining is a thing it can *say* rather than something inferred from a
 *    low confidence number.
 * 2. `INVALID` is **not** available to it. An `INVALID` proposal routes to
 *    refunds and is a determination the user pre-approved in
 *    `edgeCases[].outcome`, so it can only arrive that way — see `outcome.ts`.
 */

import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);

/** Bounds on what the model may return. Not UI hints — a bound the gate enforces. */
export const RESOLUTION_OUTPUT_LIMITS = {
  reasoningMaxLength: 4000,
  statementMaxLength: 1000,
  valueMaxLength: 500,
  unresolvedReasonMaxLength: 1000,
  /**
   * Kept well under `EVIDENCE_LIMITS_V2.maxClaims` (64) so that model claims
   * plus deterministically-extracted ones cannot overflow the package and turn
   * a verbose model into a validation failure at assembly time.
   */
  maxClaims: 24,
  maxSourceReferences: 8,
} as const;

/** What the model may propose. Never the on-chain `Outcome` enum. */
export const modelOutcomeSchema = z.enum(['RESOLVED_YES', 'RESOLVED_NO', 'NEEDS_REVIEW']);
export type ModelOutcome = z.infer<typeof modelOutcomeSchema>;

/**
 * One assertion the model drew from the evidence.
 *
 * Mirrors the v2.0 claim shape minus the fields the system assigns. The
 * `support`/`value` invariant is duplicated from the package schema on purpose:
 * caught here it is a field-anchored problem with the model's output, caught at
 * assembly it is a hashing failure with no useful path.
 */
export const modelClaimSchema = z
  .object({
    /** Source ids drawn from the evidence block, e.g. `source-0`. */
    sourceIds: z
      .array(z.string().trim().min(1).max(64))
      .min(1, 'every claim must cite at least one source')
      .max(RESOLUTION_OUTPUT_LIMITS.maxSourceReferences),
    statement: text(RESOLUTION_OUTPUT_LIMITS.statementMaxLength),
    valueType: z.enum(['string', 'integer', 'decimal_string', 'boolean', 'timestamp']),
    /** Always text, exactly as the source renders it. Null iff UNSUPPORTED. */
    value: z.string().trim().min(1).max(RESOLUTION_OUTPUT_LIMITS.valueMaxLength).nullable(),
    support: z.enum(['SUPPORTED', 'UNSUPPORTED', 'DISPUTED']),
  })
  .strict()
  .superRefine((claim, ctx) => {
    if (claim.support === 'UNSUPPORTED' && claim.value !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: 'must be null for an UNSUPPORTED claim; no source asserted a value',
      });
    }
    if (claim.support !== 'UNSUPPORTED' && claim.value === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `must carry the value the sources assert when support is ${claim.support}`,
      });
    }
  });

export type ModelClaim = z.infer<typeof modelClaimSchema>;

/**
 * The full model response.
 *
 * `matchedEdgeCase` is an **index into the specification's own `edgeCases`**,
 * never an outcome. The model does the matching, which is prose comparison and
 * genuinely its job; the outcome that index settles to was decided by the user
 * when they approved the rules, and is read out of the specification by code.
 * Asking the model for the outcome instead would let it write a settlement.
 */
export const resolutionOutputSchema = z
  .object({
    outcome: modelOutcomeSchema,
    /** Integer basis points. Audit metadata; it authorises nothing. */
    confidenceBps: z
      .number()
      .int('must be an integer number of basis points')
      .min(0, 'must not be negative')
      .max(10_000, 'must not exceed 10000 basis points'),
    reasoning: text(RESOLUTION_OUTPUT_LIMITS.reasoningMaxLength),
    claims: z.array(modelClaimSchema).max(RESOLUTION_OUTPUT_LIMITS.maxClaims),
    /** Index into `ConditionSpec.edgeCases`, or null when none applies. */
    matchedEdgeCase: z.number().int().min(0).max(19).nullable(),
    /** Required when the model abstains, forbidden otherwise. */
    unresolvedReason: text(RESOLUTION_OUTPUT_LIMITS.unresolvedReasonMaxLength).nullable(),
  })
  .strict()
  .superRefine((output, ctx) => {
    if (output.outcome === 'NEEDS_REVIEW' && output.unresolvedReason === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unresolvedReason'],
        message: 'a NEEDS_REVIEW result must say what it could not establish',
      });
    }
    if (output.outcome !== 'NEEDS_REVIEW' && output.unresolvedReason !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unresolvedReason'],
        message: `must be null when the outcome is ${output.outcome}`,
      });
    }
    if (output.outcome !== 'NEEDS_REVIEW' && output.claims.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['claims'],
        message: 'a resolved outcome must cite the claims it rests on',
      });
    }
  });

export type ResolutionOutput = z.infer<typeof resolutionOutputSchema>;

/**
 * JSON Schema sent to the provider.
 *
 * Written out rather than generated from the Zod schema, for the reason
 * `compiler/output-schema.ts` gives: provider-side schemas support a narrower
 * subset than Zod expresses, so a generated one would either be rejected or
 * silently drop the constraints. The bounds live in the Zod schema, which is
 * where they are actually enforced.
 *
 * How much narrower is not a matter of opinion. **`minimum` and `maximum` are
 * not supported on an integer** — sending them returns
 * `400 output_config.format.schema: For 'integer' type, properties maximum,
 * minimum are not supported`, which is how the first live run of this engine
 * failed on every scenario that reached the provider. The same class of defect
 * as M4's `output_config.format.name` (§29), found the same way, and it is the
 * argument for the live smoke test existing at all: no amount of testing against
 * `FakeLLMProvider` builds a real request, so no unit test can catch a request
 * the provider will not accept.
 *
 * The range of `confidenceBps` is therefore stated in prose, where the model can
 * read it, and enforced in Zod, where it is checked.
 */
export const resolutionOutputJsonSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['outcome', 'confidenceBps', 'reasoning', 'claims', 'matchedEdgeCase', 'unresolvedReason'],
  properties: {
    outcome: {
      type: 'string',
      enum: ['RESOLVED_YES', 'RESOLVED_NO', 'NEEDS_REVIEW'],
      description:
        'RESOLVED_YES if the evidence satisfies the success condition, RESOLVED_NO if it ' +
        'satisfies the failure condition, NEEDS_REVIEW if the approved evidence does not ' +
        'settle it. NEEDS_REVIEW is a correct answer, not a failure.',
    },
    confidenceBps: {
      type: 'integer',
      description:
        'Your confidence in basis points, a whole number from 0 to 10000 (10000 = 100%). ' +
        'This does not settle anything; it is recorded for audit.',
    },
    reasoning: {
      type: 'string',
      description:
        'Why the outcome follows from the claims and the deterministic checks. Refer to ' +
        'sources by their source id. Do not restate arithmetic you were given.',
    },
    claims: {
      type: 'array',
      description: 'The facts you read out of the evidence. Every one must be in the evidence.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sourceIds', 'statement', 'valueType', 'value', 'support'],
        properties: {
          sourceIds: {
            type: 'array',
            description: 'Ids of the evidence sources this claim comes from, e.g. ["source-0"].',
            items: { type: 'string' },
          },
          statement: { type: 'string', description: 'The assertion, in one sentence.' },
          valueType: {
            type: 'string',
            enum: ['string', 'integer', 'decimal_string', 'boolean', 'timestamp'],
          },
          value: {
            anyOf: [{ type: 'null' }, { type: 'string' }],
            description:
              'The value exactly as the source renders it, as text. Null only when support is UNSUPPORTED.',
          },
          support: {
            type: 'string',
            enum: ['SUPPORTED', 'UNSUPPORTED', 'DISPUTED'],
            description:
              'SUPPORTED: the cited sources assert it. UNSUPPORTED: you looked and it is not ' +
              'there. DISPUTED: the cited sources disagree.',
          },
        },
      },
    },
    matchedEdgeCase: {
      anyOf: [{ type: 'null' }, { type: 'integer' }],
      description:
        'Index of the specification edge case whose scenario the evidence matches, or null. ' +
        'You report the match only; the outcome it settles to was fixed when the rules were approved.',
    },
    unresolvedReason: {
      anyOf: [{ type: 'null' }, { type: 'string' }],
      description: 'Required when outcome is NEEDS_REVIEW. Null otherwise.',
    },
  },
};
