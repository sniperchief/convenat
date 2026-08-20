/**
 * Unordered-collection normalisation.
 *
 * Array order is semantically significant by default and is never touched. A
 * small, explicit set of fields is declared to be an unordered *set* — for
 * those, and only those, element order carries no meaning, so two inputs that
 * differ only by permutation must produce the same hash. They are normalised by
 * sorting on each element's own canonical JSON, which needs no per-field sort
 * key and is stable for scalars and nested objects alike.
 *
 * There is deliberately no "sort every array" helper in this package. Adding a
 * field to `UNORDERED_FIELDS` below is a protocol change and requires a spec
 * version bump.
 */

import { CanonicalizationError } from '../errors.js';
import { compareUtf16, jcsSerialize } from './jcs.js';

/**
 * Fields whose element order carries no meaning.
 *
 * ConditionSpec:
 *  - `evidenceRequirements`, `ambiguities`, `edgeCases` are sets of independent
 *    statements. Listing them in a different order does not describe a
 *    different agreement.
 *
 * EvidencePackage v1.0 (`evidencePackage`): **nothing**, and frozen that way.
 * Every array in v1.0 is ordered because `claims[].sourceIndex` references
 * `sources` positionally, so reordering `sources` would silently repoint every
 * claim.
 *
 * EvidencePackage v2.0 (`evidencePackageV2`): `claims` only. The three
 * collections got three different answers, each for its own reason — the full
 * argument is in docs/ai-resolution.md §6 and ADR-0015:
 *
 *  - `sources` stays **ordered**. Position carries precedence and retrieval
 *    sequence: a resolver that read the fallback before the primary did
 *    something different from one that did not, and the hash should say so.
 *  - `claims` becomes **unordered**. v2.0 replaced positional `sourceIndex`
 *    references with `sourceId`, so a claim's identity no longer depends on
 *    where it sits. What remains is a set of independent assertions, and the
 *    sequence in which two unrelated facts were extracted is not part of why an
 *    outcome is justified. Leaving it ordered would mean a benign
 *    re-serialisation raises a tamper alarm.
 *  - `deterministicChecks` stays **ordered**. Execution order can matter — a
 *    validator that short-circuits after an earlier failure is a different run
 *    from one that does not — and the package records what was actually done.
 *
 * Ordered by contrast, and therefore absent from every list here:
 * `ConditionSpec.approvedSources`, where index *is* precedence.
 *
 * There is deliberately no "sort every array" helper. Adding a field below is a
 * protocol change and requires a schema version bump.
 */
export const UNORDERED_FIELDS = {
  conditionSpec: ['ambiguities', 'edgeCases', 'evidenceRequirements'] as const,
  /** EvidencePackage v1.0. Frozen — see the note above. */
  evidencePackage: [] as const,
  /** EvidencePackage v2.0. */
  evidencePackageV2: ['claims'] as const,
} satisfies Record<string, readonly string[]>;

/**
 * The unordered-field set for a given evidence package version.
 *
 * Canonicalisation must not guess: an unknown version returning "nothing is
 * unordered" would quietly produce a hash under the wrong rules, which is worse
 * than refusing.
 *
 * @throws {CanonicalizationError} for a version this build does not know.
 */
export function unorderedFieldsForEvidenceVersion(version: string): readonly string[] {
  switch (version) {
    case '1.0':
      return UNORDERED_FIELDS.evidencePackage;
    case '2.0':
      return UNORDERED_FIELDS.evidencePackageV2;
    default:
      throw new CanonicalizationError(
        `No canonical ordering rules are defined for evidence package version ${version}`,
        [{ path: 'version', message: 'unsupported evidence package version' }],
      );
  }
}

/**
 * Return a copy of `document` with the named top-level array fields sorted into
 * their canonical order.
 *
 * @throws {CanonicalizationError} if a declared-unordered field contains
 * duplicate elements — a set with repeats is ambiguous and is rejected rather
 * than silently deduplicated.
 */
export function normalizeUnorderedFields<T extends Record<string, unknown>>(
  document: T,
  fields: readonly string[],
): T {
  if (fields.length === 0) return document;

  const normalized: Record<string, unknown> = { ...document };

  for (const field of fields) {
    const value = normalized[field];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      throw new CanonicalizationError(
        `Field ${field} is declared unordered but is not an array`,
        [{ path: field, message: 'expected an array' }],
      );
    }

    const keyed = (value as readonly unknown[]).map((element, index) => ({
      index,
      element,
      canonical: jcsSerialize(element),
    }));

    const seen = new Map<string, number>();
    for (const entry of keyed) {
      const previous = seen.get(entry.canonical);
      if (previous !== undefined) {
        throw new CanonicalizationError(
          `Unordered field ${field} contains duplicate entries at positions ${previous} and ${entry.index}`,
          [{ path: `${field}[${entry.index}]`, message: 'duplicate entry in an unordered set' }],
        );
      }
      seen.set(entry.canonical, entry.index);
    }

    keyed.sort((a, b) => compareUtf16(a.canonical, b.canonical));
    normalized[field] = keyed.map((entry) => entry.element);
  }

  return normalized as T;
}
