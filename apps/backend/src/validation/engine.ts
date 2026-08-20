/**
 * The deterministic validation engine: snapshots and a plan in,
 * `DeterministicCheck[]` and a verdict out.
 *
 * ```
 * ConditionSpec  +  EvidenceSnapshot[]  +  ValidationPlan
 *      ↓   resolve each observation, in approved-source precedence order
 *      ↓   run the validator that handles it — no model, no clock, no network
 * DeterministicCheck[]        (ready for EvidencePackage v2.0)
 * ValidationVerdict           (SATISFIED | REFUTED | NEEDS_REVIEW)
 * ```
 *
 * ## What this deliberately does not produce
 *
 * No outcome, no reasoning, no confidence. `SATISFIED` is **not** `YES`: it says
 * every planned check passed, which is a fact about the checks. Turning that
 * into a proposed outcome requires reading the specification's success and
 * failure conditions against each other, and that is the next milestone's job.
 * Collapsing the two here would be the whole point of the split, undone.
 *
 * ## Conflicting sources (§7)
 *
 * When several approved sources answer the same observation, they may disagree.
 * The rule is **precedence, never majority**:
 *
 * 1. Sources are consulted in `approvedSources` order. Index 0 is primary.
 * 2. The highest-precedence source that produced a usable value supplies the
 *    observation. That is what precedence *means* (ADR-0008), and it is why the
 *    array is ordered and hashed.
 * 3. A disagreement among lower-precedence sources does not change the verdict,
 *    but it **is recorded** — on the check's `explanation` and in
 *    `conflicts`, so a challenger can see that the sources differed and that the
 *    primary was preferred rather than the disagreement being hidden.
 *
 * Majority voting is never used. Three agreeing fallbacks do not outrank the
 * primary, because the user approved an ordering, not an electorate.
 *
 * `NEEDS_REVIEW` is returned when precedence cannot settle it: no source
 * produced a usable value, or a check could not run. Never `YES`, never `NO`.
 */

import type { ConditionSpec, DeterministicCheck, RetrievalStatus } from '@covenant/shared';

import type { EvidenceSnapshot, FailedRetrieval } from '../evidence/retriever.js';
import { resolveJsonPointer } from '../evidence/normalize.js';
import { parseInstant } from './temporal.js';
import { approvedIndexOf, type PlannedCheck, type ValidationPlan } from './plan.js';
import {
  DEFAULT_VALIDATORS,
  type ObservedValue,
  type Validator,
  type ValidatorOutcome,
} from './validators.js';

/**
 * What the deterministic layer concluded about the *plan*, not about the market.
 *
 * Kept verbally distinct from `Outcome` on purpose. Anyone tempted to map
 * `SATISFIED → YES` in a later milestone has to do it deliberately, in code that
 * also reads `failureCondition`, rather than by assignment.
 */
export type ValidationVerdict = 'SATISFIED' | 'REFUTED' | 'NEEDS_REVIEW';

/** A recorded disagreement between approved sources on one observation. */
export interface SourceConflict {
  readonly checkId: string;
  /** The source precedence chose, and the value it gave. */
  readonly preferredSourceId: string;
  readonly preferredValue: string;
  /** Sources that answered differently, in precedence order. */
  readonly dissenting: ReadonlyArray<{
    readonly sourceId: string;
    readonly value: string;
  }>;
}

export interface ValidationResult {
  readonly verdict: ValidationVerdict;
  /** Ready to place in `EvidencePackage.deterministicChecks`, in plan order. */
  readonly checks: readonly DeterministicCheck[];
  readonly conflicts: readonly SourceConflict[];
  /** Plan entries no validator handled. Should be empty; non-empty is a bug. */
  readonly unhandled: readonly string[];
  /** Check ids that applied but could not run. */
  readonly validationErrors: ReadonlyArray<{ readonly checkId: string; readonly reason: string }>;
  /** Why the verdict is what it is, in one line. Not user-facing prose. */
  readonly summary: string;
}

export interface ValidationEngineOptions {
  readonly validators?: readonly Validator[];
  /**
   * Emit a `SOURCE_AVAILABLE` check per approved source.
   *
   * On by default: an auditor reading a package should see which sources
   * answered without having to infer it from which checks have values. These are
   * **informational** and never move the verdict — a primary that failed while
   * an approved fallback answered is precedence working, not a refutation.
   */
  readonly includeAvailabilityChecks?: boolean;
}

export interface ValidationInput {
  readonly specification: ConditionSpec;
  readonly plan: ValidationPlan;
  readonly snapshots: readonly EvidenceSnapshot[];
  readonly failures?: readonly FailedRetrieval[];
}

export class DeterministicValidationEngine {
  private readonly validators: readonly Validator[];
  private readonly includeAvailabilityChecks: boolean;

  constructor(options: ValidationEngineOptions = {}) {
    this.validators = options.validators ?? DEFAULT_VALIDATORS;
    this.includeAvailabilityChecks = options.includeAvailabilityChecks ?? true;
  }

  validate(input: ValidationInput): ValidationResult {
    const specDeadline = parseInstant(input.specification.deadline);
    if (specDeadline === null) {
      // Unreachable through `parseConditionSpec`, which normalises `deadline`.
      // Handled rather than asserted because an engine that threw here would
      // turn a data problem into a crash on a resolution path.
      return {
        verdict: 'NEEDS_REVIEW',
        checks: [],
        conflicts: [],
        unhandled: [],
        validationErrors: [
          { checkId: '(specification)', reason: 'the specification deadline is not a valid instant' },
        ],
        summary: 'the specification deadline could not be read',
      };
    }

    const checks: DeterministicCheck[] = [];
    const conflicts: SourceConflict[] = [];
    const unhandled: string[] = [];
    const validationErrors: Array<{ checkId: string; reason: string }> = [];

    for (const planned of input.plan.checks) {
      const validator = this.validators.find((candidate) => candidate.handles(planned));
      if (validator === undefined) {
        unhandled.push(planned.checkId);
        continue;
      }

      const resolution = this.observe(planned, input.snapshots);
      if (resolution.conflict !== null) conflicts.push(resolution.conflict);

      const outcome: ValidatorOutcome = validator.run({
        planned,
        observed: resolution.observed,
        specDeadline,
        sourceIds: resolution.sourceIds,
      });

      if (outcome.kind === 'NOT_APPLICABLE') {
        // A validator that claimed the check and then declined it is a bug, not
        // a resolution state. Recording it as unhandled surfaces that.
        unhandled.push(planned.checkId);
        continue;
      }

      if (outcome.kind === 'VALIDATION_ERROR') {
        validationErrors.push({ checkId: planned.checkId, reason: outcome.reason });
      }

      checks.push(
        resolution.conflict === null
          ? outcome.check
          : annotateConflict(outcome.check, resolution.conflict),
      );
    }

    if (this.includeAvailabilityChecks) {
      checks.push(...availabilityChecks(input.specification, input.snapshots, input.failures ?? []));
    }

    const decisive = checks.filter((entry) => entry.checkType !== 'SOURCE_AVAILABLE');
    return {
      verdict: verdictFrom(decisive, unhandled),
      checks,
      conflicts,
      unhandled,
      validationErrors,
      summary: summarise(decisive, unhandled, conflicts),
    };
  }

  /**
   * Resolve one observation across every snapshot that can serve it, honouring
   * precedence and recording any disagreement.
   */
  private observe(
    planned: PlannedCheck,
    snapshots: readonly EvidenceSnapshot[],
  ): {
    readonly observed: ObservedValue | null;
    readonly sourceIds: readonly string[];
    readonly conflict: SourceConflict | null;
  } {
    const requested = planned.observation.sourceId;
    const requestedIndex = approvedIndexOf(requested);

    /**
     * `observation.sourceId` names the **highest-precedence position to consult**,
     * not the only one.
     *
     * Every approved source at or after that position is read, because
     * corroboration is what makes a disagreement visible — consulting exactly one
     * source would make §7's conflict handling unreachable, and falling back when
     * the primary is silent impossible. Naming a later position is how a plan
     * deliberately skips a source that does not carry the field at all.
     *
     * Ordering is by approved index, so the walk below is precedence order by
     * construction rather than by the order snapshots happen to arrive in.
     */
    const floor = requestedIndex ?? 0;
    const candidates = snapshots
      .filter((snapshot) => snapshot.approvedSourceIndex >= floor)
      .slice()
      .sort((a, b) => a.approvedSourceIndex - b.approvedSourceIndex);

    const readings: ObservedValue[] = [];
    for (const snapshot of candidates) {
      const text = readObservation(snapshot, planned.observation.pointer);
      if (text === null) continue;
      readings.push({
        sourceId: snapshot.sourceId,
        approvedSourceIndex: snapshot.approvedSourceIndex,
        text,
      });
    }

    if (readings.length === 0) {
      return {
        observed: null,
        sourceIds: requestedIndex === null ? [] : [requested],
        conflict: null,
      };
    }

    // Precedence: the lowest approved index wins. Never a vote.
    const preferred = readings[0]!;
    const dissenting = readings
      .slice(1)
      .filter((reading) => reading.text !== preferred.text)
      .map((reading) => ({ sourceId: reading.sourceId, value: reading.text }));

    return {
      observed: preferred,
      sourceIds: readings.map((reading) => reading.sourceId),
      conflict:
        dissenting.length === 0
          ? null
          : {
              checkId: planned.checkId,
              preferredSourceId: preferred.sourceId,
              preferredValue: preferred.text,
              dissenting,
            },
    };
  }
}

/**
 * Read one value out of a snapshot as text.
 *
 * `pointer: null` uses the snapshot's `selection` — the value at the
 * specification's own approved `dataPath`. That is the preferred form, because
 * the locator is then part of the hashed agreement rather than of an unhashed
 * plan.
 */
function readObservation(snapshot: EvidenceSnapshot, pointer: string | null): string | null {
  if (pointer === null) {
    return snapshot.selection === null ? null : unwrapCanonical(snapshot.selection.value);
  }

  // A truncated document cannot be parsed, and guessing at the missing tail
  // would be worse than declining. The check becomes INDETERMINATE.
  if (snapshot.normalizedTruncated) return null;

  let document: unknown;
  try {
    document = JSON.parse(snapshot.normalizedContent) as unknown;
  } catch {
    return null;
  }

  const selected = resolveJsonPointer(document, pointer);
  if (selected === undefined) return null;
  if (selected === null) return null;
  if (typeof selected === 'object') return null;
  return String(selected);
}

/**
 * Turn canonical JSON back into the scalar text a validator compares.
 *
 * The snapshot stores selections as canonical JSON, so a string arrives quoted
 * and a number bare. Unquoting is not cosmetic: `"121340"` and `121340` must
 * both reach the decimal parser as `121340`, or a source that quotes its numbers
 * would be unreadable while an identical one that does not would work.
 */
function unwrapCanonical(value: string): string | null {
  if (!value.startsWith('"')) {
    // A canonical object or array is not a scalar observation.
    if (value.startsWith('{') || value.startsWith('[')) return null;
    if (value === 'null') return null;
    return value;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** Record a disagreement on the check itself, so the package carries it. */
function annotateConflict(entry: DeterministicCheck, conflict: SourceConflict): DeterministicCheck {
  const note =
    `approved sources disagreed; precedence selected ${conflict.preferredSourceId} ` +
    `(${conflict.preferredValue}) over ` +
    conflict.dissenting.map((d) => `${d.sourceId} (${d.value})`).join(', ');
  return {
    ...entry,
    explanation: entry.explanation === null ? note : `${entry.explanation}; ${note}`,
  };
}

/**
 * One `SOURCE_AVAILABLE` check per approved source.
 *
 * Informational: excluded from the verdict, because a primary that failed while
 * an approved fallback answered is precedence working as designed, not a
 * refutation of the condition.
 */
function availabilityChecks(
  specification: ConditionSpec,
  snapshots: readonly EvidenceSnapshot[],
  failures: readonly FailedRetrieval[],
): DeterministicCheck[] {
  const byIndex = new Map<number, { sourceId: string; status: RetrievalStatus; detail: string }>();

  for (const snapshot of snapshots) {
    byIndex.set(snapshot.approvedSourceIndex, {
      sourceId: snapshot.sourceId,
      status: 'RETRIEVED',
      detail: `read in ${snapshot.attempts} attempt(s)`,
    });
  }
  for (const failure of failures) {
    if (byIndex.has(failure.approvedSourceIndex)) continue;
    byIndex.set(failure.approvedSourceIndex, {
      sourceId: failure.sourceId,
      status: 'UNAVAILABLE',
      detail: failure.failure,
    });
  }

  const checks: DeterministicCheck[] = [];
  specification.approvedSources.forEach((_source, index) => {
    const record = byIndex.get(index);
    if (record === undefined) return;
    checks.push({
      checkId: `availability-${index}`,
      checkType: 'SOURCE_AVAILABLE',
      sourceIds: [record.sourceId],
      expected: `approved source ${index} responds within the resolution window`,
      observed: record.status === 'RETRIEVED' ? record.detail : null,
      result: record.status === 'RETRIEVED' ? 'PASS' : 'INDETERMINATE',
      explanation:
        record.status === 'RETRIEVED'
          ? null
          : `not read: ${record.detail}. Informational only; it does not decide the condition.`,
    });
  });
  return checks;
}

/**
 * The verdict rule, in one place.
 *
 * Conservative by construction: any check that could not run makes the whole
 * verdict `NEEDS_REVIEW`, even if every other check passed. A resolution built
 * on "most of the checks worked" is exactly the kind that looks fine until the
 * one that did not run was the one that mattered.
 */
function verdictFrom(decisive: readonly DeterministicCheck[], unhandled: readonly string[]): ValidationVerdict {
  if (unhandled.length > 0) return 'NEEDS_REVIEW';
  if (decisive.length === 0) return 'NEEDS_REVIEW';
  if (decisive.some((entry) => entry.result === 'INDETERMINATE')) return 'NEEDS_REVIEW';
  if (decisive.some((entry) => entry.result === 'FAIL')) return 'REFUTED';
  return 'SATISFIED';
}

function summarise(
  decisive: readonly DeterministicCheck[],
  unhandled: readonly string[],
  conflicts: readonly SourceConflict[],
): string {
  const parts = [
    `${decisive.filter((entry) => entry.result === 'PASS').length} passed`,
    `${decisive.filter((entry) => entry.result === 'FAIL').length} failed`,
    `${decisive.filter((entry) => entry.result === 'INDETERMINATE').length} indeterminate`,
  ];
  if (unhandled.length > 0) parts.push(`${unhandled.length} unhandled`);
  if (conflicts.length > 0) parts.push(`${conflicts.length} source conflict(s) settled by precedence`);
  return parts.join(', ');
}
