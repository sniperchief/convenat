/**
 * Anthropic implementation of `LLMProvider`.
 *
 * The only file in the backend that imports the Anthropic SDK. Everything it
 * knows about Anthropic — model ids, block types, error classes, the fact that
 * timeouts are milliseconds — stops here.
 *
 * Three decisions worth stating:
 *
 * 1. **Structured output, not prefill.** The response format is constrained
 *    with `output_config.format`. Assistant-turn prefill — the older way to
 *    force JSON — returns a 400 on current models, and it was never a
 *    guarantee anyway.
 * 2. **`stop_reason` is checked before `content` is read.** A refusal returns
 *    HTTP 200 with an empty or partial `content` array; code that indexes
 *    `content[0]` first would crash or, worse, treat a refusal as an answer.
 * 3. **No retry loop of our own.** The SDK already retries 429 and 5xx with
 *    exponential backoff. Wrapping that in another loop multiplies attempts and
 *    turns a rate limit into a retry storm, so `maxRetries` is set explicitly
 *    and left alone.
 */

import Anthropic from '@anthropic-ai/sdk';

import {
  LLMProviderError,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type LLMStopReason,
} from './provider.js';

export interface AnthropicProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  /**
   * SDK-level retries for 429 and 5xx. One, not the default two: the compiler
   * runs behind a user waiting on a request, and a slow failure is worse than a
   * fast one.
   */
  readonly maxRetries?: number;
}

/** Anthropic stop reasons, normalised onto the provider-neutral vocabulary. */
function normalizeStopReason(reason: string | null): LLMStopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'complete';
    case 'max_tokens':
      return 'max_output_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

export class AnthropicLLMProvider implements LLMProvider {
  readonly name = 'anthropic';

  private readonly client: Anthropic;
  private readonly model: string;

  constructor(options: AnthropicProviderOptions) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      maxRetries: options.maxRetries ?? 1,
    });
    this.model = options.model;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    try {
      const response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: request.maxOutputTokens,
          system: request.system,
          messages: request.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          // `output_config.format` takes `type` and `schema` only. It does NOT
          // take `name` — sending one is a 400, `output_config.format.name:
          // Extra inputs are not permitted`. M3 sent it and no test caught it,
          // because every M3 test used FakeLLMProvider and never built a real
          // request. Found by the live provider test in M4 (§29).
          ...(request.jsonSchema === undefined
            ? {}
            : {
                output_config: {
                  format: {
                    type: 'json_schema' as const,
                    schema: request.jsonSchema.schema,
                  },
                },
              }),
        },
        // The TypeScript SDK measures timeouts in MILLISECONDS. Passing seconds
        // here would set a timeout of a few milliseconds and fail every call.
        { timeout: request.timeoutMs },
      );

      const stopReason = normalizeStopReason(response.stop_reason);
      if (stopReason === 'refusal') {
        throw new LLMProviderError(
          'refused',
          'The model declined to answer this request.',
        );
      }

      // `content` is a discriminated union; only text blocks carry text.
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      return {
        text,
        model: response.model,
        stopReason,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    } catch (cause) {
      throw toProviderError(cause);
    }
  }
}

/**
 * Translate an SDK error into an `LLMProviderError`.
 *
 * Typed exception classes, not string matching on messages — the SDK exposes a
 * class per status precisely so callers can branch on the distinction between
 * "retry later" and "this request will never work".
 */
function toProviderError(cause: unknown): LLMProviderError {
  if (cause instanceof LLMProviderError) return cause;

  if (cause instanceof Anthropic.APIConnectionTimeoutError) {
    return new LLMProviderError('timeout', 'The model provider timed out.', cause);
  }
  if (cause instanceof Anthropic.RateLimitError) {
    return new LLMProviderError(
      'rate_limited',
      'The model provider is rate limited. Try again shortly.',
      cause,
    );
  }
  if (cause instanceof Anthropic.AuthenticationError) {
    // Deliberately vague to the caller: a misconfigured key is an operator
    // problem, and confirming key validity to a client is an information leak.
    return new LLMProviderError('auth', 'The model provider rejected our credentials.', cause);
  }
  if (cause instanceof Anthropic.BadRequestError) {
    return new LLMProviderError('invalid_request', 'The model provider rejected the request.', cause);
  }
  if (cause instanceof Anthropic.APIConnectionError) {
    return new LLMProviderError('unavailable', 'The model provider is unreachable.', cause);
  }
  if (cause instanceof Anthropic.APIError) {
    return new LLMProviderError('unavailable', 'The model provider returned an error.', cause);
  }

  return new LLMProviderError('unknown', 'The model provider call failed.', cause);
}
