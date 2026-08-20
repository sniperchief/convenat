/**
 * Document canonicalisation.
 *
 * The pipeline is fixed and identical for both hashed document types:
 *
 *   1. validate + normalise scalars   (schema layer)
 *   2. order declared-unordered sets  (unordered.ts)
 *   3. serialise with RFC 8785 JCS    (jcs.ts)
 *
 * Step 1 is not optional. Hashing an unvalidated object would let an
 * unnormalised timestamp, a mixed-case address, or an unknown field silently
 * define a commitment nobody agreed to.
 */

import type { ConditionSpec } from '../schema/condition-spec.js';
import type { EvidencePackage } from '../schema/evidence-package.js';
import { parseConditionSpec, parseEvidencePackage } from '../schema/validate.js';
import { jcsSerialize } from './jcs.js';
import {
  normalizeUnorderedFields,
  UNORDERED_FIELDS,
  unorderedFieldsForEvidenceVersion,
} from './unordered.js';

/** A validated document alongside the exact string that will be hashed. */
export interface Canonicalized<T> {
  readonly document: T;
  readonly canonical: string;
}

/**
 * Validate and canonicalise a condition specification.
 *
 * @throws {SpecificationValidationError} if the input is not a valid spec.
 * @throws {CanonicalizationError} if the validated document cannot be encoded.
 */
export function canonicalizeConditionSpec(input: unknown): Canonicalized<ConditionSpec> {
  const document = parseConditionSpec(input);
  const ordered = normalizeUnorderedFields(document, UNORDERED_FIELDS.conditionSpec);
  return { document, canonical: jcsSerialize(ordered) };
}

/**
 * Validate and canonicalise an evidence package.
 *
 * The unordered-field set is chosen by the package's own `version`, because the
 * two supported versions answer that question differently: v1.0 sorts nothing,
 * v2.0 sorts `claims`. Reading the rules off the validated document is what lets
 * v1.0 keep hashing exactly as it did while v2.0 hashes under its own rules.
 *
 * @throws {EvidenceValidationError} if the input is not a valid package.
 * @throws {CanonicalizationError} if the validated document cannot be encoded.
 */
export function canonicalizeEvidencePackage(input: unknown): Canonicalized<EvidencePackage> {
  const document = parseEvidencePackage(input);
  const ordered = normalizeUnorderedFields(
    document,
    unorderedFieldsForEvidenceVersion(document.version),
  );
  return { document, canonical: jcsSerialize(ordered) };
}
