/**
 * Typed error model for the shared protocol layer.
 *
 * These errors are designed to be mapped onto HTTP responses by the backend
 * without leaking internals: `toApiError()` returns a plain, serialisable shape
 * containing a stable machine code, a human message and structured field
 * issues. Stack traces and cause chains are deliberately never included in that
 * projection — they stay on the Error object for server-side logging only.
 */

export const ErrorCode = {
  /** The input is not a structurally valid ConditionSpec. */
  INVALID_SPECIFICATION: 'INVALID_SPECIFICATION',
  /** The input is not a structurally valid EvidencePackage. */
  INVALID_EVIDENCE_PACKAGE: 'INVALID_EVIDENCE_PACKAGE',
  /** A value could not be represented in the canonical protocol encoding. */
  CANONICALIZATION_FAILED: 'CANONICALIZATION_FAILED',
  /** Canonical bytes could not be hashed. */
  HASHING_FAILED: 'HASHING_FAILED',
  /** A commitment did not match its expected hash. */
  HASH_MISMATCH: 'HASH_MISMATCH',
  /**
   * An evidence package is bound to a different `rulesHash` than the market it
   * was offered for. Distinct from `HASH_MISMATCH`, which means a document did
   * not reproduce *its own* committed digest: here the document is internally
   * fine and is simply evidence for another agreement.
   */
  EVIDENCE_RULES_MISMATCH: 'EVIDENCE_RULES_MISMATCH',
  /** A chain id / network key is not one this build supports. */
  UNSUPPORTED_NETWORK: 'UNSUPPORTED_NETWORK',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** A single machine-readable problem, anchored to a path within the input. */
export interface FieldIssue {
  /** Dotted/bracketed path, e.g. `approvedSources[0].url`. Empty for root. */
  readonly path: string;
  readonly message: string;
}

/** The public wire shape for any failure originating in this package. */
export interface ApiError {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly issues: readonly FieldIssue[];
  };
}

/**
 * Base class for every error this package throws.
 *
 * `code` is typed as `string` rather than `ErrorCode` so consumers can extend
 * the hierarchy with their own codes — the backend adds HTTP-shaped ones — and
 * still map every failure through one `toApiError()`. Each concrete class below
 * declares a literal, so precision is kept exactly where it is useful.
 */
export abstract class CovenantError extends Error {
  abstract readonly code: string;
  readonly issues: readonly FieldIssue[];

  constructor(message: string, issues: readonly FieldIssue[] = []) {
    super(message);
    this.name = new.target.name;
    this.issues = issues;
  }

  /** Public, serialisable projection. Never contains a stack or a cause. */
  toApiError(): ApiError {
    return {
      error: {
        code: this.code,
        message: this.message,
        issues: this.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      },
    };
  }
}

export class SpecificationValidationError extends CovenantError {
  readonly code = ErrorCode.INVALID_SPECIFICATION;
}

export class EvidenceValidationError extends CovenantError {
  readonly code = ErrorCode.INVALID_EVIDENCE_PACKAGE;
}

export class CanonicalizationError extends CovenantError {
  readonly code = ErrorCode.CANONICALIZATION_FAILED;
}

export class HashingError extends CovenantError {
  readonly code = ErrorCode.HASHING_FAILED;
}

export class HashMismatchError extends CovenantError {
  readonly code = ErrorCode.HASH_MISMATCH;
}

/**
 * An evidence package does not belong to the market it was offered for.
 *
 * This is a security boundary, not a validation nicety: a package bound to
 * another agreement's `rulesHash` describes evidence for a different set of
 * rules, and accepting it would let a resolution be justified by facts about
 * something else entirely.
 */
export class EvidenceBindingError extends CovenantError {
  readonly code = ErrorCode.EVIDENCE_RULES_MISMATCH;
}

export class UnsupportedNetworkError extends CovenantError {
  readonly code = ErrorCode.UNSUPPORTED_NETWORK;
}

export function isCovenantError(value: unknown): value is CovenantError {
  return value instanceof CovenantError;
}
