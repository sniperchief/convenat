/**
 * Projecting a stored resolution into the shape the panel renders.
 *
 * The product story is one chain of reasoning a reader can follow without
 * trusting any single link:
 *
 * ```
 * RULES → EVIDENCE → DETERMINISTIC CHECKS → AI REASONING → OUTCOME → ON-CHAIN
 * ```
 *
 * Every function here is total and defensive. The stored record is `unknown` —
 * it was written by an earlier build and may not match this one's types — so a
 * missing field renders as absent rather than throwing. A resolution panel that
 * 500s because one field moved is worse than one that shows a gap.
 *
 * Nothing here computes anything. It reads what was recorded and renames it.
 */

import type {
  Bytes32Hex,
  MarketResolutionStatus,
  Outcome,
  ResolutionClaimView,
  ResolutionCheckView,
  ResolutionDetail,
  ResolutionSourceView,
  TxHash,
} from '@covenant/shared';

import type { MarketRecord, ResolutionRecord } from '../repositories/types.js';

/** Narrow an unknown to a record without asserting anything about its fields. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function strings(value: unknown): readonly string[] {
  return asArray(value).filter((entry): entry is string => typeof entry === 'string');
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toCheckView(value: unknown): ResolutionCheckView {
  const row = asRecord(value);
  return {
    checkId: str(row['checkId']) ?? '(unnamed)',
    checkType: str(row['checkType']) ?? 'UNKNOWN',
    sourceIds: strings(row['sourceIds']),
    expected: str(row['expected']),
    observed: str(row['observed']),
    result: str(row['result']) ?? 'INDETERMINATE',
    explanation: str(row['explanation']) ?? '',
  };
}

function toSourceView(value: unknown): ResolutionSourceView {
  const row = asRecord(value);
  const hash = str(row['contentHash']);
  return {
    sourceId: str(row['sourceId']) ?? '(unnamed)',
    approvedSourceIndex: num(row['approvedSourceIndex']) ?? -1,
    name: str(row['name']) ?? '',
    url: str(row['url']) ?? '',
    status: str(row['status']) ?? 'NOT_ATTEMPTED',
    retrievedAt: str(row['retrievedAt']),
    contentHash: hash === null ? null : (hash as Bytes32Hex),
  };
}

function toClaimView(value: unknown): ResolutionClaimView {
  const row = asRecord(value);
  const extraction = asRecord(row['extraction']);
  return {
    claimId: str(row['claimId']) ?? '(unnamed)',
    statement: str(row['statement']) ?? '',
    value: str(row['value']),
    support: str(row['support']) ?? 'UNSUPPORTED',
    sourceIds: strings(row['sourceIds']),
    extractionMethod: str(extraction['method']) ?? 'MODEL_EXTRACTION',
    extractionLocator: str(extraction['locator']),
  };
}

/**
 * Map the stored engine status and reason onto the service vocabulary.
 *
 * Duplicated from `resolution/service.ts` deliberately: this reads a *stored*
 * row, which may have been written by a build whose service is gone. Reaching
 * into the service from here would couple a projection to a runtime component
 * that need not be constructed to render a page.
 */
function toStatus(record: ResolutionRecord, reason: string | null): MarketResolutionStatus {
  if (record.status === 'PROPOSED') return 'RESOLVED';
  if (record.status === 'RESOLUTION_FAILED') return 'RESOLUTION_FAILED';
  switch (reason) {
    case 'INSUFFICIENT_EVIDENCE':
      return 'INSUFFICIENT_EVIDENCE';
    case 'RULES_HASH_MISMATCH':
    case 'PACKAGE_INVALID':
      return 'INVALID';
    default:
      return 'NEEDS_REVIEW';
  }
}

export function toResolutionDetail(
  record: ResolutionRecord,
  market: MarketRecord,
): ResolutionDetail {
  const stored = asRecord(record.record);
  const reason = str(stored['reason']);
  const outcome = record.outcome;

  return {
    marketId: market.chainMarketId ?? market.rulesHash,
    rulesHash: market.rulesHash,
    status: toStatus(record, reason),
    reason: record.status === 'PROPOSED' ? null : reason,
    detail: record.reason,
    outcome: outcome === null ? null : (outcome as Outcome),
    confidenceBps: record.confidenceBps,
    reasoning: str(stored['reasoning']),
    rationale: str(stored['rationale']),
    verdict: str(stored['verdict']),
    deterministicChecks: asArray(stored['deterministicChecks']).map(toCheckView),
    sources: asArray(stored['sources']).map(toSourceView),
    claims: asArray(stored['claims']).map(toClaimView),
    evidenceHash: record.evidenceHash,
    resolverVersion: record.resolverVersion,
    model: str(stored['model']),
    round: record.round,
    resolvedAt: record.createdAt,
    proposalTxHash: record.proposalTxHash === null ? null : (record.proposalTxHash as TxHash),
    proposalBlockNumber: record.proposalBlock,
    submissionState: record.submissionState,
  };
}
