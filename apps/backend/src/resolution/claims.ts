/**
 * Claim extraction — deterministic first, model only for the residue.
 *
 * A claim is a fact the resolver says it read out of a source. The v2.0 schema
 * makes the *provenance* of that reading part of the hashed record:
 * `JSON_POINTER` names a locator anyone holding the same bytes can re-run;
 * `MODEL_EXTRACTION` says a model read it and cannot be re-run that way. An
 * auditor should be able to see, at a glance, exactly which claims rest on a
 * model's reading — and the honest way to keep that number small is to extract
 * everything a pointer can reach *before* the model is called.
 *
 * So this module runs first, over the snapshots, with no model involved:
 *
 * ```
 * snapshots  ──►  JSON_POINTER claims   (the approved dataPath resolved a value)
 *            ──►  UNSUPPORTED claims    (the approved dataPath resolved nothing)
 * ```
 *
 * ## `UNSUPPORTED` is the load-bearing case
 *
 * A source that was read successfully and *did not contain* the field the
 * specification approved is the exact situation v2.0's `UNSUPPORTED` exists to
 * express. An extractor that can only emit `SUPPORTED` has silently deleted the
 * difference between "the carrier says undelivered" and "the carrier's response
 * had no status field at all", and those settle differently.
 *
 * ## Precedence, not majority
 *
 * When several sources answer the same pointer, they get **one** claim, not one
 * each. Its value is the highest-precedence source's, its `sourceIds` cite every
 * source consulted, and its support is `DISPUTED` when they disagreed. That
 * mirrors the deterministic engine's rule exactly (`validation/engine.ts` §7):
 * the disagreement is recorded, and precedence — never a vote — decides which
 * reading is carried.
 */

import type { ClaimValueType, EvidenceClaim } from '@covenant/shared';

import type { EvidenceSnapshot } from '../evidence/retriever.js';
import { parseDecimal } from '../validation/decimal.js';
import { parseInstant } from '../validation/temporal.js';

/** Prefix for deterministically extracted claims. Namespaced away from model claims. */
const DETERMINISTIC_PREFIX = 'det';
/** Prefix for claims a model produced. Never chosen by the model itself. */
const MODEL_PREFIX = 'model';

export function deterministicClaimId(index: number): string {
  return `${DETERMINISTIC_PREFIX}-${index}`;
}

export function modelClaimId(index: number): string {
  return `${MODEL_PREFIX}-${index}`;
}

/**
 * Turn canonical JSON back into the scalar text a claim carries.
 *
 * The snapshot stores a selection as canonical JSON, so a string arrives quoted
 * and a number bare. Identical unwrapping to `validation/engine.ts`, and for the
 * identical reason: `"delivered"` and `delivered` are the same fact, and a claim
 * that carried the quotes would not match the bytes it came from.
 *
 * Returns null for an object, an array or a JSON null — a claim's `value` is a
 * scalar, and flattening a structure into one would be a fabrication.
 */
export function scalarFromCanonical(value: string): string | null {
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return typeof parsed === 'string' && parsed.trim().length > 0 ? parsed : null;
    } catch {
      return null;
    }
  }
  if (value.startsWith('{') || value.startsWith('[')) return null;
  if (value === 'null') return null;
  return value.trim().length === 0 ? null : value;
}

/**
 * Classify a scalar for `claimValueType`.
 *
 * Deliberately narrow and deliberately ordered: booleans first because `true`
 * parses as nothing else, then instants, then exact decimals, then integers as a
 * refinement of decimal, and `string` for everything left. There is no `float`
 * member to fall into — the protocol carries every number as text.
 */
export function classifyValue(value: string): ClaimValueType {
  if (value === 'true' || value === 'false') return 'boolean';
  if (parseInstant(value) !== null) return 'timestamp';

  const decimal = parseDecimal(value);
  if (decimal !== null) return decimal.scale === 0 ? 'integer' : 'decimal_string';

  return 'string';
}

/**
 * Extract every claim a pointer can reach, before any model is called.
 *
 * One claim per distinct approved `dataPath`, plus one `UNSUPPORTED` claim per
 * source that was read but whose approved `dataPath` selected nothing.
 */
export function extractDeterministicClaims(
  snapshots: readonly EvidenceSnapshot[],
): readonly EvidenceClaim[] {
  const ordered = [...snapshots].sort((a, b) => a.approvedSourceIndex - b.approvedSourceIndex);

  /** Readings grouped by the pointer that produced them, in precedence order. */
  const byPointer = new Map<string, Array<{ sourceId: string; value: string }>>();
  /** Sources that answered but whose approved dataPath found nothing. */
  const missing: Array<{ sourceId: string; pointer: string | null }> = [];

  for (const snapshot of ordered) {
    if (snapshot.selection === null) {
      missing.push({ sourceId: snapshot.sourceId, pointer: null });
      continue;
    }
    const scalar = scalarFromCanonical(snapshot.selection.value);
    if (scalar === null) {
      // The pointer resolved, but to something that is not a scalar claim value.
      // Recorded as an absence rather than flattened: an object rendered into a
      // string would be a value no source actually asserts.
      missing.push({ sourceId: snapshot.sourceId, pointer: snapshot.selection.pointer });
      continue;
    }
    const existing = byPointer.get(snapshot.selection.pointer);
    if (existing === undefined) {
      byPointer.set(snapshot.selection.pointer, [{ sourceId: snapshot.sourceId, value: scalar }]);
    } else {
      existing.push({ sourceId: snapshot.sourceId, value: scalar });
    }
  }

  const claims: EvidenceClaim[] = [];
  let index = 0;

  for (const [pointer, readings] of byPointer) {
    // Precedence: the first reading is from the lowest approved index, because
    // `ordered` was sorted that way. Never a vote among the rest.
    const preferred = readings[0]!;
    const disputed = readings.some((reading) => reading.value !== preferred.value);

    claims.push({
      claimId: deterministicClaimId(index),
      sourceIds: readings.map((reading) => reading.sourceId),
      statement: disputed
        ? `The approved sources disagree at ${pointer}; precedence takes ${preferred.sourceId}'s value.`
        : `The approved source reports ${pointer} = ${preferred.value}.`,
      valueType: classifyValue(preferred.value),
      value: preferred.value,
      support: disputed ? 'DISPUTED' : 'SUPPORTED',
      extraction: { method: 'JSON_POINTER', locator: pointer },
    });
    index += 1;
  }

  for (const absence of missing) {
    claims.push({
      claimId: deterministicClaimId(index),
      sourceIds: [absence.sourceId],
      statement:
        absence.pointer === null
          ? `${absence.sourceId} was read, but the approved dataPath selected no value.`
          : `${absence.sourceId} was read, but ${absence.pointer} did not resolve to a single value.`,
      valueType: 'string',
      value: null,
      support: 'UNSUPPORTED',
      // NONE, not JSON_POINTER: nothing was extracted, and the v2.0 schema
      // requires the two to agree.
      extraction: { method: 'NONE', locator: null },
      });
    index += 1;
  }

  return claims;
}

/**
 * Stamp a model's claims into the v2.0 shape.
 *
 * The model supplies the reading; the system supplies the identifier and the
 * provenance. It is never asked for `extraction`, because a model able to label
 * its own reading as a reproducible `JSON_POINTER` could erase the one field
 * that tells an auditor which claims cannot be re-derived.
 */
export function stampModelClaims(
  claims: readonly {
    readonly sourceIds: readonly string[];
    readonly statement: string;
    readonly valueType: ClaimValueType;
    readonly value: string | null;
    readonly support: 'SUPPORTED' | 'UNSUPPORTED' | 'DISPUTED';
  }[],
): readonly EvidenceClaim[] {
  return claims.map((claim, index) => ({
    claimId: modelClaimId(index),
    sourceIds: [...claim.sourceIds],
    statement: claim.statement,
    valueType: claim.valueType,
    value: claim.value,
    support: claim.support,
    extraction:
      claim.support === 'UNSUPPORTED'
        ? { method: 'NONE', locator: null }
        : { method: 'MODEL_EXTRACTION', locator: null },
  }));
}

/**
 * Drop a model claim that merely repeats a deterministic one.
 *
 * Same cited sources and same value means the pointer already established it,
 * and keeping both would inflate the package while presenting a reproducible
 * fact a second time under a provenance that cannot be reproduced.
 */
export function withoutDuplicates(
  deterministic: readonly EvidenceClaim[],
  model: readonly EvidenceClaim[],
): readonly EvidenceClaim[] {
  const seen = new Set(
    deterministic.map((claim) => `${[...claim.sourceIds].sort().join(',')}|${claim.value ?? ''}`),
  );
  return model.filter(
    (claim) => !seen.has(`${[...claim.sourceIds].sort().join(',')}|${claim.value ?? ''}`),
  );
}
