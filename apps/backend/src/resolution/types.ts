/**
 * What the resolution engine returns.
 *
 * Three statuses, drawn from the protocol's `ResolutionStatus` vocabulary, and
 * **none of them is an on-chain action**. This milestone stops at a validated
 * proposal; submitting one is a later, non-AI path.
 *
 * | Status | Meaning | What a caller does |
 * | --- | --- | --- |
 * | `PROPOSED` | A validated, bound, hashed evidence package exists | May be submitted, after whatever review policy the operator applies |
 * | `NEEDS_REVIEW` | The engine will not guess | A person reads the record. Nothing is submitted |
 * | `RESOLUTION_FAILED` | The model provider could not be reached at all | Retry later. Nothing is submitted, and nothing is known |
 *
 * The last two are kept apart because they call for different actions.
 * `NEEDS_REVIEW` means the evidence, the checks and the model produced something
 * a person has to look at; retrying it changes nothing. `RESOLUTION_FAILED`
 * means no resolution was attempted; a person has nothing to read.
 *
 * Neither is a 5xx. A resolver that crashed on ambiguous evidence would be a
 * resolver that cannot say "I do not know", and the whole point of these types
 * is that saying so is a normal, structured, first-class result.
 */

import type {
  Bytes32Hex,
  DeterministicCheck,
  EvidenceClaim,
  EvidencePackageV2,
  EvidenceSource,
  FieldIssue,
  Outcome,
} from '@covenant/shared';

import type { ValidationVerdict } from '../validation/engine.js';
import type { SemanticViolationKind } from './grounding.js';
import type { OutcomeReviewReason } from './outcome.js';

/** Why a resolution attempt ended in review rather than a proposal. */
export type ReviewReason =
  /** The specification does not hash to the rules the market committed. */
  | 'RULES_HASH_MISMATCH'
  /** No approved source produced content. Absence of evidence, not evidence. */
  | 'INSUFFICIENT_EVIDENCE'
  /** The model returned something that is not a valid resolution output. */
  | 'MODEL_OUTPUT_INVALID'
  /** The model's output failed a semantic check — see `violations`. */
  | 'MODEL_OUTPUT_UNGROUNDED'
  /** Confidence fell below the operator's floor for proposing at all. */
  | 'CONFIDENCE_BELOW_FLOOR'
  /** The assembled package did not validate or did not bind to the rules. */
  | 'PACKAGE_INVALID'
  | OutcomeReviewReason;

/** Why a resolution attempt did not happen at all. */
export type FailureReason = 'PROVIDER_TIMEOUT' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_REFUSED';

/**
 * Everything a resolution attempt gathered, whatever its status.
 *
 * Carried on the review and failure results too, deliberately: an operator
 * reading a `NEEDS_REVIEW` needs the checks and the sources in front of them,
 * and making them re-run the retrieval to see what happened would be an
 * invitation to re-run it against a source that has since changed.
 */
export interface ResolutionRecord {
  readonly verdict: ValidationVerdict;
  readonly deterministicChecks: readonly DeterministicCheck[];
  readonly sources: readonly EvidenceSource[];
  /** Deterministic claims always; model claims only once they passed the gate. */
  readonly claims: readonly EvidenceClaim[];
  /** The model that served the request, or null if none was called. */
  readonly model: string | null;
}

export interface ProposedResolution extends ResolutionRecord {
  readonly status: 'PROPOSED';
  readonly outcome: Outcome;
  readonly confidenceBps: number;
  readonly reasoning: string;
  /** The validated package. Its canonical bytes are what `evidenceHash` covers. */
  readonly evidence: EvidencePackageV2;
  readonly canonical: string;
  readonly evidenceHash: Bytes32Hex;
  /** Derived from the specification, never taken from the model or the caller. */
  readonly rulesHash: Bytes32Hex;
  /** Why this outcome follows from the verdict. Written by code, not the model. */
  readonly rationale: string;
}

export interface ReviewRequired extends ResolutionRecord {
  readonly status: 'NEEDS_REVIEW';
  readonly reason: ReviewReason;
  /** One line, safe to log and to show an operator. */
  readonly detail: string;
  /** Field-anchored problems with the model's output, when there were any. */
  readonly issues: readonly FieldIssue[];
  readonly violations: readonly SemanticViolationKind[];
  /** The model's own numbers, when it produced any. Recorded, never acted on. */
  readonly confidenceBps: number | null;
  readonly reasoning: string | null;
}

export interface ResolutionFailed extends ResolutionRecord {
  readonly status: 'RESOLUTION_FAILED';
  readonly reason: FailureReason;
  readonly detail: string;
}

export type ResolutionResult = ProposedResolution | ReviewRequired | ResolutionFailed;
