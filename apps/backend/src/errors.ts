/**
 * Backend error model.
 *
 * Extends the shared `CovenantError` hierarchy rather than starting a second
 * one, so a specification-validation failure raised inside `@covenant/shared`
 * and a repository failure raised here map to HTTP through the same function.
 *
 * Nothing here ever carries a stack trace, a SQL string, a provider payload, or
 * a secret into `toApiError()`. What the client sees is a stable code, a
 * human-readable message written for a client, and field-anchored issues.
 */

import { CovenantError, isCovenantError, type ApiError, type FieldIssue } from '@covenant/shared';

export const BackendErrorCode = {
  /** Request body or query failed validation. */
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  /** Environment configuration is unusable. Startup only. */
  CONFIGURATION_INVALID: 'CONFIGURATION_INVALID',
  /** The model returned something that is not a valid compiler output. */
  COMPILER_OUTPUT_INVALID: 'COMPILER_OUTPUT_INVALID',
  /** The LLM provider timed out. */
  LLM_TIMEOUT: 'LLM_TIMEOUT',
  /** The LLM provider is unreachable, rate limited, or erroring. */
  LLM_UNAVAILABLE: 'LLM_UNAVAILABLE',
  /** The provider declined to answer. */
  LLM_REFUSED: 'LLM_REFUSED',
  /** Persistence is unavailable or failed. */
  REPOSITORY_UNAVAILABLE: 'REPOSITORY_UNAVAILABLE',
  /** The RPC endpoint is unreachable or refused the call. */
  CHAIN_UNAVAILABLE: 'CHAIN_UNAVAILABLE',
  /** The node serves a different chain than this process is configured for. */
  CHAIN_MISMATCH: 'CHAIN_MISMATCH',
  /** The chain returned something this build cannot interpret. */
  CHAIN_DATA_INVALID: 'CHAIN_DATA_INVALID',
  /** The caller did not prove ownership of the wallet it is acting as. */
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  /** Authenticated, but not permitted to act on this resource. */
  FORBIDDEN: 'FORBIDDEN',
  /** The requested resource does not exist. */
  NOT_FOUND: 'NOT_FOUND',
  /** The route exists but the capability arrives in a later milestone. */
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  /** Anything unclassified. The message is generic by construction. */
  INTERNAL: 'INTERNAL',
} as const;

export type BackendErrorCode = (typeof BackendErrorCode)[keyof typeof BackendErrorCode];

abstract class BackendError extends CovenantError {
  abstract override readonly code: BackendErrorCode;
  abstract readonly status: number;

  /**
   * The message a client may see.
   *
   * Defaults to `message`, which is written for a client on most of these
   * types. Subclasses whose message can carry infrastructure detail override
   * it with a fixed string, so the detailed version survives for the log and
   * cannot reach a response even if a future caller passes something careless.
   */
  get clientMessage(): string {
    return this.message;
  }
}

export class ValidationError extends BackendError {
  readonly code = BackendErrorCode.VALIDATION_FAILED;
  readonly status = 400;
}

export class ConfigurationError extends BackendError {
  readonly code = BackendErrorCode.CONFIGURATION_INVALID;
  readonly status = 500;
}

/**
 * The model produced output that is not a usable compiler result.
 *
 * A 502: the caller did nothing wrong, an upstream dependency misbehaved. This
 * is emphatically *not* something to paper over with a retry that lowers the
 * bar — malformed output means no specification, and no specification means no
 * hash.
 */
export class CompilerOutputError extends BackendError {
  readonly code = BackendErrorCode.COMPILER_OUTPUT_INVALID;
  readonly status = 502;
}

export class LlmTimeoutError extends BackendError {
  readonly code = BackendErrorCode.LLM_TIMEOUT;
  readonly status = 504;
}

export class LlmUnavailableError extends BackendError {
  readonly code = BackendErrorCode.LLM_UNAVAILABLE;
  readonly status = 503;
}

export class LlmRefusedError extends BackendError {
  readonly code = BackendErrorCode.LLM_REFUSED;
  readonly status = 422;
}

/**
 * Persistence failed.
 *
 * The constructor message is for the log and may name the operation, the
 * driver, or the connection. None of that is safe to return — a connection
 * string carries a password — so the client-facing message is fixed.
 */
export class RepositoryError extends BackendError {
  readonly code = BackendErrorCode.REPOSITORY_UNAVAILABLE;
  readonly status = 503;

  override get clientMessage(): string {
    return 'The service is temporarily unable to reach its datastore.';
  }
}

/**
 * The RPC endpoint could not be reached, or refused.
 *
 * A 503 rather than a 500: the backend is fine, its upstream is not. The
 * constructor message may name the endpoint — an RPC URL can carry an API key in
 * its path — so the client-facing message is fixed, for the same reason
 * `RepositoryError`'s is.
 */
export class ChainUnavailableError extends BackendError {
  readonly code = BackendErrorCode.CHAIN_UNAVAILABLE;
  readonly status = 503;

  override get clientMessage(): string {
    return 'The service is temporarily unable to reach the blockchain node.';
  }
}

/**
 * The node reports a chain id other than the configured one.
 *
 * Fatal at startup (§15) and never recoverable at runtime. This is the error
 * that stops a process configured for testnet from transacting against mainnet
 * because someone changed one environment variable.
 */
export class ChainMismatchError extends BackendError {
  readonly code = BackendErrorCode.CHAIN_MISMATCH;
  readonly status = 500;
}

/** The chain returned a value this build cannot interpret — e.g. a newer enum. */
export class ChainDataError extends BackendError {
  readonly code = BackendErrorCode.CHAIN_DATA_INVALID;
  readonly status = 502;
}

/**
 * The caller has not proved control of the wallet it is acting as.
 *
 * Distinct from `ForbiddenError`: this one means *we do not know who you are*.
 * It carries no hint about whether the claimed wallet exists.
 */
export class UnauthenticatedError extends BackendError {
  readonly code = BackendErrorCode.UNAUTHENTICATED;
  readonly status = 401;
}

/** Authenticated, but acting on something belonging to another wallet. */
export class ForbiddenError extends BackendError {
  readonly code = BackendErrorCode.FORBIDDEN;
  readonly status = 403;
}

export class NotFoundError extends BackendError {
  readonly code = BackendErrorCode.NOT_FOUND;
  readonly status = 404;
}

/**
 * A route that exists in the API contract but is not implemented yet.
 *
 * Returning this is a product decision, not a stub: `/resolve` and `/challenge`
 * cannot be answered without the resolution engine, and answering them with
 * fabricated data would be worse than answering honestly.
 */
export class NotImplementedError extends BackendError {
  readonly code = BackendErrorCode.NOT_IMPLEMENTED;
  readonly status = 501;
}

export class InternalError extends BackendError {
  readonly code = BackendErrorCode.INTERNAL;
  readonly status = 500;
}

/** HTTP status for errors raised inside `@covenant/shared`. */
const SHARED_ERROR_STATUS: Readonly<Record<string, number>> = {
  INVALID_SPECIFICATION: 422,
  INVALID_EVIDENCE_PACKAGE: 422,
  CANONICALIZATION_FAILED: 422,
  HASHING_FAILED: 500,
  HASH_MISMATCH: 409,
  /**
   * A 409 for the same reason `HASH_MISMATCH` is: the request is well-formed and
   * the document is valid, but it conflicts with the state of the market it was
   * offered for. A 422 would suggest the package could be fixed by editing a
   * field, and it cannot — it is evidence for a different agreement.
   */
  EVIDENCE_RULES_MISMATCH: 409,
  UNSUPPORTED_NETWORK: 400,
};

export interface HttpErrorResponse {
  readonly status: number;
  readonly body: ApiError;
}

/**
 * Map any thrown value onto an HTTP response.
 *
 * The `unknown` branch is deliberately opaque: an error we did not anticipate
 * could contain a connection string, a query, or a provider payload, so the
 * client is told only that something failed. The detail belongs in the server
 * log, which is where the caller-facing projection never goes.
 */
export function toHttpError(error: unknown): HttpErrorResponse {
  if (error instanceof BackendError) {
    const projected = error.toApiError();
    return {
      status: error.status,
      body: { error: { ...projected.error, message: error.clientMessage } },
    };
  }

  if (isCovenantError(error)) {
    const status = SHARED_ERROR_STATUS[error.code] ?? 500;
    return { status, body: error.toApiError() };
  }

  return {
    status: 500,
    body: {
      error: {
        code: BackendErrorCode.INTERNAL,
        message: 'An internal error occurred.',
        issues: [],
      },
    },
  };
}

export type { ApiError, FieldIssue };
