/**
 * The LLM boundary.
 *
 * Everything above this file — the compiler, the routes, the tests — speaks
 * only these types. No Anthropic SDK type, error class, or field name is
 * visible past this module. That is what makes `FakeLLMProvider` a complete
 * substitute rather than an approximation, and it is why the entire test suite
 * runs without a network.
 *
 * The interface is deliberately narrow: one request in, one normalised response
 * out. No streaming, no tool loop, no conversation state. The compiler is a
 * single-shot structured extraction, and a wider interface would invite the
 * provider to grow responsibilities that belong to the compiler.
 */

/** A conversation turn. The system prompt travels separately. */
export interface LLMMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/**
 * A JSON Schema the provider should constrain the response to.
 *
 * JSON Schema rather than a Zod schema on purpose: it is what every provider
 * speaks, so this stays portable. The schema constrains *shape*; it is not the
 * validation gate — Zod is, on the way back in.
 */
export interface LLMJsonSchema {
  readonly name: string;
  readonly schema: Record<string, unknown>;
}

export interface LLMRequest {
  readonly system: string;
  readonly messages: readonly LLMMessage[];
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  readonly jsonSchema?: LLMJsonSchema;
}

/**
 * Why generation stopped, normalised across providers.
 *
 * `refusal` is a first-class member because a provider declining to answer is
 * a real outcome that must not be mistaken for an empty response.
 */
export type LLMStopReason = 'complete' | 'max_output_tokens' | 'refusal' | 'other';

export interface LLMResponse {
  readonly text: string;
  /** The model that actually served the request, as reported by the provider. */
  readonly model: string;
  readonly stopReason: LLMStopReason;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

/** How a provider call failed, normalised. */
export type LLMFailureKind =
  | 'timeout'
  | 'rate_limited'
  | 'unavailable'
  | 'auth'
  | 'invalid_request'
  | 'refused'
  | 'unknown';

/**
 * A provider failure, stripped of provider internals.
 *
 * The message is written to be safe to surface; the original error is kept on
 * `cause` for server-side logging only and never reaches an API response.
 */
export class LLMProviderError extends Error {
  readonly kind: LLMFailureKind;
  override readonly cause: unknown;

  constructor(kind: LLMFailureKind, message: string, cause?: unknown) {
    super(message);
    this.name = 'LLMProviderError';
    this.kind = kind;
    this.cause = cause;
  }
}

export interface LLMProvider {
  /** Identifies the implementation in logs, e.g. `anthropic` or `fake`. */
  readonly name: string;
  complete(request: LLMRequest): Promise<LLMResponse>;
}
