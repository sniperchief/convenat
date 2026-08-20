/**
 * EvidencePackage v2.0 — the hashed record of how a resolution was reached.
 *
 * The ConditionSpec says **what must be true**. This says **why the proposed
 * outcome follows**, and its canonical bytes are hashed into `evidenceHash`,
 * which the resolver commits on-chain alongside the outcome. The chain never
 * sees the document; the hash is what makes the served copy tamper-evident, so a
 * resolver cannot quietly rewrite its reasoning once a challenge is filed.
 *
 * Four rules govern the shape. Each exists because of a way this can go wrong:
 *
 * 1. **The package binds to the rules.** `rulesHash` must equal the market's.
 *    Evidence gathered against a different agreement is not evidence for this
 *    one, however good it is. Enforced at construction, not only in review —
 *    see `evidence/binding.ts`.
 * 2. **No storage-layer fields.** Row ids, insertion timestamps and request ids
 *    are absent from the schema and *rejected* if present, so a package restored
 *    from Postgres, served over the API or read from a file hashes identically.
 * 3. **Timestamps are evidence, not clock reads.** `retrievedAt` and
 *    `resolvedAt` record when something happened and are supplied by the caller.
 *    Nothing on the canonicalisation or hashing path reads a clock.
 * 4. **Every value is text or an integer.** A price, a count and a date all
 *    travel as strings, so no float ever enters a hashed document.
 *
 * What changed from v1.0, and why, is ADR-0015. The short version: v1.0's
 * deterministic checks could be read but not re-run, and its claims could not
 * record a fact the resolver looked for and failed to find.
 */

import { z } from 'zod';

import {
  claimSupportSchema,
  claimValueTypeSchema,
  deterministicCheckResultSchema,
  deterministicCheckTypeSchema,
  extractionMethodSchema,
  outcomeSchema,
  retrievalKindSchema,
  retrievalStatusSchema,
} from './enums.js';
import { resolverIdentitySchema } from './evidence-common.js';
import { SPEC_LIMITS } from './condition-spec.js';
import {
  addressSchema,
  basisPointsSchema,
  bytes32Schema,
  identifierSchema,
  nonNegativeIntSchema,
  positiveIntSchema,
  publicUrlSchema,
  text,
  uint256StringSchema,
  utcInstantSchema,
} from './primitives.js';

/** The evidence package version this build produces. */
export const EVIDENCE_PACKAGE_VERSION_2 = '2.0';

/** Bounds are protocol limits, not UI hints: they keep a hashed document bounded. */
export const EVIDENCE_LIMITS_V2 = {
  nameMaxLength: 120,
  statementMaxLength: 1000,
  valueMaxLength: 500,
  locatorMaxLength: 500,
  reasoningMaxLength: 4000,
  expectationMaxLength: 500,
  explanationMaxLength: 1000,
  minSources: 1,
  maxSources: 16,
  maxClaims: 64,
  maxDeterministicChecks: 32,
  /** How many sources one claim or check may cite. */
  maxSourceReferences: 8,
} as const;

/** A non-empty, bounded list of source ids, with no repeats. */
const sourceReferencesSchema = z
  .array(identifierSchema)
  .min(1, 'must cite at least one source')
  .max(EVIDENCE_LIMITS_V2.maxSourceReferences)
  .superRefine((ids, ctx) => {
    const seen = new Map<string, number>();
    ids.forEach((id, index) => {
      const previous = seen.get(id);
      if (previous !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: `duplicates the reference at position ${previous}; cite each source once`,
        });
        return;
      }
      seen.set(id, index);
    });
  });

/**
 * One reading of one approved source.
 *
 * `approvedSourceIndex` is mandatory and has no null escape hatch: evidence may
 * only come from a source the user approved when they approved the rules. A
 * resolver that needs an unapproved source cannot resolve, and saying so —
 * `INVALID`, refunds — is the correct behaviour rather than a limitation.
 *
 * Carrying both the index and the URL is two representations of one fact, which
 * ADR-0008 warns against. They are reconciled rather than deduplicated:
 * `buildEvidenceCommitmentForSpec` refuses a package whose URL does not match
 * the approved source it cites, so they cannot disagree. The URL stays because a
 * package should be readable on its own, without fetching the specification.
 *
 * The same approved source may appear more than once — a retry, or a
 * before-and-after reading. `sourceId` is what distinguishes them.
 */
export const evidenceSourceSchema = z
  .object({
    /** Stable identifier, unique within the package. Claims and checks cite it. */
    sourceId: identifierSchema,
    /** Position in the specification's `approvedSources`, which is precedence-ordered. */
    approvedSourceIndex: nonNegativeIntSchema.max(SPEC_LIMITS.maxApprovedSources - 1),
    /** Publisher or source name, as the specification names it. */
    name: text(EVIDENCE_LIMITS_V2.nameMaxLength),
    /** The exact URL read. Published, so it may not carry a credential. */
    url: publicUrlSchema,
    retrievalKind: retrievalKindSchema,
    status: retrievalStatusSchema,
    retrievedAt: utcInstantSchema,
    /**
     * keccak256 of the raw retrieved bytes, so a stored copy of the content is
     * verifiable. Null exactly when nothing was retrieved — v1.0 required a
     * value here even for an unreachable source, which obliged an honest
     * resolver to invent one.
     */
    contentHash: bytes32Schema.nullable(),
  })
  .strict()
  .superRefine((source, ctx) => {
    if (source.status === 'RETRIEVED' && source.contentHash === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contentHash'],
        message: 'a retrieved source must hash the bytes it returned',
      });
    }
    if (source.status !== 'RETRIEVED' && source.contentHash !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contentHash'],
        message: `must be null when status is ${source.status}; there were no bytes to hash`,
      });
    }
  });

export type EvidenceSource = z.infer<typeof evidenceSourceSchema>;

/** How a claim's value was located inside a source. */
export const claimExtractionSchema = z
  .object({
    method: extractionMethodSchema,
    /**
     * The pointer, selector or pattern used. Required for the reproducible
     * methods and null for the rest, so "deterministically extracted" and
     * "a model read it" can never be confused.
     */
    locator: z.string().trim().min(1).max(EVIDENCE_LIMITS_V2.locatorMaxLength).nullable(),
  })
  .strict()
  .superRefine((extraction, ctx) => {
    const needsLocator =
      extraction.method === 'JSON_POINTER' ||
      extraction.method === 'CSS_SELECTOR' ||
      extraction.method === 'REGEX';

    if (needsLocator && extraction.locator === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['locator'],
        message: `${extraction.method} must name the locator it used, or the extraction cannot be reproduced`,
      });
    }
    if (!needsLocator && extraction.locator !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['locator'],
        message: `must be null for ${extraction.method}`,
      });
    }
  });

export type ClaimExtraction = z.infer<typeof claimExtractionSchema>;

/**
 * One assertion the resolver drew from the evidence.
 *
 * A claim is machine-readable on purpose: `valueType` and `value` are what a
 * later validator re-checks, and `support` is what stops an absence from being
 * silently dropped. `value` is null exactly when `support` is `UNSUPPORTED` —
 * there is no value to record for a fact that was not found, and a placeholder
 * string would be a fabrication sitting inside a financial commitment.
 */
export const evidenceClaimSchema = z
  .object({
    /** Stable identifier, unique within the package. */
    claimId: identifierSchema,
    /** The sources consulted for this claim, by `sourceId`. */
    sourceIds: sourceReferencesSchema,
    statement: text(EVIDENCE_LIMITS_V2.statementMaxLength),
    valueType: claimValueTypeSchema,
    /** Always text, to preserve the exact representation. Null iff UNSUPPORTED. */
    value: z.string().trim().min(1).max(EVIDENCE_LIMITS_V2.valueMaxLength).nullable(),
    support: claimSupportSchema,
    extraction: claimExtractionSchema,
  })
  .strict()
  .superRefine((claim, ctx) => {
    if (claim.support === 'UNSUPPORTED' && claim.value !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: 'must be null for an UNSUPPORTED claim; no source asserted a value',
      });
    }
    if (claim.support !== 'UNSUPPORTED' && claim.value === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `must carry the value the sources assert when support is ${claim.support}`,
      });
    }
    if (claim.support === 'UNSUPPORTED' && claim.extraction.method !== 'NONE') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['extraction', 'method'],
        message: 'must be NONE for an UNSUPPORTED claim; nothing was extracted',
      });
    }
  });

export type EvidenceClaim = z.infer<typeof evidenceClaimSchema>;

/**
 * One deterministic validator run, recorded so it can be checked rather than
 * believed.
 *
 * `expected` and `observed` are the whole point. v1.0 recorded a validator name
 * and a boolean, which told an auditor that a check had happened but never what
 * it compared against what. Here the comparison is in the document: given the
 * cited sources' content, a third party can re-run the check and disagree.
 *
 * `observed` is null exactly when the result is `INDETERMINATE` — a check that
 * could not run observed nothing.
 */
export const deterministicCheckSchema = z
  .object({
    /** Stable identifier, unique within the package. */
    checkId: identifierSchema,
    checkType: deterministicCheckTypeSchema,
    /** The sources whose content this check read, by `sourceId`. */
    sourceIds: sourceReferencesSchema,
    /** The condition asserted, e.g. `delivery timestamp <= 2026-09-01T23:59:59Z`. */
    expected: text(EVIDENCE_LIMITS_V2.expectationMaxLength),
    /** What was actually found, as text. Null iff the check was INDETERMINATE. */
    observed: z.string().trim().min(1).max(EVIDENCE_LIMITS_V2.valueMaxLength).nullable(),
    result: deterministicCheckResultSchema,
    /** Optional prose. Never a substitute for `expected` and `observed`. */
    explanation: text(EVIDENCE_LIMITS_V2.explanationMaxLength).nullable().default(null),
  })
  .strict()
  .superRefine((check, ctx) => {
    if (check.result === 'INDETERMINATE' && check.observed !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['observed'],
        message: 'must be null for an INDETERMINATE check; nothing was observed',
      });
    }
    if (check.result !== 'INDETERMINATE' && check.observed === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['observed'],
        message: `must record what was observed when the result is ${check.result}`,
      });
    }
  });

export type DeterministicCheck = z.infer<typeof deterministicCheckSchema>;

export const evidencePackageV2ObjectSchema = z
  .object({
    version: z.literal(EVIDENCE_PACKAGE_VERSION_2),

    /** Identity of the condition being resolved. */
    chainId: positiveIntSchema,
    marketId: uint256StringSchema,
    marketAddress: addressSchema,
    /**
     * Binds this package to the exact rules it was resolved against. Equality
     * with the market's `rulesHash` is a hard boundary, enforced at
     * construction — see `evidence/binding.ts`.
     */
    rulesHash: bytes32Schema,

    /**
     * The proposed outcome, from the closed on-chain vocabulary. There is no
     * `UNRESOLVED` member: an unresolved condition must leave the contract
     * untouched, so it is a resolver *status* and never reaches a package.
     */
    outcome: outcomeSchema,
    /**
     * Integer basis points, 0–10000.
     *
     * Audit metadata and nothing else. It is a *floor for proposing at all*,
     * never a *reason to settle*: the contract receives the outcome and the
     * evidence hash, and has no confidence parameter to weigh.
     */
    confidenceBps: basisPointsSchema,
    /** Why the outcome follows from the claims and the checks. */
    reasoning: text(EVIDENCE_LIMITS_V2.reasoningMaxLength),

    /** ORDERED — precedence and retrieval sequence. See docs/ai-resolution.md §6. */
    sources: z
      .array(evidenceSourceSchema)
      .min(EVIDENCE_LIMITS_V2.minSources, 'at least one source is required')
      .max(EVIDENCE_LIMITS_V2.maxSources),
    /** UNORDERED — a set of independent assertions, identified by `claimId`. */
    claims: z.array(evidenceClaimSchema).max(EVIDENCE_LIMITS_V2.maxClaims),
    /** ORDERED — the sequence in which validators ran. */
    deterministicChecks: z
      .array(deterministicCheckSchema)
      .max(EVIDENCE_LIMITS_V2.maxDeterministicChecks),

    resolver: resolverIdentitySchema,
    resolvedAt: utcInstantSchema,
  })
  .strict();

function rejectDuplicateIds(
  ids: readonly string[],
  field: string,
  key: string,
  ctx: z.RefinementCtx,
): void {
  const seen = new Map<string, number>();
  ids.forEach((id, index) => {
    const previous = seen.get(id);
    if (previous !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field, index, key],
        message: `duplicates the ${key} at position ${previous}; identifiers must be unique within a package`,
      });
      return;
    }
    seen.set(id, index);
  });
}

/**
 * The full v2.0 schema, including the cross-field checks.
 *
 * These run here rather than in canonicalisation so a caller gets a
 * field-anchored validation error instead of a hashing failure.
 */
export const evidencePackageV2Schema = evidencePackageV2ObjectSchema.superRefine((pkg, ctx) => {
  rejectDuplicateIds(
    pkg.sources.map((source) => source.sourceId),
    'sources',
    'sourceId',
    ctx,
  );
  rejectDuplicateIds(
    pkg.claims.map((claim) => claim.claimId),
    'claims',
    'claimId',
    ctx,
  );
  rejectDuplicateIds(
    pkg.deterministicChecks.map((check) => check.checkId),
    'deterministicChecks',
    'checkId',
    ctx,
  );

  const known = new Set(pkg.sources.map((source) => source.sourceId));

  const checkReferences = (
    ids: readonly string[],
    field: string,
    elementIndex: number,
  ): void => {
    ids.forEach((id, referenceIndex) => {
      if (!known.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field, elementIndex, 'sourceIds', referenceIndex],
          message: `references source "${id}", which is not present in sources`,
        });
      }
    });
  };

  pkg.claims.forEach((claim, index) => checkReferences(claim.sourceIds, 'claims', index));
  pkg.deterministicChecks.forEach((check, index) =>
    checkReferences(check.sourceIds, 'deterministicChecks', index),
  );

  pkg.sources.forEach((source, index) => {
    if (Date.parse(source.retrievedAt) > Date.parse(pkg.resolvedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sources', index, 'retrievedAt'],
        message: 'evidence cannot be retrieved after the resolution was produced',
      });
    }
  });
});

/** Validated, normalised v2.0 package. This is what gets canonicalised. */
export type EvidencePackageV2 = z.infer<typeof evidencePackageV2Schema>;

/** Accepted v2.0 input shape, before normalisation and defaults are applied. */
export type EvidencePackageV2Input = z.input<typeof evidencePackageV2Schema>;
