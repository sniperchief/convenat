/**
 * Exact decimal and instant comparison: the boundaries, and the refusals.
 *
 * This file exists because the boundary is where a market gets decided wrongly.
 * `threshold − 1`, `threshold`, `threshold + 1` and the equivalent second either
 * side of a deadline are walked for every operator, because "greater than" and
 * "greater than or equal" differ in exactly one place and that place is worth
 * money.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_DECIMAL_DIGITS,
  applyNumericOperator,
  compareDecimal,
  parseDecimal,
  withinInclusiveRange,
  type NumericOperator,
} from '../src/validation/decimal.js';
import {
  applyTemporalOperator,
  parseInstant,
  type TemporalOperator,
} from '../src/validation/temporal.js';

function decimal(text: string) {
  const value = parseDecimal(text);
  if (value === null) throw new Error(`expected ${text} to parse`);
  return value;
}

function instant(text: string) {
  const value = parseInstant(text);
  if (value === null) throw new Error(`expected ${text} to parse`);
  return value;
}

describe('decimal parsing', () => {
  it('accepts integers and decimals, with and without a sign', () => {
    for (const text of ['0', '1', '121340', '121340.50', '-1', '-0.001', '0.0']) {
      expect(parseDecimal(text), text).not.toBeNull();
    }
  });

  it('preserves the text it was given, so `observed` records what the source said', () => {
    expect(decimal('121340.50').text).toBe('121340.50');
    expect(decimal('  121340.50  ').text).toBe('121340.50');
  });

  const refused: ReadonlyArray<readonly [string, string]> = [
    ['exponent notation', '1e3'],
    ['uppercase exponent', '1E3'],
    ['a leading plus', '+120000'],
    ['a leading zero', '0120000'],
    ['a bare fraction', '.5'],
    ['a trailing point', '120000.'],
    ['thousands separators', '120,000'],
    ['a currency symbol', '$120000'],
    ['a percent sign', '95%'],
    ['whitespace inside', '120 000'],
    ['a hex literal', '0x1d4c0'],
    ['Infinity', 'Infinity'],
    ['NaN', 'NaN'],
    ['empty', ''],
    ['a word', 'delivered'],
    ['two points', '1.2.3'],
    ['a lone minus', '-'],
  ];

  for (const [label, text] of refused) {
    it(`refuses ${label}`, () => {
      expect(parseDecimal(text)).toBeNull();
    });
  }

  it('refuses a number too long to be arithmetic rather than a payload', () => {
    expect(parseDecimal('1'.repeat(MAX_DECIMAL_DIGITS))).not.toBeNull();
    expect(parseDecimal('1'.repeat(MAX_DECIMAL_DIGITS + 1))).toBeNull();
  });

  it('treats -0 and 0 as one value', () => {
    expect(compareDecimal(decimal('-0'), decimal('0'))).toBe(0);
    expect(compareDecimal(decimal('-0.00'), decimal('0'))).toBe(0);
  });
});

describe('decimal comparison is exact', () => {
  it('compares across differing scales', () => {
    expect(compareDecimal(decimal('1.50'), decimal('1.5'))).toBe(0);
    expect(compareDecimal(decimal('1.5'), decimal('1.50'))).toBe(0);
  });

  it('gets right what floating point gets wrong', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754. Here the question does not arise.
    expect(compareDecimal(decimal('0.30'), decimal('0.3'))).toBe(0);
    // A difference far below float resolution at this magnitude.
    expect(compareDecimal(decimal('9007199254740993'), decimal('9007199254740992'))).toBe(1);
    expect(compareDecimal(decimal('121340.100000000000001'), decimal('121340.1'))).toBe(1);
  });

  it('orders negatives correctly', () => {
    expect(compareDecimal(decimal('-2'), decimal('-1'))).toBe(-1);
    expect(compareDecimal(decimal('-1'), decimal('1'))).toBe(-1);
  });

  it('handles magnitudes far beyond a double', () => {
    const big = '1'.repeat(40);
    expect(compareDecimal(decimal(big), decimal(`${big}0`))).toBe(-1);
  });
});

describe('numeric operators at the boundary', () => {
  const threshold = decimal('120000');

  const expectations: ReadonlyArray<readonly [NumericOperator, boolean, boolean, boolean]> = [
    //                          below   at      above
    ['GREATER_THAN', false, false, true],
    ['GREATER_THAN_OR_EQUAL', false, true, true],
    ['LESS_THAN', true, false, false],
    ['LESS_THAN_OR_EQUAL', true, true, false],
    ['EQUAL', false, true, false],
    ['NOT_EQUAL', true, false, true],
  ];

  for (const [operator, below, at, above] of expectations) {
    it(`${operator}: threshold-1 / threshold / threshold+1`, () => {
      const apply = (value: string): boolean =>
        applyNumericOperator(compareDecimal(decimal(value), threshold), operator);

      expect(apply('119999'), 'threshold - 1').toBe(below);
      expect(apply('120000'), 'threshold').toBe(at);
      expect(apply('120001'), 'threshold + 1').toBe(above);
    });
  }

  it('is exact one unit in the last place from the threshold', () => {
    const precise = decimal('120000.00');
    const apply = (value: string): boolean =>
      applyNumericOperator(compareDecimal(decimal(value), precise), 'GREATER_THAN');

    expect(apply('119999.99')).toBe(false);
    expect(apply('120000.00')).toBe(false);
    expect(apply('120000.01')).toBe(true);
  });
});

describe('numeric range', () => {
  const low = decimal('100');
  const high = decimal('200');

  it('is inclusive at both ends', () => {
    expect(withinInclusiveRange(decimal('99'), low, high)).toBe(false);
    expect(withinInclusiveRange(decimal('100'), low, high)).toBe(true);
    expect(withinInclusiveRange(decimal('150'), low, high)).toBe(true);
    expect(withinInclusiveRange(decimal('200'), low, high)).toBe(true);
    expect(withinInclusiveRange(decimal('201'), low, high)).toBe(false);
  });

  it('is exact at the ends', () => {
    expect(withinInclusiveRange(decimal('99.999999'), low, high)).toBe(false);
    expect(withinInclusiveRange(decimal('200.000001'), low, high)).toBe(false);
  });
});

describe('instant parsing', () => {
  it('normalises an offset to UTC', () => {
    expect(instant('2026-09-01T18:59:59-05:00').normalized).toBe('2026-09-01T23:59:59Z');
    expect(instant('2026-09-02T00:59:59+01:00').normalized).toBe('2026-09-01T23:59:59Z');
  });

  it('truncates sub-second precision to the protocol resolution', () => {
    expect(instant('2026-09-01T23:59:59.999Z').normalized).toBe('2026-09-01T23:59:59Z');
    expect(instant('2026-09-01T23:59:59.000Z').epochSeconds).toBe(
      instant('2026-09-01T23:59:59.999Z').epochSeconds,
    );
  });

  const refused: ReadonlyArray<readonly [string, string]> = [
    ['a local date-time with no offset', '2026-09-01T23:59:59'],
    ['a bare date', '2026-09-01'],
    ['a US-style date', '09/01/2026'],
    ['prose', 'yesterday'],
    ['an impossible calendar date', '2026-02-31T00:00:00Z'],
    ['a pre-epoch instant', '1969-01-01T00:00:00Z'],
    ['empty', ''],
    ['a bare epoch number', '1788307199'],
  ];

  for (const [label, text] of refused) {
    it(`refuses ${label}`, () => {
      expect(parseInstant(text)).toBeNull();
    });
  }

  it('never interprets a timestamp in server local time', () => {
    // The refusal above is the mechanism. This states the property: the only way
    // to get an instant is to say which one you mean.
    expect(parseInstant('2026-09-01T23:59:59')).toBeNull();
    expect(parseInstant('2026-09-01T23:59:59Z')).not.toBeNull();
  });
});

describe('temporal operators at the deadline boundary', () => {
  const deadline = instant('2026-09-01T23:59:59Z');

  const expectations: ReadonlyArray<readonly [TemporalOperator, boolean, boolean, boolean]> = [
    //                     -1s    exactly  +1s
    ['BEFORE', true, false, false],
    ['AT_OR_BEFORE', true, true, false],
    ['AFTER', false, false, true],
    ['AT_OR_AFTER', false, true, true],
  ];

  for (const [operator, before, at, after] of expectations) {
    it(`${operator}: deadline-1s / deadline / deadline+1s`, () => {
      const apply = (text: string): boolean =>
        applyTemporalOperator(instant(text), deadline, operator);

      expect(apply('2026-09-01T23:59:58Z'), 'deadline - 1s').toBe(before);
      expect(apply('2026-09-01T23:59:59Z'), 'deadline').toBe(at);
      expect(apply('2026-09-02T00:00:00Z'), 'deadline + 1s').toBe(after);
    });
  }

  it('compares across timezones by instant, not by wall clock', () => {
    // 19:59:58 in New York is 23:59:58Z — one second before the deadline —
    // even though its wall clock reads earlier in the day.
    expect(applyTemporalOperator(instant('2026-09-01T19:59:58-04:00'), deadline, 'BEFORE')).toBe(
      true,
    );
    expect(applyTemporalOperator(instant('2026-09-01T20:00:00-04:00'), deadline, 'BEFORE')).toBe(
      false,
    );
  });

  it('treats a sub-second overshoot as the same second, not as after', () => {
    expect(
      applyTemporalOperator(instant('2026-09-01T23:59:59.900Z'), deadline, 'AT_OR_BEFORE'),
    ).toBe(true);
    expect(applyTemporalOperator(instant('2026-09-01T23:59:59.900Z'), deadline, 'AFTER')).toBe(
      false,
    );
  });
});
