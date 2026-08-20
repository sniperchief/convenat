/**
 * Schema behaviour: what is accepted, what is normalised, and what the
 * discriminated validation result reports.
 */

import { describe, expect, it } from 'vitest';

import {
  formatIssuePath,
  parseConditionSpec,
  validateConditionSpec,
  validateEvidencePackage,
  type ConditionSpecInput,
} from '../src/index.js';
import { conditionSpecFixtures, evidencePackageFixtures } from '../src/testing/fixtures.js';

const spec = conditionSpecFixtures.shipment;

describe('validateConditionSpec', () => {
  it('returns ok with the normalised document for a valid specification', () => {
    const result = validateConditionSpec(spec);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.question).toBe(spec.question.trim());
    expect(result.value.deadline).toBe('2026-09-01T23:59:59Z');
  });

  it('returns the complete issue list rather than throwing', () => {
    const result = validateConditionSpec({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.length).toBeGreaterThan(5);
    for (const issue of result.issues) {
      expect(typeof issue.path).toBe('string');
      expect(issue.message.length).toBeGreaterThan(0);
    }
  });

  it('names the missing field so the user can be asked for it', () => {
    const { deadline: _deadline, ...withoutDeadline } = spec;
    const result = validateConditionSpec(withoutDeadline);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.path === 'deadline')).toBe(true);
  });

  it('rejects unknown keys instead of stripping them', () => {
    const result = validateConditionSpec({ ...spec, extra: 'smuggled' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => /unrecognized|unknown/i.test(issue.message))).toBe(true);
  });
});

describe('normalisation', () => {
  it('trims surrounding whitespace but preserves internal spacing', () => {
    const padded: ConditionSpecInput = { ...spec, question: '  Did  it  arrive?  ' };
    expect(parseConditionSpec(padded).question).toBe('Did  it  arrive?');
  });

  it('converts an offset timestamp to the equivalent UTC instant', () => {
    const parsed = parseConditionSpec(conditionSpecFixtures.productLaunch);
    expect(parsed.deadline).toBe('2026-12-31T23:59:59Z');
  });

  it('accepts a lowercase t/z separator and normalises it', () => {
    const lowercase: ConditionSpecInput = { ...spec, deadline: '2026-09-01t23:59:59z' };
    expect(parseConditionSpec(lowercase).deadline).toBe('2026-09-01T23:59:59Z');
  });

  it('lowercases hex-encoded values', () => {
    const parsed = parseConditionSpec(conditionSpecFixtures.productLaunch);
    expect(parsed.creator).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(parsed.nonce).toBe(
      '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    );
  });

  it('materialises nullable fields so the key set is always identical', () => {
    const source = spec.approvedSources[0]!;
    const parsed = parseConditionSpec({
      ...spec,
      approvedSources: [{ name: source.name, url: source.url, retrievalKind: source.retrievalKind }],
    });
    expect(Object.keys(parsed.approvedSources[0]!).sort()).toEqual([
      'dataPath',
      'name',
      'retrievalKind',
      'url',
    ]);
    expect(parsed.approvedSources[0]!.dataPath).toBeNull();
  });
});

describe('timezone handling', () => {
  it('accepts UTC and IANA names', () => {
    for (const timezone of ['UTC', 'America/New_York', 'Asia/Ho_Chi_Minh', 'Europe/Isle_of_Man']) {
      expect(validateConditionSpec({ ...spec, timezone }).ok).toBe(true);
    }
  });

  it('rejects abbreviations and offsets, which are ambiguous', () => {
    for (const timezone of ['EST', 'GMT+7', '+07:00', '']) {
      expect(validateConditionSpec({ ...spec, timezone }).ok).toBe(false);
    }
  });
});

/**
 * Impossible calendar dates.
 *
 * `Date.parse` does not reject these — it **rolls them over silently**.
 * `2026-02-31` becomes 3 March, `2026-04-31` becomes 1 May, and `2025-02-29`
 * becomes 1 March. Each yields a finite timestamp, so the original
 * `Number.isFinite` guard saw nothing wrong and the normalised document carried
 * a different day from the one written.
 *
 * In a hashed document that is a silent alteration of the agreement: approving a
 * deadline of 29 February would commit the user to 1 March. Found in M5.3 while
 * testing the temporal validators.
 */
describe('a deadline must be a date that exists', () => {
  const impossible = [
    '2026-02-31T00:00:00Z',
    '2026-02-30T00:00:00Z',
    '2025-02-29T00:00:00Z', // 2025 is not a leap year
    '2026-04-31T00:00:00Z',
    '2026-06-31T00:00:00Z',
    '2026-09-31T00:00:00Z',
    '2026-11-31T00:00:00Z',
    '2026-01-00T00:00:00Z',
  ];

  for (const deadline of impossible) {
    it(`rejects ${deadline} rather than rolling it forward`, () => {
      const result = validateConditionSpec({ ...spec, deadline });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.some((issue) => issue.path === 'deadline')).toBe(true);
    });
  }

  it('still accepts 29 February in a leap year', () => {
    // The Gregorian rule, not just "divisible by 4": 2028 is a leap year, 2100
    // will not be, and 2000 was. Getting this wrong in the other direction would
    // reject a real date, which is just as bad.
    expect(validateConditionSpec({ ...spec, deadline: '2028-02-29T00:00:00Z' }).ok).toBe(true);
    expect(validateConditionSpec({ ...spec, deadline: '2100-02-29T00:00:00Z' }).ok).toBe(false);
  });

  it('rejects a time of day that does not exist', () => {
    for (const deadline of [
      '2026-09-01T24:00:00Z', // legal RFC 3339 midnight; rolls into the next day
      '2026-09-01T23:60:00Z',
      '2026-09-01T23:59:60Z',
    ]) {
      expect(validateConditionSpec({ ...spec, deadline }).ok, deadline).toBe(false);
    }
  });

  it('leaves every real date it already accepted unchanged', () => {
    // The fix only removes inputs that were being silently corrupted. Nothing
    // that validated before and denoted a real instant may hash differently now.
    const result = validateConditionSpec({ ...spec, deadline: '2026-09-01T23:59:59Z' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.deadline).toBe('2026-09-01T23:59:59Z');
  });
});

describe('validateEvidencePackage', () => {
  it('accepts a well-formed package', () => {
    expect(validateEvidencePackage(evidencePackageFixtures.delivered).ok).toBe(true);
    expect(validateEvidencePackage(evidencePackageFixtures.unreachableSource).ok).toBe(true);
  });

  it('anchors an issue to the offending array element', () => {
    const evidence = evidencePackageFixtures.delivered;
    const result = validateEvidencePackage({
      ...evidence,
      claims: [evidence.claims[0]!, { ...evidence.claims[1]!, sourceIndex: 99 }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.path === 'claims[1].sourceIndex')).toBe(true);
  });
});

describe('formatIssuePath', () => {
  it('renders object and array segments the way a developer would write them', () => {
    expect(formatIssuePath([])).toBe('');
    expect(formatIssuePath(['question'])).toBe('question');
    expect(formatIssuePath(['settlement', 'token', 'address'])).toBe('settlement.token.address');
    expect(formatIssuePath(['approvedSources', 0, 'url'])).toBe('approvedSources[0].url');
    expect(formatIssuePath(['claims', 1, 'sourceIndex'])).toBe('claims[1].sourceIndex');
  });
});
