/**
 * evidenceHash — the on-chain commitment to a resolution's evidence package.
 *
 *   evidenceHash = keccak256( UTF8( JCS( normalise( validate( package ) ) ) ) )
 *
 * Submitted by the resolver alongside the proposed outcome. The package itself
 * stays off-chain and is served through the API; the hash is what makes the
 * served copy tamper-evident, so a resolver cannot quietly rewrite its
 * reasoning after a challenge is filed.
 */

import { canonicalizeEvidencePackage } from '../canonical/canonicalize.js';
import { HashMismatchError } from '../errors.js';
import type { EvidencePackage } from '../schema/evidence-package.js';
import { hashCanonicalText, type Bytes32Hex } from './keccak.js';

/** Everything produced while committing an evidence package. */
export interface EvidenceCommitment {
  readonly evidence: EvidencePackage;
  readonly canonical: string;
  readonly evidenceHash: Bytes32Hex;
}

export function buildEvidenceCommitment(input: unknown): EvidenceCommitment {
  const { document, canonical } = canonicalizeEvidencePackage(input);
  return { evidence: document, canonical, evidenceHash: hashCanonicalText(canonical) };
}

/**
 * The evidenceHash of an evidence package.
 *
 * @throws {EvidenceValidationError} if the input is not a valid package.
 */
export function hashEvidencePackage(input: unknown): Bytes32Hex {
  return buildEvidenceCommitment(input).evidenceHash;
}

export function verifyEvidenceHash(input: unknown, expected: string): boolean {
  return hashEvidencePackage(input) === expected.toLowerCase();
}

/** As `verifyEvidenceHash`, but throws `HashMismatchError` on disagreement. */
export function assertEvidenceHash(input: unknown, expected: string): EvidenceCommitment {
  const commitment = buildEvidenceCommitment(input);
  if (commitment.evidenceHash !== expected.toLowerCase()) {
    throw new HashMismatchError(
      `Evidence package does not match the committed evidence hash (expected ${expected}, computed ${commitment.evidenceHash})`,
    );
  }
  return commitment;
}
