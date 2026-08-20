/**
 * Closed vocabularies shared by the specification, the evidence package and the
 * application layers.
 *
 * Every one of these is intentionally a closed set. An LLM that invents a new
 * `resolutionMethod` or a new `outcome` must fail validation loudly rather than
 * widen the protocol at runtime.
 */

import { z } from 'zod';

/**
 * Settlement shape of a condition.
 *
 * `binary` is the only type the MVP settles. The enum exists so that later
 * settlement adapters (scalar payouts, multi-outcome) are a schema version bump
 * rather than a redesign.
 */
export const conditionTypeSchema = z.enum(['binary']);
export type ConditionType = z.infer<typeof conditionTypeSchema>;

/** How the resolver is expected to decide the condition. */
export const resolutionMethodSchema = z.enum([
  /** A number from an approved source compared against a fixed threshold. Fully deterministic. */
  'deterministic_numeric_threshold',
  /** A dated event either did or did not occur by the deadline, per an approved source. */
  'deterministic_event_occurrence',
  /** An approved source publishes an explicit status field that maps onto the outcome. */
  'source_attested_status',
  /** Evidence requires reading and judgement; AI interpretation is genuinely needed. */
  'ai_evidence_interpretation',
]);
export type ResolutionMethod = z.infer<typeof resolutionMethodSchema>;

/** How evidence is pulled from a source. */
export const retrievalKindSchema = z.enum(['http_json', 'http_html', 'manual_attestation']);
export type RetrievalKind = z.infer<typeof retrievalKindSchema>;

/**
 * Whether a retrieval produced usable bytes.
 *
 * This is the *protocol-level* result of reading a source, deliberately not the
 * transport-level one. An HTTP status code, a content type and a latency are
 * facts about one request over one protocol; `UNAVAILABLE` is a fact about the
 * evidence. Recording the former inside a hashed document would make the digest
 * depend on infrastructure detail that carries no meaning for the outcome — and
 * an evidence package that hashes differently because a CDN changed a header is
 * a tamper alarm that cries wolf.
 *
 * `NOT_ATTEMPTED` is the honest record of an approved fallback that was never
 * needed because a higher-precedence source answered.
 */
export const retrievalStatusSchema = z.enum([
  /** Bytes were retrieved and are hashed in `contentHash`. */
  'RETRIEVED',
  /** The source could not be read at all within the resolution window. */
  'UNAVAILABLE',
  /** The source answered, but the response could not be parsed as its declared kind. */
  'MALFORMED',
  /** The source was approved but never read — typically an unused fallback. */
  'NOT_ATTEMPTED',
]);
export type RetrievalStatus = z.infer<typeof retrievalStatusSchema>;

/** How a claim's value should be read. Never a float. */
export const claimValueTypeSchema = z.enum([
  'string',
  'integer',
  'decimal_string',
  'boolean',
  'timestamp',
]);
export type ClaimValueType = z.infer<typeof claimValueTypeSchema>;

/**
 * Whether the cited sources actually carry the claim.
 *
 * `UNSUPPORTED` is the load-bearing member: it records a fact the resolver went
 * looking for and did not find. Without it, an absent fact is indistinguishable
 * from a fact nobody thought to check, and "we could not establish this" is
 * exactly the kind of thing a resolution needs to state rather than omit.
 */
export const claimSupportSchema = z.enum([
  /** Every cited source asserts this value. */
  'SUPPORTED',
  /** No cited source asserts it. `value` must be null. */
  'UNSUPPORTED',
  /** The cited sources disagree; `value` is the reading the resolver took. */
  'DISPUTED',
]);
export type ClaimSupport = z.infer<typeof claimSupportSchema>;

/**
 * How a claim's value was lifted out of a source's bytes.
 *
 * The point of this field is to make the *non*-deterministic case visible.
 * `JSON_POINTER`, `CSS_SELECTOR` and `REGEX` name a locator, so a third party
 * holding the same bytes can re-extract the same value and check it.
 * `MODEL_EXTRACTION` cannot be re-run that way, and labelling it plainly is what
 * lets an auditor see exactly which claims rest on a model's reading.
 */
export const extractionMethodSchema = z.enum([
  'JSON_POINTER',
  'CSS_SELECTOR',
  'REGEX',
  /** A language model read the content. Not reproducible; declared as such. */
  'MODEL_EXTRACTION',
  /** A human or counterparty attested to the value. */
  'MANUAL_ATTESTATION',
  /** Nothing was extracted — the claim records an absence. */
  'NONE',
]);
export type ExtractionMethod = z.infer<typeof extractionMethodSchema>;

/**
 * The deterministic validators this build can run.
 *
 * Closed, like every other vocabulary here: a resolver that invents a check type
 * must fail validation rather than widen the protocol at runtime. The *record*
 * shape (`expected`, `observed`, `result`) is generic enough for any future
 * validator; only the vocabulary is fixed, and adding a member is a schema
 * version bump.
 *
 * `PRICE_ABOVE_THRESHOLD` and `PRICE_BELOW_THRESHOLD` are kept alongside the
 * general `NUMERIC_COMPARISON` rather than folded into it, because a price
 * comparison carries a currency and a quotation convention that a bare number
 * does not, and an auditor should be able to see which was meant.
 */
export const deterministicCheckTypeSchema = z.enum([
  'NUMERIC_COMPARISON',
  'PRICE_ABOVE_THRESHOLD',
  'PRICE_BELOW_THRESHOLD',
  'DATE_BEFORE_DEADLINE',
  'DATE_AFTER_DEADLINE',
  'BOOLEAN_MATCH',
  'STRING_MATCH',
  'SOURCE_AVAILABLE',
]);
export type DeterministicCheckType = z.infer<typeof deterministicCheckTypeSchema>;

/**
 * The outcome of one deterministic check.
 *
 * `INDETERMINATE` exists because "the check could not run" is neither a pass nor
 * a failure, and a boolean would force it to be recorded as one of the two. The
 * same reasoning that keeps `NEEDS_REVIEW` out of the on-chain outcome enum
 * applies here: a system that cannot say "I do not know" will say something
 * false instead.
 */
export const deterministicCheckResultSchema = z.enum(['PASS', 'FAIL', 'INDETERMINATE']);
export type DeterministicCheckResult = z.infer<typeof deterministicCheckResultSchema>;

/** Compiler's assessment of how likely this condition is to resolve cleanly. */
export const riskLevelSchema = z.enum(['low', 'medium', 'high']);
export type RiskLevel = z.infer<typeof riskLevelSchema>;

/**
 * A settled outcome.
 *
 * `INVALID` routes to the refund path. There is no `UNRESOLVED` member: an
 * unresolved condition must leave the contract untouched, so it is represented
 * by a resolver *status*, never by an outcome.
 */
export const outcomeSchema = z.enum(['YES', 'NO', 'INVALID']);
export type Outcome = z.infer<typeof outcomeSchema>;

/**
 * Terminal state of a resolution attempt, off-chain only.
 *
 * `NEEDS_REVIEW` and `RESOLUTION_FAILED` never reach the chain — they are the
 * structured way the engine says "I will not guess".
 */
export const resolutionStatusSchema = z.enum(['PROPOSED', 'NEEDS_REVIEW', 'RESOLUTION_FAILED']);
export type ResolutionStatus = z.infer<typeof resolutionStatusSchema>;

/** How a settlement pool is divided. */
export const settlementKindSchema = z.enum(['binary_parimutuel']);
export type SettlementKind = z.infer<typeof settlementKindSchema>;

/**
 * Lifecycle position of a market.
 *
 * `DRAFT`, `PENDING_ONCHAIN` and `UNKNOWN_SPEC` exist only off-chain:
 * a specification approved but not yet committed by the user's wallet, and a
 * market observed on-chain whose specification the backend has never seen.
 * The remainder mirror the on-chain state machine exactly.
 */
export const marketStatusSchema = z.enum([
  'DRAFT',
  'PENDING_ONCHAIN',
  'OPEN',
  'CLOSED',
  'RESOLUTION_PROPOSED',
  'CHALLENGED',
  'FINALIZED',
  'SETTLED',
  'CANCELLED',
  'UNKNOWN_SPEC',
]);
export type MarketStatus = z.infer<typeof marketStatusSchema>;

/** Which side of a binary condition a stake backs. */
export const marketSideSchema = z.enum(['YES', 'NO']);
export type MarketSide = z.infer<typeof marketSideSchema>;
