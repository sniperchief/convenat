/**
 * The AI resolution engine.
 *
 * **This is not an autonomous agent.** It is a bounded reasoning step with one
 * question to answer, no tools, no memory, and no way to act. It cannot fetch a
 * URL, sign anything, reach a contract, or widen its own instructions. What it
 * produces is a proposal that the surrounding code either accepts or refuses.
 *
 * ```
 * ConditionSpec (immutable)  +  snapshots  +  DeterministicCheck[]
 *      │
 *      ├─ rules binding ....... hash the spec; refuse if it is not the market's
 *      ├─ evidence present? ... no source read → NEEDS_REVIEW, no model call
 *      ├─ verdict conclusive? . deterministic NEEDS_REVIEW → NEEDS_REVIEW, no model call
 *      ├─ claims .............. every pointer-reachable value, before the model
 *      │
 *      ▼  the only model call
 *   LLMProvider.complete()
 *      │
 *      ├─ JSON.parse .......... malformed → NEEDS_REVIEW
 *      ├─ Zod ................. wrong shape, invented field, bad confidence → NEEDS_REVIEW
 *      ├─ semantic gate ....... ungrounded value, uncited source, invented URL → NEEDS_REVIEW
 *      ├─ outcome mapping ..... model disagrees with the checks → NEEDS_REVIEW
 *      ├─ confidence floor .... below it → NEEDS_REVIEW
 *      ▼
 *   assemble → validate → bind to rulesHash → evidenceHash
 *      ▼
 *   PROPOSED     (and nothing is submitted; that is a later, non-AI path)
 * ```
 *
 * ## Four things this engine cannot do, structurally
 *
 * 1. **Modify the `ConditionSpec`.** It is an input, read-only, and it is hashed
 *    at the end of the pipeline; a test asserts the document is byte-identical
 *    afterwards. Any edit would change `rulesHash` and unbind the market.
 * 2. **Produce a `rulesHash`.** The model's output schema has no such field and
 *    `.strict()` rejects one. The hash is derived from the specification by
 *    `@covenant/shared`.
 * 3. **Touch the settlement contract.** Nothing here imports a chain client, an
 *    ABI, a signer, or a key. There is no code path from this file to a
 *    transaction.
 * 4. **Decide by confidence.** A 9999-bps proposal is still a proposal. The
 *    floor below is a threshold for *proposing at all*, never a reason to
 *    settle — the contract has no confidence parameter to weigh.
 *
 * ## Where the model sits in the order
 *
 * Last, and only for the part that needs reading. The deterministic checks are
 * computed first and handed to it as established facts; the outcome they
 * establish is computed before the call and the model's own reading is then
 * required to *concur* with it. A model that disagrees cannot flip the outcome —
 * it can only withhold one. That asymmetry is the entire safety argument: the
 * failure mode of a language model on a comparison is a confident wrong answer,
 * and nothing here lets a confident wrong answer through, however sure it sounds.
 */

import { buildRulesCommitment } from '@covenant/shared';
import type {
  Bytes32Hex,
  ConditionSpec,
  EvidenceClaim,
  EvidenceSource,
  FieldIssue,
} from '@covenant/shared';

import type { EvidenceSnapshot, FailedRetrieval } from '../evidence/retriever.js';
import { LLMProviderError, type LLMProvider } from '../llm/provider.js';
import type { ValidationResult } from '../validation/engine.js';
import type { ValidationPlan } from '../validation/plan.js';
import { assembleEvidencePackage, type MarketIdentity } from './assemble.js';
import { extractDeterministicClaims, stampModelClaims, withoutDuplicates } from './claims.js';
import { checkSemantics, indexEvidence, type SemanticViolationKind } from './grounding.js';
import { decideOutcome, deterministicOutcome, type PlanEncodes } from './outcome.js';
import { buildResolutionMessage, RESOLVER_SYSTEM_PROMPT } from './prompt.js';
import {
  resolutionOutputJsonSchema,
  resolutionOutputSchema,
  type ResolutionOutput,
} from './output-schema.js';
import type {
  FailureReason,
  ProposedResolution,
  ResolutionRecord,
  ResolutionResult,
  ReviewReason,
  ReviewRequired,
} from './types.js';
import { RESOLVER_VERSION } from './version.js';

export interface ResolutionEngineOptions {
  /**
   * The model boundary. Any `LLMProvider` — the engine names no vendor, imports
   * no SDK, and is exercised end to end by `FakeLLMProvider`.
   */
  readonly provider: LLMProvider;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  /**
   * Below this, the engine returns `NEEDS_REVIEW` and proposes nothing.
   *
   * A floor for *proposing*, not a rule for settling: there is no threshold in
   * Solidity and no path from this number to a payout. Default 7000 bps.
   */
  readonly confidenceFloorBps?: number;
  /**
   * Per-source ceiling on the content rendered into the prompt.
   *
   * Truncation is always declared to the model, so it cannot read an absence
   * caused by our own bound as an absence in the source.
   */
  readonly maxEvidenceCharsPerSource?: number;
}

export interface ResolutionInput {
  /** Immutable. Read, hashed, never written. */
  readonly specification: ConditionSpec;
  /**
   * The rules hash the market committed on-chain.
   *
   * Compared against the hash derived from the specification, never trusted as a
   * substitute for it. A mismatch means the specification in hand is not the one
   * the parties agreed to, and no amount of good evidence fixes that.
   */
  readonly expectedRulesHash: string;
  readonly market: MarketIdentity;
  readonly snapshots: readonly EvidenceSnapshot[];
  readonly failures: readonly FailedRetrieval[];
  /** The v2.0 source records retrieval produced, in approved-source order. */
  readonly sources: readonly EvidenceSource[];
  readonly validation: ValidationResult;
  readonly plan: ValidationPlan;
  /** When this resolution is being produced. Supplied; nothing here reads a clock. */
  readonly resolvedAt: string;
}

const DEFAULT_CONFIDENCE_FLOOR_BPS = 7000;
const DEFAULT_MAX_EVIDENCE_CHARS = 6000;

export class ResolutionEngine {
  private readonly confidenceFloorBps: number;
  private readonly maxEvidenceCharsPerSource: number;

  constructor(private readonly options: ResolutionEngineOptions) {
    this.confidenceFloorBps = options.confidenceFloorBps ?? DEFAULT_CONFIDENCE_FLOOR_BPS;
    this.maxEvidenceCharsPerSource = options.maxEvidenceCharsPerSource ?? DEFAULT_MAX_EVIDENCE_CHARS;
  }

  get version(): string {
    return RESOLVER_VERSION;
  }

  async resolve(input: ResolutionInput): Promise<ResolutionResult> {
    const deterministicClaims = extractDeterministicClaims(input.snapshots);
    const base: ResolutionRecord = {
      verdict: input.validation.verdict,
      deterministicChecks: input.validation.checks,
      sources: input.sources,
      claims: deterministicClaims,
      model: null,
    };

    // --- Gates that run before any model call ------------------------------
    //
    // Each of these makes a model call pointless, so none of them spends one.
    // That is not only economy: a resolution that was never going to be
    // proposable should not put attacker-controlled content in front of a model
    // at all.

    const derived = buildRulesCommitment(input.specification).rulesHash;
    if (!hashesEqual(derived, input.expectedRulesHash)) {
      return review(base, 'RULES_HASH_MISMATCH', {
        detail:
          `the specification hashes to ${derived}, but the market committed ` +
          `${normalizeHash(input.expectedRulesHash)}; this is not the agreement that was approved`,
      });
    }

    if (input.snapshots.length === 0) {
      return review(base, 'INSUFFICIENT_EVIDENCE', {
        detail:
          'no approved source produced content; absence of evidence is not evidence for ' +
          'either outcome',
      });
    }

    const encodes: PlanEncodes = input.plan.encodes;
    if (deterministicOutcome(input.validation.verdict, encodes) === null) {
      return review(base, 'DETERMINISTIC_INCONCLUSIVE', {
        detail: `the deterministic checks did not settle the condition (${input.validation.summary})`,
      });
    }

    // --- The model call ----------------------------------------------------

    let raw: { readonly text: string; readonly model: string };
    try {
      raw = await this.callModel(input);
    } catch (cause) {
      const failure = classifyProviderFailure(cause);
      if (failure === null) throw cause;
      return {
        ...base,
        status: 'RESOLUTION_FAILED',
        reason: failure.reason,
        detail: failure.detail,
      };
    }

    const withModel: ResolutionRecord = { ...base, model: raw.model };

    // --- The Zod gate ------------------------------------------------------

    const parsed = parseResolutionOutput(raw.text);
    if (!parsed.ok) {
      return review(withModel, 'MODEL_OUTPUT_INVALID', {
        detail: parsed.detail,
        issues: parsed.issues,
      });
    }
    const output = parsed.output;

    // --- The semantic gate -------------------------------------------------

    const modelClaims = stampModelClaims(output.claims);
    const violations = checkSemantics({
      claims: modelClaims,
      reasoning: output.reasoning,
      matchedEdgeCase: output.matchedEdgeCase,
      edgeCaseCount: input.specification.edgeCases.length,
      approvedUrls: input.specification.approvedSources.map((source) => source.url),
      conflicts: input.validation.conflicts,
      index: indexEvidence(input.snapshots),
    });

    if (violations.length > 0) {
      return review(withModel, 'MODEL_OUTPUT_UNGROUNDED', {
        detail: `the reading of the evidence failed ${violations.length} semantic check(s)`,
        issues: violations.map((violation) => ({
          path: violation.path,
          message: violation.message,
        })),
        violations: violations.map((violation) => violation.kind),
        confidenceBps: output.confidenceBps,
        reasoning: output.reasoning,
      });
    }

    // --- The outcome, which the model concurs in rather than chooses -------

    const decision = decideOutcome({
      specification: input.specification,
      verdict: input.validation.verdict,
      encodes,
      modelOutcome: output.outcome,
      matchedEdgeCase: output.matchedEdgeCase,
    });

    if (decision.kind === 'REVIEW') {
      return review(withModel, decision.reason, {
        detail: decision.detail,
        confidenceBps: output.confidenceBps,
        reasoning: output.reasoning,
      });
    }

    if (output.confidenceBps < this.confidenceFloorBps) {
      return review(withModel, 'CONFIDENCE_BELOW_FLOOR', {
        detail:
          `confidence ${output.confidenceBps} bps is below the floor of ` +
          `${this.confidenceFloorBps} bps required to propose`,
        confidenceBps: output.confidenceBps,
        reasoning: output.reasoning,
      });
    }

    // --- Assembly ----------------------------------------------------------

    const claims: readonly EvidenceClaim[] = [
      ...deterministicClaims,
      ...withoutDuplicates(deterministicClaims, modelClaims),
    ];

    const assembled = assembleEvidencePackage({
      specification: input.specification,
      market: input.market,
      outcome: decision.outcome,
      confidenceBps: output.confidenceBps,
      reasoning: output.reasoning,
      claims,
      deterministicChecks: input.validation.checks,
      sources: input.sources,
      model: raw.model,
      resolvedAt: input.resolvedAt,
    });

    if (!assembled.ok) {
      return review({ ...withModel, claims }, 'PACKAGE_INVALID', {
        detail: assembled.detail,
        issues: assembled.issues,
        confidenceBps: output.confidenceBps,
        reasoning: output.reasoning,
      });
    }

    const proposal: ProposedResolution = {
      status: 'PROPOSED',
      outcome: decision.outcome,
      confidenceBps: output.confidenceBps,
      reasoning: output.reasoning,
      rationale: decision.rationale,
      verdict: input.validation.verdict,
      deterministicChecks: input.validation.checks,
      sources: input.sources,
      claims,
      model: raw.model,
      evidence: assembled.evidence,
      canonical: assembled.canonical,
      evidenceHash: assembled.evidenceHash,
      rulesHash: assembled.rulesHash,
    };
    return proposal;
  }

  // -------------------------------------------------------------------------

  private async callModel(
    input: ResolutionInput,
  ): Promise<{ readonly text: string; readonly model: string }> {
    const message = buildResolutionMessage({
      specification: input.specification,
      checks: input.validation.checks,
      verdict: input.validation.verdict,
      snapshots: input.snapshots,
      failures: input.failures,
      render: { maxCharsPerSource: this.maxEvidenceCharsPerSource },
    });

    const response = await this.options.provider.complete({
      system: RESOLVER_SYSTEM_PROMPT,
      // One turn. No history, and no conversation to carry an instruction from
      // one resolution into the next.
      messages: [{ role: 'user', content: message }],
      maxOutputTokens: this.options.maxOutputTokens,
      timeoutMs: this.options.timeoutMs,
      jsonSchema: { name: 'resolution_output', schema: resolutionOutputJsonSchema },
    });

    if (response.stopReason === 'max_output_tokens') {
      // Truncated JSON would fail the parse anyway, but saying why is more useful
      // than a generic parse failure in a review record.
      throw new LLMProviderError(
        'invalid_request',
        'the model response was cut off before it was complete',
      );
    }

    return { text: response.text, model: response.model };
  }
}

// ---------------------------------------------------------------------------

/**
 * Parse and validate raw model text.
 *
 * Exported for direct testing: this is the function standing between a model and
 * a financial proposal, and it should be exercised against garbage directly
 * rather than only through the engine.
 *
 * Returns a result rather than throwing. Invalid model output is a
 * `NEEDS_REVIEW`, not a 500 — the caller did nothing wrong and neither did the
 * evidence, and an exception here would make an ambiguous resolution look like
 * an outage.
 */
export function parseResolutionOutput(
  text: string,
):
  | { readonly ok: true; readonly output: ResolutionOutput }
  | { readonly ok: false; readonly detail: string; readonly issues: readonly FieldIssue[] } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      ok: false,
      detail: 'the model returned output that is not valid JSON',
      issues: [{ path: '', message: 'response body did not parse as JSON' }],
    };
  }

  const result = resolutionOutputSchema.safeParse(json);
  if (!result.success) {
    return {
      ok: false,
      detail: 'the model returned output that does not match the resolution schema',
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    };
  }

  return { ok: true, output: result.data };
}

/**
 * Map a provider failure onto a resolution failure.
 *
 * Returns null for anything that is not a provider error, so a defect in this
 * code surfaces as a defect rather than being reported as an unreachable model.
 */
function classifyProviderFailure(
  cause: unknown,
): { readonly reason: FailureReason; readonly detail: string } | null {
  if (!(cause instanceof LLMProviderError)) return null;

  switch (cause.kind) {
    case 'timeout':
      return { reason: 'PROVIDER_TIMEOUT', detail: 'the model provider timed out' };
    case 'refused':
      return { reason: 'PROVIDER_REFUSED', detail: 'the model declined to answer' };
    case 'rate_limited':
    case 'unavailable':
    case 'auth':
    case 'invalid_request':
    case 'unknown':
    default:
      // `auth` is folded in deliberately: a misconfigured key is an operator
      // problem, and it is not a fact about this market's evidence.
      return { reason: 'PROVIDER_UNAVAILABLE', detail: 'the model provider could not be reached' };
  }
}

/** Build a review result, defaulting the fields most callers do not set. */
function review(
  record: ResolutionRecord,
  reason: ReviewReason,
  fields: {
    readonly detail: string;
    readonly issues?: readonly FieldIssue[];
    readonly violations?: readonly SemanticViolationKind[];
    readonly confidenceBps?: number;
    readonly reasoning?: string;
  },
): ReviewRequired {
  return {
    ...record,
    status: 'NEEDS_REVIEW',
    reason,
    detail: fields.detail,
    issues: fields.issues ?? [],
    violations: fields.violations ?? [],
    confidenceBps: fields.confidenceBps ?? null,
    reasoning: fields.reasoning ?? null,
  };
}

function normalizeHash(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Compare two rules hashes.
 *
 * Case-insensitive, for the reason `evidence/binding.ts` gives: a hash read from
 * an event log, an explorer or a manifest may arrive in any casing, and a
 * rejection over letter case would be a false alarm on the one check that must
 * never cry wolf.
 */
function hashesEqual(derived: Bytes32Hex, expected: string): boolean {
  return derived === normalizeHash(expected);
}
