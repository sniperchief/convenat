/**
 * Typed API contracts.
 *
 * Request and response shapes for the endpoints the backend will expose in
 * Milestone 3, declared here so that backend handlers and frontend callers are
 * type-checked against one definition. No endpoint is implemented in this
 * milestone; these are the contracts those implementations must satisfy.
 */

import type { ApiError, FieldIssue } from '../errors.js';
import type { ConditionSpec, ConditionSpecInput } from '../schema/condition-spec.js';
import type { Bytes32Hex } from '../hashing/keccak.js';
import type {
  ChallengeRecord,
  EvidenceRecord,
  MarketDetail,
  MarketSummary,
  Position,
  ResolutionProposal,
} from './domain.js';
import type { MarketStatus } from '../schema/enums.js';

// `ApiError` and `FieldIssue` are defined in ../errors.js and re-exported from
// the package root there. They are imported, not re-exported, so the barrel has
// exactly one export site per name.

/** Every successful response body is wrapped, so clients branch on one field. */
export interface ApiSuccess<T> {
  readonly data: T;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export function isApiError<T>(response: ApiResponse<T>): response is ApiError {
  return 'error' in response;
}

// --- POST /api/markets/compile ---------------------------------------------

/**
 * A question the compiler needs answered before it can produce enforceable
 * rules. Carrying the question separately from the field path is what lets the
 * UI ask a person something readable instead of showing a validation error.
 */
export interface CompilerQuestion {
  /** Field path this question would fill, e.g. `deadline`. */
  readonly field: string;
  /** The question, phrased for the user. */
  readonly question: string;
  /** Why it cannot be resolved without an answer. */
  readonly why: string;
}

export interface CompileMarketRequest {
  /** The user's natural-language condition or clarification, verbatim. */
  readonly message: string;
  /** Wallet that will approve and commit the rules. */
  readonly creator: string;
  /** Chain the market will be created on, so the settlement token can be resolved. */
  readonly chainId: number;
  /**
   * Continue an existing compilation. Omit to start a new one.
   *
   * Compilation is conversational because clarification is the point: the
   * common case is a condition that cannot be resolved objectively until a
   * person supplies a missing fact, and the session is what carries that
   * exchange.
   */
  readonly sessionId?: string;
}

/** Fields present on every compile response, whatever the outcome. */
interface CompileResponseBase {
  readonly sessionId: string;
  /**
   * Which compiler produced this. The same input under a different version may
   * produce a different specification, so the version is part of the
   * reproducibility record.
   */
  readonly compilerVersion: string;
  /**
   * The compiler's reading of the request, in plain language.
   *
   * Kept separate from the specification on purpose: this is interpretation,
   * and interpretation is never silently promoted to fact.
   */
  readonly interpretation: string;
}

/**
 * The compiler's answer.
 *
 * `INCOMPLETE` is a first-class result, not an error: the model correctly
 * declining to invent a missing deadline is the system working. The frontend
 * asks `questions` rather than proceeding to approval.
 */
export type CompileMarketResponse =
  | (CompileResponseBase & {
      readonly status: 'COMPILED';
      /** Normalised draft. It is not financially active until approved. */
      readonly specification: ConditionSpec;
      /** The hash this spec would commit to, for preview only. */
      readonly rulesHash: Bytes32Hex;
      readonly canonical: string;
    })
  | (CompileResponseBase & {
      readonly status: 'INCOMPLETE';
      /** What to ask the user, in the order it should be asked. */
      readonly questions: readonly CompilerQuestion[];
      /** Fields the compiler could not determine. */
      readonly missing: readonly FieldIssue[];
      /** What the model did manage to extract, for the user to complete. */
      readonly partial: Partial<ConditionSpecInput>;
    });

// --- POST /api/markets ------------------------------------------------------

/**
 * Register an approved specification before the user's wallet commits it.
 *
 * The backend stores it keyed by `rulesHash`; the indexer joins the resulting
 * `MarketCreated` event back to it. The backend never submits this transaction.
 */
export interface RegisterMarketRequest {
  readonly specification: ConditionSpecInput;
  /** Client-computed hash, re-derived and compared server-side. */
  readonly rulesHash: string;
}

export interface RegisterMarketResponse {
  readonly rulesHash: Bytes32Hex;
  readonly canonical: string;
  readonly status: Extract<MarketStatus, 'PENDING_ONCHAIN'>;
}

// --- GET /api/markets -------------------------------------------------------

export interface ListMarketsQuery {
  readonly chainId?: number;
  readonly status?: MarketStatus;
  readonly creator?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListMarketsResponse {
  readonly markets: readonly MarketSummary[];
  readonly nextCursor: string | null;
}

// --- GET /api/markets/:id ---------------------------------------------------

export type GetMarketResponse = MarketDetail;

// --- POST /api/markets/:id/resolve -----------------------------------------

/** Triggers the resolution engine. Idempotent per market and round. */
export interface ResolveMarketRequest {
  /** Re-run even if a proposal already exists. Operator use only. */
  readonly force?: boolean;
}

export type ResolveMarketResponse = ResolutionProposal;

// --- POST /api/markets/:id/challenge ---------------------------------------

export interface ChallengeMarketRequest {
  readonly challenger: string;
  /** The challenge argument. Its keccak256 is what goes on-chain. */
  readonly reason: string;
  /** Hash of the on-chain challenge transaction, so the bond can be verified. */
  readonly txHash: string;
}

export type ChallengeMarketResponse = ChallengeRecord;

// --- GET /api/markets/:id/evidence -----------------------------------------

export type GetEvidenceResponse = EvidenceRecord;

// --- GET /api/positions (portfolio) ----------------------------------------

export interface ListPositionsQuery {
  readonly wallet: string;
  readonly chainId?: number;
}

export interface ListPositionsResponse {
  readonly positions: readonly Position[];
}
