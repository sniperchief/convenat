/**
 * JSON Canonicalization Scheme (RFC 8785) — restricted protocol profile.
 *
 * This module turns a JavaScript value into the exact byte sequence that the
 * protocol hashes. It is part of the protocol, not an implementation detail:
 * changing anything here changes every rulesHash and evidenceHash in existence.
 *
 * Conformance notes
 * -----------------
 * - Object members are emitted in ascending order of their key's UTF-16 code
 *   units (RFC 8785 §3.2.3). The comparator is written out explicitly rather
 *   than relying on `Array.prototype.sort`'s default coercion, so the ordering
 *   rule is visible and cannot drift.
 * - Strings use ECMAScript `JSON.stringify` escaping, which RFC 8785 §3.2.2.2
 *   defers to. Node 20+ implements well-formed stringify, so lone surrogates
 *   are escaped rather than emitted as invalid UTF-8.
 * - No insignificant whitespace is produced anywhere.
 *
 * Restricted profile (stricter than RFC 8785, never looser)
 * ---------------------------------------------------------
 * The protocol admits only a subset of JSON, because the excluded parts are
 * exactly the parts that are fragile across languages and runtimes:
 *
 * - Numbers must be safe integers. Floating point is rejected outright, so the
 *   RFC's double-to-string edge cases can never affect a hash. Quantities that
 *   need magnitude (token amounts) are carried as decimal strings; quantities
 *   that need fractions (confidence) are carried as integer basis points.
 * - `undefined`, functions, symbols, bigints, and non-plain objects (Date, Map,
 *   Set, class instances) are rejected. "Absent" is expressed as an explicit
 *   `null`, never as a missing key, so two semantically equal documents cannot
 *   differ in key set.
 * - Circular structures are rejected.
 *
 * Every rejection throws `CanonicalizationError` with the offending path, so a
 * caller never receives silently-coerced bytes.
 */

import { CanonicalizationError } from '../errors.js';

/** The JSON subset this protocol canonicalises. */
export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

/** Compare two strings by UTF-16 code unit, as required by RFC 8785 §3.2.3. */
export function compareUtf16(a: string, b: string): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    const delta = a.charCodeAt(i) - b.charCodeAt(i);
    if (delta !== 0) return delta;
  }
  return a.length - b.length;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function fail(path: string, message: string): never {
  throw new CanonicalizationError(
    `Value at ${path === '' ? '<root>' : path} cannot be canonicalised: ${message}`,
    [{ path, message }],
  );
}

function serializeNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    fail(path, 'NaN and Infinity have no JSON representation');
  }
  if (!Number.isInteger(value)) {
    fail(
      path,
      'floating-point numbers are not part of the canonical protocol; use a decimal string or integer basis points',
    );
  }
  if (!Number.isSafeInteger(value)) {
    fail(path, 'integer exceeds the exactly-representable range; use a decimal string');
  }
  // Number.isInteger already excludes -0 from differing textually, but be explicit.
  return Object.is(value, -0) ? '0' : String(value);
}

function serializeValue(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return serializeNumber(value, path);
    case 'string':
      return JSON.stringify(value);
    case 'undefined':
      fail(path, 'undefined is not representable; use an explicit null');
      break;
    case 'bigint':
      fail(path, 'bigint is not representable; use a decimal string');
      break;
    case 'function':
      fail(path, 'functions are not representable');
      break;
    case 'symbol':
      fail(path, 'symbols are not representable');
      break;
    default:
      break;
  }

  const object = value as object;
  if (ancestors.has(object)) {
    fail(path, 'circular reference');
  }
  ancestors.add(object);
  try {
    if (Array.isArray(object)) {
      const parts = (object as readonly unknown[]).map((element, index) =>
        serializeValue(element, `${path}[${index}]`, ancestors),
      );
      return `[${parts.join(',')}]`;
    }

    if (!isPlainObject(object)) {
      fail(
        path,
        `only plain objects are representable (received ${object.constructor?.name ?? 'an exotic object'})`,
      );
    }

    const record = object as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareUtf16);
    const parts = keys.map((key) => {
      const child = record[key];
      const childPath = path === '' ? key : `${path}.${key}`;
      return `${JSON.stringify(key)}:${serializeValue(child, childPath, ancestors)}`;
    });
    return `{${parts.join(',')}}`;
  } finally {
    ancestors.delete(object);
  }
}

/**
 * Serialise a value to its canonical JSON string.
 *
 * @throws {CanonicalizationError} if the value falls outside the restricted profile.
 */
export function jcsSerialize(value: unknown): string {
  return serializeValue(value, '', new Set<object>());
}

/**
 * Serialise a value to the canonical UTF-8 bytes that the protocol hashes.
 *
 * This is the only place a string is turned into bytes for hashing; keeping it
 * single-sourced is what makes the encoding step non-negotiable.
 */
export function jcsBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(jcsSerialize(value));
}
