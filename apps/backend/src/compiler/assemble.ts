/**
 * Assembling a `ConditionSpec` from a model draft.
 *
 * The split matters. The model supplies the *condition* — what must be
 * observed, by when, from which sources. The system supplies everything that is
 * an identifier or an economic term:
 *
 *   version   protocol constant
 *   nonce     random salt, so two identical wordings do not collide on one hash
 *   creator   the wallet from the authenticated request
 *   settlement  token, trading end, challenge window, bond, resolution window
 *
 * A model has no business choosing a bond size or a token address, and letting
 * it do so would put invented economic terms inside a hash a user is asked to
 * approve. Market terms come from operator policy; identifiers come from the
 * request and the RNG.
 *
 * The deadline is checked against a clock passed in by the caller, never one
 * read here, so the whole path stays deterministic under test.
 */

import type { ConditionSpecInput } from '@covenant/shared';

import type { MarketPolicy, SettlementTokenConfig } from '../config.js';
import type { ConditionDraft } from './output-schema.js';

export interface AssembleContext {
  readonly creator: string;
  readonly nonce: string;
  readonly token: SettlementTokenConfig;
  readonly policy: MarketPolicy;
  readonly now: Date;
}

/** A reason assembly could not proceed, in the shape the compiler reports. */
export interface AssemblyProblem {
  readonly field: string;
  readonly question: string;
  readonly why: string;
}

export type AssemblyResult =
  | { readonly ok: true; readonly spec: ConditionSpecInput }
  | { readonly ok: false; readonly problems: readonly AssemblyProblem[] };

const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

function toUtcSecondString(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Turn a validated draft into a full specification input.
 *
 * Returns problems rather than throwing, because every one of them is a
 * question for the user: a deadline in the past, a deadline too near for the
 * policy's trading window, a date the model wrote in a shape nobody can parse.
 * Those belong on the INCOMPLETE path, not in an error log.
 */
export function assembleConditionSpec(
  draft: ConditionDraft,
  context: AssembleContext,
): AssemblyResult {
  const problems: AssemblyProblem[] = [];

  if (!RFC3339.test(draft.deadline)) {
    problems.push({
      field: 'deadline',
      question:
        'What exact date and time should the condition be measured at? Please include a timezone, for example 2026-09-01 23:59:59 UTC.',
      why: `"${draft.deadline}" is not an unambiguous instant, so two people could measure the condition at different moments.`,
    });
    return { ok: false, problems };
  }

  const deadlineMs = Date.parse(draft.deadline);
  if (!Number.isFinite(deadlineMs)) {
    problems.push({
      field: 'deadline',
      question: 'What exact date and time should the condition be measured at?',
      why: `"${draft.deadline}" is not a real calendar date.`,
    });
    return { ok: false, problems };
  }

  const deadlineSeconds = Math.floor(deadlineMs / 1000);
  const nowSeconds = Math.floor(context.now.getTime() / 1000);

  if (deadlineSeconds <= nowSeconds) {
    problems.push({
      field: 'deadline',
      question: 'That deadline has already passed. What future date and time did you mean?',
      why: 'A condition cannot be opened for funding once the instant it is measured against is in the past.',
    });
    return { ok: false, problems };
  }

  const tradingEndsSeconds = deadlineSeconds - context.policy.tradingEndsLeadSeconds;
  if (tradingEndsSeconds <= nowSeconds) {
    const hours = Math.round(context.policy.tradingEndsLeadSeconds / 3600);
    problems.push({
      field: 'deadline',
      question: `That deadline is too soon. Funding closes ${hours} hours before the deadline, so the deadline needs to be further out. What later date and time works?`,
      why: 'There would be no time left for anyone to fund the condition before staking closes.',
    });
    return { ok: false, problems };
  }

  return {
    ok: true,
    spec: {
      version: '1.0',
      nonce: context.nonce,
      creator: context.creator,
      question: draft.question,
      conditionType: draft.conditionType,
      successCondition: draft.successCondition,
      failureCondition: draft.failureCondition,
      deadline: toUtcSecondString(deadlineSeconds),
      timezone: draft.timezone,
      resolutionMethod: draft.resolutionMethod,
      // Order is preserved exactly as the model produced it: index 0 is the
      // primary source and later entries are fallbacks in priority order
      // (ADR-0008). Sorting this array would silently change which source
      // decides the outcome.
      approvedSources: draft.approvedSources.map((source) => ({
        name: source.name,
        url: source.url,
        retrievalKind: source.retrievalKind,
        dataPath: source.dataPath,
      })),
      evidenceRequirements: draft.evidenceRequirements,
      ambiguities: draft.ambiguities,
      edgeCases: draft.edgeCases,
      risk: draft.risk,
      settlement: {
        kind: 'binary_parimutuel',
        token: {
          chainId: context.token.chainId,
          address: context.token.address,
          symbol: context.token.symbol,
          decimals: context.token.decimals,
        },
        tradingEndsAt: toUtcSecondString(tradingEndsSeconds),
        challengeWindowSeconds: context.policy.challengeWindowSeconds,
        challengeBondBaseUnits: context.policy.challengeBondBaseUnits,
        resolutionDeadlineSeconds: context.policy.resolutionWindowSeconds,
      },
    },
  };
}
