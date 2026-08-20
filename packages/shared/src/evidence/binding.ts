/**
 * Binding an evidence package to the rules it resolves.
 *
 * The ConditionSpec defines what must be true; the EvidencePackage argues that
 * it is. The argument is only about *this* agreement if the package names the
 * same rules, so `evidence.rulesHash` must equal the market's `rulesHash`.
 *
 * That is a security boundary rather than a consistency check. Evidence bound to
 * another agreement can be perfectly well-formed, internally consistent and
 * entirely true — and still justify nothing about the market it is offered for.
 * Accepting one would let a resolution be defended with facts about a different
 * question.
 *
 * These functions are pure and take no clock, no database and no network: the
 * check has to be available anywhere a package is built, served or reviewed, and
 * a boundary enforced in only one of those places is a boundary with a way
 * around it. A caller that has the specification should prefer
 * `buildEvidenceCommitmentForSpec`, which derives the expected hash itself
 * instead of trusting one it was handed.
 */

import { EvidenceBindingError } from '../errors.js';
import { buildEvidenceCommitment, type EvidenceCommitment } from '../hashing/evidence-hash.js';
import { buildRulesCommitment } from '../hashing/rules-hash.js';
import type { Bytes32Hex } from '../hashing/keccak.js';
import type { ConditionSpec } from '../schema/condition-spec.js';
import type { EvidencePackage } from '../schema/evidence-package.js';

/** A commitment that has been checked against the rules it claims to resolve. */
export interface BoundEvidenceCommitment extends EvidenceCommitment {
  /** The rules hash both the package and the market agree on. */
  readonly rulesHash: Bytes32Hex;
}

function normalizeHash(value: string, label: string): Bytes32Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new EvidenceBindingError(`The ${label} is not a 0x-prefixed 32-byte hex string`, [
      { path: label, message: 'must be a 0x-prefixed 32-byte hex string' },
    ]);
  }
  return value.toLowerCase() as Bytes32Hex;
}

/**
 * Assert that a validated package resolves the given rules.
 *
 * Comparison is case-insensitive, because a hash read from an event log, an
 * explorer or a manifest may arrive in any casing, and a rejection over letter
 * case would be a false alarm on the one check that must never cry wolf.
 *
 * @throws {EvidenceBindingError} if the package names different rules, or if the
 * expected hash is not a well-formed bytes32.
 */
export function assertEvidenceBinding(
  evidence: EvidencePackage,
  expectedRulesHash: string,
): Bytes32Hex {
  const expected = normalizeHash(expectedRulesHash, 'expected rules hash');

  if (evidence.rulesHash !== expected) {
    throw new EvidenceBindingError(
      `Evidence package is bound to rules ${evidence.rulesHash}, but was offered for ${expected}`,
      [
        {
          path: 'rulesHash',
          message: 'must equal the rules hash of the market being resolved',
        },
      ],
    );
  }

  return expected;
}

/**
 * Validate, canonicalise and hash a package, refusing it unless it is bound to
 * the given rules.
 *
 * Ordering is deliberate: the document is validated *first*, so a malformed
 * package fails as a validation problem naming its fields rather than as a
 * binding problem, and no unvalidated `rulesHash` is ever compared.
 *
 * @throws {EvidenceValidationError} if the input is not a valid package.
 * @throws {EvidenceBindingError} if it resolves different rules.
 */
export function buildBoundEvidenceCommitment(
  input: unknown,
  expected: { readonly rulesHash: string },
): BoundEvidenceCommitment {
  const commitment = buildEvidenceCommitment(input);
  const rulesHash = assertEvidenceBinding(commitment.evidence, expected.rulesHash);
  return { ...commitment, rulesHash };
}

/**
 * Build a bound commitment from the specification itself.
 *
 * Stronger than `buildBoundEvidenceCommitment`, and the form the resolution
 * engine should use, for two reasons:
 *
 * 1. The expected `rulesHash` is *derived* from the specification rather than
 *    supplied alongside it, so a caller cannot pass a hash that does not belong
 *    to the document it is holding.
 * 2. Every v2.0 source is reconciled against the approved source it cites. The
 *    package carries both an `approvedSourceIndex` and a `url`, which is two
 *    representations of one fact — exactly what ADR-0008 warns against. They are
 *    made unable to disagree here: the index must be in range for this
 *    specification, and the URL must be the one the user approved at that
 *    position. A resolver that read something the user never approved is
 *    refused, which is the whole reason `approvedSources` is part of the hash.
 *
 * v1.0 packages have no `approvedSourceIndex`, so only the binding is checked.
 * That is not an oversight — it is precisely the auditability v1.0 lacked, and
 * the reason v2.0 exists.
 *
 * @throws {SpecificationValidationError} if the specification is invalid.
 * @throws {EvidenceValidationError} if the package is invalid.
 * @throws {EvidenceBindingError} if the package resolves different rules, or
 * cites a source the specification never approved.
 */
export function buildEvidenceCommitmentForSpec(
  specification: ConditionSpec | unknown,
  input: unknown,
): BoundEvidenceCommitment {
  const rules = buildRulesCommitment(specification);
  const commitment = buildBoundEvidenceCommitment(input, { rulesHash: rules.rulesHash });

  if (commitment.evidence.version === '2.0') {
    const approved = rules.spec.approvedSources;

    commitment.evidence.sources.forEach((source, index) => {
      const cited = approved[source.approvedSourceIndex];

      if (cited === undefined) {
        throw new EvidenceBindingError(
          `Source "${source.sourceId}" cites approved source ${source.approvedSourceIndex}, ` +
            `but the specification approves only ${approved.length}`,
          [
            {
              path: `sources[${index}].approvedSourceIndex`,
              message: `must be between 0 and ${approved.length - 1} for this specification`,
            },
          ],
        );
      }

      if (cited.url !== source.url) {
        throw new EvidenceBindingError(
          `Source "${source.sourceId}" was read from ${source.url}, which is not the URL ` +
            `approved at position ${source.approvedSourceIndex}`,
          [
            {
              path: `sources[${index}].url`,
              message: 'must be the URL the specification approved at the cited position',
            },
          ],
        );
      }
    });
  }

  return commitment;
}
