/**
 * A scripted `LLMProvider` for tests and local development.
 *
 * Ships in `src`, not `test`, for two reasons: the whole test suite depends on
 * it, and running the backend locally without an API key is genuinely useful.
 *
 * It is a *script*, not a simulation. Each call consumes the next queued
 * response, so a test states exactly what the model returns — including the
 * malformed, refusing and hallucinating cases that a real model produces only
 * occasionally and never on demand. Those are the cases the compiler's safety
 * properties are made of, so being able to produce them deterministically is
 * the point.
 */

import {
  LLMProviderError,
  type LLMFailureKind,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type LLMStopReason,
} from './provider.js';

/** One scripted outcome: either a response body or a failure. */
export type FakeScript =
  | { readonly kind: 'text'; readonly text: string; readonly stopReason?: LLMStopReason }
  | { readonly kind: 'json'; readonly value: unknown }
  | { readonly kind: 'error'; readonly failure: LLMFailureKind; readonly message?: string };

export class FakeLLMProvider implements LLMProvider {
  readonly name = 'fake';

  /** Every request received, in order. Lets a test assert on the prompt. */
  readonly calls: LLMRequest[] = [];

  private readonly queue: FakeScript[];
  private readonly fallback: FakeScript | null;

  /**
   * @param scripts Consumed one per call, in order.
   * @param fallback Used once the queue is empty. Without one, an extra call
   *        throws — a test that makes more model calls than it scripted has a
   *        bug worth surfacing, not papering over.
   */
  constructor(scripts: readonly FakeScript[] = [], fallback: FakeScript | null = null) {
    this.queue = [...scripts];
    this.fallback = fallback;
  }

  /** Convenience for the common case: one JSON response. */
  static respondingWith(value: unknown): FakeLLMProvider {
    return new FakeLLMProvider([{ kind: 'json', value }]);
  }

  /** Convenience for the failure case. */
  static failingWith(failure: LLMFailureKind, message?: string): FakeLLMProvider {
    return new FakeLLMProvider([
      message === undefined ? { kind: 'error', failure } : { kind: 'error', failure, message },
    ]);
  }

  complete(request: LLMRequest): Promise<LLMResponse> {
    this.calls.push(request);

    const script = this.queue.shift() ?? this.fallback;
    if (script === null || script === undefined) {
      return Promise.reject(
        new Error(
          `FakeLLMProvider ran out of scripted responses on call ${this.calls.length}. ` +
            'Queue another response, or pass a fallback.',
        ),
      );
    }

    if (script.kind === 'error') {
      return Promise.reject(
        new LLMProviderError(script.failure, script.message ?? `scripted ${script.failure}`),
      );
    }

    const text = script.kind === 'json' ? JSON.stringify(script.value) : script.text;
    const stopReason: LLMStopReason =
      script.kind === 'text' ? (script.stopReason ?? 'complete') : 'complete';

    return Promise.resolve({
      text,
      model: 'fake-model',
      stopReason,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  }
}
