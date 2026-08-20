/**
 * evidenceHash: determinism, sensitivity, storage-independence, and refusal to
 * hash invalid input.
 */

import { describe, expect, it } from 'vitest';

import {
  assertEvidenceHash,
  buildEvidenceCommitment,
  CovenantError,
  EvidenceValidationError,
  hashEvidencePackage,
  HashMismatchError,
  isBytes32Hex,
  verifyEvidenceHash,
  type EvidencePackageInput,
} from '../src/index.js';
import { evidencePackageFixtures } from '../src/testing/fixtures.js';
import { throughJson, withReversedKeys } from './helpers.js';

const evidence = evidencePackageFixtures.delivered;
const baseline = hashEvidencePackage(evidence);

describe('output shape', () => {
  it('is a lowercase 0x-prefixed 32-byte hex string', () => {
    for (const fixture of Object.values(evidencePackageFixtures)) {
      const hash = hashEvidencePackage(fixture);
      expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(isBytes32Hex(hash)).toBe(true);
    }
  });
});

describe('determinism', () => {
  it('returns the same hash on repeated execution', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(hashEvidencePackage(evidence)).toBe(baseline);
    }
  });

  it('is unaffected by a JSON round trip', () => {
    expect(hashEvidencePackage(throughJson(evidence))).toBe(baseline);
  });

  it('is unaffected by key insertion order', () => {
    const reordered = withReversedKeys({
      ...evidence,
      resolver: withReversedKeys(evidence.resolver),
      sources: evidence.sources.map((source) => withReversedKeys(source)),
    }) as EvidencePackageInput;
    expect(hashEvidencePackage(reordered)).toBe(baseline);
  });

  it('reads no clock: hashing the same package tomorrow gives the same digest', () => {
    // The only timestamps in the digest are the ones carried by the document.
    const commitment = buildEvidenceCommitment(evidence);
    expect(commitment.canonical).toContain('"resolvedAt":"2026-09-02T00:05:30Z"');
    expect(commitment.canonical).not.toContain(String(new Date().getFullYear() + 100));
    expect(hashEvidencePackage(commitment.evidence)).toBe(baseline);
  });
});

describe('independence from storage-layer fields', () => {
  it('rejects a package carrying a database row id rather than ignoring it', () => {
    const withRowId = { ...evidence, id: 4212 };
    expect(() => hashEvidencePackage(withRowId)).toThrow(EvidenceValidationError);
  });

  it('rejects a package carrying an insertion timestamp', () => {
    const withInsertedAt = { ...evidence, createdAt: '2026-09-02T00:06:00Z' };
    expect(() => hashEvidencePackage(withInsertedAt)).toThrow(EvidenceValidationError);
  });

  it('hashes a package restored from storage identically to the original', () => {
    // Simulates a round trip through a jsonb column: keys reordered, extra
    // columns stripped by the repository layer before rehydration.
    const stored = JSON.parse(JSON.stringify({ ...evidence, _rowId: 9 })) as Record<
      string,
      unknown
    >;
    delete stored['_rowId'];
    expect(hashEvidencePackage(stored)).toBe(baseline);
  });
});

describe('sensitivity to semantic change', () => {
  const mutations: ReadonlyArray<readonly [string, EvidencePackageInput]> = [
    ['outcome', { ...evidence, outcome: 'NO' }],
    ['confidence', { ...evidence, confidenceBps: 9799 }],
    ['reasoning', { ...evidence, reasoning: `${evidence.reasoning} Confirmed twice.` }],
    ['rulesHash binding', {
      ...evidence,
      rulesHash: '0x0000000000000000000000000000000000000000000000000000000000000001',
    }],
    ['marketId', { ...evidence, marketId: '8' }],
    ['marketAddress', { ...evidence, marketAddress: '0x7777777777777777777777777777777777777777' }],
    ['chainId', { ...evidence, chainId: 196 }],
    ['resolvedAt', { ...evidence, resolvedAt: '2026-09-02T00:05:31Z' }],
    ['resolver version', { ...evidence, resolver: { version: '1.0.1', model: null } }],
    ['resolver model', { ...evidence, resolver: { version: '1.0.0', model: 'some-model' } }],
    ['a source content hash', {
      ...evidence,
      sources: [
        {
          ...evidence.sources[0]!,
          contentHash: '0x9999999999999999999999999999999999999999999999999999999999999999',
        },
      ],
    }],
    ['a source retrieval time', {
      ...evidence,
      sources: [{ ...evidence.sources[0]!, retrievedAt: '2026-09-02T00:04:00Z' }],
    }],
    ['a claim value', {
      ...evidence,
      claims: [{ ...evidence.claims[0]!, value: 'in transit' }, evidence.claims[1]!],
    }],
    ['claim order', { ...evidence, claims: [...evidence.claims].reverse() }],
    ['a deterministic check result', {
      ...evidence,
      deterministicChecks: [
        { ...evidence.deterministicChecks[0]!, passed: false },
        evidence.deterministicChecks[1]!,
      ],
    }],
    ['dropping a deterministic check', {
      ...evidence,
      deterministicChecks: [evidence.deterministicChecks[0]!],
    }],
  ];

  for (const [label, mutated] of mutations) {
    it(`changes when ${label} changes`, () => {
      expect(hashEvidencePackage(mutated)).not.toBe(baseline);
    });
  }

  it('gives every fixture a distinct hash', () => {
    const hashes = Object.values(evidencePackageFixtures).map(hashEvidencePackage);
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});

describe('invalid input is never hashed', () => {
  const invalid: ReadonlyArray<readonly [string, unknown]> = [
    ['null', null],
    ['an empty object', {}],
    ['a wrong version', { ...evidence, version: '2.0' }],
    ['an unknown outcome', { ...evidence, outcome: 'MAYBE' }],
    ['an unresolved outcome, which must never reach the chain', {
      ...evidence,
      outcome: 'NEEDS_REVIEW',
    }],
    ['a fractional confidence', { ...evidence, confidenceBps: 0.98 }],
    ['a confidence above 100 percent', { ...evidence, confidenceBps: 10_001 }],
    ['a negative confidence', { ...evidence, confidenceBps: -1 }],
    ['zero sources', { ...evidence, sources: [] }],
    ['a malformed content hash', {
      ...evidence,
      sources: [{ ...evidence.sources[0]!, contentHash: '0xabc' }],
    }],
    ['a claim pointing at a source that does not exist', {
      ...evidence,
      claims: [{ ...evidence.claims[0]!, sourceIndex: 7 }],
    }],
    ['evidence retrieved after the resolution was produced', {
      ...evidence,
      sources: [{ ...evidence.sources[0]!, retrievedAt: '2026-09-03T00:00:00Z' }],
    }],
    ['a malformed resolver version', {
      ...evidence,
      resolver: { version: 'v1', model: null },
    }],
    ['a malformed market address', { ...evidence, marketAddress: '0x123' }],
    ['a market id that is not an integer string', { ...evidence, marketId: '7.5' }],
    ['an unknown extra field', { ...evidence, notes: 'hello' }],
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
});

describe('verification', () => {
  it('confirms a served package against its on-chain commitment', () => {
    expect(verifyEvidenceHash(evidence, baseline)).toBe(true);
    expect(assertEvidenceHash(evidence, baseline).evidenceHash).toBe(baseline);
  });

  it('detects reasoning rewritten after the proposal was submitted', () => {
    const rewritten = { ...evidence, reasoning: 'Actually, the shipment was late.' };
    expect(verifyEvidenceHash(rewritten, baseline)).toBe(false);
    expect(() => assertEvidenceHash(rewritten, baseline)).toThrow(HashMismatchError);
  });
});
