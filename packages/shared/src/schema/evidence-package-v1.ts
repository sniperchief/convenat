/**
 * EvidencePackage v1.0 — FROZEN.
 *
 * This is the schema Milestone 1 shipped, moved here unchanged when v2.0 was
 * introduced in Milestone 5.1 (ADR-0015). It is still *accepted* so that any
 * package produced under it keeps validating and hashing to the same digest, and
 * it is no longer *produced*: `CURRENT_EVIDENCE_PACKAGE_VERSION` is `2.0`.
 *
 * Nothing in this file may change. Its two golden vectors are locked, and a
 * change here would silently redefine hashes that were committed as a protocol
 * contract. If v1.0 needs to say something new, that is a new version.
 *
 * Why v1.0 was superseded rather than amended, in one line each — the full
 * argument is in ADR-0015:
 *
 * - `deterministicChecks` recorded a free-text validator name and a free-text
 *   detail, so an auditor could see *that* a check ran but never re-run it.
 * - `claims` had no way to record a fact the resolver looked for and did not
 *   find, so an absence was indistinguishable from an omission.
 * - `httpStatus` and `contentType` put transport metadata inside the digest.
 * - `contentHash` was mandatory even when nothing had been retrieved, which
 *   obliged an honest resolver to invent one.
 */

import { z } from 'zod';

import { claimValueTypeSchema, outcomeSchema, retrievalKindSchema } from './enums.js';
import { resolverIdentitySchema } from './evidence-common.js';
import {
  addressSchema,
  basisPointsSchema,
  bytes32Schema,
  httpsUrlSchema,
  nonNegativeIntSchema,
  positiveIntSchema,
  text,
  uint256StringSchema,
  utcInstantSchema,
} from './primitives.js';

/** The frozen first evidence package version. */
export const EVIDENCE_PACKAGE_VERSION_1 = '1.0';

export const EVIDENCE_LIMITS_V1 = {
  statementMaxLength: 1000,
  valueMaxLength: 500,
  reasoningMaxLength: 4000,
  detailMaxLength: 1000,
  minSources: 1,
  maxSources: 16,
  maxClaims: 64,
  maxDeterministicChecks: 32,
} as const;

/** One retrieval from one approved source. Ordered: mirrors retrieval order. */
export const evidenceSourceV1Schema = z
  .object({
    name: text(120),
    url: httpsUrlSchema,
    retrievalKind: retrievalKindSchema,
    retrievedAt: utcInstantSchema,
    /** HTTP status, or null for retrieval kinds that are not HTTP. */
    httpStatus: nonNegativeIntSchema.max(599).nullable().default(null),
    contentType: z.string().trim().min(1).max(200).nullable().default(null),
    /** keccak256 of the raw retrieved bytes, so the stored copy is verifiable. */
    contentHash: bytes32Schema,
  })
  .strict();

export type EvidenceSourceV1 = z.infer<typeof evidenceSourceV1Schema>;

/** A single fact extracted from a source. Ordered: extraction order is the record. */
export const evidenceClaimV1Schema = z
  .object({
    /** Index into `sources`. Positional reference is why `sources` is ordered. */
    sourceIndex: nonNegativeIntSchema,
    statement: text(EVIDENCE_LIMITS_V1.statementMaxLength),
    valueType: claimValueTypeSchema,
    /** The extracted value, always as text to preserve exact representation. */
    value: z.string().trim().min(1).max(EVIDENCE_LIMITS_V1.valueMaxLength),
  })
  .strict();

export type EvidenceClaimV1 = z.infer<typeof evidenceClaimV1Schema>;

/**
 * A deterministic check the engine ran before any AI interpretation.
 *
 * Recording these in the hashed package is what lets an auditor see that
 * deterministic validation actually happened rather than being asserted.
 */
export const deterministicCheckV1Schema = z
  .object({
    validator: text(120),
    passed: z.boolean(),
    detail: text(EVIDENCE_LIMITS_V1.detailMaxLength),
  })
  .strict();

export type DeterministicCheckV1 = z.infer<typeof deterministicCheckV1Schema>;

export const evidencePackageV1ObjectSchema = z
  .object({
    version: z.literal(EVIDENCE_PACKAGE_VERSION_1),

    /** Identity of the condition being resolved. */
    chainId: positiveIntSchema,
    marketId: uint256StringSchema,
    marketAddress: addressSchema,
    /** Binds this package to the exact rules it was resolved against. */
    rulesHash: bytes32Schema,

    outcome: outcomeSchema,
    /** Integer basis points. Recorded for audit; it never authorises anything. */
    confidenceBps: basisPointsSchema,
    reasoning: text(EVIDENCE_LIMITS_V1.reasoningMaxLength),

    /** Ordered. `claims[].sourceIndex` refers to positions in this array. */
    sources: z
      .array(evidenceSourceV1Schema)
      .min(EVIDENCE_LIMITS_V1.minSources, 'at least one source is required')
      .max(EVIDENCE_LIMITS_V1.maxSources),
    /** Ordered: the sequence in which facts were extracted. */
    claims: z.array(evidenceClaimV1Schema).max(EVIDENCE_LIMITS_V1.maxClaims),
    /** Ordered: the sequence in which deterministic validators ran. */
    deterministicChecks: z
      .array(deterministicCheckV1Schema)
      .max(EVIDENCE_LIMITS_V1.maxDeterministicChecks),

    resolver: resolverIdentitySchema,
    resolvedAt: utcInstantSchema,
  })
  .strict();

export const evidencePackageV1Schema = evidencePackageV1ObjectSchema.superRefine((pkg, ctx) => {
  pkg.claims.forEach((claim, index) => {
    if (claim.sourceIndex >= pkg.sources.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['claims', index, 'sourceIndex'],
        message: `references source ${claim.sourceIndex}, but only ${pkg.sources.length} source(s) are present`,
      });
    }
  });

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

/** Validated, normalised v1.0 package. */
export type EvidencePackageV1 = z.infer<typeof evidencePackageV1Schema>;

/** Accepted v1.0 input shape, before normalisation and defaults are applied. */
export type EvidencePackageV1Input = z.input<typeof evidencePackageV1Schema>;
