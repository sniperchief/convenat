/**
 * Validation entry points.
 *
 * Two styles are offered deliberately:
 *
 * - `validate*` returns a discriminated union. Use it where invalid input is an
 *   expected outcome — an LLM returning an incomplete specification is normal
 *   operation, not an exception, and the caller needs the field list to tell
 *   the user what is missing.
 * - `parse*` throws a typed error. Use it on paths where the document has
 *   already been accepted and invalidity means a bug.
 */

import type { z } from 'zod';

import type { FieldIssue } from '../errors.js';
import { EvidenceValidationError, SpecificationValidationError } from '../errors.js';
import { conditionSpecSchema, type ConditionSpec } from './condition-spec.js';
import {
  EVIDENCE_PACKAGE_VERSION_1,
  EVIDENCE_PACKAGE_VERSION_2,
  SUPPORTED_EVIDENCE_PACKAGE_VERSIONS,
  evidencePackageV1Schema,
  evidencePackageV2Schema,
  type EvidencePackage,
} from './evidence-package.js';

/** Render a Zod path as `approvedSources[0].url`. */
export function formatIssuePath(path: readonly (string | number)[]): string {
  return path.reduce<string>((accumulated, segment) => {
    if (typeof segment === 'number') return `${accumulated}[${segment}]`;
    return accumulated === '' ? segment : `${accumulated}.${segment}`;
  }, '');
}

export function toFieldIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    path: formatIssuePath(issue.path),
    message: issue.message,
  }));
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly FieldIssue[] };

/**
 * Validate a candidate specification.
 *
 * Returns the normalised document, or the complete list of problems. It never
 * repairs, fills in, or guesses at a missing field: an incomplete condition is
 * returned to the user for another pass, because inventing a deadline or an
 * approved source is precisely the failure this system is built to prevent.
 */
export function validateConditionSpec(input: unknown): ValidationResult<ConditionSpec> {
  const result = conditionSpecSchema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, issues: toFieldIssues(result.error) };
}

/** As `validateConditionSpec`, but throws `SpecificationValidationError`. */
export function parseConditionSpec(input: unknown): ConditionSpec {
  const result = validateConditionSpec(input);
  if (result.ok) return result.value;
  throw new SpecificationValidationError(
    `Condition specification is invalid (${result.issues.length} problem(s))`,
    result.issues,
  );
}

/**
 * Validate a candidate evidence package, dispatching on its declared version.
 *
 * The dispatch is explicit rather than a discriminated union so that an
 * unrecognised version produces one clear issue anchored at `version`, instead
 * of the union of every failure from every schema — which, for two schemas with
 * disjoint field sets, would be a wall of noise naming the wrong problem.
 *
 * A package whose `version` does not match its shape is rejected by the schema
 * that version selects. Claiming to be v2.0 does not make a v1.0 document one.
 */
export function validateEvidencePackage(input: unknown): ValidationResult<EvidencePackage> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      ok: false,
      issues: [{ path: '', message: 'an evidence package must be a JSON object' }],
    };
  }

  const version = (input as { version?: unknown }).version;

  switch (version) {
    case EVIDENCE_PACKAGE_VERSION_1: {
      const result = evidencePackageV1Schema.safeParse(input);
      if (result.success) return { ok: true, value: result.data };
      return { ok: false, issues: toFieldIssues(result.error) };
    }
    case EVIDENCE_PACKAGE_VERSION_2: {
      const result = evidencePackageV2Schema.safeParse(input);
      if (result.success) return { ok: true, value: result.data };
      return { ok: false, issues: toFieldIssues(result.error) };
    }
    default:
      return {
        ok: false,
        issues: [
          {
            path: 'version',
            message: `must be one of ${SUPPORTED_EVIDENCE_PACKAGE_VERSIONS.map((v) => `"${v}"`).join(', ')}`,
          },
        ],
      };
  }
}

/** As `validateEvidencePackage`, but throws `EvidenceValidationError`. */
export function parseEvidencePackage(input: unknown): EvidencePackage {
  const result = validateEvidencePackage(input);
  if (result.ok) return result.value;
  throw new EvidenceValidationError(
    `Evidence package is invalid (${result.issues.length} problem(s))`,
    result.issues,
  );
}
