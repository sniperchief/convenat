/**
 * EvidencePackage v2.0: the schema, the ordering decisions, and the hash.
 *
 * Three questions this file exists to answer, and they are different questions:
 *
 * 1. Does semantically identical evidence produce an identical `evidenceHash`?
 * 2. Does any meaningful change produce a different one?
 * 3. Does every malformed input fail as a *typed* validation error naming the
 *    offending field, rather than as a raw runtime exception?
 *
 * The third matters as much as the first two. A resolution engine feeds this
 * schema output that a model had a hand in producing; anything that escapes the
 * typed model surfaces as a 500 instead of a field-level refusal, and a 500 is
 * indistinguishable from the backend being broken.
 */

import { describe, expect, it } from 'vitest';

import {
  buildEvidenceCommitment,
  CanonicalizationError,
  canonicalizeEvidencePackage,
  CovenantError,
  CURRENT_EVIDENCE_PACKAGE_VERSION,
  EvidenceValidationError,
  hashConditionSpec,
  hashEvidencePackage,
  SUPPORTED_EVIDENCE_PACKAGE_VERSIONS,
  UNORDERED_FIELDS,
  unorderedFieldsForEvidenceVersion,
  validateEvidencePackage,
  type EvidencePackageV2Input,
} from '../src/index.js';
import {
  conditionSpecFixtures,
  evidencePackageFixtures,
  evidencePackageV2Fixtures,
} from '../src/testing/fixtures.js';
import { shuffleDeterministically, throughJson, withReversedKeys } from './helpers.js';

const evidence = evidencePackageV2Fixtures.shipmentYes;
const baseline = hashEvidencePackage(evidence);

/** Build a variant of the base package. Keeps every mutation a one-line diff. */
function variant(patch: Partial<EvidencePackageV2Input>): EvidencePackageV2Input {
  return { ...evidence, ...patch };
}

describe('version handling', () => {
  it('produces v2.0 and still accepts v1.0', () => {
    expect(CURRENT_EVIDENCE_PACKAGE_VERSION).toBe('2.0');
    expect([...SUPPORTED_EVIDENCE_PACKAGE_VERSIONS]).toEqual(['1.0', '2.0']);
    expect(validateEvidencePackage(evidencePackageFixtures.delivered).ok).toBe(true);
    expect(validateEvidencePackage(evidence).ok).toBe(true);
  });

  it('refuses a version this build does not know, naming the field', () => {
    const result = validateEvidencePackage({ ...evidence, version: '3.0' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.path).toBe('version');
    expect(result.issues[0]?.message).toContain('"1.0"');
    expect(result.issues[0]?.message).toContain('"2.0"');
  });

  it('does not let a version label change what a document is', () => {
    // A v1.0 body labelled 2.0 is not a v2.0 package, and vice versa.
    expect(() => hashEvidencePackage({ ...evidencePackageFixtures.delivered, version: '2.0' })).toThrow(
      EvidenceValidationError,
    );
    expect(() => hashEvidencePackage({ ...evidence, version: '1.0' })).toThrow(
      EvidenceValidationError,
    );
  });

  it('refuses anything that is not a JSON object', () => {
    for (const input of [null, undefined, 42, 'a package', [], true]) {
      expect(() => hashEvidencePackage(input)).toThrow(EvidenceValidationError);
    }
  });

  it('has no canonical ordering rules for an unknown version', () => {
    // Refusing beats guessing: defaulting to "nothing is unordered" would hash a
    // future document under the wrong rules and look like it had worked.
    expect(() => unorderedFieldsForEvidenceVersion('9.9')).toThrow(CanonicalizationError);
    expect(unorderedFieldsForEvidenceVersion('1.0')).toEqual([]);
    expect(unorderedFieldsForEvidenceVersion('2.0')).toEqual(['claims']);
  });
});

describe('output shape', () => {
  it('hashes every v2.0 fixture to a lowercase bytes32', () => {
    for (const fixture of Object.values(evidencePackageV2Fixtures)) {
      expect(hashEvidencePackage(fixture)).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });
});

describe('determinism: identical evidence hashes identically', () => {
  it('returns the same hash on repeated execution', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(hashEvidencePackage(evidence)).toBe(baseline);
    }
  });

  it('is unaffected by a JSON round trip', () => {
    expect(hashEvidencePackage(throughJson(evidence))).toBe(baseline);
  });

  it('is unaffected by key insertion order at every depth', () => {
    const reordered = withReversedKeys({
      ...evidence,
      resolver: withReversedKeys(evidence.resolver),
      sources: evidence.sources.map((source) => withReversedKeys(source)),
      claims: evidence.claims.map((claim) => ({
        ...withReversedKeys(claim),
        extraction: withReversedKeys(claim.extraction),
      })),
      deterministicChecks: evidence.deterministicChecks.map((check) => withReversedKeys(check)),
    }) as EvidencePackageV2Input;
    expect(hashEvidencePackage(reordered)).toBe(baseline);
  });

  it('is unaffected by surrounding whitespace in text fields', () => {
    const padded = variant({
      reasoning: `  ${evidence.reasoning}\n`,
      claims: evidence.claims.map((claim) => ({ ...claim, statement: ` ${claim.statement} ` })),
    });
    expect(hashEvidencePackage(padded)).toBe(baseline);
  });

  it('is unaffected by hex casing in addresses and hashes', () => {
    const shouted = variant({
      marketAddress: evidence.marketAddress.toUpperCase().replace('0X', '0x'),
      rulesHash: evidence.rulesHash.toUpperCase().replace('0X', '0x'),
      sources: evidence.sources.map((source) => ({
        ...source,
        contentHash: source.contentHash!.toUpperCase().replace('0X', '0x'),
      })),
    });
    expect(hashEvidencePackage(shouted)).toBe(baseline);
  });

  it('is unaffected by timestamp representation: offsets and sub-second precision', () => {
    // 00:05:30Z, +01:00 with the hour added, and a sub-second component that the
    // protocol truncates, are all the same instant at one-second resolution.
    const rewritten = variant({
      resolvedAt: '2026-09-02T01:05:30.499+01:00',
      sources: evidence.sources.map((source) => ({
        ...source,
        retrievedAt: '2026-09-01T19:05:00.000-05:00',
      })),
    });
    expect(hashEvidencePackage(rewritten)).toBe(baseline);
  });

  it('reads no clock', () => {
    const { canonical } = buildEvidenceCommitment(evidence);
    expect(canonical).toContain('"resolvedAt":"2026-09-02T00:05:30Z"');
    expect(hashEvidencePackage(evidence)).toBe(baseline);
  });

  it('omitting an optional-with-default field matches writing it as null', () => {
    const withoutExplanation = variant({
      deterministicChecks: evidence.deterministicChecks.map(({ explanation: _drop, ...rest }) => rest),
    });
    const withNullExplanation = variant({
      deterministicChecks: evidence.deterministicChecks.map((check) => ({
        ...check,
        explanation: null,
      })),
    });
    expect(hashEvidencePackage(withoutExplanation)).toBe(hashEvidencePackage(withNullExplanation));
  });
});

describe('ordering: three collections, three answers', () => {
  it('treats claims as an unordered set — permuting them does not change the hash', () => {
    const source = evidencePackageV2Fixtures.multiClaim;
    const expected = hashEvidencePackage(source);

    for (let seed = 0; seed < 12; seed += 1) {
      const permuted = { ...source, claims: shuffleDeterministically(source.claims, seed) };
      expect(hashEvidencePackage(permuted), `seed ${seed}`).toBe(expected);
    }
  });

  it('sorts claims into one canonical order regardless of how they arrive', () => {
    const source = evidencePackageV2Fixtures.multiClaim;
    const forward = canonicalizeEvidencePackage(source).canonical;
    const reversed = canonicalizeEvidencePackage({
      ...source,
      claims: [...source.claims].reverse(),
    }).canonical;
    expect(reversed).toBe(forward);
  });

  it('declares exactly one unordered field for v2.0, and it is claims', () => {
    expect([...UNORDERED_FIELDS.evidencePackageV2]).toEqual(['claims']);
  });

  it('treats sources as ordered — precedence is part of the record', () => {
    const forward = hashEvidencePackage(evidencePackageV2Fixtures.multiSource);
    const swapped = hashEvidencePackage(evidencePackageV2Fixtures.sourceOrderSwapped);
    expect(swapped).not.toBe(forward);
  });

  it('keeps sources in the caller-supplied order in the canonical output', () => {
    const { canonical } = buildEvidenceCommitment(evidencePackageV2Fixtures.multiSource);
    // Scoped to the sources array: both ids also appear in `claims` and
    // `deterministicChecks`, which JCS emits earlier because keys sort
    // alphabetically. A bare indexOf would be measuring the wrong block.
    const sourcesBlock = canonical.slice(canonical.indexOf('"sources":['));
    expect(sourcesBlock.indexOf('"carrier-api"')).toBeGreaterThan(-1);
    expect(sourcesBlock.indexOf('"carrier-api"')).toBeLessThan(
      sourcesBlock.indexOf('"carrier-page"'),
    );
  });

  it('treats deterministic checks as ordered — execution sequence is the record', () => {
    const source = evidencePackageV2Fixtures.multiSource;
    const permuted = {
      ...source,
      deterministicChecks: [...source.deterministicChecks].reverse(),
    };
    expect(hashEvidencePackage(permuted)).not.toBe(hashEvidencePackage(source));
  });

  it('rejects a duplicated claim rather than silently collapsing it', () => {
    // `claims` is a declared unordered set, and a set with repeats is ambiguous.
    // Caught at validation as a duplicate id, so the caller gets a field path
    // rather than a canonicalisation failure.
    const duplicated = variant({ claims: [evidence.claims[0]!, evidence.claims[0]!] });
    const result = validateEvidencePackage(duplicated);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.path === 'claims[1].claimId')).toBe(true);
  });
});

describe('sensitivity: a meaningful change changes the hash', () => {
  const mutations: ReadonlyArray<readonly [string, EvidencePackageV2Input]> = [
    ['the outcome', variant({ outcome: 'NO' })],
    ['the outcome to INVALID', variant({ outcome: 'INVALID' })],
    ['the confidence', variant({ confidenceBps: 9799 })],
    ['the reasoning', variant({ reasoning: `${evidence.reasoning} Confirmed twice.` })],
    [
      'the rules binding',
      variant({
        rulesHash: '0x0000000000000000000000000000000000000000000000000000000000000001',
      }),
    ],
    ['the chain id', variant({ chainId: 196 })],
    ['the market id', variant({ marketId: '8' })],
    [
      'the market address',
      variant({ marketAddress: '0x7777777777777777777777777777777777777777' }),
    ],
    ['the resolution time', variant({ resolvedAt: '2026-09-02T00:05:31Z' })],
    ['the resolver version', variant({ resolver: { version: '1.0.1', model: null } })],
    [
      'the resolver model',
      variant({ resolver: { version: '1.0.0', model: 'claude-haiku-4-5-20251001' } }),
    ],
    [
      "a source's content hash",
      variant({
        sources: [
          {
            ...evidence.sources[0]!,
            contentHash:
              '0x9999999999999999999999999999999999999999999999999999999999999999',
          },
        ],
      }),
    ],
    [
      "a source's retrieval time",
      variant({ sources: [{ ...evidence.sources[0]!, retrievedAt: '2026-09-02T00:04:00Z' }] }),
    ],
    [
      "a source's retrieval status",
      variant({
        sources: [{ ...evidence.sources[0]!, status: 'MALFORMED', contentHash: null }],
      }),
    ],
    [
      'which approved source was read',
      variant({
        sources: [
          {
            ...evidence.sources[0]!,
            approvedSourceIndex: 1,
            url: 'https://www.example-carrier.test/track?id=1Z999AA10123456784',
          },
        ],
      }),
    ],
    [
      'a claim value',
      variant({
        claims: [
          { ...evidence.claims[0]!, value: 'in transit' },
          evidence.claims[1]!,
        ],
      }),
    ],
    [
      'a claim support status',
      variant({
        claims: [
          { ...evidence.claims[0]!, support: 'DISPUTED' },
          evidence.claims[1]!,
        ],
      }),
    ],
    [
      'how a claim was extracted',
      variant({
        claims: [
          { ...evidence.claims[0]!, extraction: { method: 'MODEL_EXTRACTION', locator: null } },
          evidence.claims[1]!,
        ],
      }),
    ],
    [
      'an extraction locator',
      variant({
        claims: [
          {
            ...evidence.claims[0]!,
            extraction: { method: 'JSON_POINTER', locator: '/shipment/state' },
          },
          evidence.claims[1]!,
        ],
      }),
    ],
    [
      'a claim identifier',
      variant({
        claims: [
          { ...evidence.claims[0]!, claimId: 'status' },
          evidence.claims[1]!,
        ],
      }),
    ],
    ['dropping a claim', variant({ claims: [evidence.claims[0]!] })],
    [
      'a deterministic check result',
      variant({
        deterministicChecks: [
          { ...evidence.deterministicChecks[0]!, result: 'FAIL', observed: 'in_transit' },
          evidence.deterministicChecks[1]!,
        ],
      }),
    ],
    [
      'what a deterministic check expected',
      variant({
        deterministicChecks: [
          { ...evidence.deterministicChecks[0]!, expected: 'shipment status == "shipped"' },
          evidence.deterministicChecks[1]!,
        ],
      }),
    ],
    [
      'what a deterministic check observed',
      variant({
        deterministicChecks: [
          { ...evidence.deterministicChecks[0]!, observed: 'DELIVERED' },
          evidence.deterministicChecks[1]!,
        ],
      }),
    ],
    [
      'which validator a check claims to be',
      variant({
        deterministicChecks: [
          { ...evidence.deterministicChecks[0]!, checkType: 'BOOLEAN_MATCH' },
          evidence.deterministicChecks[1]!,
        ],
      }),
    ],
    [
      "a check's explanation",
      variant({
        deterministicChecks: [
          { ...evidence.deterministicChecks[0]!, explanation: 'Matched after normalisation.' },
          evidence.deterministicChecks[1]!,
        ],
      }),
    ],
    ['dropping a deterministic check', variant({ deterministicChecks: [evidence.deterministicChecks[0]!] })],
  ];

  for (const [label, mutated] of mutations) {
    it(`changes when ${label} changes`, () => {
      expect(hashEvidencePackage(mutated)).not.toBe(baseline);
    });
  }

  it('gives every shipped fixture a distinct hash', () => {
    const hashes = Object.values(evidencePackageFixtures).map(hashEvidencePackage);
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});

describe('independence from storage and infrastructure', () => {
  const rejected: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['a database row id', { id: 4212 }],
    ['a uuid primary key', { id: '0d1b1f4e-1f4a-4a1e-9a3f-3f2b8b0a1c2d' }],
    ['an insertion timestamp', { createdAt: '2026-09-02T00:06:00Z' }],
    ['an updated-at column', { updatedAt: '2026-09-02T00:06:00Z' }],
    ['a request id', { requestId: 'req_01HZX' }],
    ['a trace id', { traceId: '4bf92f3577b34da6a3ce929d0e0e4736' }],
    ['an api key', { apiKey: 'sk-not-a-real-key' }],
    ['a retry counter', { attempts: 3 }],
    ['a transaction hash the chain has not produced yet', { proposalTxHash: `0x${'ab'.repeat(32)}` }],
  ];

  for (const [label, extra] of rejected) {
    it(`rejects a package carrying ${label} rather than ignoring it`, () => {
      expect(() => hashEvidencePackage({ ...evidence, ...extra })).toThrow(
        EvidenceValidationError,
      );
    });
  }

  it('rejects transport metadata inside a source', () => {
    for (const extra of [
      { httpStatus: 200 },
      { contentType: 'application/json' },
      { latencyMs: 412 },
      { responseHeaders: { etag: 'W/"abc"' } },
    ]) {
      const polluted = variant({
        sources: [{ ...evidence.sources[0]!, ...extra } as (typeof evidence.sources)[number]],
      });
      expect(() => hashEvidencePackage(polluted)).toThrow(EvidenceValidationError);
    }
  });

  it('hashes a package restored from a jsonb column identically', () => {
    const stored = JSON.parse(JSON.stringify({ ...evidence, _rowId: 9 })) as Record<
      string,
      unknown
    >;
    delete stored['_rowId'];
    expect(hashEvidencePackage(stored)).toBe(baseline);
  });
});

describe('invalid input is never hashed', () => {
  const invalid: ReadonlyArray<readonly [string, unknown]> = [
    ['an empty object', {}],
    ['an outcome outside the closed vocabulary', variant({ outcome: 'MAYBE' as never })],
    ['UNSET, which is on-chain but must never be proposed', variant({ outcome: 'UNSET' as never })],
    ['a resolver status masquerading as an outcome', variant({ outcome: 'NEEDS_REVIEW' as never })],
    ['a lowercase outcome', variant({ outcome: 'yes' as never })],
    ['a fractional confidence', variant({ confidenceBps: 0.98 })],
    ['a confidence above 100 per cent', variant({ confidenceBps: 10_001 })],
    ['a negative confidence', variant({ confidenceBps: -1 })],
    ['a confidence expressed as a string', variant({ confidenceBps: '9800' as never })],
    ['a confidence that is not a safe integer', variant({ confidenceBps: 2 ** 53 })],
    ['a chain id that is not a safe integer', variant({ chainId: 2 ** 53 })],
    ['a chain id of zero', variant({ chainId: 0 })],
    ['a market id that is not an integer string', variant({ marketId: '7.5' })],
    ['a market id with a leading zero', variant({ marketId: '07' })],
    ['a market id beyond uint256', variant({ marketId: '1'.repeat(80) })],
    ['a malformed market address', variant({ marketAddress: '0x123' })],
    ['a malformed rules hash', variant({ rulesHash: '0xabc' })],
    ['a rules hash with no 0x prefix', variant({ rulesHash: 'a'.repeat(64) })],
    ['zero sources', variant({ sources: [] })],
    ['an empty reasoning', variant({ reasoning: '   ' })],
    ['a malformed resolver version', variant({ resolver: { version: 'v1', model: null } })],
    ['an unknown extra field', { ...evidence, notes: 'hello' }],
    [
      'a source identifier with uppercase, which would be a second name for one thing',
      variant({ sources: [{ ...evidence.sources[0]!, sourceId: 'Carrier-API' }] }),
    ],
    [
      'a malformed content hash',
      variant({ sources: [{ ...evidence.sources[0]!, contentHash: '0xabc' }] }),
    ],
    [
      'an approved source index beyond what any specification may hold',
      variant({ sources: [{ ...evidence.sources[0]!, approvedSourceIndex: 8 }] }),
    ],
    [
      'a negative approved source index',
      variant({ sources: [{ ...evidence.sources[0]!, approvedSourceIndex: -1 }] }),
    ],
    [
      'a plain http source url',
      variant({ sources: [{ ...evidence.sources[0]!, url: 'http://api.example-carrier.test/x' }] }),
    ],
    [
      'a url embedding credentials',
      variant({
        sources: [
          { ...evidence.sources[0]!, url: 'https://user:hunter2@api.example-carrier.test/v1' },
        ],
      }),
    ],
    [
      'a url carrying an api key in the query string',
      variant({
        sources: [
          { ...evidence.sources[0]!, url: 'https://api.example-carrier.test/v1?api_key=abc123' },
        ],
      }),
    ],
    [
      'a url carrying an access token',
      variant({
        sources: [
          {
            ...evidence.sources[0]!,
            url: 'https://api.example-carrier.test/v1?id=1&access_token=abc',
          },
        ],
      }),
    ],
    [
      'a retrieved source with no content hash',
      variant({ sources: [{ ...evidence.sources[0]!, contentHash: null }] }),
    ],
    [
      'an unavailable source that hashes bytes it never received',
      variant({ sources: [{ ...evidence.sources[0]!, status: 'UNAVAILABLE' }] }),
    ],
    [
      'a retrieval status outside the vocabulary',
      variant({ sources: [{ ...evidence.sources[0]!, status: 'TIMEOUT' as never }] }),
    ],
    [
      'two sources sharing an identifier',
      variant({
        sources: [evidence.sources[0]!, { ...evidence.sources[0]!, approvedSourceIndex: 1 }],
      }),
    ],
    [
      'a claim citing a source that is not present',
      variant({ claims: [{ ...evidence.claims[0]!, sourceIds: ['no-such-source'] }] }),
    ],
    [
      'a claim citing no source at all',
      variant({ claims: [{ ...evidence.claims[0]!, sourceIds: [] }] }),
    ],
    [
      'a claim citing the same source twice',
      variant({
        claims: [{ ...evidence.claims[0]!, sourceIds: ['carrier-api', 'carrier-api'] }],
      }),
    ],
    [
      'two claims sharing an identifier',
      variant({ claims: [evidence.claims[0]!, { ...evidence.claims[0]!, value: 'other' }] }),
    ],
    [
      'an unsupported claim that still carries a value',
      variant({ claims: [{ ...evidence.claims[0]!, support: 'UNSUPPORTED' }] }),
    ],
    [
      'a supported claim with no value',
      variant({ claims: [{ ...evidence.claims[0]!, value: null }] }),
    ],
    [
      'a deterministic extraction that does not name its locator',
      variant({
        claims: [
          { ...evidence.claims[0]!, extraction: { method: 'JSON_POINTER', locator: null } },
        ],
      }),
    ],
    [
      'a model extraction pretending to have a locator',
      variant({
        claims: [
          {
            ...evidence.claims[0]!,
            extraction: { method: 'MODEL_EXTRACTION', locator: '/shipment/status' },
          },
        ],
      }),
    ],
    [
      'an extraction method outside the vocabulary',
      variant({
        claims: [
          { ...evidence.claims[0]!, extraction: { method: 'EYEBALL' as never, locator: null } },
        ],
      }),
    ],
    [
      'a claim value type outside the vocabulary',
      variant({ claims: [{ ...evidence.claims[0]!, valueType: 'float' as never }] }),
    ],
    [
      'a check citing a source that is not present',
      variant({
        deterministicChecks: [
          { ...evidence.deterministicChecks[0]!, sourceIds: ['ghost'] },
          evidence.deterministicChecks[1]!,
        ],
      }),
    ],
    [
      'two checks sharing an identifier',
      variant({
        deterministicChecks: [
          evidence.deterministicChecks[0]!,
          { ...evidence.deterministicChecks[0]!, result: 'FAIL' },
        ],
      }),
    ],
    [
      'a check type this build cannot run',
      variant({
        deterministicChecks: [
          { ...evidence.deterministicChecks[0]!, checkType: 'VIBES_MATCH' as never },
          evidence.deterministicChecks[1]!,
        ],
      }),
    ],
    [
      'a check result outside the vocabulary',
      variant({
        deterministicChecks: [
          { ...evidence.deterministicChecks[0]!, result: 'MAYBE' as never },
          evidence.deterministicChecks[1]!,
        ],
      }),
    ],
    [
      'a passing check that observed nothing',
      variant({
        deterministicChecks: [
          { ...evidence.deterministicChecks[0]!, observed: null },
          evidence.deterministicChecks[1]!,
        ],
      }),
    ],
    [
      'an indeterminate check that reports an observation anyway',
      variant({
        deterministicChecks: [
          { ...evidence.deterministicChecks[0]!, result: 'INDETERMINATE' },
          evidence.deterministicChecks[1]!,
        ],
      }),
    ],
    [
      'a local date-time with no offset',
      variant({ resolvedAt: '2026-09-02T00:05:30' as never }),
    ],
    ['a date that is not a real calendar date', variant({ resolvedAt: '2026-02-31T00:00:00Z' })],
    ['a date before the Unix epoch', variant({ resolvedAt: '1969-01-01T00:00:00Z' })],
    ['a date-shaped string that is not a date', variant({ resolvedAt: 'yesterday' })],
    [
      'evidence retrieved after the resolution was produced',
      variant({ sources: [{ ...evidence.sources[0]!, retrievedAt: '2026-09-03T00:00:00Z' }] }),
    ],
  ];

  for (const [label, input] of invalid) {
    it(`refuses to hash ${label}`, () => {
      expect(() => hashEvidencePackage(input)).toThrow(EvidenceValidationError);
    });
  }

  it('never lets a raw runtime error escape the typed error model', () => {
    for (const [label, input] of invalid) {
      try {
        hashEvidencePackage(input);
        expect.unreachable(`${label} should have thrown`);
      } catch (error) {
        expect(error, label).toBeInstanceOf(CovenantError);
      }
    }
  });

  it('anchors an issue to the offending array element', () => {
    const result = validateEvidencePackage(
      variant({
        claims: [evidence.claims[0]!, { ...evidence.claims[1]!, sourceIds: ['ghost'] }],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.path === 'claims[1].sourceIds[0]')).toBe(true);
  });

  it('reports every problem at once rather than the first', () => {
    const result = validateEvidencePackage(
      variant({ confidenceBps: -1, marketAddress: '0x123', reasoning: '' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.length).toBeGreaterThanOrEqual(3);
  });
});

describe('the fixtures bind to the specification they claim to resolve', () => {
  it('carries the frozen rulesHash of the shipment specification', () => {
    // The fixtures hard-code this hash rather than computing it. If either side
    // drifts, this is what says so.
    expect(evidence.rulesHash).toBe(hashConditionSpec(conditionSpecFixtures.shipment));
  });

  it('binds the other-rules fixture to a genuinely different specification', () => {
    expect(evidencePackageV2Fixtures.otherRules.rulesHash).toBe(
      hashConditionSpec(conditionSpecFixtures.productLaunch),
    );
    expect(evidencePackageV2Fixtures.otherRules.rulesHash).not.toBe(evidence.rulesHash);
  });
});
