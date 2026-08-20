/**
 * Scaffolding for the resolution suite.
 *
 * Everything a test needs to stand up the real engine over a scripted model:
 * the shipment specification, snapshots in the exact shape M5.2 produces, the
 * deterministic checks M5.3 computes from them, and a `FakeLLMProvider` whose
 * response the test writes itself.
 *
 * Nothing here is a simulation of a model. The whole reason the fake is a
 * *script* is that the cases worth testing — a hallucinated source, an invented
 * number, an outcome that contradicts the checks, output that is not JSON — are
 * ones a real model produces rarely and never on demand.
 */

import {
  buildRulesCommitment,
  parseConditionSpec,
  type ConditionSpec,
  type EvidenceSource,
} from '@covenant/shared';
import { conditionSpecFixtures } from '@covenant/shared/testing';

import type { EvidenceSnapshot, FailedRetrieval } from '../src/evidence/retriever.js';
import { FakeLLMProvider, type FakeScript } from '../src/llm/fake-provider.js';
import { ResolutionEngine, type ResolutionInput } from '../src/resolution/engine.js';
import { DeterministicValidationEngine, type ValidationResult } from '../src/validation/engine.js';
import { validateValidationPlan, type ValidationPlanInput } from '../src/validation/plan.js';

export const RETRIEVED_AT = '2026-09-02T00:05:00Z';
export const RESOLVED_AT = '2026-09-02T00:10:00Z';

export const MARKET = {
  chainId: 1952,
  marketId: '7',
  marketAddress: '0x00000000000000000000000000000000000000c1',
} as const;

/** The shipment fixture: two approved sources, `dataPath` `/shipment/status`. */
export const spec = (): ConditionSpec => parseConditionSpec(conditionSpecFixtures.shipment);

export const rulesHashOf = (specification: ConditionSpec): string =>
  buildRulesCommitment(specification).rulesHash;

export function plan(input: ValidationPlanInput) {
  const result = validateValidationPlan(input);
  if (!result.ok) throw new Error(`plan invalid: ${JSON.stringify(result.issues)}`);
  return result.plan;
}

/**
 * A plan asserting the success condition: the carrier reports "delivered".
 *
 * `caseSensitive: false` because the fixture's sources render the status in
 * lowercase and the point of these tests is the resolution layer, not the
 * validator's case policy — which has its own suite.
 */
export const deliveredPlan = () =>
  plan({
    checks: [
      {
        checkId: 'status-delivered',
        kind: 'CATEGORICAL_MATCH',
        observation: { sourceId: 'source-0', pointer: null },
        accepted: ['delivered'],
        caseSensitive: false,
      },
    ],
    encodes: 'successCondition',
  });

/** A snapshot in the shape the retriever produces, carrying one selected value. */
export function snapshot(options: {
  index: number;
  /** The scalar the approved `dataPath` selected, or null for "found nothing". */
  status: string | null;
  /** Full retained content. Defaults to a document containing the status. */
  content?: string;
  truncated?: boolean;
}): EvidenceSnapshot {
  const specification = spec();
  const approved = specification.approvedSources[options.index];
  if (approved === undefined) throw new Error(`no approved source at ${options.index}`);

  const content =
    options.content ??
    JSON.stringify({
      shipment: {
        status: options.status ?? 'unknown',
        deliveredAt: '2026-08-30T14:02:00Z',
        tracking: '1Z999AA10123456784',
      },
    });

  return {
    sourceId: `source-${options.index}`,
    approvedSourceIndex: options.index,
    name: approved.name,
    url: approved.url,
    normalizedUrl: approved.url,
    retrievalKind: approved.retrievalKind,
    retrievedAt: RETRIEVED_AT,
    contentHash: `0x${String(options.index + 1).repeat(64).slice(0, 64)}` as `0x${string}`,
    normalizedContent: content,
    normalizedHash: `0x${'a'.repeat(64)}` as `0x${string}`,
    normalizedTruncated: options.truncated ?? false,
    rawBytes: content.length,
    selection:
      options.status === null
        ? null
        : { pointer: '/shipment/status', value: JSON.stringify(options.status) },
    finalUrl: approved.url,
    redirects: [],
    attempts: 1,
    deduplicatedFrom: null,
  };
}

export function failure(index: number, kind = 'SOURCE_UNAVAILABLE'): FailedRetrieval {
  const approved = spec().approvedSources[index];
  if (approved === undefined) throw new Error(`no approved source at ${index}`);
  return {
    sourceId: `source-${index}`,
    approvedSourceIndex: index,
    name: approved.name,
    url: approved.url,
    normalizedUrl: approved.url,
    retrievalKind: approved.retrievalKind,
    attemptedAt: RETRIEVED_AT,
    failure: kind as FailedRetrieval['failure'],
    detail: 'connection failed',
    attempts: 3,
  };
}

/**
 * The v2.0 source records, derived from the snapshots and failures.
 *
 * Built from the specification's own `approvedSources`, because the binding step
 * reconciles every record's URL against the position it cites — a helper that
 * invented URLs would be testing nothing.
 */
export function evidenceSources(
  snapshots: readonly EvidenceSnapshot[],
  failures: readonly FailedRetrieval[] = [],
): readonly EvidenceSource[] {
  const specification = spec();
  return specification.approvedSources.map((approved, index) => {
    const found = snapshots.find((entry) => entry.approvedSourceIndex === index);
    const failed = failures.find((entry) => entry.approvedSourceIndex === index);

    const status = found !== undefined ? 'RETRIEVED' : failed !== undefined ? 'UNAVAILABLE' : 'NOT_ATTEMPTED';

    return {
      sourceId: `source-${index}`,
      approvedSourceIndex: index,
      name: approved.name,
      url: approved.url,
      retrievalKind: approved.retrievalKind,
      status,
      retrievedAt: RETRIEVED_AT,
      contentHash: found?.contentHash ?? null,
    } as EvidenceSource;
  });
}

/** Run the real M5.3 engine, so the checks a test feeds in are real checks. */
export function validate(
  snapshots: readonly EvidenceSnapshot[],
  planInput = deliveredPlan(),
  failures: readonly FailedRetrieval[] = [],
): ValidationResult {
  return new DeterministicValidationEngine().validate({
    specification: spec(),
    plan: planInput,
    snapshots,
    failures,
  });
}

export interface ResolveHarness {
  readonly engine: ResolutionEngine;
  readonly provider: FakeLLMProvider;
  readonly input: ResolutionInput;
}

/**
 * Assemble a full resolution input around a scripted model response.
 *
 * Defaults describe the happy path — one delivered shipment, one approved source
 * read, checks satisfied — so a test states only what it is changing.
 */
export function harness(
  scripts: readonly FakeScript[],
  overrides: {
    snapshots?: readonly EvidenceSnapshot[];
    failures?: readonly FailedRetrieval[];
    plan?: ReturnType<typeof deliveredPlan>;
    specification?: ConditionSpec;
    expectedRulesHash?: string;
    confidenceFloorBps?: number;
  } = {},
): ResolveHarness {
  const specification = overrides.specification ?? spec();
  const snapshots = overrides.snapshots ?? [snapshot({ index: 0, status: 'delivered' })];
  const failures = overrides.failures ?? [];
  const planned = overrides.plan ?? deliveredPlan();
  const provider = new FakeLLMProvider(scripts);

  const engine = new ResolutionEngine({
    provider,
    maxOutputTokens: 4000,
    timeoutMs: 30_000,
    ...(overrides.confidenceFloorBps === undefined
      ? {}
      : { confidenceFloorBps: overrides.confidenceFloorBps }),
  });

  return {
    engine,
    provider,
    input: {
      specification,
      expectedRulesHash: overrides.expectedRulesHash ?? rulesHashOf(specification),
      market: { ...MARKET },
      snapshots,
      failures,
      sources: evidenceSources(snapshots, failures),
      validation: new DeterministicValidationEngine().validate({
        specification,
        plan: planned,
        snapshots,
        failures,
      }),
      plan: planned,
      resolvedAt: RESOLVED_AT,
    },
  };
}

/** A well-formed model response resolving YES. Overridable field by field. */
export function modelYes(overrides: Record<string, unknown> = {}): unknown {
  return {
    outcome: 'RESOLVED_YES',
    confidenceBps: 9200,
    reasoning:
      'source-0 reports the shipment status as delivered, and the deterministic check ' +
      'status-delivered passed against the approved status list.',
    claims: [
      {
        sourceIds: ['source-0'],
        statement: 'The carrier reports the shipment as delivered.',
        valueType: 'string',
        value: 'delivered',
        support: 'SUPPORTED',
      },
    ],
    matchedEdgeCase: null,
    unresolvedReason: null,
    ...overrides,
  };
}

/** A well-formed model response resolving NO. */
export function modelNo(overrides: Record<string, unknown> = {}): unknown {
  return {
    outcome: 'RESOLVED_NO',
    confidenceBps: 8800,
    reasoning:
      'source-0 reports the shipment status as in_transit, which is not the delivered ' +
      'status the success condition requires.',
    claims: [
      {
        sourceIds: ['source-0'],
        statement: 'The carrier reports the shipment as in_transit.',
        valueType: 'string',
        value: 'in_transit',
        support: 'SUPPORTED',
      },
    ],
    matchedEdgeCase: null,
    unresolvedReason: null,
    ...overrides,
  };
}

/** A well-formed abstention. */
export function modelReview(reason = 'the approved sources do not carry a delivery status'): unknown {
  return {
    outcome: 'NEEDS_REVIEW',
    confidenceBps: 3000,
    reasoning: 'The evidence retrieved does not establish the status the condition turns on.',
    claims: [],
    matchedEdgeCase: null,
    unresolvedReason: reason,
  };
}
