/**
 * rulesHash — the on-chain commitment to an approved condition specification.
 *
 *   rulesHash = keccak256( UTF8( JCS( normalise( validate( spec ) ) ) ) )
 *
 * Committed by the creator's wallet when the market is opened, before any funds
 * are exposed. Anyone holding the specification document can re-derive the hash
 * and compare it with `ConditionalMarket.rulesHash()`; a mismatch means the
 * rules on display are not the rules the money is subject to.
 */

import { canonicalizeConditionSpec } from '../canonical/canonicalize.js';
import { HashMismatchError } from '../errors.js';
import type { ConditionSpec } from '../schema/condition-spec.js';
import { hashCanonicalText, type Bytes32Hex } from './keccak.js';

/** Everything produced while committing a specification. */
export interface RulesCommitment {
  readonly spec: ConditionSpec;
  readonly canonical: string;
  readonly rulesHash: Bytes32Hex;
}

/**
 * Validate, canonicalise and hash a specification, returning all three
 * artefacts. Use this when the caller needs to persist the normalised document
 * next to the hash it produced.
 */
export function buildRulesCommitment(input: unknown): RulesCommitment {
  const { document, canonical } = canonicalizeConditionSpec(input);
  return { spec: document, canonical, rulesHash: hashCanonicalText(canonical) };
}

/**
 * The rulesHash of a specification.
 *
 * @throws {SpecificationValidationError} if the input is not a valid spec —
 * an invalid document can never be hashed.
 */
export function hashConditionSpec(input: unknown): Bytes32Hex {
  return buildRulesCommitment(input).rulesHash;
}

/**
 * Check a specification against a commitment, comparing case-insensitively so
 * a hash read from an explorer or an event log matches regardless of casing.
 */
export function verifyRulesHash(input: unknown, expected: string): boolean {
  return hashConditionSpec(input) === expected.toLowerCase();
}

/** As `verifyRulesHash`, but throws `HashMismatchError` on disagreement. */
export function assertRulesHash(input: unknown, expected: string): RulesCommitment {
  const commitment = buildRulesCommitment(input);
  if (commitment.rulesHash !== expected.toLowerCase()) {
    throw new HashMismatchError(
      `Specification does not match the committed rules hash (expected ${expected}, computed ${commitment.rulesHash})`,
    );
  }
  return commitment;
}
