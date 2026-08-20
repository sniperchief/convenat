/**
 * Evidence retrieval: precedence, bounds, failure classification, and the
 * artifacts that feed `EvidencePackage` v2.0.
 *
 * Every test here runs against `FakeSourceAdapter`. That is not a convenience —
 * it is the only way to get a timeout, a malformed body, a wrong content-type
 * and a redirect loop *on demand and in the same second*, and those are the
 * cases the retrieval layer's safety properties are made of. A suite that
 * pointed at real websites would be slow, flaky, and would stop testing the
 * interesting half.
 *
 * A separate, opt-in live check exists for the thing a fake cannot prove; see
 * `tools/evidence-smoke-test.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  buildEvidenceCommitmentForSpec,
  hashContentBytes,
  parseConditionSpec,
  type ConditionSpec,
  type ConditionSpecInput,
  type EvidencePackageV2Input,
} from '@covenant/shared';
import { conditionSpecFixtures } from '@covenant/shared/testing';

import { FakeSourceAdapter, type FakeSourceScript } from '../src/evidence/fake-adapter.js';
import {
  EvidenceRetriever,
  FAILURE_TO_STATUS,
  assertStatus,
  sourceIdForIndex,
  type RetrievalLimits,
} from '../src/evidence/retriever.js';
import { htmlToText, resolveJsonPointer } from '../src/evidence/normalize.js';
import { SourceRetrievalError } from '../src/evidence/types.js';

const PRIMARY = 'https://api.example-carrier.test/v1/track/1Z999AA10123456784';
const FALLBACK = 'https://www.example-carrier.test/track?id=1Z999AA10123456784';

const TRACKING_JSON = JSON.stringify({
  shipment: { status: 'delivered', deliveredAt: '2026-08-28T14:02:11Z', scans: 14 },
});

/** A frozen clock, so `retrievedAt` is a fact of the test rather than of the day. */
const NOW = new Date('2026-09-02T00:05:30Z');

function retriever(
  scripts: Readonly<Record<string, FakeSourceScript | readonly FakeSourceScript[]>>,
  limits: Partial<RetrievalLimits> = {},
): { engine: EvidenceRetriever; adapter: FakeSourceAdapter } {
  const adapter = new FakeSourceAdapter(scripts);
  const engine = new EvidenceRetriever({
    adapters: [adapter],
    limits: { retryBackoffMs: 0, ...limits },
    now: () => NOW,
    sleep: async () => {},
  });
  return { engine, adapter };
}

/** The shipment specification: two approved sources, JSON primary, HTML fallback. */
function shipmentSpec(): ConditionSpec {
  return parseConditionSpec(conditionSpecFixtures.shipment);
}

/** A specification with the approved sources replaced. */
function specWithSources(
  sources: ConditionSpecInput['approvedSources'],
): ConditionSpec {
  return parseConditionSpec({ ...conditionSpecFixtures.shipment, approvedSources: sources });
}

describe('successful retrieval', () => {
  it('reads the primary source and snapshots it', async () => {
    const { engine } = retriever({ [PRIMARY]: { kind: 'response', body: TRACKING_JSON } });
    const result = await engine.retrieve(shipmentSpec());

    expect(result.primary).not.toBeNull();
    expect(result.primary?.sourceId).toBe('source-0');
    expect(result.primary?.approvedSourceIndex).toBe(0);
    expect(result.primary?.retrievedAt).toBe('2026-09-02T00:05:30Z');
    expect(result.failures).toHaveLength(0);
  });

  it('hashes the complete raw bytes, not the normalised text', async () => {
    const { engine } = retriever({ [PRIMARY]: { kind: 'response', body: TRACKING_JSON } });
    const result = await engine.retrieve(shipmentSpec());

    expect(result.primary?.contentHash).toBe(
      hashContentBytes(new TextEncoder().encode(TRACKING_JSON)),
    );
    // The normalised form is canonical JSON, which differs from the raw text
    // whenever the source did not already emit canonical bytes.
    expect(result.primary?.normalizedHash).not.toBe(result.primary?.contentHash);
  });

  it('applies the approved dataPath and records what it selected', async () => {
    const { engine } = retriever({ [PRIMARY]: { kind: 'response', body: TRACKING_JSON } });
    const result = await engine.retrieve(shipmentSpec());

    expect(result.primary?.selection).toEqual({
      pointer: '/shipment/status',
      value: '"delivered"',
    });
  });

  it('normalises JSON canonically, so key order does not change the snapshot', async () => {
    const forward = '{"a":1,"b":2}';
    const reversed = '{"b":2,"a":1}';
    const spec = specWithSources([
      { name: 'API', url: PRIMARY, retrievalKind: 'http_json', dataPath: null },
    ]);

    const one = await retriever({ [PRIMARY]: { kind: 'response', body: forward } }).engine.retrieve(
      spec,
    );
    const two = await retriever({
      [PRIMARY]: { kind: 'response', body: reversed },
    }).engine.retrieve(spec);

    expect(one.primary?.normalizedContent).toBe(two.primary?.normalizedContent);
    expect(one.primary?.normalizedHash).toBe(two.primary?.normalizedHash);
    // But the raw bytes differ, and the content hash says so.
    expect(one.primary?.contentHash).not.toBe(two.primary?.contentHash);
  });

  it('accepts a +json structured suffix content type', async () => {
    const { engine } = retriever({
      [PRIMARY]: {
        kind: 'response',
        body: TRACKING_JSON,
        contentType: 'application/vnd.carrier.tracking+json; charset=utf-8',
      },
    });
    expect((await engine.retrieve(shipmentSpec())).primary).not.toBeNull();
  });
});

describe('content hash stability', () => {
  const spec = () =>
    specWithSources([{ name: 'API', url: PRIMARY, retrievalKind: 'http_json', dataPath: null }]);

  it('is identical across repeated retrievals of identical bytes', async () => {
    const hashes = new Set<string>();
    for (let i = 0; i < 10; i += 1) {
      const { engine } = retriever({ [PRIMARY]: { kind: 'response', body: TRACKING_JSON } });
      const result = await engine.retrieve(spec());
      hashes.add(result.primary?.contentHash ?? 'missing');
    }
    expect(hashes.size).toBe(1);
  });

  it('changes when a single byte of the response changes', async () => {
    const a = await retriever({
      [PRIMARY]: { kind: 'response', body: '{"v":1}' },
    }).engine.retrieve(spec());
    const b = await retriever({
      [PRIMARY]: { kind: 'response', body: '{"v":2}' },
    }).engine.retrieve(spec());
    expect(a.primary?.contentHash).not.toBe(b.primary?.contentHash);
  });

  it('does not depend on transport metadata', async () => {
    // The same body served with a different content-type parameter, a different
    // final URL and a redirect chain must hash identically: none of that is
    // evidence, and a digest that moved with it would cry wolf.
    const plain = await retriever({
      [PRIMARY]: { kind: 'response', body: TRACKING_JSON, contentType: 'application/json' },
    }).engine.retrieve(spec());

    const decorated = await retriever({
      [PRIMARY]: {
        kind: 'response',
        body: TRACKING_JSON,
        contentType: 'application/json; charset=utf-8',
        finalUrl: 'https://api.example-carrier.test/v1/track/1Z999AA10123456784?cdn=eu',
        redirects: ['https://api.example-carrier.test/v1/track/1Z999AA10123456784?cdn=eu'],
      },
    }).engine.retrieve(spec());

    expect(decorated.primary?.contentHash).toBe(plain.primary?.contentHash);
  });

  it('is not affected by the retained-content ceiling', async () => {
    // Truncation applies to the normalised projection only. The content hash
    // always commits to the whole body.
    const long = JSON.stringify({ note: 'x'.repeat(3_000) });
    const a = await retriever({ [PRIMARY]: { kind: 'response', body: long } }, {
      maxRetainedChars: 100,
    }).engine.retrieve(spec());
    const b = await retriever({ [PRIMARY]: { kind: 'response', body: long } }, {
      maxRetainedChars: 10_000,
    }).engine.retrieve(spec());

    expect(a.primary?.contentHash).toBe(b.primary?.contentHash);
    expect(a.primary?.normalizedTruncated).toBe(true);
    expect(b.primary?.normalizedTruncated).toBe(false);
    expect(a.primary?.normalizedHash).not.toBe(b.primary?.normalizedHash);
  });
});

describe('precedence and fallback', () => {
  it('stops at the first usable source and never reads the fallback', async () => {
    const { engine, adapter } = retriever({
      [PRIMARY]: { kind: 'response', body: TRACKING_JSON },
      [FALLBACK]: { kind: 'response', body: '<html>should not be read</html>' },
    });
    const result = await engine.retrieve(shipmentSpec());

    expect(adapter.calls.map((call) => call.url)).toEqual([PRIMARY]);
    expect(result.primary?.approvedSourceIndex).toBe(0);
    expect(result.skipped.map((entry) => entry.approvedSourceIndex)).toEqual([1]);
    expect(result.skipped[0]?.reason).toBe('PRECEDENCE_SATISFIED');
  });

  it('falls through to the approved fallback when the primary is unavailable', async () => {
    const { engine, adapter } = retriever({
      [PRIMARY]: { kind: 'failure', failure: 'SOURCE_UNAVAILABLE', detail: 'host down' },
      [FALLBACK]: {
        kind: 'response',
        body: '<html><body>Status: <b>Delivered</b></body></html>',
        contentType: 'text/html',
      },
    });
    const result = await engine.retrieve(shipmentSpec());

    expect(adapter.calls.map((call) => call.url)).toEqual([PRIMARY, FALLBACK]);
    expect(result.primary?.approvedSourceIndex).toBe(1);
    expect(result.failures.map((f) => f.approvedSourceIndex)).toEqual([0]);
    expect(result.skipped).toHaveLength(0);
  });

  it('preserves precedence exactly, in the order the specification declares', async () => {
    const spec = specWithSources([
      { name: 'A', url: 'https://a.test/x', retrievalKind: 'http_json', dataPath: null },
      { name: 'B', url: 'https://b.test/x', retrievalKind: 'http_json', dataPath: null },
      { name: 'C', url: 'https://c.test/x', retrievalKind: 'http_json', dataPath: null },
    ]);
    const { engine, adapter } = retriever({
      'https://a.test/x': { kind: 'failure', failure: 'SOURCE_TIMEOUT' },
      'https://b.test/x': { kind: 'failure', failure: 'SOURCE_UNAVAILABLE' },
      'https://c.test/x': { kind: 'response', body: '{"ok":true}' },
    });
    const result = await engine.retrieve(spec);

    expect(adapter.calls.map((call) => call.url)).toEqual([
      'https://a.test/x',
      'https://b.test/x',
      'https://c.test/x',
    ]);
    expect(result.primary?.name).toBe('C');
  });

  it('reads no source outside the approved list', async () => {
    const { engine, adapter } = retriever({
      [PRIMARY]: { kind: 'failure', failure: 'SOURCE_UNAVAILABLE' },
      [FALLBACK]: { kind: 'failure', failure: 'SOURCE_UNAVAILABLE' },
      'https://helpful-alternative.test/track': { kind: 'response', body: TRACKING_JSON },
    });
    const result = await engine.retrieve(shipmentSpec());

    // Both approved sources failed and the retriever gave up, rather than
    // finding something that would have answered.
    expect(result.primary).toBeNull();
    expect(adapter.calls.map((call) => call.url)).toEqual([PRIMARY, FALLBACK]);
  });

  it('records every source when all of them fail, and decides nothing', async () => {
    const { engine } = retriever({
      [PRIMARY]: { kind: 'failure', failure: 'SOURCE_TIMEOUT' },
      [FALLBACK]: { kind: 'failure', failure: 'SOURCE_UNAVAILABLE' },
    });
    const result = await engine.retrieve(shipmentSpec());

    expect(result.primary).toBeNull();
    expect(result.failures).toHaveLength(2);
    expect(result.evidenceSources.every((source) => source.contentHash === null)).toBe(true);
    // Nothing anywhere in the result resembles an outcome.
    expect(JSON.stringify(result)).not.toMatch(/"(YES|NO|INVALID)"/);
  });
});

describe('failure classification', () => {
  const cases: ReadonlyArray<readonly [string, FakeSourceScript, string]> = [
    ['a scripted timeout', { kind: 'failure', failure: 'SOURCE_TIMEOUT' }, 'SOURCE_TIMEOUT'],
    [
      'an unreachable host',
      { kind: 'failure', failure: 'SOURCE_UNAVAILABLE' },
      'SOURCE_UNAVAILABLE',
    ],
    ['a 404', { kind: 'response', statusCode: 404 }, 'SOURCE_UNAVAILABLE'],
    ['a 403', { kind: 'response', statusCode: 403 }, 'SOURCE_FORBIDDEN'],
    ['a 500', { kind: 'response', statusCode: 500 }, 'SOURCE_UNAVAILABLE'],
    ['a 204 with no content', { kind: 'response', statusCode: 204 }, 'SOURCE_INVALID'],
    ['a 418', { kind: 'response', statusCode: 418 }, 'SOURCE_INVALID'],
    [
      'a wrong content type',
      { kind: 'response', body: TRACKING_JSON, contentType: 'text/html' },
      'SOURCE_INVALID',
    ],
    [
      'a missing content type',
      { kind: 'response', body: TRACKING_JSON, contentType: null },
      'SOURCE_INVALID',
    ],
    [
      'a body that is not JSON',
      { kind: 'response', body: '<html>nope</html>', contentType: 'application/json' },
      'SOURCE_MALFORMED',
    ],
    [
      'a dataPath that is not present',
      { kind: 'response', body: '{"shipment":{"state":"delivered"}}' },
      'SOURCE_INVALID',
    ],
    [
      'a JSON payload carrying a float',
      { kind: 'response', body: '{"shipment":{"status":1.5}}' },
      'SOURCE_MALFORMED',
    ],
    [
      'a body that is not valid UTF-8',
      { kind: 'response', bytes: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]) },
      'SOURCE_MALFORMED',
    ],
  ];

  for (const [label, script, expected] of cases) {
    it(`classifies ${label} as ${expected}`, async () => {
      const { engine } = retriever({ [PRIMARY]: script });
      const result = await engine.retrieve(shipmentSpec());
      expect(result.failures[0]?.failure).toBe(expected);
    });
  }

  it('maps every failure kind onto a protocol status, and never onto an outcome', async () => {
    for (const [kind, status] of Object.entries(FAILURE_TO_STATUS)) {
      expect(['UNAVAILABLE', 'MALFORMED'], kind).toContain(status);
    }
    // NOT_ATTEMPTED is reachable only by never trying, never by failing.
    expect(Object.values(FAILURE_TO_STATUS)).not.toContain('NOT_ATTEMPTED');
    expect(Object.values(FAILURE_TO_STATUS)).not.toContain('RETRIEVED');
  });

  it('reports a detail that carries no transport internals', async () => {
    const { engine } = retriever({ [PRIMARY]: { kind: 'response', statusCode: 500 } });
    const result = await engine.retrieve(shipmentSpec());
    const detail = result.failures[0]?.detail ?? '';
    expect(detail).toContain('500');
    expect(detail).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it('turns an unexpected error into a recorded failure rather than a crash', async () => {
    const engine = new EvidenceRetriever({
      adapters: [
        {
          name: 'broken',
          supports: () => true,
          retrieve: () => Promise.reject(new Error('something nobody classified')),
        },
      ],
      limits: { retryBackoffMs: 0 },
      now: () => NOW,
      sleep: async () => {},
    });
    const result = await engine.retrieve(shipmentSpec());
    expect(result.failures[0]?.failure).toBe('SOURCE_UNAVAILABLE');
    expect(result.failures[0]?.detail).toBe('retrieval failed unexpectedly');
  });

  it('records a retrieval kind no adapter can serve as unsupported', async () => {
    const spec = specWithSources([
      {
        name: 'Signed acceptance form',
        url: 'https://docs.example.test/acceptance.pdf',
        retrievalKind: 'manual_attestation',
        dataPath: null,
      },
    ]);
    const { engine, adapter } = retriever({});
    const result = await engine.retrieve(spec);

    expect(result.failures[0]?.failure).toBe('SOURCE_UNSUPPORTED');
    // Never even offered to the adapter — there is nothing to fetch.
    expect(adapter.calls).toHaveLength(0);
  });
});

describe('assertStatus', () => {
  it('accepts only 200', () => {
    expect(() => assertStatus(200)).not.toThrow();
    for (const status of [201, 202, 204, 206, 302, 400, 404, 500]) {
      expect(() => assertStatus(status), String(status)).toThrow(SourceRetrievalError);
    }
  });

  it('marks throttling and server failure retryable, and 404 not', () => {
    const kindOf = (status: number): SourceRetrievalError => {
      try {
        assertStatus(status);
      } catch (error) {
        return error as SourceRetrievalError;
      }
      throw new Error('expected a refusal');
    };

    expect(kindOf(429).retryable).toBe(true);
    expect(kindOf(503).retryable).toBe(true);
    // Definitive: the resource is not there, and asking again will not put it there.
    expect(kindOf(404).retryable).toBe(false);
    expect(kindOf(403).retryable).toBe(false);
  });
});

describe('retry policy', () => {
  it('retries a transient failure and succeeds on a later attempt', async () => {
    const { engine, adapter } = retriever({
      [PRIMARY]: [
        { kind: 'failure', failure: 'SOURCE_TIMEOUT', retryable: true },
        { kind: 'failure', failure: 'SOURCE_TIMEOUT', retryable: true },
        { kind: 'response', body: TRACKING_JSON },
      ],
    });
    const result = await engine.retrieve(shipmentSpec());

    expect(adapter.calls).toHaveLength(3);
    expect(result.primary?.attempts).toBe(3);
  });

  it('bounds the attempts', async () => {
    const { engine, adapter } = retriever(
      { [PRIMARY]: { kind: 'failure', failure: 'SOURCE_TIMEOUT', retryable: true } },
      { maxAttempts: 2 },
    );
    const result = await engine.retrieve(shipmentSpec());

    expect(adapter.calls.filter((call) => call.url === PRIMARY)).toHaveLength(2);
    expect(result.failures[0]?.attempts).toBe(2);
  });

  it('does not retry a definitive failure', async () => {
    // A 404 answered the question. Four more requests is a retry storm aimed at
    // a source that has already been clear.
    const { engine, adapter } = retriever({ [PRIMARY]: { kind: 'response', statusCode: 404 } });
    await engine.retrieve(shipmentSpec());
    expect(adapter.calls.filter((call) => call.url === PRIMARY)).toHaveLength(1);
  });

  it('does not retry a malformed body', async () => {
    const { engine, adapter } = retriever({
      [PRIMARY]: { kind: 'response', body: 'not json', contentType: 'application/json' },
    });
    await engine.retrieve(shipmentSpec());
    expect(adapter.calls.filter((call) => call.url === PRIMARY)).toHaveLength(1);
  });

  it('does not retry a policy refusal', async () => {
    const spec = specWithSources([
      { name: 'Internal', url: 'https://a.test:22/x', retrievalKind: 'http_json', dataPath: null },
    ]);
    const { engine, adapter } = retriever({});
    const result = await engine.retrieve(spec);

    expect(result.failures[0]?.failure).toBe('SOURCE_FORBIDDEN');
    expect(adapter.calls).toHaveLength(0);
  });
});

describe('bounds', () => {
  it('refuses an oversized response rather than truncating what it hashes', async () => {
    const { engine } = retriever(
      { [PRIMARY]: { kind: 'response', body: JSON.stringify({ blob: 'x'.repeat(5_000) }) } },
      { maxResponseBytes: 1_000 },
    );
    const result = await engine.retrieve(shipmentSpec());

    expect(result.failures[0]?.failure).toBe('SOURCE_INVALID');
    expect(result.failures[0]?.detail).toContain('1000-byte limit');
    expect(result.primary).toBeNull();
  });

  it('lets precedence rescue an oversized primary', async () => {
    const { engine } = retriever(
      {
        [PRIMARY]: { kind: 'response', body: JSON.stringify({ blob: 'x'.repeat(5_000) }) },
        [FALLBACK]: { kind: 'response', body: '<html>Delivered</html>', contentType: 'text/html' },
      },
      { maxResponseBytes: 1_000 },
    );
    const result = await engine.retrieve(shipmentSpec());
    expect(result.primary?.approvedSourceIndex).toBe(1);
  });

  it('truncates retained text and says so', async () => {
    const spec = specWithSources([
      { name: 'Page', url: FALLBACK, retrievalKind: 'http_html', dataPath: null },
    ]);
    const { engine } = retriever(
      {
        [FALLBACK]: {
          kind: 'response',
          body: `<p>${'word '.repeat(2_000)}</p>`,
          contentType: 'text/html',
        },
      },
      { maxRetainedChars: 500 },
    );
    const result = await engine.retrieve(spec);

    expect(result.primary?.normalizedTruncated).toBe(true);
    expect(result.primary?.normalizedContent.length).toBe(500);
    // The raw size is still on record, so a reader can see what was dropped.
    expect(result.primary?.rawBytes).toBeGreaterThan(500);
  });

  it('does not wait forever on an adapter that never returns', async () => {
    // The regression for a real defect: the https adapter bounded its connect
    // but not its DNS lookup, so a run in an environment with no reachable
    // resolver hung indefinitely instead of classifying as a timeout. The
    // retriever now refuses to wait on any transport past its deadline, whether
    // or not that transport believes it is bounded.
    const engine = new EvidenceRetriever({
      adapters: [
        {
          name: 'hangs',
          supports: () => true,
          retrieve: () => new Promise(() => {}),
        },
      ],
      limits: { timeoutMs: 20, maxAttempts: 1, retryBackoffMs: 0 },
      now: () => NOW,
      sleep: async () => {},
    });

    const result = await engine.retrieve(shipmentSpec());
    expect(result.failures[0]?.failure).toBe('SOURCE_TIMEOUT');
    expect(result.primary).toBeNull();
  }, 10_000);

  it('stops the walk when the total budget is exhausted', async () => {
    let clock = Date.now();
    const adapter = new FakeSourceAdapter({
      [PRIMARY]: { kind: 'failure', failure: 'SOURCE_UNAVAILABLE' },
      [FALLBACK]: { kind: 'response', body: '<html>x</html>', contentType: 'text/html' },
    });
    const engine = new EvidenceRetriever({
      adapters: [
        {
          name: 'slow',
          supports: (kind) => adapter.supports(kind),
          retrieve: async (request) => {
            clock += 10_000; // Each attempt burns ten seconds of the budget.
            return adapter.retrieve(request);
          },
        },
      ],
      limits: { totalBudgetMs: 5_000, retryBackoffMs: 0 },
      now: () => NOW,
      sleep: async () => {},
    });

    const realNow = Date.now;
    Date.now = () => clock;
    try {
      const result = await engine.retrieve(shipmentSpec());
      expect(result.skipped[0]?.reason).toBe('BUDGET_EXHAUSTED');
      expect(result.primary).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });
});

describe('SSRF: a hostile approved source never reaches a socket', () => {
  const hostile: ReadonlyArray<readonly [string, string]> = [
    ['https://127.0.0.1/admin', 'SOURCE_FORBIDDEN'],
    ['https://localhost.localdomain.test:22/x', 'SOURCE_FORBIDDEN'],
    ['https://169.254.169.254/latest/meta-data/', 'SOURCE_FORBIDDEN'],
    ['https://[::1]/x', 'SOURCE_FORBIDDEN'],
    ['https://10.0.0.5/internal', 'SOURCE_FORBIDDEN'],
    ['https://192.168.1.1/router', 'SOURCE_FORBIDDEN'],
    ['https://user:secret@api.example.test/x', 'SOURCE_FORBIDDEN'],
    ['https://a.test:6379/x', 'SOURCE_FORBIDDEN'],
  ];

  for (const [url, expected] of hostile) {
    it(`refuses ${url} before any adapter is called`, async () => {
      const spec = specWithSources([
        { name: 'Hostile', url, retrievalKind: 'http_json', dataPath: null },
      ]);
      const { engine, adapter } = retriever({ [url]: { kind: 'response', body: '{"a":1}' } });
      const result = await engine.retrieve(spec);

      expect(result.failures[0]?.failure).toBe(expected);
      expect(result.primary).toBeNull();
      // The point: the transport was never invited to make the request.
      expect(adapter.calls).toHaveLength(0);
    });
  }

  it('records the refused source with a null content hash and no retrieval', async () => {
    const spec = specWithSources([
      {
        name: 'Metadata',
        url: 'https://169.254.169.254/latest/meta-data/',
        retrievalKind: 'http_json',
        dataPath: null,
      },
    ]);
    const { engine } = retriever({});
    const result = await engine.retrieve(spec);

    expect(result.evidenceSources[0]?.status).toBe('UNAVAILABLE');
    expect(result.evidenceSources[0]?.contentHash).toBeNull();
  });
});

describe('duplicate sources', () => {
  it('reads a normalised duplicate once and reuses the read', async () => {
    // The ConditionSpec schema already rejects two *identical* approved URLs.
    // These two differ textually and are the same request, which is the case a
    // string comparison misses.
    const spec = specWithSources([
      { name: 'API', url: 'https://api.example.test/x#one', retrievalKind: 'http_json', dataPath: null },
      { name: 'API mirror', url: 'https://api.example.test/x#two', retrievalKind: 'http_json', dataPath: null },
    ]);
    const { engine, adapter } = retriever({
      'https://api.example.test/x': { kind: 'failure', failure: 'SOURCE_UNAVAILABLE' },
    });
    const result = await engine.retrieve(spec);

    // The first failed, so the second was attempted — and, being the same URL,
    // it is attempted rather than assumed. Both are on record.
    expect(result.failures).toHaveLength(2);
    expect(adapter.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('does not fetch the same URL twice once one read has succeeded', async () => {
    const spec = specWithSources([
      { name: 'API', url: 'https://api.example.test/x', retrievalKind: 'http_json', dataPath: null },
      { name: 'Mirror', url: 'https://api.example.test/x?', retrievalKind: 'http_json', dataPath: null },
    ]);
    const { engine, adapter } = retriever({
      'https://api.example.test/x': { kind: 'response', body: '{"a":1}' },
    });
    const result = await engine.retrieve(spec);

    expect(adapter.calls).toHaveLength(1);
    expect(result.primary?.approvedSourceIndex).toBe(0);
    expect(result.skipped.map((entry) => entry.approvedSourceIndex)).toEqual([1]);
  });

  it('gives every approved position its own source id', async () => {
    const { engine } = retriever({ [PRIMARY]: { kind: 'response', body: TRACKING_JSON } });
    const result = await engine.retrieve(shipmentSpec());
    const ids = result.evidenceSources.map((source) => source.sourceId);

    expect(ids).toEqual([sourceIdForIndex(0), sourceIdForIndex(1)]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the ConditionSpec is an input, never a workspace', () => {
  it('leaves the specification byte-identical', async () => {
    const spec = shipmentSpec();
    const before = JSON.stringify(spec);

    const { engine } = retriever({
      [PRIMARY]: { kind: 'failure', failure: 'SOURCE_UNAVAILABLE' },
      [FALLBACK]: { kind: 'response', body: '<html>x</html>', contentType: 'text/html' },
    });
    await engine.retrieve(spec);

    // A retriever that edited the spec would change its rulesHash and unbind
    // every market that references it.
    expect(JSON.stringify(spec)).toBe(before);
  });

  it('records the specification URL verbatim, not the normalised one', async () => {
    const spec = specWithSources([
      { name: 'API', url: 'https://API.example.test/x#frag', retrievalKind: 'http_json', dataPath: null },
    ]);
    const { engine, adapter } = retriever({
      'https://api.example.test/x': { kind: 'response', body: '{"a":1}' },
    });
    const result = await engine.retrieve(spec);

    // Requested in normalised form...
    expect(adapter.calls[0]?.url).toBe('https://api.example.test/x');
    // ...recorded as the specification wrote it, because
    // buildEvidenceCommitmentForSpec requires exact equality with the approved
    // URL. Normalisation decides what is requested; the spec decides what is
    // recorded.
    expect(result.evidenceSources[0]?.url).toBe('https://API.example.test/x#frag');
    expect(result.primary?.normalizedUrl).toBe('https://api.example.test/x');
  });
});

describe('integration with EvidencePackage v2.0', () => {
  it('produces source records that bind to the specification', async () => {
    const spec = shipmentSpec();
    const { engine } = retriever({ [PRIMARY]: { kind: 'response', body: TRACKING_JSON } });
    const result = await engine.retrieve(spec);

    const evidence: EvidencePackageV2Input = {
      version: '2.0',
      chainId: 1952,
      marketId: '7',
      marketAddress: '0x3333333333333333333333333333333333333333',
      rulesHash: '0x739735cae491d20d3242742eda9d9efcdf1ef0e6d34a2cbca7555ed868ff6e97',
      outcome: 'YES',
      confidenceBps: 9800,
      reasoning:
        'The primary approved source reported status "delivered" before the deadline. Recorded here only to exercise the retrieval-to-package seam; M5.2 decides no outcomes.',
      sources: [...result.evidenceSources],
      claims: [],
      deterministicChecks: [],
      resolver: { version: '1.0.0', model: null },
      resolvedAt: '2026-09-02T00:06:00Z',
    };

    // The whole §10 integration in one assertion: what retrieval emits is
    // exactly what the M5.1 builder accepts, binding included.
    const commitment = buildEvidenceCommitmentForSpec(spec, evidence);
    expect(commitment.rulesHash).toBe(
      '0x739735cae491d20d3242742eda9d9efcdf1ef0e6d34a2cbca7555ed868ff6e97',
    );
    expect(commitment.evidenceHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('produces records the package accepts when every source failed', async () => {
    const spec = shipmentSpec();
    const { engine } = retriever({
      [PRIMARY]: { kind: 'failure', failure: 'SOURCE_TIMEOUT' },
      [FALLBACK]: { kind: 'response', statusCode: 500 },
    });
    const result = await engine.retrieve(spec);

    const evidence: EvidencePackageV2Input = {
      version: '2.0',
      chainId: 1952,
      marketId: '7',
      marketAddress: '0x3333333333333333333333333333333333333333',
      rulesHash: '0x739735cae491d20d3242742eda9d9efcdf1ef0e6d34a2cbca7555ed868ff6e97',
      outcome: 'INVALID',
      confidenceBps: 0,
      reasoning:
        'Neither approved source could be read within the resolution window, so the condition cannot be decided on approved evidence.',
      sources: [...result.evidenceSources],
      claims: [],
      deterministicChecks: [],
      resolver: { version: '1.0.0', model: null },
      resolvedAt: '2026-09-02T00:06:00Z',
    };

    expect(() => buildEvidenceCommitmentForSpec(spec, evidence)).not.toThrow();
  });

  it('records an unused fallback as NOT_ATTEMPTED rather than omitting it', async () => {
    const { engine } = retriever({ [PRIMARY]: { kind: 'response', body: TRACKING_JSON } });
    const result = await engine.retrieve(shipmentSpec());

    expect(result.evidenceSources).toHaveLength(2);
    expect(result.evidenceSources[0]?.status).toBe('RETRIEVED');
    expect(result.evidenceSources[1]?.status).toBe('NOT_ATTEMPTED');
    expect(result.evidenceSources[1]?.contentHash).toBeNull();
  });

  it('orders the records by approved-source position', async () => {
    const { engine } = retriever({
      [PRIMARY]: { kind: 'failure', failure: 'SOURCE_UNAVAILABLE' },
      [FALLBACK]: { kind: 'response', body: '<html>x</html>', contentType: 'text/html' },
    });
    const result = await engine.retrieve(shipmentSpec());

    expect(result.evidenceSources.map((source) => source.approvedSourceIndex)).toEqual([0, 1]);
  });

  it('never emits a status the retrieval layer is not entitled to invent', async () => {
    const { engine } = retriever({ [PRIMARY]: { kind: 'response', body: TRACKING_JSON } });
    const result = await engine.retrieve(shipmentSpec());
    for (const source of result.evidenceSources) {
      expect(['RETRIEVED', 'UNAVAILABLE', 'MALFORMED', 'NOT_ATTEMPTED']).toContain(source.status);
    }
  });
});

describe('normalisation helpers', () => {
  it('resolves a JSON pointer, including escapes and array indices', () => {
    const document = { 'a/b': { '~c': [10, 20] }, list: [{ v: 1 }] };
    expect(resolveJsonPointer(document, '/a~1b/~0c/1')).toBe(20);
    expect(resolveJsonPointer(document, '/list/0/v')).toBe(1);
    expect(resolveJsonPointer(document, '')).toBe(document);
  });

  it('returns undefined rather than guessing when a pointer misses', () => {
    const document = { a: { b: 1 } };
    expect(resolveJsonPointer(document, '/a/c')).toBeUndefined();
    expect(resolveJsonPointer(document, '/a/b/c')).toBeUndefined();
    expect(resolveJsonPointer(document, '/list/0')).toBeUndefined();
    expect(resolveJsonPointer(document, 'no-leading-slash')).toBeUndefined();
  });

  it('distinguishes a null value from a missing one', () => {
    // `null` is a legitimate answer; `undefined` means "not there". Collapsing
    // them would make a source that publishes null look like one that has
    // stopped publishing the field at all.
    expect(resolveJsonPointer({ a: null }, '/a')).toBeNull();
    expect(resolveJsonPointer({ a: null }, '/b')).toBeUndefined();
  });

  it('drops script and style content from HTML text', () => {
    const html =
      '<html><head><style>.a{color:red}</style><script>var x=1;</script></head>' +
      '<body><h1>Status</h1><p>Delivered&nbsp;on 28 Aug</p><!-- hidden --></body></html>';
    const text = htmlToText(html);

    expect(text).toBe('Status Delivered on 28 Aug');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('var x');
  });

  it('is stable across cosmetic churn', () => {
    const a = htmlToText('<p>Delivered</p>\n<p>28 Aug</p>');
    const b = htmlToText('<p  class="x">Delivered</p><p>28   Aug</p>');
    expect(a).toBe(b);
  });
});
