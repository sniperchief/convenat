/**
 * EvidencePackage — versions, and the union every consumer works against.
 *
 * Two schema versions exist, and the distinction is deliberate rather than
 * transitional:
 *
 * | Version | Status | Module |
 * | --- | --- | --- |
 * | `1.0` | Frozen. Accepted, never produced | `evidence-package-v1.ts` |
 * | `2.0` | Current. What this build produces | `evidence-package-v2.ts` |
 *
 * A hashed document's schema can never be edited in place — the digest *is* the
 * agreement — so a change is always a new version, and the old one keeps
 * validating and hashing exactly as it did. v1.0's golden vectors are unchanged
 * by the introduction of v2.0, and a test asserts it.
 *
 * Reasoning: ADR-0015. Field-by-field protocol definition:
 * docs/canonical-specification.md §3 and docs/ai-resolution.md.
 */

import type { EvidencePackageV1, EvidencePackageV1Input } from './evidence-package-v1.js';
import type { EvidencePackageV2, EvidencePackageV2Input } from './evidence-package-v2.js';
import { EVIDENCE_PACKAGE_VERSION_1 } from './evidence-package-v1.js';
import { EVIDENCE_PACKAGE_VERSION_2 } from './evidence-package-v2.js';

export * from './evidence-common.js';
export * from './evidence-package-v1.js';
export * from './evidence-package-v2.js';

/**
 * The version this build produces.
 *
 * Nothing should hard-code `'2.0'`; read it from here, so a future version bump
 * is one edit rather than a search.
 */
export const CURRENT_EVIDENCE_PACKAGE_VERSION = EVIDENCE_PACKAGE_VERSION_2;

/** Every version this build can validate, canonicalise and hash. */
export const SUPPORTED_EVIDENCE_PACKAGE_VERSIONS = [
  EVIDENCE_PACKAGE_VERSION_1,
  EVIDENCE_PACKAGE_VERSION_2,
] as const;

export type EvidencePackageVersion = (typeof SUPPORTED_EVIDENCE_PACKAGE_VERSIONS)[number];

/**
 * @deprecated Names the frozen v1.0 schema, which is what it meant when M1
 * introduced it. Use `CURRENT_EVIDENCE_PACKAGE_VERSION` for what this build
 * produces, or `EVIDENCE_PACKAGE_VERSION_1` when v1.0 is what you mean. Kept so
 * the golden-vector generator and any v1.0 consumer keep compiling.
 */
export const EVIDENCE_PACKAGE_VERSION = EVIDENCE_PACKAGE_VERSION_1;

/**
 * A validated evidence package of any supported version.
 *
 * Consumers that only store, serve or hash a package should use this. Code that
 * reads fields — the resolution engine, the review UI — should narrow on
 * `version` first, because the two versions do not share a field set.
 */
export type EvidencePackage = EvidencePackageV1 | EvidencePackageV2;

/** Accepted input shape for any supported version. */
export type EvidencePackageInput = EvidencePackageV1Input | EvidencePackageV2Input;

export function isEvidencePackageVersion(value: unknown): value is EvidencePackageVersion {
  return (
    typeof value === 'string' &&
    (SUPPORTED_EVIDENCE_PACKAGE_VERSIONS as readonly string[]).includes(value)
  );
}

/** Narrow a validated package to v2.0. */
export function isEvidencePackageV2(pkg: EvidencePackage): pkg is EvidencePackageV2 {
  return pkg.version === EVIDENCE_PACKAGE_VERSION_2;
}
