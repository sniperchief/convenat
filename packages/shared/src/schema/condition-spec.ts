/**
 * ConditionSpec — the approved, hashed description of a conditional agreement.
 *
 * This document *is* the agreement. Its canonical bytes are hashed into
 * `rulesHash` and committed on-chain before any money is at risk, so anything
 * that could change how the condition settles has to live in here, and nothing
 * in here may be optional-by-absence.
 *
 * Two protocol rules govern the shape:
 *
 * 1. **No optional keys.** Fields that may carry "nothing" are declared
 *    nullable with a `null` default, so the validated document always has the
 *    same key set. An absent key and an explicit null would otherwise produce
 *    different canonical bytes for the same meaning.
 * 2. **Unknown keys are rejected, not stripped.** Silently dropping a field the
 *    caller believed was part of the agreement is exactly the failure mode this
 *    product exists to prevent.
 */

import { z } from 'zod';

import { jcsSerialize } from '../canonical/jcs.js';
import {
  conditionTypeSchema,
  resolutionMethodSchema,
  retrievalKindSchema,
  riskLevelSchema,
  settlementKindSchema,
  outcomeSchema,
} from './enums.js';
import {
  addressSchema,
  bytes32Schema,
  httpsUrlSchema,
  nonNegativeIntSchema,
  positiveIntSchema,
  text,
  timezoneSchema,
  uint256StringSchema,
  utcInstantSchema,
} from './primitives.js';

/** The only specification version this build produces or accepts. */
export const CONDITION_SPEC_VERSION = '1.0';

/** Bounds are protocol limits, not UI hints: they keep a hashed document bounded. */
export const SPEC_LIMITS = {
  questionMaxLength: 500,
  conditionMaxLength: 2000,
  resolutionNoteMaxLength: 1000,
  sourceNameMaxLength: 120,
  minApprovedSources: 1,
  maxApprovedSources: 8,
  minEvidenceRequirements: 1,
  maxEvidenceRequirements: 20,
  maxAmbiguities: 20,
  maxEdgeCases: 20,
  minChallengeWindowSeconds: 60,
  maxChallengeWindowSeconds: 30 * 24 * 60 * 60,
  minResolutionDeadlineSeconds: 60 * 60,
  maxResolutionDeadlineSeconds: 90 * 24 * 60 * 60,
  maxTokenDecimals: 36,
} as const;

/**
 * A source the resolver is permitted to consult.
 *
 * Position in `approvedSources` is precedence: index 0 is primary, later
 * entries are fallbacks in priority order. Precedence is carried by position
 * alone — a separate `role` field would be a second, conflictable source of
 * truth for the same fact.
 */
export const approvedSourceSchema = z
  .object({
    name: text(SPEC_LIMITS.sourceNameMaxLength),
    url: httpsUrlSchema,
    retrievalKind: retrievalKindSchema,
    /** JSON pointer / selector locating the value within the response, or null. */
    dataPath: z.string().trim().min(1).max(500).nullable().default(null),
  })
  .strict();

export type ApprovedSource = z.infer<typeof approvedSourceSchema>;

/** Something the compiler could not pin down, and the reading it committed to. */
export const ambiguitySchema = z
  .object({
    description: text(SPEC_LIMITS.resolutionNoteMaxLength),
    assumption: text(SPEC_LIMITS.resolutionNoteMaxLength),
  })
  .strict();

export type Ambiguity = z.infer<typeof ambiguitySchema>;

/** A named corner case and the outcome it settles to, decided in advance. */
export const edgeCaseSchema = z
  .object({
    scenario: text(SPEC_LIMITS.resolutionNoteMaxLength),
    outcome: outcomeSchema,
  })
  .strict();

export type EdgeCase = z.infer<typeof edgeCaseSchema>;

/**
 * The settlement token, as resolved from the deployment manifest at approval
 * time. It is part of the hashed rules because "paid in which token, at which
 * precision, on which chain" is unambiguously part of the agreement.
 *
 * `address` is data supplied by the caller, never a constant compiled into this
 * package.
 */
export const settlementTokenSchema = z
  .object({
    chainId: positiveIntSchema,
    address: addressSchema,
    symbol: text(16),
    decimals: nonNegativeIntSchema.max(SPEC_LIMITS.maxTokenDecimals),
  })
  .strict();

export type SettlementToken = z.infer<typeof settlementTokenSchema>;

/**
 * Market parameters fixed at approval time.
 *
 * These are hashed alongside the condition text so that the challenge window
 * and bond a user agreed to cannot be altered when the market is created.
 */
export const settlementTermsSchema = z
  .object({
    kind: settlementKindSchema,
    token: settlementTokenSchema,
    /** Last instant a stake is accepted. Must not be after the deadline. */
    tradingEndsAt: utcInstantSchema,
    challengeWindowSeconds: nonNegativeIntSchema
      .min(SPEC_LIMITS.minChallengeWindowSeconds)
      .max(SPEC_LIMITS.maxChallengeWindowSeconds),
    /** Challenge bond in token base units. */
    challengeBondBaseUnits: uint256StringSchema,
    /**
     * Seconds after `deadline` by which a resolution must be proposed. Once it
     * elapses, anyone may cancel the market into full refunds — the liveness
     * guarantee against an absent resolver.
     */
    resolutionDeadlineSeconds: nonNegativeIntSchema
      .min(SPEC_LIMITS.minResolutionDeadlineSeconds)
      .max(SPEC_LIMITS.maxResolutionDeadlineSeconds),
  })
  .strict();

export type SettlementTerms = z.infer<typeof settlementTermsSchema>;

/** The specification object before cross-field checks are applied. */
export const conditionSpecObjectSchema = z
  .object({
    version: z.literal(CONDITION_SPEC_VERSION),
    /**
     * Uniqueness salt fixed when the user approves. Two users approving
     * byte-identical wording must not collide onto one rulesHash.
     */
    nonce: bytes32Schema,
    /** The wallet that approved these rules and will commit them on-chain. */
    creator: addressSchema,

    question: text(SPEC_LIMITS.questionMaxLength),
    conditionType: conditionTypeSchema,
    successCondition: text(SPEC_LIMITS.conditionMaxLength),
    failureCondition: text(SPEC_LIMITS.conditionMaxLength),

    /** The instant the condition is measured against. */
    deadline: utcInstantSchema,
    timezone: timezoneSchema,

    resolutionMethod: resolutionMethodSchema,
    /** Ordered: index 0 is primary, the rest are fallbacks in priority order. */
    approvedSources: z
      .array(approvedSourceSchema)
      .min(SPEC_LIMITS.minApprovedSources, 'at least one approved source is required')
      .max(SPEC_LIMITS.maxApprovedSources),
    /** Unordered set. */
    evidenceRequirements: z
      .array(text(SPEC_LIMITS.resolutionNoteMaxLength))
      .min(SPEC_LIMITS.minEvidenceRequirements, 'at least one evidence requirement is required')
      .max(SPEC_LIMITS.maxEvidenceRequirements),
    /** Unordered set. */
    ambiguities: z.array(ambiguitySchema).max(SPEC_LIMITS.maxAmbiguities),
    /** Unordered set. */
    edgeCases: z.array(edgeCaseSchema).max(SPEC_LIMITS.maxEdgeCases),

    risk: riskLevelSchema,
    settlement: settlementTermsSchema,
  })
  .strict();

function rejectDuplicates(
  values: readonly unknown[],
  field: string,
  ctx: z.RefinementCtx,
): void {
  const seen = new Map<string, number>();
  values.forEach((value, index) => {
    const canonical = jcsSerialize(value);
    const previous = seen.get(canonical);
    if (previous !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field, index],
        message: `duplicates entry ${previous}; unordered sets must not repeat`,
      });
      return;
    }
    seen.set(canonical, index);
  });
}

/**
 * The full ConditionSpec schema, including cross-field consistency checks.
 *
 * Duplicate detection runs here rather than in canonicalisation so that a
 * caller gets a field-anchored validation error instead of a hashing failure.
 */
export const conditionSpecSchema = conditionSpecObjectSchema.superRefine((spec, ctx) => {
  if (Date.parse(spec.settlement.tradingEndsAt) > Date.parse(spec.deadline)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['settlement', 'tradingEndsAt'],
      message: 'trading must end no later than the condition deadline',
    });
  }

  if (spec.successCondition === spec.failureCondition) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['failureCondition'],
      message: 'must describe a different state from the success condition',
    });
  }

  const sourceUrls = new Set<string>();
  spec.approvedSources.forEach((source, index) => {
    if (sourceUrls.has(source.url)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approvedSources', index],
        message: 'duplicates the URL of an earlier approved source',
      });
    }
    sourceUrls.add(source.url);
  });

  rejectDuplicates(spec.evidenceRequirements, 'evidenceRequirements', ctx);
  rejectDuplicates(spec.ambiguities, 'ambiguities', ctx);
  rejectDuplicates(spec.edgeCases, 'edgeCases', ctx);
});

/** Validated, normalised specification. This is what gets canonicalised. */
export type ConditionSpec = z.infer<typeof conditionSpecSchema>;

/** Accepted input shape, before normalisation and defaults are applied. */
export type ConditionSpecInput = z.input<typeof conditionSpecSchema>;
