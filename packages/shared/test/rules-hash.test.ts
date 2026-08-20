/**
 * rulesHash: determinism, sensitivity, and refusal to hash invalid input.
 */

import { describe, expect, it } from 'vitest';

import {
  assertRulesHash,
  buildRulesCommitment,
  CovenantError,
  hashConditionSpec,
  HashMismatchError,
  isBytes32Hex,
  SpecificationValidationError,
  verifyRulesHash,
  type ConditionSpecInput,
} from '../src/index.js';
import { conditionSpecFixtures } from '../src/testing/fixtures.js';
import { shuffleDeterministically, throughJson, withReversedKeys } from './helpers.js';

const spec = conditionSpecFixtures.shipment;
const baseline = hashConditionSpec(spec);

describe('output shape', () => {
  it('is a lowercase 0x-prefixed 32-byte hex string', () => {
    for (const fixture of Object.values(conditionSpecFixtures)) {
      const hash = hashConditionSpec(fixture);
      expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(isBytes32Hex(hash)).toBe(true);
    }
  });

  it('is 32 bytes, never truncated', () => {
    expect(baseline.length).toBe(66);
  });
});

describe('determinism', () => {
  it('returns the same hash on repeated execution', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(hashConditionSpec(spec)).toBe(baseline);
    }
  });

  it('is unaffected by a JSON round trip', () => {
    expect(hashConditionSpec(throughJson(spec))).toBe(baseline);
  });

  it('is unaffected by key insertion order at any depth', () => {
    const reordered = withReversedKeys({
      ...spec,
      settlement: withReversedKeys(spec.settlement),
    }) as ConditionSpecInput;
    expect(hashConditionSpec(reordered)).toBe(baseline);
  });

  it('is unaffected by permuting a declared-unordered set', () => {
    for (let seed = 0; seed < 8; seed += 1) {
      const permuted: ConditionSpecInput = {
        ...spec,
        edgeCases: shuffleDeterministically(spec.edgeCases, seed),
        evidenceRequirements: shuffleDeterministically(spec.evidenceRequirements, seed),
      };
      expect(hashConditionSpec(permuted)).toBe(baseline);
    }
  });

  it('agrees with the hash of the canonical string reported alongside it', () => {
    const commitment = buildRulesCommitment(spec);
    expect(commitment.rulesHash).toBe(baseline);
    expect(commitment.canonical.startsWith('{')).toBe(true);
    // Re-hashing the normalised document must reproduce the same commitment.
    expect(hashConditionSpec(commitment.spec)).toBe(baseline);
  });
});

describe('sensitivity to semantic change', () => {
  const mutations: ReadonlyArray<readonly [string, ConditionSpecInput]> = [
    ['question', { ...spec, question: `${spec.question} Really?` }],
    [
      'successCondition',
      { ...spec, successCondition: spec.successCondition.replace('delivered', 'received') },
    ],
    [
      'failureCondition',
      { ...spec, failureCondition: `${spec.failureCondition} Additionally, weekends are excluded.` },
    ],
    ['deadline', { ...spec, deadline: '2026-09-02T23:59:59Z' }],
    ['deadline by one second', { ...spec, deadline: '2026-09-01T23:59:58Z' }],
    ['timezone', { ...spec, timezone: 'America/New_York' }],
    ['resolutionMethod', { ...spec, resolutionMethod: 'ai_evidence_interpretation' }],
    ['risk', { ...spec, risk: 'high' }],
    ['creator', { ...spec, creator: '0x9999999999999999999999999999999999999999' }],
    [
      'nonce',
      { ...spec, nonce: '0x2222222222222222222222222222222222222222222222222222222222222222' },
    ],
    [
      'approved source url',
      {
        ...spec,
        approvedSources: [
          { ...spec.approvedSources[0]!, url: 'https://api.other-carrier.test/v1/track/1' },
          spec.approvedSources[1]!,
        ],
      },
    ],
    [
      'approved source dataPath',
      {
        ...spec,
        approvedSources: [
          { ...spec.approvedSources[0]!, dataPath: '/shipment/state' },
          spec.approvedSources[1]!,
        ],
      },
    ],
    [
      'approved source precedence',
      { ...spec, approvedSources: [...spec.approvedSources].reverse() },
    ],
    [
      'dropping a fallback source',
      { ...spec, approvedSources: [spec.approvedSources[0]!] },
    ],
    [
      'an edge case outcome',
      {
        ...spec,
        edgeCases: [{ ...spec.edgeCases[0]!, outcome: 'NO' }, spec.edgeCases[1]!],
      },
    ],
    [
      'an evidence requirement',
      {
        ...spec,
        evidenceRequirements: [
          spec.evidenceRequirements[0]!,
          'A delivery timestamp expressed as a local instant.',
        ],
      },
    ],
    [
      'settlement token',
      {
        ...spec,
        settlement: {
          ...spec.settlement,
          token: { ...spec.settlement.token, address: '0x000000000000000000000000000000000000beef' },
        },
      },
    ],
    [
      'challenge window',
      { ...spec, settlement: { ...spec.settlement, challengeWindowSeconds: 3600 } },
    ],
    [
      'challenge bond',
      { ...spec, settlement: { ...spec.settlement, challengeBondBaseUnits: '50000001' } },
    ],
    [
      'trading end',
      { ...spec, settlement: { ...spec.settlement, tradingEndsAt: '2026-08-26T00:00:00Z' } },
    ],
    [
      'resolution deadline',
      { ...spec, settlement: { ...spec.settlement, resolutionDeadlineSeconds: 259200 } },
    ],
  ];

  for (const [label, mutated] of mutations) {
    it(`changes when ${label} changes`, () => {
      expect(hashConditionSpec(mutated)).not.toBe(baseline);
    });
  }

  it('gives every fixture a distinct hash', () => {
    const hashes = Object.values(conditionSpecFixtures).map(hashConditionSpec);
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});

describe('invalid input is never hashed', () => {
  const invalid: ReadonlyArray<readonly [string, unknown]> = [
    ['null', null],
    ['a string', 'not a specification'],
    ['an empty object', {}],
    ['a missing deadline', { ...spec, deadline: undefined }],
    ['a missing question', { ...spec, question: undefined }],
    ['an empty question', { ...spec, question: '   ' }],
    ['a wrong version', { ...spec, version: '2.0' }],
    ['an unknown risk level', { ...spec, risk: 'catastrophic' }],
    ['an unknown condition type', { ...spec, conditionType: 'scalar' }],
    ['a malformed deadline', { ...spec, deadline: 'the first of September' }],
    ['a deadline with no offset', { ...spec, deadline: '2026-09-01T23:59:59' }],
    ['an impossible calendar date', { ...spec, deadline: '2026-02-30T00:00:00Z' }],
    ['a non-https source url', {
      ...spec,
      approvedSources: [{ ...spec.approvedSources[0]!, url: 'http://insecure.test/track' }],
    }],
    ['a malformed source url', {
      ...spec,
      approvedSources: [{ ...spec.approvedSources[0]!, url: 'not-a-url' }],
    }],
    ['zero approved sources', { ...spec, approvedSources: [] }],
    ['a malformed creator address', { ...spec, creator: '0x123' }],
    ['a malformed nonce', { ...spec, nonce: '0xabc' }],
    ['an unknown extra field', { ...spec, backdoor: true }],
    ['a floating point challenge window', {
      ...spec,
      settlement: { ...spec.settlement, challengeWindowSeconds: 7200.5 },
    }],
    ['a challenge bond that is not an integer string', {
      ...spec,
      settlement: { ...spec.settlement, challengeBondBaseUnits: '50.5' },
    }],
    ['a challenge bond with a leading zero', {
      ...spec,
      settlement: { ...spec.settlement, challengeBondBaseUnits: '007' },
    }],
    ['a challenge bond as a number', {
      ...spec,
      settlement: { ...spec.settlement, challengeBondBaseUnits: 50_000_000 },
    }],
    ['a challenge window below the protocol minimum', {
      ...spec,
      settlement: { ...spec.settlement, challengeWindowSeconds: 30 },
    }],
    ['trading ending after the deadline', {
      ...spec,
      settlement: { ...spec.settlement, tradingEndsAt: '2026-09-05T00:00:00Z' },
    }],
    ['identical success and failure conditions', {
      ...spec,
      failureCondition: spec.successCondition,
    }],
    ['duplicate approved source urls', {
      ...spec,
      approvedSources: [spec.approvedSources[0]!, spec.approvedSources[0]!],
    }],
  ];

  for (const [label, input] of invalid) {
    it(`refuses to hash ${label}`, () => {
      expect(() => hashConditionSpec(input)).toThrow(SpecificationValidationError);
    });
  }

  it('never lets a raw runtime error escape the typed error model', () => {
    // A validator that throws instead of returning false would surface as a
    // 500 rather than a field-level validation failure. Every rejection above
    // must be a CovenantError, not a SyntaxError or TypeError.
    for (const [label, input] of invalid) {
      try {
        hashConditionSpec(input);
        expect.unreachable(`${label} should have thrown`);
      } catch (error) {
        expect(error, label).toBeInstanceOf(CovenantError);
      }
    }
  });

  it('reports every problem with a field path, not just the first', () => {
    try {
      hashConditionSpec({ ...spec, question: '', risk: 'nope', deadline: 'soon' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SpecificationValidationError);
      const issues = (error as SpecificationValidationError).issues;
      expect(issues.length).toBeGreaterThanOrEqual(3);
      expect(issues.map((issue) => issue.path)).toEqual(
        expect.arrayContaining(['question', 'risk', 'deadline']),
      );
    }
  });

  it('anchors a nested problem to its full path', () => {
    try {
      hashConditionSpec({
        ...spec,
        approvedSources: [spec.approvedSources[0]!, { ...spec.approvedSources[1]!, url: 'nope' }],
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      const issues = (error as SpecificationValidationError).issues;
      expect(issues.some((issue) => issue.path === 'approvedSources[1].url')).toBe(true);
    }
  });
});

describe('verification', () => {
  it('confirms a specification against its own commitment', () => {
    expect(verifyRulesHash(spec, baseline)).toBe(true);
  });

  it('accepts an uppercase commitment, as read from an explorer or a log', () => {
    expect(verifyRulesHash(spec, baseline.toUpperCase().replace('0X', '0x'))).toBe(true);
  });

  it('rejects a specification whose wording was altered after commitment', () => {
    const altered = { ...spec, question: `${spec.question} (revised)` };
    expect(verifyRulesHash(altered, baseline)).toBe(false);
    expect(() => assertRulesHash(altered, baseline)).toThrow(HashMismatchError);
  });

  it('returns the full commitment when assertion succeeds', () => {
    const commitment = assertRulesHash(spec, baseline);
    expect(commitment.rulesHash).toBe(baseline);
    expect(commitment.spec.question).toBe(spec.question.trim());
  });
});
