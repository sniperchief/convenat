/**
 * Mapping a deterministic verdict onto a proposed `Outcome`.
 *
 * `SATISFIED` is not `YES`. It says every planned check passed, which is a fact
 * about the checks — and whether that amounts to the success condition or to the
 * failure condition depends on which of the two the checks were written to test.
 * A shipment plan that checks `status == "delivered"` and one that checks
 * `status == "returned_to_sender"` can both come back `SATISFIED` and they
 * settle opposite ways.
 *
 * ## Three inputs decide the outcome, and the model is the weakest of them
 *
 * 1. **The deterministic verdict**, mapped through `plan.encodes`. This is the
 *    authority. `SATISFIED` + `encodes: successCondition` → `YES`.
 * 2. **The model's reading** of `successCondition` and `failureCondition`
 *    against the evidence. It cannot *change* the outcome; it can only *withhold*
 *    one. A model that disagrees with the deterministic mapping produces
 *    `NEEDS_REVIEW`, never a flip — the two readings disagreeing means one of
 *    them is wrong, and a person should find out which.
 * 3. **A matched edge case**, whose outcome the *user* fixed when they approved
 *    the rules. See below.
 *
 * ## Why a matched edge case cannot flip a settlement
 *
 * `edgeCases[].outcome` is inside the hash, so it is genuinely user-approved —
 * but *which* edge case matches the evidence is a prose judgement, and the thing
 * making that judgement is a model reading attacker-controlled content. If a
 * matched edge case could carry `YES`, then a source that persuaded the model
 * "this is edge case 2" could settle a market against the deterministic checks.
 *
 * So a matched edge case may only make the proposal **more conservative**:
 *
 * | Edge case outcome | Deterministic mapping | Result |
 * | --- | --- | --- |
 * | same as mapping | conclusive | that outcome |
 * | `INVALID` | conclusive | `INVALID` — refunds, never a payout to either side |
 * | `YES` / `NO` against the mapping | conclusive | `NEEDS_REVIEW` |
 * | anything | inconclusive | `NEEDS_REVIEW` |
 *
 * `INVALID` is allowed through because it routes to refunds: it takes money from
 * nobody and gives it to nobody, so a hostile source that can force it has
 * achieved a denial of service, not a theft. Everything else needs a person.
 *
 * This is also the only route by which `INVALID` can be proposed at all — the
 * model's own vocabulary does not contain it (`output-schema.ts`).
 */

import type { ConditionSpec, Outcome } from '@covenant/shared';

import type { ValidationVerdict } from '../validation/engine.js';
import type { ModelOutcome } from './output-schema.js';

/**
 * Which of the specification's two conditions the plan's checks were written to
 * test.
 *
 * Carried on the `ValidationPlan`, which is **unhashed operator input** — the
 * same limitation `validation/plan.ts` documents for thresholds, and it deserves
 * the same plain statement rather than a euphemism: a user approving a
 * `rulesHash` is not approving this assertion. It is not derived from the prose
 * of `successCondition`, because deriving it would mean parsing intent out of a
 * sentence, and getting that wrong inverts a settlement silently.
 *
 * What keeps it honest in the meantime is that the model reads both condition
 * texts independently and must concur. A mis-set `encodes` produces a
 * disagreement and therefore `NEEDS_REVIEW`, not an inverted payout.
 */
export type PlanEncodes = 'successCondition' | 'failureCondition';

export type OutcomeDecision =
  | { readonly kind: 'OUTCOME'; readonly outcome: Outcome; readonly rationale: string }
  | { readonly kind: 'REVIEW'; readonly reason: OutcomeReviewReason; readonly detail: string };

export type OutcomeReviewReason =
  /** The deterministic layer could not settle the checks. */
  | 'DETERMINISTIC_INCONCLUSIVE'
  /** The model declined to resolve. */
  | 'MODEL_ABSTAINED'
  /** The model's reading contradicts what the checks establish. */
  | 'OUTCOME_CONTRADICTS_CHECKS'
  /** A matched edge case would flip the outcome the checks establish. */
  | 'EDGE_CASE_CONTRADICTS_CHECKS';

/**
 * The outcome the checks establish on their own, before the model is consulted.
 *
 * Exported so a caller can see the deterministic answer without a model call at
 * all — which is what makes "the AI explains the result rather than inventing a
 * different calculation" checkable rather than aspirational.
 */
export function deterministicOutcome(
  verdict: ValidationVerdict,
  encodes: PlanEncodes,
): Outcome | null {
  if (verdict === 'NEEDS_REVIEW') return null;

  const satisfied = verdict === 'SATISFIED';
  return encodes === 'successCondition'
    ? satisfied
      ? 'YES'
      : 'NO'
    : satisfied
      ? 'NO'
      : 'YES';
}

/** How a model outcome corresponds to the on-chain vocabulary. Null when it abstained. */
export function toOutcome(modelOutcome: ModelOutcome): Outcome | null {
  switch (modelOutcome) {
    case 'RESOLVED_YES':
      return 'YES';
    case 'RESOLVED_NO':
      return 'NO';
    case 'NEEDS_REVIEW':
      return null;
  }
}

export interface OutcomeInput {
  readonly specification: ConditionSpec;
  readonly verdict: ValidationVerdict;
  readonly encodes: PlanEncodes;
  readonly modelOutcome: ModelOutcome;
  /** Already validated as in range by the semantic gate. */
  readonly matchedEdgeCase: number | null;
}

/**
 * Decide the proposed outcome, or refuse to.
 *
 * Every path that is not unanimous ends in `NEEDS_REVIEW`. That is the whole
 * design: three independent readings — code, model, and the pre-approved edge
 * cases — and a settlement only where they agree or where disagreement can only
 * make the result more conservative.
 */
export function decideOutcome(input: OutcomeInput): OutcomeDecision {
  const established = deterministicOutcome(input.verdict, input.encodes);
  if (established === null) {
    return {
      kind: 'REVIEW',
      reason: 'DETERMINISTIC_INCONCLUSIVE',
      detail:
        'the deterministic checks did not settle the condition, so there is nothing for a ' +
        'reading of the evidence to confirm',
    };
  }

  const proposed = toOutcome(input.modelOutcome);
  if (proposed === null) {
    return {
      kind: 'REVIEW',
      reason: 'MODEL_ABSTAINED',
      detail: 'the evidence reading did not settle the condition',
    };
  }

  if (proposed !== established) {
    return {
      kind: 'REVIEW',
      reason: 'OUTCOME_CONTRADICTS_CHECKS',
      detail:
        `the deterministic checks establish ${established} under the ${input.encodes} the plan ` +
        `encodes, but the reading of the evidence concluded ${proposed}`,
    };
  }

  if (input.matchedEdgeCase === null) {
    return {
      kind: 'OUTCOME',
      outcome: established,
      rationale: `the deterministic checks are ${input.verdict} against the ${input.encodes}`,
    };
  }

  const edgeCase = input.specification.edgeCases[input.matchedEdgeCase];
  if (edgeCase === undefined) {
    // Unreachable through the engine, which runs the semantic gate first. Handled
    // rather than asserted because a crash on a resolution path is worse than a
    // review, whatever the reason for it.
    return {
      kind: 'REVIEW',
      reason: 'EDGE_CASE_CONTRADICTS_CHECKS',
      detail: `edge case ${input.matchedEdgeCase} is not in the specification`,
    };
  }

  if (edgeCase.outcome === established) {
    return {
      kind: 'OUTCOME',
      outcome: established,
      rationale:
        `the deterministic checks are ${input.verdict} against the ${input.encodes}, and the ` +
        `pre-approved edge case ${input.matchedEdgeCase} settles the same way`,
    };
  }

  if (edgeCase.outcome === 'INVALID') {
    return {
      kind: 'OUTCOME',
      outcome: 'INVALID',
      rationale:
        `the evidence matches pre-approved edge case ${input.matchedEdgeCase}, which the parties ` +
        'fixed as INVALID; that routes to refunds rather than to a payout',
    };
  }

  return {
    kind: 'REVIEW',
    reason: 'EDGE_CASE_CONTRADICTS_CHECKS',
    detail:
      `edge case ${input.matchedEdgeCase} settles to ${edgeCase.outcome}, but the deterministic ` +
      `checks establish ${established}; a matched edge case may not flip a settlement`,
  };
}
