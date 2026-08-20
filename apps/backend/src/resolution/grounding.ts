/**
 * The semantic gate: everything Zod cannot check.
 *
 * Zod proves the model's output has the right *shape*. It cannot prove the
 * output is about the evidence that was actually retrieved. A perfectly
 * well-formed response can cite a source that was never read, quote a price that
 * appears nowhere in the bytes, name a URL nobody approved, or prefer a
 * fallback's value over the primary's. Every one of those is a resolution built
 * on something that does not exist, and every one of them passes a schema.
 *
 * So this module answers one question per claim: **is this traceable to bytes we
 * hold?** A claim that is not is not demoted, softened, or repaired — the whole
 * proposal becomes `NEEDS_REVIEW`. There is no partial credit, because a model
 * that fabricated one fact has not demonstrated that it did not fabricate the
 * others.
 *
 * ## What grounding is, and what it is not
 *
 * A value is grounded when it appears in the retained content of a source the
 * claim cites, or equals that source's approved selection. That is a
 * **necessary** condition, not a sufficient one: a number can appear in a
 * document and still be the wrong number to read. Sufficiency is what the
 * deterministic checks are for, and the two are complementary — the checks say
 * the right value was compared correctly, grounding says the model did not
 * invent the value it is talking about.
 *
 * Deliberately not attempted: proving that the model's *statement* is a fair
 * reading of the content. That is judgement, it is what the model was asked for,
 * and a second model checking the first would just move the trust rather than
 * remove it.
 */

import type { EvidenceClaim } from '@covenant/shared';

import type { EvidenceSnapshot } from '../evidence/retriever.js';
import type { SourceConflict } from '../validation/engine.js';
import { compareDecimal, parseDecimal } from '../validation/decimal.js';
import { scalarFromCanonical } from './claims.js';

/** One reason a proposal cannot stand. Every member ends in `NEEDS_REVIEW`. */
export type SemanticViolationKind =
  /** A claim cites a source that produced no content. */
  | 'UNCITED_SOURCE'
  /** A claim's value does not appear in the content of any source it cites. */
  | 'UNGROUNDED_VALUE'
  /** The reasoning names a URL that is not an approved source. */
  | 'INVENTED_URL'
  /** A claim carries the value of a source precedence did not select. */
  | 'SOURCE_PRECEDENCE_VIOLATED'
  /** The reasoning carries a hash or an address — values a resolver does not write. */
  | 'PROTOCOL_VALUE_IN_REASONING'
  /** `matchedEdgeCase` names an edge case the specification does not have. */
  | 'EDGE_CASE_OUT_OF_RANGE';

export interface SemanticViolation {
  readonly kind: SemanticViolationKind;
  /** Field path into the model's output, for the review record. */
  readonly path: string;
  readonly message: string;
}

/**
 * The retrieved evidence, indexed for grounding lookups.
 *
 * Built once per resolution rather than per claim: a model may return two dozen
 * claims and the content is measured in tens of kilobytes.
 */
export interface EvidenceIndex {
  /** Source ids that produced content. A claim may cite nothing else. */
  readonly citable: ReadonlySet<string>;
  /** Lowercased retained content per source id. */
  readonly content: ReadonlyMap<string, string>;
  /** The approved selection scalar per source id, when there was one. */
  readonly selections: ReadonlyMap<string, string>;
}

export function indexEvidence(snapshots: readonly EvidenceSnapshot[]): EvidenceIndex {
  const citable = new Set<string>();
  const content = new Map<string, string>();
  const selections = new Map<string, string>();

  for (const snapshot of snapshots) {
    citable.add(snapshot.sourceId);
    content.set(snapshot.sourceId, snapshot.normalizedContent.toLowerCase());
    if (snapshot.selection !== null) {
      const scalar = scalarFromCanonical(snapshot.selection.value);
      if (scalar !== null) selections.set(snapshot.sourceId, scalar);
    }
  }

  return { citable, content, selections };
}

/**
 * Whether a value is traceable to one of the sources a claim cites.
 *
 * Three ways to be grounded, in decreasing order of strength:
 *
 * 1. It equals the source's approved selection — the strongest, since that value
 *    came out of the specification's own `dataPath`.
 * 2. It is numerically equal to that selection. `121340` and `121340.00` are one
 *    price rendered two ways, and refusing the second would fail a resolution
 *    over a source's formatting rather than over its facts.
 * 3. It appears verbatim in the retained content. The weakest, and the reason
 *    grounding is necessary rather than sufficient.
 *
 * Case-insensitive, because a status field rendered `Delivered` in the document
 * and reported as `delivered` is the same reading. Note that the deterministic
 * validators are case-*sensitive* by default and that difference is intentional:
 * a validator is deciding whether a value matches an approved criterion, which
 * is a stricter question than whether a model made a value up.
 */
export function isGrounded(value: string, sourceIds: readonly string[], index: EvidenceIndex): boolean {
  const needle = value.trim().toLowerCase();
  if (needle.length === 0) return false;

  const parsed = parseDecimal(value);

  for (const sourceId of sourceIds) {
    const selection = index.selections.get(sourceId);
    if (selection !== undefined) {
      if (selection.trim().toLowerCase() === needle) return true;
      if (parsed !== null) {
        const selectionDecimal = parseDecimal(selection);
        if (selectionDecimal !== null && compareDecimal(parsed, selectionDecimal) === 0) return true;
      }
    }

    const body = index.content.get(sourceId);
    if (body !== undefined && body.includes(needle)) return true;
  }

  return false;
}

/** Hosts a resolver may legitimately name: exactly the approved ones. */
export function approvedHosts(urls: readonly string[]): ReadonlySet<string> {
  const hosts = new Set<string>();
  for (const url of urls) {
    try {
      hosts.add(new URL(url).host.toLowerCase());
    } catch {
      // An unparseable approved URL cannot be matched against, and refusing the
      // whole resolution over it would be the wrong failure: the URL policy
      // already refused to fetch it, and this check only widens what the model
      // is allowed to mention.
    }
  }
  return hosts;
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"'()\[\],;]+/gi;

/**
 * A 0x-prefixed 32-byte hex string, or a 20-byte address.
 *
 * A resolver has no reason to write either into its reasoning: it does not
 * compute a hash, does not name a contract, and does not address a transaction.
 * A model that produced one has stepped outside its role, and the cheap,
 * conservative response is a human read rather than a settlement.
 */
const PROTOCOL_VALUE_IN_TEXT = /0x[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?\b/;

export interface SemanticInput {
  readonly claims: readonly EvidenceClaim[];
  readonly reasoning: string;
  readonly matchedEdgeCase: number | null;
  readonly edgeCaseCount: number;
  readonly approvedUrls: readonly string[];
  readonly conflicts: readonly SourceConflict[];
  readonly index: EvidenceIndex;
}

/**
 * Run every semantic check, returning all violations rather than the first.
 *
 * All of them, because the review record is read by a person deciding what went
 * wrong, and "the model cited a source that does not exist" plus "and invented
 * the number" is a materially different diagnosis from either alone.
 */
export function checkSemantics(input: SemanticInput): readonly SemanticViolation[] {
  const violations: SemanticViolation[] = [];

  input.claims.forEach((claim, position) => {
    for (const sourceId of claim.sourceIds) {
      if (input.index.citable.has(sourceId)) continue;
      violations.push({
        kind: 'UNCITED_SOURCE',
        path: `claims[${position}].sourceIds`,
        message:
          `cites "${sourceId}", which produced no retrieved content; ` +
          'a claim may only rest on a source that was actually read',
      });
    }

    if (claim.value === null) return;
    if (isGrounded(claim.value, claim.sourceIds, input.index)) return;

    violations.push({
      kind: 'UNGROUNDED_VALUE',
      path: `claims[${position}].value`,
      message:
        `the value "${claim.value}" does not appear in the content of any source it cites; ` +
        'a claim must be traceable to retrieved bytes',
    });
  });

  /**
   * §7 of the validation engine, enforced against the model's own output.
   *
   * The rule is **not** "no claim may carry a rejected value". Reporting that a
   * fallback disagreed is exactly the transparency the conflict record exists
   * for, and a model that mentions it is doing the right thing. What is
   * forbidden is *substitution*: carrying the rejected reading while dropping
   * the one precedence selected, which presents the fallback's answer as the
   * operative fact.
   *
   * So a violation needs both halves — a rejected value present, and the
   * preferred value absent from the whole claim set.
   */
  for (const conflict of input.conflicts) {
    const rejected = new Set(conflict.dissenting.map((entry) => entry.value.trim().toLowerCase()));
    const preferred = conflict.preferredValue.trim().toLowerCase();

    const reportsPreferred = input.claims.some(
      (claim) => claim.value !== null && claim.value.trim().toLowerCase() === preferred,
    );
    if (reportsPreferred) continue;

    input.claims.forEach((claim, position) => {
      if (claim.value === null) return;
      const value = claim.value.trim().toLowerCase();
      if (!rejected.has(value)) return;

      violations.push({
        kind: 'SOURCE_PRECEDENCE_VIOLATED',
        path: `claims[${position}].value`,
        message:
          `carries "${claim.value}", which precedence rejected in favour of ` +
          `${conflict.preferredSourceId}'s "${conflict.preferredValue}" on check ` +
          `${conflict.checkId}, and no claim reports the value precedence selected`,
      });
    });
  }

  const hosts = approvedHosts(input.approvedUrls);
  for (const match of input.reasoning.matchAll(URL_IN_TEXT)) {
    let host: string;
    try {
      host = new URL(match[0]).host.toLowerCase();
    } catch {
      continue;
    }
    if (hosts.has(host)) continue;
    violations.push({
      kind: 'INVENTED_URL',
      path: 'reasoning',
      message: `names ${host}, which is not an approved source for this condition`,
    });
  }

  if (PROTOCOL_VALUE_IN_TEXT.test(input.reasoning)) {
    violations.push({
      kind: 'PROTOCOL_VALUE_IN_REASONING',
      path: 'reasoning',
      message:
        'contains a hash or address; a resolver does not compute either, and one appearing ' +
        'here means the model wrote something it was not asked for',
    });
  }

  if (input.matchedEdgeCase !== null && input.matchedEdgeCase >= input.edgeCaseCount) {
    violations.push({
      kind: 'EDGE_CASE_OUT_OF_RANGE',
      path: 'matchedEdgeCase',
      message:
        `names edge case ${input.matchedEdgeCase}, but the specification records ` +
        `${input.edgeCaseCount}`,
    });
  }

  return violations;
}
