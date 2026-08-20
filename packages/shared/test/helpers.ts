/**
 * Test-only utilities.
 *
 * Deliberately not exported from the package: nothing in production reorders a
 * document's keys or shuffles an array, and shipping helpers that do would
 * invite exactly the accidental reordering the protocol forbids.
 */

/** Rebuild an object with its own enumerable keys in reverse insertion order. */
export function withReversedKeys<T extends object>(value: T): T {
  const entries = Object.entries(value).reverse();
  return Object.fromEntries(entries) as T;
}

/**
 * A seeded, reproducible shuffle.
 *
 * Uses a small LCG rather than `Math.random` so a permutation failure is
 * reproducible from the seed printed in the test name.
 */
export function shuffleDeterministically<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  let state = (seed + 1) * 2_654_435_761;
  for (let i = result.length - 1; i > 0; i -= 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    const j = state % (i + 1);
    const a = result[i]!;
    const b = result[j]!;
    result[i] = b;
    result[j] = a;
  }
  return result;
}

/** Deep clone through JSON, matching how a document arrives over the wire. */
export function throughJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
