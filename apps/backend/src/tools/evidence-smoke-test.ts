/**
 * A small, controlled live check of the https source adapter.
 *
 * ```
 * node --dns-result-order=ipv4first dist/tools/evidence-smoke-test.js
 * ```
 *
 * **Not part of the test suite, deliberately.** Every retrieval test runs
 * against `FakeSourceAdapter`, because a suite that depends on third-party
 * uptime is a suite that fails for reasons unrelated to the code, and people
 * stop reading it. But a fake proves nothing about TLS, real DNS, the `lookup`
 * hook actually being honoured, chunked bodies, or a real redirect — and M4's
 * lesson was precisely that a year of fake-provider tests could not find a
 * defect that the first live call found immediately.
 *
 * So: fakes for the logic, this for the transport, and the two never pretend to
 * be each other.
 *
 * It reads publicly documented endpoints, sends a truthful user agent, makes one
 * request each, and prints classifications only — never response bodies.
 */

import type { RetrievalKind } from '@covenant/shared';

import { HttpsSourceAdapter } from '../evidence/https-adapter.js';
import { SourceRetrievalError } from '../evidence/types.js';
import { assertStatus } from '../evidence/retriever.js';
import { assertContentType, normalizeContent } from '../evidence/normalize.js';
import { DEFAULT_URL_POLICY } from '../evidence/url-policy.js';

interface Probe {
  readonly label: string;
  readonly url: string;
  readonly kind: RetrievalKind;
  /** What a healthy run looks like. Anything else is worth reading carefully. */
  readonly expect: 'retrieved' | 'refused';
}

const PROBES: readonly Probe[] = [
  {
    label: 'HTML over TLS',
    url: 'https://example.com/',
    kind: 'http_html',
    expect: 'retrieved',
  },
  {
    label: 'JSON over TLS',
    url: 'https://dns.google/resolve?name=example.com&type=A',
    kind: 'http_json',
    expect: 'retrieved',
  },
  {
    label: 'cloud metadata endpoint (must be refused)',
    url: 'https://169.254.169.254/latest/meta-data/',
    kind: 'http_json',
    expect: 'refused',
  },
  {
    label: 'loopback (must be refused)',
    url: 'https://127.0.0.1/admin',
    kind: 'http_json',
    expect: 'refused',
  },
  {
    label: 'non-standard port (must be refused)',
    url: 'https://example.com:8080/',
    kind: 'http_html',
    expect: 'refused',
  },
];

async function main(): Promise<void> {
  const adapter = new HttpsSourceAdapter({ urlPolicy: DEFAULT_URL_POLICY });
  let failures = 0;

  for (const probe of PROBES) {
    const startedAt = Date.now();
    try {
      const response = await adapter.retrieve({
        url: probe.url,
        retrievalKind: probe.kind,
        timeoutMs: 10_000,
        maxResponseBytes: 2 * 1024 * 1024,
        maxRedirects: 3,
      });

      assertStatus(response.statusCode);
      assertContentType(probe.kind, response.contentType);

      const normalized = normalizeContent({
        retrievalKind: probe.kind,
        contentType: response.contentType,
        body: response.body,
        dataPath: null,
        maxRetainedChars: 20_000,
      });

      const ok = probe.expect === 'retrieved';
      if (!ok) failures += 1;
      // Sizes and hashes only. A response body from a third party has no
      // business in this project's logs.
      console.log(
        `${ok ? 'ok  ' : 'FAIL'} ${probe.label}\n` +
          `       status=${response.statusCode} bytes=${normalized.rawBytes} ` +
          `redirects=${response.redirects.length} ms=${Date.now() - startedAt}\n` +
          `       contentHash=${normalized.contentHash}\n` +
          `       normalized=${normalized.normalizedContent.length} chars` +
          `${normalized.normalizedTruncated ? ' (truncated)' : ''}`,
      );
    } catch (error) {
      const known = error instanceof SourceRetrievalError;
      const kind = known ? error.kind : 'UNCLASSIFIED';
      const ok = probe.expect === 'refused' && known;
      if (!ok) failures += 1;
      console.log(
        `${ok ? 'ok  ' : 'FAIL'} ${probe.label}\n` +
          `       ${kind}: ${known ? error.detail : 'unexpected error'} ` +
          `(ms=${Date.now() - startedAt})`,
      );
    }
  }

  console.log(
    `\n${PROBES.length - failures}/${PROBES.length} probes behaved as expected.` +
      (failures > 0
        ? '\nA network-level failure here is not automatically a code defect — read the classification before concluding anything.'
        : ''),
  );
  process.exitCode = failures > 0 ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error('smoke test could not run:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
