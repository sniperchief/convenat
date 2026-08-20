import { describe, expect, it } from 'vitest';

import { CanonicalizationError, compareUtf16, jcsBytes, jcsSerialize } from '../src/index.js';

const NUL = String.fromCharCode(0);

describe('RFC 8785 conformance', () => {
  it('sorts object members by UTF-16 code unit, not insertion order', () => {
    expect(jcsSerialize({ b: 1, a: 2, C: 3 })).toBe('{"C":3,"a":2,"b":1}');
  });

  it('sorts nested object members independently at every depth', () => {
    expect(jcsSerialize({ z: { y: 1, x: 2 }, a: { c: 3, b: 4 } })).toBe(
      '{"a":{"b":4,"c":3},"z":{"x":2,"y":1}}',
    );
  });

  it('emits no insignificant whitespace', () => {
    expect(jcsSerialize({ a: [1, 2], b: { c: 'd' } })).toBe('{"a":[1,2],"b":{"c":"d"}}');
  });

  it('preserves array order', () => {
    expect(jcsSerialize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('uses the RFC 8785 literal spellings for null and booleans', () => {
    expect(jcsSerialize({ n: null, t: true, f: false })).toBe('{"f":false,"n":null,"t":true}');
  });

  it('escapes control characters, quotes and backslashes per ECMAScript JSON.stringify', () => {
    expect(jcsSerialize(`a${NUL}b"c\\d\ne`)).toBe('"a\\u0000b\\"c\\\\d\\ne"');
  });

  it('escapes lone surrogates rather than emitting invalid UTF-8', () => {
    expect(jcsSerialize('\ud800')).toBe('"\\ud800"');
  });

  it('leaves printable non-ASCII characters unescaped', () => {
    // U+2019 RIGHT SINGLE QUOTATION MARK, as used in the productLaunch fixture.
    expect(jcsSerialize('Apple’s')).toBe('"Apple’s"');
  });

  it('encodes to UTF-8 bytes, not UTF-16', () => {
    // U+2019 is three bytes in UTF-8: e2 80 99, wrapped in ASCII quotes.
    expect(Array.from(jcsBytes('’'))).toEqual([0x22, 0xe2, 0x80, 0x99, 0x22]);
  });

  it('sorts keys spanning the BMP by code unit', () => {
    // U+0061 'a' < U+00E4 'a-umlaut' < U+4E2D CJK.
    expect(jcsSerialize({ '中': 1, 'ä': 2, a: 3 })).toBe(
      '{"a":3,"ä":2,"中":1}',
    );
  });
});

describe('compareUtf16', () => {
  it('orders by code unit and then by length', () => {
    expect(compareUtf16('a', 'b')).toBeLessThan(0);
    expect(compareUtf16('b', 'a')).toBeGreaterThan(0);
    expect(compareUtf16('a', 'a')).toBe(0);
    expect(compareUtf16('a', 'aa')).toBeLessThan(0);
  });

  it('orders uppercase before lowercase, as code units require', () => {
    expect(compareUtf16('Z', 'a')).toBeLessThan(0);
  });
});

describe('restricted profile rejections', () => {
  it('rejects floating point numbers', () => {
    expect(() => jcsSerialize({ price: 1.5 })).toThrow(CanonicalizationError);
    expect(() => jcsSerialize({ price: 1.5 })).toThrow(/floating-point/);
  });

  it('rejects integers beyond exact representation', () => {
    expect(() => jcsSerialize(Number.MAX_SAFE_INTEGER + 2)).toThrow(CanonicalizationError);
  });

  it('rejects NaN and Infinity', () => {
    expect(() => jcsSerialize(Number.NaN)).toThrow(CanonicalizationError);
    expect(() => jcsSerialize(Number.POSITIVE_INFINITY)).toThrow(CanonicalizationError);
  });

  it('rejects undefined, so an absent value can never be silently dropped', () => {
    expect(() => jcsSerialize({ a: undefined })).toThrow(CanonicalizationError);
    expect(() => jcsSerialize(undefined)).toThrow(CanonicalizationError);
  });

  it('rejects bigint, function and symbol', () => {
    expect(() => jcsSerialize(1n)).toThrow(CanonicalizationError);
    expect(() => jcsSerialize({ f: () => 1 })).toThrow(CanonicalizationError);
    expect(() => jcsSerialize({ s: Symbol('x') })).toThrow(CanonicalizationError);
  });

  it('rejects non-plain objects whose JSON form would be implementation-defined', () => {
    expect(() => jcsSerialize(new Date(0))).toThrow(CanonicalizationError);
    expect(() => jcsSerialize(new Map())).toThrow(CanonicalizationError);
    expect(() => jcsSerialize(new Set())).toThrow(CanonicalizationError);
  });

  it('rejects circular structures instead of overflowing the stack', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => jcsSerialize(circular)).toThrow(CanonicalizationError);
  });

  it('reports the path of the offending value', () => {
    try {
      jcsSerialize({ outer: { inner: [0, 1.5] } });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CanonicalizationError);
      expect((error as CanonicalizationError).issues[0]?.path).toBe('outer.inner[1]');
    }
  });

  it('serialises -0 as 0 so signed zero cannot split a hash', () => {
    expect(jcsSerialize(-0)).toBe('0');
    expect(jcsSerialize(0)).toBe('0');
  });

  it('projects a public error with no stack trace', () => {
    try {
      jcsSerialize({ a: 1.5 });
      expect.unreachable('should have thrown');
    } catch (error) {
      const projected = (error as CanonicalizationError).toApiError();
      expect(projected.error.code).toBe('CANONICALIZATION_FAILED');
      expect(Object.keys(projected.error)).toEqual(['code', 'message', 'issues']);
      expect(JSON.stringify(projected)).not.toContain('stack');
    }
  });
});
