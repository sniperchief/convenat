/**
 * The evidence retrieval boundary.
 *
 * Everything above this file — the retriever, the future validators, the tests —
 * speaks only these types. No `https`, `fetch`, `axios` or socket type is
 * visible past this module, which is what makes `FakeSourceAdapter` a complete
 * substitute rather than an approximation, and why the whole retrieval suite
 * runs with no network.
 *
 * **On the name.** The brief calls this abstraction `EvidenceSource`. That name
 * is already taken, by the *hashed record* in `EvidencePackage` v2.0
 * (`@covenant/shared`), and reusing it for a fetcher would put two unrelated
 * things behind one word in a codebase where the hashed record is protocol
 * surface. The adapter is `EvidenceSourceAdapter`; the record it helps produce
 * keeps its name.
 *
 * The interface is deliberately narrow: one request in, one raw response out.
 * It does not know what a ConditionSpec is, does not decide whether a status
 * code is acceptable, and does not parse a body. Those are *policy*, and policy
 * lives in the retriever so it can be tested without a transport at all.
 */

import type { RetrievalKind } from '@covenant/shared';

/**
 * How a retrieval failed.
 *
 * Six operational kinds against the protocol's four (`RetrievalStatus` in
 * `@covenant/shared`), and the asymmetry is deliberate. An operator needs to
 * know the difference between "the host refused us" and "our own policy refused
 * the host"; the hashed evidence document does not, and every extra member in a
 * hashed vocabulary is a member every reimplementation must reproduce forever.
 * `toRetrievalStatus` below is the one place the two are related.
 *
 * None of these is ever an outcome. A source that could not be read says nothing
 * about whether the condition happened — see docs/ai-resolution.md.
 */
export const RETRIEVAL_FAILURE_KINDS = [
  /** The host could not be reached, or answered that the resource is not there. */
  'SOURCE_UNAVAILABLE',
  /** The source answered, but the answer violates the retrieval contract. */
  'SOURCE_INVALID',
  /** No usable response within the per-attempt deadline. */
  'SOURCE_TIMEOUT',
  /** Refused — either by the source (401/403) or by our own address policy. */
  'SOURCE_FORBIDDEN',
  /** Nothing configured can retrieve this kind of source, or this scheme. */
  'SOURCE_UNSUPPORTED',
  /** The body could not be parsed as the kind the specification declared. */
  'SOURCE_MALFORMED',
] as const;

export type RetrievalFailureKind = (typeof RETRIEVAL_FAILURE_KINDS)[number];

/**
 * A retrieval failure, stripped of transport internals.
 *
 * `detail` is written to be safe to surface and to end up in a
 * `SOURCE_AVAILABLE` check's `observed` field. The original error stays on
 * `cause` for the log and never reaches an API response or a hashed document.
 *
 * `retryable` is carried rather than derived from `kind`, because the two do not
 * line up: a 429 and a 404 are both `SOURCE_UNAVAILABLE`, and retrying the
 * second is pointless noise aimed at a source that has already answered
 * definitively.
 */
export class SourceRetrievalError extends Error {
  readonly kind: RetrievalFailureKind;
  readonly detail: string;
  readonly retryable: boolean;
  override readonly cause: unknown;

  constructor(
    kind: RetrievalFailureKind,
    detail: string,
    options: { readonly retryable?: boolean; readonly cause?: unknown } = {},
  ) {
    super(`${kind}: ${detail}`);
    this.name = 'SourceRetrievalError';
    this.kind = kind;
    this.detail = detail;
    this.retryable = options.retryable ?? false;
    this.cause = options.cause;
  }
}

/** What the adapter is asked to do. Every bound is explicit; none has a default. */
export interface SourceRequest {
  /** Already normalised and policy-checked. An adapter must not accept a raw one. */
  readonly url: string;
  readonly retrievalKind: RetrievalKind;
  /** Wall-clock ceiling for this single attempt, including redirects. */
  readonly timeoutMs: number;
  /** Hard ceiling on the response body. Exceeding it is a failure, never a trim. */
  readonly maxResponseBytes: number;
  readonly maxRedirects: number;
}

/**
 * What a source returned.
 *
 * `body` is the **complete** response. An adapter that cannot deliver the whole
 * body within `maxResponseBytes` must throw rather than return a prefix: the
 * bytes here are what `contentHash` commits to, and a truncated body under a
 * hash that claims to be the response is the kind of quiet inaccuracy this
 * project exists to prevent.
 */
export interface SourceResponse {
  /** The URL that actually served the body, after any redirects. */
  readonly finalUrl: string;
  readonly statusCode: number;
  /** Raw `Content-Type`, or null if the source sent none. */
  readonly contentType: string | null;
  readonly body: Uint8Array;
  /** Every hop taken, in order. Empty when the first request answered. */
  readonly redirects: readonly string[];
}

/**
 * A transport that can read an approved source.
 *
 * Implementations: `HttpsSourceAdapter` (production) and `FakeSourceAdapter`
 * (tests, local development).
 */
export interface EvidenceSourceAdapter {
  /** Identifies the implementation in logs. Never part of a hashed document. */
  readonly name: string;
  /** Which retrieval kinds this adapter can serve. */
  supports(kind: RetrievalKind): boolean;
  /** @throws {SourceRetrievalError} — never any other error type. */
  retrieve(request: SourceRequest): Promise<SourceResponse>;
}
