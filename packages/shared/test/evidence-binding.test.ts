/**
 * The rulesHash binding — the hard boundary between an evidence package and the
 * agreement it claims to resolve.
 *
 * A package bound to another market's rules can be well-formed, internally
 * consistent and entirely true, and still justify nothing here. That is why the
 * check is a refusal at construction rather than a warning at review time, and
 * why it lives in the shared package: the backend, the frontend verifier and any
 * third-party auditor all have to reach the same verdict.
 */

import { describe, expect, it } from 'vitest';

import {
  assertEvidenceBinding,
  buildBoundEvidenceCommitment,
  buildEvidenceCommitmentForSpec,
  CovenantError,
  EvidenceBindingError,
  EvidenceValidationError,
  hashConditionSpec,
  hashEvidencePackage,
  parseEvidencePackage,
  SpecificationValidationError,
  type EvidencePackageV2Input,
} from '../src/index.js';
import {
  conditionSpecFixtures,
  evidencePackageFixtures,
  evidencePackageV2Fixtures,
} from '../src/testing/fixtures.js';

const spec = conditionSpecFixtures.shipment;
const rulesHash = hashConditionSpec(spec);
const evidence = evidencePackageV2Fixtures.shipmentYes;

const OTHER_RULES_HASH = hashConditionSpec(conditionSpecFixtures.minimal);

describe('assertEvidenceBinding', () => {
  it('accepts a package bound to the rules it is offered for', () => {
    expect(assertEvidenceBinding(parseEvidencePackage(evidence), rulesHash)).toBe(rulesHash);
  });

  it('accepts a hash that arrives in a different casing', () => {
    // An event log, an explorer and a manifest each pick their own casing. A
    // rejection over letter case would be a false alarm on the one check that
    // must never cry wolf.
    const shouted = rulesHash.toUpperCase().replace('0X', '0x');
    expect(assertEvidenceBinding(parseEvidencePackage(evidence), shouted)).toBe(rulesHash);
  });

  it('refuses a package bound to different rules', () => {
    expect(() => assertEvidenceBinding(parseEvidencePackage(evidence), OTHER_RULES_HASH)).toThrow(
      EvidenceBindingError,
    );
  });

  it('anchors the refusal to rulesHash and names both hashes', () => {
    try {
      assertEvidenceBinding(parseEvidencePackage(evidence), OTHER_RULES_HASH);
      expect.unreachable('should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(EvidenceBindingError);
      const typed = error as EvidenceBindingError;
      expect(typed.code).toBe('EVIDENCE_RULES_MISMATCH');
      expect(typed.issues[0]?.path).toBe('rulesHash');
      expect(typed.message).toContain(rulesHash);
      expect(typed.message).toContain(OTHER_RULES_HASH);
    }
  });

  it('refuses a malformed expected hash rather than comparing against it', () => {
    for (const malformed of ['', '0x', '0xabc', 'a'.repeat(64), `0x${'z'.repeat(64)}`]) {
      expect(() => assertEvidenceBinding(parseEvidencePackage(evidence), malformed)).toThrow(
        EvidenceBindingError,
      );
    }
  });

  it('binds v1.0 packages too', () => {
    const v1 = parseEvidencePackage(evidencePackageFixtures.delivered);
    expect(assertEvidenceBinding(v1, v1.rulesHash)).toBe(v1.rulesHash);
    expect(() => assertEvidenceBinding(v1, rulesHash)).toThrow(EvidenceBindingError);
  });
});

describe('buildBoundEvidenceCommitment', () => {
  it('returns the same hash the unbound builder produces', () => {
    const bound = buildBoundEvidenceCommitment(evidence, { rulesHash });
    expect(bound.evidenceHash).toBe(hashEvidencePackage(evidence));
    expect(bound.rulesHash).toBe(rulesHash);
  });

  it('refuses to build a commitment for a different market', () => {
    expect(() => buildBoundEvidenceCommitment(evidence, { rulesHash: OTHER_RULES_HASH })).toThrow(
      EvidenceBindingError,
    );
  });

  it('reports a malformed package as a validation problem, not a binding one', () => {
    // Ordering matters: validate first, so the caller is told about the field
    // that is actually wrong instead of about a rulesHash nobody parsed.
    const malformed = { ...evidence, confidenceBps: -1 };
    expect(() => buildBoundEvidenceCommitment(malformed, { rulesHash })).toThrow(
      EvidenceValidationError,
    );
  });

  it('refuses evidence whose rulesHash was swapped after it was written', () => {
    const swapped = { ...evidence, rulesHash: OTHER_RULES_HASH };
    expect(() => buildBoundEvidenceCommitment(swapped, { rulesHash })).toThrow(
      EvidenceBindingError,
    );
  });
});

describe('buildEvidenceCommitmentForSpec', () => {
  it('derives the expected hash from the specification itself', () => {
    const bound = buildEvidenceCommitmentForSpec(spec, evidence);
    expect(bound.rulesHash).toBe(rulesHash);
    expect(bound.evidenceHash).toBe(hashEvidencePackage(evidence));
  });

  it('accepts every v2.0 fixture that resolves this specification', () => {
    for (const [name, fixture] of Object.entries(evidencePackageV2Fixtures)) {
      if (fixture.rulesHash !== rulesHash) continue;
      expect(() => buildEvidenceCommitmentForSpec(spec, fixture), name).not.toThrow();
    }
  });

  it('refuses a package that resolves a different specification', () => {
    expect(() =>
      buildEvidenceCommitmentForSpec(spec, evidencePackageV2Fixtures.otherRules),
    ).toThrow(EvidenceBindingError);
  });

  it('refuses a source citing an approved position the specification does not have', () => {
    // The shipment specification approves two sources, so index 2 is a citation
    // of something the user never agreed to.
    const outOfRange: EvidencePackageV2Input = {
      ...evidence,
      sources: [{ ...evidence.sources[0]!, approvedSourceIndex: 2 }],
    };
    try {
      buildEvidenceCommitmentForSpec(spec, outOfRange);
      expect.unreachable('should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(EvidenceBindingError);
      expect((error as EvidenceBindingError).issues[0]?.path).toBe(
        'sources[0].approvedSourceIndex',
      );
    }
  });

  it('refuses a source read from a URL the specification never approved', () => {
    // The core anti-substitution rule: evidence may only come from sources the
    // user approved when they approved the rules.
    const substituted: EvidencePackageV2Input = {
      ...evidence,
      sources: [{ ...evidence.sources[0]!, url: 'https://totally-different.test/track' }],
    };
    try {
      buildEvidenceCommitmentForSpec(spec, substituted);
      expect.unreachable('should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(EvidenceBindingError);
      expect((error as EvidenceBindingError).issues[0]?.path).toBe('sources[0].url');
    }
  });

  it('refuses a source that cites the primary but reads the fallback', () => {
    // Index and URL are two representations of one fact. This is what stops them
    // from disagreeing — see ADR-0008 decision 1 and ADR-0015.
    const mismatched: EvidencePackageV2Input = {
      ...evidence,
      sources: [
        {
          ...evidence.sources[0]!,
          approvedSourceIndex: 0,
          url: 'https://www.example-carrier.test/track?id=1Z999AA10123456784',
        },
      ],
    };
    expect(() => buildEvidenceCommitmentForSpec(spec, mismatched)).toThrow(EvidenceBindingError);
  });

  it('accepts the fallback when it is cited at its own position', () => {
    expect(() =>
      buildEvidenceCommitmentForSpec(spec, evidencePackageV2Fixtures.multiSource),
    ).not.toThrow();
  });

  it('refuses an invalid specification before looking at the evidence', () => {
    expect(() => buildEvidenceCommitmentForSpec({ version: '1.0' }, evidence)).toThrow(
      SpecificationValidationError,
    );
  });

  it('checks only the binding for a v1.0 package, which has no source citations', () => {
    // v1.0 sources cannot be reconciled against the approved list — they carry
    // no index. That gap is precisely why v2.0 exists, and pretending otherwise
    // would be worse than stating it.
    const v1 = parseEvidencePackage(evidencePackageFixtures.delivered);
    expect(() => buildEvidenceCommitmentForSpec(spec, v1)).toThrow(EvidenceBindingError);
  });

  it('never lets a raw runtime error escape the typed error model', () => {
    const bad: readonly unknown[] = [
      null,
      {},
      { ...evidence, rulesHash: '0xnope' },
      { ...evidence, sources: [] },
    ];
    for (const input of bad) {
      try {
        buildEvidenceCommitmentForSpec(spec, input);
        expect.unreachable(`${JSON.stringify(input)} should have thrown`);
      } catch (error) {
        expect(error).toBeInstanceOf(CovenantError);
      }
    }
  });
});
