/**
 * A scripted `EvidenceSourceAdapter` for tests and local development.
 *
 * Ships in `src`, not `test`, for the same two reasons `FakeLLMProvider` does:
 * the retrieval suite depends on it, and running the resolver locally against
 * fixed responses is genuinely useful.
 *
 * It is a *script*, not a simulation. A test states exactly what each approved
 * source returns — including the timeout, the malformed body, the wrong
 * content-type and the redirect chain that a real source produces only
 * occasionally and never on demand. Those are the cases the retrieval layer's
 * safety properties are made of, so producing them deterministically is the
 * whole point.
 *
 * Responses are keyed by **normalised** URL, which is itself load-bearing: a
 * test that scripts `https://a.test/x` and is asked for `https://a.test/x#frag`
 * gets a hit, and that is exactly the identity rule §14 of docs/ai-resolution.md
 * describes.
 */

import type { RetrievalKind } from '@covenant/shared';

import {
  SourceRetrievalError,
  type EvidenceSourceAdapter,
  type RetrievalFailureKind,
  type SourceRequest,
  type SourceResponse,
} from './types.js';
import { normalizeSourceUrl } from './url-policy.js';

/** One scripted outcome for one URL. */
export type FakeSourceScript =
  | {
      readonly kind: 'response';
      readonly statusCode?: number;
      readonly contentType?: string | null;
      /** Text body; encoded as UTF-8. Mutually exclusive with `bytes`. */
      readonly body?: string;
      /** Exact bytes, for tests about encoding or size. */
      readonly bytes?: Uint8Array;
      readonly finalUrl?: string;
      readonly redirects?: readonly string[];
    }
  | {
      readonly kind: 'failure';
      readonly failure: RetrievalFailureKind;
      readonly detail?: string;
      readonly retryable?: boolean;
    };

export interface FakeSourceCall {
  readonly url: string;
  readonly retrievalKind: RetrievalKind;
  readonly timeoutMs: number;
}

export class FakeSourceAdapter implements EvidenceSourceAdapter {
  readonly name = 'fake';

  /** Every request received, in order. Lets a test assert on precedence. */
  readonly calls: FakeSourceCall[] = [];

  private readonly byUrl = new Map<string, FakeSourceScript[]>();
  private readonly supported: ReadonlySet<RetrievalKind>;

  /**
   * @param scripts Keyed by URL. A list is consumed one entry per call, so a
   *        test can make the first attempt fail and the retry succeed — which is
   *        the only honest way to test a retry policy.
   * @param supported Retrieval kinds this adapter claims. Defaults to the two
   *        the https adapter serves, so the fake is a like-for-like stand-in.
   */
  constructor(
    scripts: Readonly<Record<string, FakeSourceScript | readonly FakeSourceScript[]>> = {},
    supported: readonly RetrievalKind[] = ['http_json', 'http_html'],
  ) {
    for (const [url, script] of Object.entries(scripts)) {
      this.byUrl.set(this.key(url), Array.isArray(script) ? [...script] : [script as FakeSourceScript]);
    }
    this.supported = new Set(supported);
  }

  supports(kind: RetrievalKind): boolean {
    return this.supported.has(kind);
  }

  async retrieve(request: SourceRequest): Promise<SourceResponse> {
    this.calls.push({
      url: request.url,
      retrievalKind: request.retrievalKind,
      timeoutMs: request.timeoutMs,
    });

    if (!this.supports(request.retrievalKind)) {
      throw new SourceRetrievalError(
        'SOURCE_UNSUPPORTED',
        `retrieval kind ${request.retrievalKind} is not scripted`,
      );
    }

    const queue = this.byUrl.get(this.key(request.url));
    const script = queue === undefined ? undefined : (queue.length > 1 ? queue.shift() : queue[0]);

    if (script === undefined) {
      // An unscripted URL is a test that did not say what should happen. Failing
      // as "unavailable" is the truthful answer and keeps a missing script from
      // silently passing as a successful retrieval.
      throw new SourceRetrievalError('SOURCE_UNAVAILABLE', 'no scripted response for this URL', {
        retryable: false,
      });
    }

    if (script.kind === 'failure') {
      throw new SourceRetrievalError(script.failure, script.detail ?? 'scripted failure', {
        retryable: script.retryable ?? false,
      });
    }

    const body =
      script.bytes ?? new TextEncoder().encode(script.body ?? '');

    if (body.length > request.maxResponseBytes) {
      // The real adapter enforces this while streaming; the fake enforces it on
      // the whole body so the retriever sees the identical failure.
      throw new SourceRetrievalError(
        'SOURCE_INVALID',
        `response exceeds the ${request.maxResponseBytes}-byte limit`,
      );
    }

    const redirects = script.redirects ?? [];
    if (redirects.length > request.maxRedirects) {
      throw new SourceRetrievalError(
        'SOURCE_INVALID',
        `exceeded ${request.maxRedirects} redirect(s)`,
      );
    }

    return {
      finalUrl: script.finalUrl ?? request.url,
      statusCode: script.statusCode ?? 200,
      contentType: script.contentType === undefined ? 'application/json' : script.contentType,
      body,
      redirects,
    };
  }

  private key(url: string): string {
    try {
      return normalizeSourceUrl(url).href;
    } catch {
      // Unnormalisable URLs are still keyable; the retriever refuses them before
      // an adapter is reached, so this only matters for direct adapter tests.
      return url;
    }
  }
}
