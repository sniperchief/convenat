/**
 * Canonicalisation behaviour at the document level: what may be permuted
 * without changing the bytes, and what may not.
 */

import { describe, expect, it } from 'vitest';

import {
  canonicalizeConditionSpec,
  canonicalizeEvidencePackage,
  jcsSerialize,
  normalizeUnorderedFields,
  SpecificationValidationError,
  UNORDERED_FIELDS,
  CanonicalizationError,
  type ConditionSpecInput,
} from '../src/index.js';
import { conditionSpecFixtures, evidencePackageFixtures } from '../src/testing/fixtures.js';
import { shuffleDeterministically, withReversedKeys } from './helpers.js';

const spec = conditionSpecFixtures.shipment;
const baselineCanonical = canonicalizeConditionSpec(spec).canonical;

describe('key ordering', () => {
  it('produces identical bytes when top-level keys are reordered', () => {
    const reordered = withReversedKeys(spec) as ConditionSpecInput;
    expect(canonicalizeConditionSpec(reordered).canonical).toBe(baselineCanonical);
  });

  it('produces identical bytes when nested object keys are reordered', () => {
    const reordered: ConditionSpecInput = {
      ...spec,
      settlement: {
        ...spec.settlement,
        token: withReversedKeys(spec.settlement.token),
      },
      approvedSources: spec.approvedSources.map((source) => withReversedKeys(source)),
    };
    expect(canonicalizeConditionSpec(reordered).canonical).toBe(baselineCanonical);
  });
});

describe('input whitespace', () => {
  it('is irrelevant: canonical output is derived from values, not from source text', () => {
    const viaJson = JSON.parse(JSON.stringify(spec, null, 4)) as ConditionSpecInput;
    const viaCompactJson = JSON.parse(JSON.stringify(spec)) as ConditionSpecInput;
    expect(canonicalizeConditionSpec(viaJson).canonical).toBe(baselineCanonical);
    expect(canonicalizeConditionSpec(viaCompactJson).canonical).toBe(baselineCanonical);
  });

  it('trims leading and trailing whitespace inside string values', () => {
    const padded: ConditionSpecInput = { ...spec, question: `\t  ${spec.question}  \n` };
    expect(canonicalizeConditionSpec(padded).canonical).toBe(baselineCanonical);
  });

  it('preserves whitespace inside a string, which is part of the meaning', () => {
    const altered: ConditionSpecInput = {
      ...spec,
      question: spec.question.replace(' be ', '  be  '),
    };
    expect(canonicalizeConditionSpec(altered).canonical).not.toBe(baselineCanonical);
  });
});

describe('unordered sets', () => {
  const cases = UNORDERED_FIELDS.conditionSpec;

  it('declares exactly the fields documented as unordered', () => {
    expect([...cases]).toEqual(['ambiguities', 'edgeCases', 'evidenceRequirements']);
    expect([...UNORDERED_FIELDS.evidencePackage]).toEqual([]);
  });

  it('canonicalises evidenceRequirements independently of input order', () => {
    const permuted: ConditionSpecInput = {
      ...spec,
      evidenceRequirements: [...spec.evidenceRequirements].reverse(),
    };
    expect(canonicalizeConditionSpec(permuted).canonical).toBe(baselineCanonical);
  });

  it('canonicalises edgeCases independently of input order', () => {
    const permuted: ConditionSpecInput = { ...spec, edgeCases: [...spec.edgeCases].reverse() };
    expect(canonicalizeConditionSpec(permuted).canonical).toBe(baselineCanonical);
  });

  it('canonicalises ambiguities independently of input order', () => {
    const launch = conditionSpecFixtures.productLaunch;
    const baseline = canonicalizeConditionSpec(launch).canonical;
    const permuted: ConditionSpecInput = { ...launch, ambiguities: [...launch.ambiguities].reverse() };
    expect(canonicalizeConditionSpec(permuted).canonical).toBe(baseline);
  });

  it('agrees across every permutation of a multi-element set', () => {
    const launch = conditionSpecFixtures.productLaunch;
    const baseline = canonicalizeConditionSpec(launch).canonical;
    for (let seed = 0; seed < 12; seed += 1) {
      const permuted: ConditionSpecInput = {
        ...launch,
        edgeCases: shuffleDeterministically(launch.edgeCases, seed),
      };
      expect(canonicalizeConditionSpec(permuted).canonical).toBe(baseline);
    }
  });

  it('rejects duplicates in an unordered set rather than deduplicating them', () => {
    const duplicated: ConditionSpecInput = {
      ...spec,
      evidenceRequirements: [spec.evidenceRequirements[0]!, spec.evidenceRequirements[0]!],
    };
    expect(() => canonicalizeConditionSpec(duplicated)).toThrow(SpecificationValidationError);
  });
});

describe('ordered arrays', () => {
  it('treats approvedSources order as meaningful: permuting it changes the bytes', () => {
    const permuted: ConditionSpecInput = {
      ...spec,
      approvedSources: [...spec.approvedSources].reverse(),
    };
    const canonical = canonicalizeConditionSpec(permuted).canonical;
    expect(canonical).not.toBe(baselineCanonical);
  });

  it('keeps approvedSources in the caller-supplied order in the canonical output', () => {
    const canonical = canonicalizeConditionSpec(spec).canonical;
    const primaryPosition = canonical.indexOf('Carrier tracking API');
    const fallbackPosition = canonical.indexOf('Carrier public tracking page');
    expect(primaryPosition).toBeGreaterThan(-1);
    expect(primaryPosition).toBeLessThan(fallbackPosition);
  });

  it('treats every evidence package array as ordered', () => {
    const evidence = evidencePackageFixtures.delivered;
    const baseline = canonicalizeEvidencePackage(evidence).canonical;
    const permuted = { ...evidence, claims: [...evidence.claims].reverse() };
    expect(canonicalizeEvidencePackage(permuted).canonical).not.toBe(baseline);
  });
});

describe('normalizeUnorderedFields', () => {
  it('leaves a document untouched when no fields are declared unordered', () => {
    const document = { a: [3, 1, 2] };
    expect(normalizeUnorderedFields(document, [])).toBe(document);
  });

  it('sorts only the named fields', () => {
    const document = { sorted: ['b', 'a'], untouched: ['b', 'a'] };
    const result = normalizeUnorderedFields(document, ['sorted']);
    expect(result.sorted).toEqual(['a', 'b']);
    expect(result.untouched).toEqual(['b', 'a']);
  });

  it('does not mutate its input', () => {
    const document = { items: ['b', 'a'] };
    normalizeUnorderedFields(document, ['items']);
    expect(document.items).toEqual(['b', 'a']);
  });

  it('rejects a declared-unordered field that is not an array', () => {
    expect(() => normalizeUnorderedFields({ items: 'nope' }, ['items'])).toThrow(
      CanonicalizationError,
    );
  });

  it('orders structurally identical objects consistently regardless of key order', () => {
    const a = { x: 1, y: 2 };
    const b = { y: 2, x: 1 };
    expect(jcsSerialize(a)).toBe(jcsSerialize(b));
    expect(() => normalizeUnorderedFields({ items: [a, b] }, ['items'])).toThrow(
      CanonicalizationError,
    );
  });
});

describe('normalisation of scalar representation', () => {
  it('normalises an offset timestamp to the equivalent UTC instant', () => {
    const launch = conditionSpecFixtures.productLaunch;
    const { document } = canonicalizeConditionSpec(launch);
    expect(document.deadline).toBe('2026-12-31T23:59:59Z');
  });

  it('produces identical bytes for the same instant written in different offsets', () => {
    const utc: ConditionSpecInput = { ...spec, deadline: '2026-09-01T23:59:59Z' };
    const offset: ConditionSpecInput = { ...spec, deadline: '2026-09-01T19:59:59-04:00' };
    expect(canonicalizeConditionSpec(offset).canonical).toBe(
      canonicalizeConditionSpec(utc).canonical,
    );
  });

  it('truncates sub-second precision to the protocol resolution of one second', () => {
    const fractional: ConditionSpecInput = { ...spec, deadline: '2026-09-01T23:59:59.750Z' };
    expect(canonicalizeConditionSpec(fractional).canonical).toBe(baselineCanonical);
  });

  it('lowercases addresses and 32-byte values', () => {
    const launch = conditionSpecFixtures.productLaunch;
    const { document } = canonicalizeConditionSpec(launch);
    expect(document.creator).toBe(document.creator.toLowerCase());
    expect(document.nonce).toBe(document.nonce.toLowerCase());
  });

  it('produces identical bytes for the same address in different casings', () => {
    const lower: ConditionSpecInput = {
      ...spec,
      creator: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    };
    const mixed: ConditionSpecInput = {
      ...spec,
      creator: '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa',
    };
    expect(canonicalizeConditionSpec(mixed).canonical).toBe(
      canonicalizeConditionSpec(lower).canonical,
    );
  });

  it('applies the null default so an omitted nullable key cannot change the bytes', () => {
    const withExplicitNull: ConditionSpecInput = {
      ...spec,
      approvedSources: [{ ...spec.approvedSources[1]!, dataPath: null }],
      evidenceRequirements: spec.evidenceRequirements,
    };
    const source = spec.approvedSources[1]!;
    const withoutKey: ConditionSpecInput = {
      ...spec,
      approvedSources: [
        { name: source.name, url: source.url, retrievalKind: source.retrievalKind },
      ],
    };
    expect(canonicalizeConditionSpec(withoutKey).canonical).toBe(
      canonicalizeConditionSpec(withExplicitNull).canonical,
    );
    expect(canonicalizeConditionSpec(withoutKey).canonical).toContain('"dataPath":null');
  });
});
