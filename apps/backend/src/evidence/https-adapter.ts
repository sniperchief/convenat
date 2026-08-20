/**
 * The production transport. **The only file in this backend that opens a socket
 * to a source.**
 *
 * Built on `node:https` rather than `fetch`, for one reason that matters and
 * three that follow from it:
 *
 * - `https.request` accepts a **`lookup` function**, which `net.connect` calls
 *   to resolve the hostname. Supplying it means the socket connects to an
 *   address this process vetted, with no second resolution in between — the DNS
 *   rebinding hole that "resolve, check, then hand the hostname to a client"
 *   leaves wide open. `fetch` exposes no equivalent hook without pulling in a
 *   dependency to replace its dispatcher.
 * - Redirects are not followed automatically, so every hop is re-checked against
 *   the same policy as the first request rather than trusted.
 * - The response is a stream, so the size cap is enforced while bytes arrive and
 *   the connection is destroyed the moment it is exceeded — not after buffering
 *   a hostile gigabyte.
 * - Timeouts can cover the whole attempt, including redirects, rather than one
 *   socket at a time.
 */

import { request as httpsRequest, type RequestOptions } from 'node:https';
import { lookup as dnsLookup } from 'node:dns';

import type { RetrievalKind } from '@covenant/shared';

import {
  SourceRetrievalError,
  type EvidenceSourceAdapter,
  type SourceRequest,
  type SourceResponse,
} from './types.js';
import {
  addressBlockedReason,
  assertAddressAllowed,
  normalizeSourceUrl,
  DEFAULT_URL_POLICY,
  type UrlPolicy,
} from './url-policy.js';

/**
 * Sent so a source operator can identify and contact us.
 *
 * Deliberately boring and honest. Impersonating a browser to get past a bot
 * check would make this system a scraper that lies about itself, and a source
 * that does not want to be read automatically is a source that should be
 * recorded as unavailable rather than tricked.
 */
const USER_AGENT = 'covenant-resolver/1.0 (+evidence retrieval; contact the market operator)';

export interface HttpsSourceAdapterOptions {
  readonly urlPolicy?: UrlPolicy;
  /** Injected in tests so the address policy can be exercised without DNS. */
  readonly resolve?: (hostname: string) => Promise<readonly string[]>;
}

export class HttpsSourceAdapter implements EvidenceSourceAdapter {
  readonly name = 'https';

  private readonly urlPolicy: UrlPolicy;
  private readonly resolve: (hostname: string) => Promise<readonly string[]>;

  constructor(options: HttpsSourceAdapterOptions = {}) {
    this.urlPolicy = options.urlPolicy ?? DEFAULT_URL_POLICY;
    this.resolve = options.resolve ?? defaultResolve;
  }

  supports(kind: RetrievalKind): boolean {
    // `manual_attestation` is a document handed over out of band. There is no
    // endpoint to read, and pretending otherwise would invent a retrieval that
    // never happened.
    return kind === 'http_json' || kind === 'http_html';
  }

  async retrieve(request: SourceRequest): Promise<SourceResponse> {
    if (!this.supports(request.retrievalKind)) {
      throw new SourceRetrievalError(
        'SOURCE_UNSUPPORTED',
        `retrieval kind ${request.retrievalKind} cannot be read over https`,
      );
    }

    const deadline = Date.now() + request.timeoutMs;
    const redirects: string[] = [];
    let target = normalizeSourceUrl(request.url, this.urlPolicy);

    for (let hop = 0; hop <= request.maxRedirects; hop += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new SourceRetrievalError(
          'SOURCE_TIMEOUT',
          `no response within ${request.timeoutMs}ms`,
          { retryable: true },
        );
      }

      // Name resolution is inside the deadline, not before it. A resolver that
      // never answers is indistinguishable from a source that never answers,
      // and only one of the two used to be bounded — see the note on
      // `withDeadline`.
      const addresses = await this.vetAddresses(target.hostname, remaining);
      const hopResult = await this.attempt(
        target.href,
        addresses,
        Math.max(1, deadline - Date.now()),
        request,
      );

      if (hopResult.kind === 'body') {
        return {
          finalUrl: target.href,
          statusCode: hopResult.statusCode,
          contentType: hopResult.contentType,
          body: hopResult.body,
          redirects,
        };
      }

      // A redirect. Resolve it against the current URL and put it through the
      // full name-level policy again — an https source redirecting to
      // http://169.254.169.254/ is the whole reason this loop exists.
      let next: URL;
      try {
        next = new URL(hopResult.location, target.href);
      } catch {
        throw new SourceRetrievalError(
          'SOURCE_INVALID',
          `redirect to an unparseable location after ${redirects.length} hop(s)`,
        );
      }
      target = normalizeSourceUrl(next.toString(), this.urlPolicy);
      redirects.push(target.href);
    }

    throw new SourceRetrievalError(
      'SOURCE_INVALID',
      `exceeded ${request.maxRedirects} redirect(s)`,
    );
  }

  /**
   * Resolve a hostname and refuse the host outright if **any** answer is
   * disallowed.
   *
   * Fail-closed, not filter-and-continue: a name that resolves to one public and
   * one private address is a name doing something a legitimate evidence source
   * has no reason to do.
   */
  private async vetAddresses(
    hostname: string,
    timeoutMs: number,
  ): Promise<readonly string[]> {
    // A bare IP literal never reaches DNS; check it directly.
    const literal = addressBlockedReason(hostname);
    if (literal === null) return [hostname];

    let addresses: readonly string[];
    try {
      addresses = await withDeadline(
        this.resolve(hostname),
        timeoutMs,
        `name resolution did not complete within ${timeoutMs}ms`,
      );
    } catch (cause) {
      if (cause instanceof SourceRetrievalError) throw cause;
      throw new SourceRetrievalError('SOURCE_UNAVAILABLE', 'host could not be resolved', {
        retryable: true,
        cause,
      });
    }

    if (addresses.length === 0) {
      throw new SourceRetrievalError('SOURCE_UNAVAILABLE', 'host resolved to no addresses', {
        retryable: true,
      });
    }

    for (const address of addresses) assertAddressAllowed(address);
    return addresses;
  }

  private attempt(
    href: string,
    addresses: readonly string[],
    timeoutMs: number,
    request: SourceRequest,
  ): Promise<HopResult> {
    return new Promise<HopResult>((resolve, reject) => {
      const url = new URL(href);
      let settled = false;

      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        action();
      };

      const options: RequestOptions = {
        method: 'GET',
        headers: {
          accept: request.retrievalKind === 'http_json' ? 'application/json' : 'text/html',
          'accept-encoding': 'identity',
          'user-agent': USER_AGENT,
        },
        // The hook that makes this safe: `net.connect` calls it instead of
        // resolving again, so the socket lands on an address already vetted.
        lookup: (hostname, _options, callback) => {
          const chosen = addresses[0];
          if (chosen === undefined) {
            callback(new Error(`no vetted address for ${hostname}`), '', 4);
            return;
          }
          const reason = addressBlockedReason(chosen);
          if (reason !== null) {
            callback(new Error(`address ${chosen} is not permitted (${reason})`), '', 4);
            return;
          }
          callback(null, chosen, chosen.includes(':') ? 6 : 4);
        },
      };

      const clientRequest = httpsRequest(url, options, (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;

        if (status >= 300 && status < 400) {
          response.destroy();
          if (typeof location !== 'string' || location.trim() === '') {
            finish(() =>
              reject(
                new SourceRetrievalError('SOURCE_INVALID', `status ${status} with no location`),
              ),
            );
            return;
          }
          finish(() => resolve({ kind: 'redirect', location }));
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;

        response.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > request.maxResponseBytes) {
            response.destroy();
            clientRequest.destroy();
            finish(() =>
              reject(
                new SourceRetrievalError(
                  'SOURCE_INVALID',
                  `response exceeds the ${request.maxResponseBytes}-byte limit`,
                ),
              ),
            );
            return;
          }
          chunks.push(chunk);
        });

        response.on('end', () => {
          finish(() =>
            resolve({
              kind: 'body',
              statusCode: status,
              contentType: headerValue(response.headers['content-type']),
              body: new Uint8Array(Buffer.concat(chunks)),
            }),
          );
        });

        response.on('error', (cause) => {
          finish(() =>
            reject(
              new SourceRetrievalError('SOURCE_UNAVAILABLE', 'connection failed mid-response', {
                retryable: true,
                cause,
              }),
            ),
          );
        });
      });

      const timer = setTimeout(() => {
        clientRequest.destroy();
        if (settled) return;
        settled = true;
        reject(
          new SourceRetrievalError('SOURCE_TIMEOUT', `no response within ${timeoutMs}ms`, {
            retryable: true,
          }),
        );
      }, timeoutMs);
      // Do not hold the event loop open for a timer whose request already ended.
      timer.unref?.();

      clientRequest.on('error', (cause) => {
        finish(() =>
          reject(
            new SourceRetrievalError('SOURCE_UNAVAILABLE', describeSocketError(cause), {
              retryable: true,
              cause,
            }),
          ),
        );
      });

      clientRequest.end();
    });
  }
}

/**
 * Bound a promise that has no timeout of its own.
 *
 * Written for `dns.lookup`, which is the one step of a retrieval that Node gives
 * no deadline for. The first version of this adapter left it unbounded, on the
 * assumption that a connect timeout covered the whole attempt — it does not,
 * because the connect has not started yet. A live smoke run against an
 * environment with no reachable resolver hung indefinitely rather than
 * classifying as a timeout, which is exactly the "an external source can stall
 * the resolver" failure the retrieval bounds exist to prevent.
 *
 * The loser of the race is not cancelled — `dns.lookup` has no cancellation —
 * so the underlying call may still complete later and is simply ignored. The
 * timer is unreferenced so a pending lookup cannot hold the process open.
 */
async function withDeadline<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new SourceRetrievalError('SOURCE_TIMEOUT', message, { retryable: true })),
          Math.max(1, timeoutMs),
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type HopResult =
  | { readonly kind: 'redirect'; readonly location: string }
  | {
      readonly kind: 'body';
      readonly statusCode: number;
      readonly contentType: string | null;
      readonly body: Uint8Array;
    };

function headerValue(value: string | readonly string[] | undefined): string | null {
  if (value === undefined) return null;
  const first = Array.isArray(value) ? value[0] : (value as string);
  return typeof first === 'string' && first.trim() !== '' ? first : null;
}

/**
 * Describe a socket failure without leaking topology.
 *
 * A raw Node error message can carry the resolved IP and the port, which is
 * internal detail that would end up in a published evidence document if it were
 * passed through.
 */
function describeSocketError(cause: unknown): string {
  const code = (cause as { code?: unknown } | null)?.code;
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'host could not be resolved';
    case 'ECONNREFUSED':
      return 'connection refused';
    case 'ECONNRESET':
      return 'connection reset';
    case 'ETIMEDOUT':
      return 'connection timed out';
    case 'EPROTO':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
    case 'CERT_HAS_EXPIRED':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return 'TLS handshake failed';
    default:
      return 'connection failed';
  }
}

function defaultResolve(hostname: string): Promise<readonly string[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(addresses.map((entry) => entry.address));
    });
  });
}
