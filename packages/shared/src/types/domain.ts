/**
 * Domain types that cross application boundaries.
 *
 * These describe records the backend produces and the frontend renders. They
 * are not hashed, so they are plain interfaces rather than schemas — but they
 * are shared so that backend and frontend cannot drift apart on field names or
 * value vocabularies.
 *
 * A note on money: every amount is a base-unit decimal **string**, never a
 * number. JSON numbers cannot carry a uint256, and a silently rounded balance
 * is worse than no balance at all.
 */

import type {
  MarketSide,
  MarketStatus,
  Outcome,
  ResolutionStatus,
} from '../schema/enums.js';
import type { ConditionSpec } from '../schema/condition-spec.js';
import type { EvidencePackage } from '../schema/evidence-package.js';
import type { Bytes32Hex } from '../hashing/keccak.js';

/** A 0x-prefixed lowercase EVM address. */
export type Address = `0x${string}`;
/** A transaction hash. */
export type TxHash = `0x${string}`;

/**
 * Where a displayed value came from.
 *
 * Rendering this next to a balance is a product requirement, not decoration:
 * the chain is authoritative for money, and indexed values can lag it. Anything
 * a user is about to act on should be `chain`.
 */
export type ValueOrigin = 'chain' | 'indexer';

/** A market as the API presents it. */
export interface MarketSummary {
  /** Sequential id assigned by the factory. Decimal string. */
  readonly marketId: string;
  readonly chainId: number;
  readonly address: Address;
  readonly status: MarketStatus;
  readonly question: string;
  readonly rulesHash: Bytes32Hex;
  readonly deadline: string;
  readonly tradingEndsAt: string;
  readonly totalYesBaseUnits: string;
  readonly totalNoBaseUnits: string;
  readonly createdAt: string;
  readonly origin: ValueOrigin;
}

/** A market with its full approved specification attached. */
export interface MarketDetail extends MarketSummary {
  /**
   * The approved specification, or null for a market observed on-chain whose
   * specification this backend has never seen (`UNKNOWN_SPEC`). The chain is
   * authoritative about which markets exist, so such markets are surfaced
   * without a body rather than hidden.
   */
  readonly specification: ConditionSpec | null;
  /** True when `keccak256(canonical(specification))` equals the on-chain hash. */
  readonly rulesHashVerified: boolean;
  readonly resolution: ResolutionProposal | null;
  readonly challenge: ChallengeRecord | null;
  readonly creationTxHash: TxHash | null;
}

/**
 * A resolution the engine produced.
 *
 * `status` and `outcome` are separate on purpose. A `NEEDS_REVIEW` or
 * `RESOLUTION_FAILED` attempt has no outcome and is never submitted on-chain —
 * that is the structured form of "the engine will not guess".
 */
export interface ResolutionProposal {
  readonly marketId: string;
  readonly status: ResolutionStatus;
  readonly outcome: Outcome | null;
  /** Integer basis points. Audit metadata; it never authorises settlement. */
  readonly confidenceBps: number;
  readonly reason: string;
  readonly evidenceHash: Bytes32Hex | null;
  readonly resolverVersion: string;
  readonly round: number;
  readonly proposedAt: string | null;
  readonly challengeEndsAt: string | null;
  readonly finalizedAt: string | null;
  readonly proposalTxHash: TxHash | null;
}

/**
 * Why a resolution attempt ended where it did.
 *
 * Four terminal states, kept apart on purpose. Collapsing them into one
 * "failed" would hide the distinction that matters most to a person reading the
 * result: `INSUFFICIENT_EVIDENCE` means nothing was read, `NEEDS_REVIEW` means
 * something was read and did not settle the question, and `INVALID` means the
 * attempt should never have been made against this market at all.
 *
 * `RESOLUTION_FAILED` is separate again: no resolution was attempted, so there
 * is nothing for a person to read and retrying is the correct response.
 */
export type MarketResolutionStatus =
  | 'RESOLVED'
  | 'NEEDS_REVIEW'
  | 'INSUFFICIENT_EVIDENCE'
  | 'INVALID'
  | 'RESOLUTION_FAILED';

/** One deterministic check, as the API presents it. Mirrors the hashed record. */
export interface ResolutionCheckView {
  readonly checkId: string;
  readonly checkType: string;
  readonly sourceIds: readonly string[];
  readonly expected: string | null;
  readonly observed: string | null;
  readonly result: string;
  readonly explanation: string;
}

/** One evidence source, as the API presents it. */
export interface ResolutionSourceView {
  readonly sourceId: string;
  readonly approvedSourceIndex: number;
  readonly name: string;
  readonly url: string;
  readonly status: string;
  readonly retrievedAt: string | null;
  readonly contentHash: Bytes32Hex | null;
}

/** One claim the resolver drew from the evidence. */
export interface ResolutionClaimView {
  readonly claimId: string;
  readonly statement: string;
  readonly value: string | null;
  readonly support: string;
  readonly sourceIds: readonly string[];
  readonly extractionMethod: string;
  readonly extractionLocator: string | null;
}

/**
 * The full "why", assembled for the resolution panel.
 *
 * This is the product: a reader must be able to walk rules → evidence →
 * deterministic checks → AI reasoning → proposed outcome → on-chain
 * finalization without trusting any single step. Every field below is either
 * inside `evidenceHash` or is explicitly labelled as operational metadata that
 * is not.
 */
export interface ResolutionDetail {
  readonly marketId: string;
  readonly rulesHash: Bytes32Hex;
  readonly status: MarketResolutionStatus;
  /** Machine-readable reason. `null` only when the status is `RESOLVED`. */
  readonly reason: string | null;
  /** One line, safe to show. Never carries infrastructure detail. */
  readonly detail: string;
  readonly outcome: Outcome | null;
  readonly confidenceBps: number;
  /** The model's reasoning, verbatim. Inside `evidenceHash` when one exists. */
  readonly reasoning: string | null;
  /** Written by code, not the model: why this outcome follows from the checks. */
  readonly rationale: string | null;
  /** `SATISFIED | REFUTED | NEEDS_REVIEW` — the deterministic layer's verdict. */
  readonly verdict: string | null;
  readonly deterministicChecks: readonly ResolutionCheckView[];
  readonly sources: readonly ResolutionSourceView[];
  readonly claims: readonly ResolutionClaimView[];
  readonly evidenceHash: Bytes32Hex | null;
  readonly resolverVersion: string;
  /** The model that served the request. Operational metadata. */
  readonly model: string | null;
  readonly round: number;
  readonly resolvedAt: string;
  /** Present once the proposal has been submitted and confirmed on-chain. */
  readonly proposalTxHash: TxHash | null;
  readonly proposalBlockNumber: string | null;
  readonly submissionState: 'NOT_SUBMITTED' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED';
}

/** A filed challenge against a proposed resolution. */
export interface ChallengeRecord {
  readonly marketId: string;
  readonly challenger: Address;
  /** keccak256 of the challenge document, committed on-chain. */
  readonly reasonHash: Bytes32Hex;
  /** The off-chain challenge text, if this backend holds it. */
  readonly reason: string | null;
  readonly bondBaseUnits: string;
  readonly challengedAt: string;
  readonly txHash: TxHash | null;
  /** Null while the review is outstanding. */
  readonly bondRefunded: boolean | null;
}

/** A user's stake on one side of one market. */
export interface Position {
  readonly marketId: string;
  readonly wallet: Address;
  readonly side: MarketSide;
  readonly amountBaseUnits: string;
  readonly claimed: boolean;
  readonly origin: ValueOrigin;
}

/** An evidence package as served, paired with the hash committed on-chain. */
export interface EvidenceRecord {
  readonly marketId: string;
  readonly evidenceHash: Bytes32Hex;
  readonly package: EvidencePackage;
  /** True when the served package re-hashes to the on-chain commitment. */
  readonly verified: boolean;
}
