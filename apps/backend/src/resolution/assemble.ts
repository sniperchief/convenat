/**
 * Assembling a validated proposal into an `EvidencePackage` v2.0.
 *
 * The last step before a proposal could be submitted, and the one that makes it
 * checkable. Everything upstream produced parts — sources from retrieval, checks
 * from the validators, claims from the extractor and the model, an outcome from
 * the mapping. This puts them in the frozen v2.0 shape and pushes the result
 * through `buildEvidenceCommitmentForSpec`, which is the only function in the
 * system permitted to turn a document into an `evidenceHash`.
 *
 * That function is used rather than `buildBoundEvidenceCommitment` because it is
 * strictly stronger, and the difference matters here:
 *
 * - It **derives** the expected `rulesHash` from the specification instead of
 *   trusting one handed to it, so a caller cannot pair a package with a hash
 *   that does not belong to the document it is holding.
 * - It **reconciles every source** against the approved source it cites: the
 *   index must be in range and the URL must be the one the user approved at that
 *   position. A resolver that read something nobody approved is refused here,
 *   which is the whole reason `approvedSources` is inside the hash.
 *
 * ## Nothing here reads a clock
 *
 * `resolvedAt` is supplied by the caller, like `retrievedAt` before it. Rule 3
 * of the v2.0 schema: timestamps in a hashed document are evidence about when
 * something happened, not readings taken at hashing time. A hash that depends on
 * when it was computed is not reproducible, and a package nobody can re-hash is
 * a package nobody can check.
 */

import {
  CURRENT_EVIDENCE_PACKAGE_VERSION,
  buildEvidenceCommitmentForSpec,
  buildRulesCommitment,
  isCovenantError,
  type Bytes32Hex,
  type ConditionSpec,
  type DeterministicCheck,
  type EvidenceClaim,
  type EvidencePackageV2,
  type EvidencePackageV2Input,
  type EvidenceSource,
  type FieldIssue,
  type Outcome,
} from '@covenant/shared';

import { RESOLVER_VERSION } from './version.js';

export interface MarketIdentity {
  readonly chainId: number;
  /** Decimal string, as the protocol carries a uint256. */
  readonly marketId: string;
  readonly marketAddress: string;
}

export interface AssembleInput {
  readonly specification: ConditionSpec;
  readonly market: MarketIdentity;
  readonly outcome: Outcome;
  readonly confidenceBps: number;
  readonly reasoning: string;
  readonly claims: readonly EvidenceClaim[];
  readonly deterministicChecks: readonly DeterministicCheck[];
  readonly sources: readonly EvidenceSource[];
  /** The model that produced the reading, or null when none was consulted. */
  readonly model: string | null;
  /** When the resolution was produced. Supplied, never read from a clock. */
  readonly resolvedAt: string;
}

export type AssembleResult =
  | {
      readonly ok: true;
      readonly evidence: EvidencePackageV2;
      readonly canonical: string;
      readonly evidenceHash: Bytes32Hex;
      readonly rulesHash: Bytes32Hex;
    }
  | { readonly ok: false; readonly detail: string; readonly issues: readonly FieldIssue[] };

/** The v2.0 document, before validation. Exported so a test can inspect it. */
export function toPackageInput(input: AssembleInput): EvidencePackageV2Input {
  return {
    version: CURRENT_EVIDENCE_PACKAGE_VERSION,
    chainId: input.market.chainId,
    marketId: input.market.marketId,
    marketAddress: input.market.marketAddress,
    // Placeholder only in the sense that it is immediately checked: the binding
    // step derives the true hash from the specification and refuses the package
    // unless this equals it. Nothing downstream trusts this field's value.
    rulesHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
    outcome: input.outcome,
    confidenceBps: input.confidenceBps,
    reasoning: input.reasoning,
    sources: input.sources.map((source) => ({ ...source })),
    claims: input.claims.map((claim) => ({ ...claim })),
    deterministicChecks: input.deterministicChecks.map((check) => ({ ...check })),
    resolver: { version: RESOLVER_VERSION, model: input.model },
    resolvedAt: input.resolvedAt,
  };
}

/**
 * Build, validate, bind and hash the package.
 *
 * Failure is returned rather than thrown. A package that does not assemble is a
 * resolution that must not be proposed, which is a `NEEDS_REVIEW` — and an
 * exception escaping onto the resolution path would turn "this evidence is
 * inconsistent" into a crash, which tells an operator less and wakes them at a
 * worse hour.
 */
export function assembleEvidencePackage(input: AssembleInput): AssembleResult {
  // The rules hash is derived from the specification here, then written into the
  // document, so that the binding check compares a derived value against a
  // derived value rather than against anything a caller supplied.
  const draft = toPackageInput(input);

  try {
    // Derived from the specification by `@covenant/shared`, which owns the only
    // implementation of `rulesHash` in this repository. Writing a derived value
    // into the draft means the binding check below compares a derived hash
    // against a derived hash, with nothing caller-supplied in between.
    const rulesHash = buildRulesCommitment(input.specification).rulesHash;
    const commitment = buildEvidenceCommitmentForSpec(input.specification, { ...draft, rulesHash });

    if (commitment.evidence.version !== '2.0') {
      // Unreachable: `toPackageInput` writes the current version literal. Handled
      // so the narrowing below is a check rather than an assertion.
      return {
        ok: false,
        detail: `assembled a package of version ${commitment.evidence.version}, expected 2.0`,
        issues: [{ path: 'version', message: 'must be 2.0' }],
      };
    }

    return {
      ok: true,
      evidence: commitment.evidence,
      canonical: commitment.canonical,
      evidenceHash: commitment.evidenceHash,
      rulesHash: commitment.rulesHash,
    };
  } catch (cause) {
    // Only the protocol's own errors are turned into a review. Anything else is
    // a defect in this code rather than in the evidence, and swallowing it would
    // report a bug as an ambiguous market.
    if (isCovenantError(cause)) {
      return { ok: false, detail: cause.message, issues: cause.issues };
    }
    throw cause;
  }
}
