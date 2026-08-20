/**
 * The evidence retriever: approved sources in, snapshots out.
 *
 * ```
 * ConditionSpec.approvedSources  (ordered — index 0 is primary)
 *      ↓  precedence walk, stopping at the first usable answer
 * retrieved bytes
 *      ↓  status / content-type / parse / dataPath policy
 * EvidenceSnapshot            (normalised, bounded, hashed)
 *      ↓
 * EvidenceSource[]            (the v2.0 records EvidencePackage needs)
 * ```
 *
 * ## Three things it does not do
 *
 * - **It never adds a source.** The only URLs it will read are the ones in the
 *   specification the user approved, in the order they approved them. There is
 *   no discovery, no substitution, and no "try the obvious alternative".
 * - **It never decides an outcome.** A source that could not be read produces a
 *   failure record, not a NO. Absence of evidence is not evidence — the whole
 *   reason `RetrievalStatus` exists as a separate vocabulary from `Outcome`.
 * - **It never mutates the ConditionSpec.** The specification is an input and is
 *   read-only; a test asserts it is byte-identical afterwards, because a
 *   retriever that edited it would change `rulesHash` and unbind every market.
 *
 * ## Precedence, exactly
 *
 * Sources are attempted in array order. The **first** one that yields a usable
 * snapshot ends the walk; everything after it is recorded as `NOT_ATTEMPTED`
 * rather than omitted, so the package distinguishes "we did not need it" from
 * "we forgot it". Everything before it is recorded with the status its failure
 * maps to. That is what makes a fallback visible: reading position 1 is only
 * legitimate when position 0 is on record as having failed.
 */

import type {
  ApprovedSource,
  ConditionSpec,
  EvidenceSource as EvidenceSourceRecord,
  RetrievalKind,
  RetrievalStatus,
} from '@covenant/shared';
import type { Bytes32Hex } from '@covenant/shared';

import { assertContentType, normalizeContent, type SnapshotSelection } from './normalize.js';
import {
  SourceRetrievalError,
  type EvidenceSourceAdapter,
  type RetrievalFailureKind,
  type SourceResponse,
} from './types.js';
import { normalizeSourceUrl, DEFAULT_URL_POLICY, type UrlPolicy } from './url-policy.js';

/**
 * How an operational failure becomes a protocol status.
 *
 * Six kinds collapse into three, and the collapse is the point: an operator
 * needs to know that our own policy blocked a host rather than the host being
 * down; a published evidence document does not, and every extra member of a
 * hashed vocabulary is one every reimplementation carries forever.
 *
 * Note that `SOURCE_FORBIDDEN` and `SOURCE_UNSUPPORTED` both become
 * `UNAVAILABLE`. Neither is `MALFORMED`, which is reserved for "the source
 * answered and the answer could not be parsed as its declared kind" — in both
 * of these cases nothing was read at all.
 */
export const FAILURE_TO_STATUS: Readonly<Record<RetrievalFailureKind, RetrievalStatus>> = {
  SOURCE_UNAVAILABLE: 'UNAVAILABLE',
  SOURCE_TIMEOUT: 'UNAVAILABLE',
  SOURCE_FORBIDDEN: 'UNAVAILABLE',
  SOURCE_UNSUPPORTED: 'UNAVAILABLE',
  SOURCE_INVALID: 'MALFORMED',
  SOURCE_MALFORMED: 'MALFORMED',
};

export interface RetrievalLimits {
  /** Per-attempt wall clock, including redirects. */
  readonly timeoutMs: number;
  /** Hard body ceiling. Exceeding it fails the source; nothing is truncated. */
  readonly maxResponseBytes: number;
  /** Ceiling on retained `normalizedContent`, in characters. */
  readonly maxRetainedChars: number;
  /** Total attempts per source, including the first. 1 disables retries. */
  readonly maxAttempts: number;
  /** Base delay between attempts; multiplied by the attempt number. */
  readonly retryBackoffMs: number;
  readonly maxRedirects: number;
  /** Ceiling across the whole walk, so one market cannot stall the resolver. */
  readonly totalBudgetMs: number;
}

export const DEFAULT_RETRIEVAL_LIMITS: RetrievalLimits = {
  timeoutMs: 10_000,
  maxResponseBytes: 2 * 1024 * 1024,
  maxRetainedChars: 20_000,
  maxAttempts: 3,
  retryBackoffMs: 500,
  maxRedirects: 3,
  totalBudgetMs: 60_000,
};

/** Common identity of an approved source, whatever happened to it. */
interface SourceIdentity {
  readonly sourceId: string;
  readonly approvedSourceIndex: number;
  readonly name: string;
  /** Verbatim from the specification — see `toEvidenceSources`. */
  readonly url: string;
  /** What was actually requested. May differ from `url`; see §14 of the doc. */
  readonly normalizedUrl: string | null;
  readonly retrievalKind: RetrievalKind;
}

/** A source that was read and normalised. */
export interface EvidenceSnapshot extends SourceIdentity {
  readonly retrievedAt: string;
  /** keccak256 of the complete raw body. */
  readonly contentHash: Bytes32Hex;
  readonly normalizedContent: string;
  readonly normalizedHash: Bytes32Hex;
  readonly normalizedTruncated: boolean;
  readonly rawBytes: number;
  readonly selection: SnapshotSelection | null;
  readonly finalUrl: string;
  readonly redirects: readonly string[];
  readonly attempts: number;
  /** `sourceId` of the earlier source whose read this reuses, if any. */
  readonly deduplicatedFrom: string | null;
}

/** A source that was attempted and could not be used. */
export interface FailedRetrieval extends SourceIdentity {
  readonly attemptedAt: string;
  readonly failure: RetrievalFailureKind;
  /** Safe to surface. Never carries a resolved address or a credential. */
  readonly detail: string;
  readonly attempts: number;
}

/** A source that was never read, because precedence never reached it. */
export interface SkippedSource extends SourceIdentity {
  readonly reason: 'PRECEDENCE_SATISFIED' | 'BUDGET_EXHAUSTED';
}

export interface RetrievalResult {
  readonly snapshots: readonly EvidenceSnapshot[];
  readonly failures: readonly FailedRetrieval[];
  readonly skipped: readonly SkippedSource[];
  /** The snapshot precedence selected, or null when every source failed. */
  readonly primary: EvidenceSnapshot | null;
  /** The v2.0 records, in approved-source order. Feed straight to M5.1. */
  readonly evidenceSources: readonly EvidenceSourceRecord[];
}

export interface EvidenceRetrieverOptions {
  readonly adapters: readonly EvidenceSourceAdapter[];
  readonly limits?: Partial<RetrievalLimits>;
  readonly urlPolicy?: UrlPolicy;
  /** Injected so `retrievedAt` is deterministic in tests. */
  readonly now?: () => Date;
  /** Injected so retry backoff does not make the suite sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * `sourceId` for an approved source.
 *
 * Derived from the index rather than slugified from the name: it must satisfy
 * the protocol's identifier grammar (lowercase, bounded), must be unique, and
 * must be stable across runs. Slugifying arbitrary user-supplied text satisfies
 * none of those reliably — a non-ASCII name would produce an empty slug and two
 * similar names would collide. The human label lives in `name`.
 */
export function sourceIdForIndex(index: number): string {
  return `source-${index}`;
}

/** UTC instant at whole-second resolution — the protocol's time granularity. */
function instant(date: Date): string {
  return new Date(Math.floor(date.getTime() / 1000) * 1000).toISOString().replace(/\.000Z$/, 'Z');
}

/**
 * How long past its own deadline an adapter is given before the retriever stops
 * waiting for it.
 *
 * Generous on purpose: this is a backstop against an adapter that has stopped
 * honouring its contract, not a second timeout competing with the first. If it
 * fires, the adapter has a bug.
 */
const ADAPTER_GRACE_MS = 2_000;

/**
 * Stop waiting on a promise that may never settle.
 *
 * The loser of the race is not cancelled, because a generic promise cannot be;
 * it is simply ignored. The timer is unreferenced so an abandoned retrieval
 * cannot hold the process open.
 */
async function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new SourceRetrievalError(
                'SOURCE_TIMEOUT',
                `the transport did not return within ${timeoutMs}ms`,
                { retryable: true },
              ),
            ),
          Math.max(1, timeoutMs),
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class EvidenceRetriever {
  private readonly adapters: readonly EvidenceSourceAdapter[];
  private readonly limits: RetrievalLimits;
  private readonly urlPolicy: UrlPolicy;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EvidenceRetrieverOptions) {
    this.adapters = options.adapters;
    this.limits = { ...DEFAULT_RETRIEVAL_LIMITS, ...options.limits };
    this.urlPolicy = options.urlPolicy ?? DEFAULT_URL_POLICY;
    this.now = options.now ?? (() => new Date());
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms).unref?.();
        }));
  }

  /**
   * Walk the approved sources in precedence order.
   *
   * @param specification Read-only. Never modified, and never a source of URLs
   * beyond `approvedSources`.
   */
  async retrieve(specification: ConditionSpec): Promise<RetrievalResult> {
    const snapshots: EvidenceSnapshot[] = [];
    const failures: FailedRetrieval[] = [];
    const skipped: SkippedSource[] = [];

    /** Successful reads within this walk, keyed by normalised URL. */
    const seen = new Map<string, EvidenceSnapshot>();
    const startedAt = Date.now();
    let primary: EvidenceSnapshot | null = null;

    for (const [index, approved] of specification.approvedSources.entries()) {
      const identity = this.identify(approved, index);

      if (primary !== null) {
        skipped.push({ ...identity, reason: 'PRECEDENCE_SATISFIED' });
        continue;
      }

      if (Date.now() - startedAt >= this.limits.totalBudgetMs) {
        skipped.push({ ...identity, reason: 'BUDGET_EXHAUSTED' });
        continue;
      }

      // A URL that fails name-level policy never reaches an adapter. Refusing
      // before the socket is the point of having the policy at all.
      let normalizedUrl: string;
      try {
        normalizedUrl = normalizeSourceUrl(approved.url, this.urlPolicy).href;
      } catch (error) {
        failures.push(this.toFailure({ ...identity, normalizedUrl: null }, error, 1));
        continue;
      }

      const resolved: SourceIdentity = { ...identity, normalizedUrl };

      // An earlier approved source that normalises to the same URL was already
      // read. Reading it again would be a second request for one fact, and the
      // second answer could differ, which would put two readings of one source
      // into one package.
      const alreadyRead = seen.get(normalizedUrl);
      if (alreadyRead !== undefined) {
        const reused: EvidenceSnapshot = {
          ...resolved,
          retrievedAt: alreadyRead.retrievedAt,
          contentHash: alreadyRead.contentHash,
          normalizedContent: alreadyRead.normalizedContent,
          normalizedHash: alreadyRead.normalizedHash,
          normalizedTruncated: alreadyRead.normalizedTruncated,
          rawBytes: alreadyRead.rawBytes,
          selection: alreadyRead.selection,
          finalUrl: alreadyRead.finalUrl,
          redirects: alreadyRead.redirects,
          attempts: 0,
          deduplicatedFrom: alreadyRead.sourceId,
        };
        snapshots.push(reused);
        primary = reused;
        continue;
      }

      const attempt = await this.retrieveOne(resolved, approved, startedAt);
      if (attempt.ok) {
        snapshots.push(attempt.snapshot);
        seen.set(normalizedUrl, attempt.snapshot);
        primary = attempt.snapshot;
      } else {
        failures.push(attempt.failure);
      }
    }

    return {
      snapshots,
      failures,
      skipped,
      primary,
      evidenceSources: toEvidenceSources(specification, { snapshots, failures, skipped }),
    };
  }

  private identify(approved: ApprovedSource, index: number): SourceIdentity {
    return {
      sourceId: sourceIdForIndex(index),
      approvedSourceIndex: index,
      name: approved.name,
      url: approved.url,
      normalizedUrl: null,
      retrievalKind: approved.retrievalKind,
    };
  }

  private adapterFor(kind: RetrievalKind): EvidenceSourceAdapter | null {
    return this.adapters.find((adapter) => adapter.supports(kind)) ?? null;
  }

  private async retrieveOne(
    identity: SourceIdentity,
    approved: ApprovedSource,
    startedAt: number,
  ): Promise<
    { readonly ok: true; readonly snapshot: EvidenceSnapshot } | {
      readonly ok: false;
      readonly failure: FailedRetrieval;
    }
  > {
    const adapter = this.adapterFor(approved.retrievalKind);
    if (adapter === null) {
      return {
        ok: false,
        failure: this.toFailure(
          identity,
          new SourceRetrievalError(
            'SOURCE_UNSUPPORTED',
            `no configured adapter can retrieve a ${approved.retrievalKind} source`,
          ),
          0,
        ),
      };
    }

    let attempts = 0;
    let lastError: unknown = null;

    while (attempts < this.limits.maxAttempts) {
      attempts += 1;

      if (Date.now() - startedAt >= this.limits.totalBudgetMs) {
        lastError = new SourceRetrievalError(
          'SOURCE_TIMEOUT',
          'the retrieval budget for this market was exhausted',
        );
        break;
      }

      try {
        // The adapter is contractually required to honour `timeoutMs`. This
        // wraps it anyway, with a grace margin, because "an approved source can
        // stall the resolver forever" is a liveness failure and a contract is
        // not an enforcement mechanism. A live run found exactly this: an
        // unbounded DNS lookup inside an adapter that believed it was bounded.
        const response = await withDeadline(
          adapter.retrieve({
            url: identity.normalizedUrl as string,
            retrievalKind: approved.retrievalKind,
            timeoutMs: this.limits.timeoutMs,
            maxResponseBytes: this.limits.maxResponseBytes,
            maxRedirects: this.limits.maxRedirects,
          }),
          this.limits.timeoutMs + ADAPTER_GRACE_MS,
        );

        assertStatus(response.statusCode);
        assertContentType(approved.retrievalKind, response.contentType);

        const normalized = normalizeContent({
          retrievalKind: approved.retrievalKind,
          contentType: response.contentType,
          body: response.body,
          dataPath: approved.retrievalKind === 'http_json' ? approved.dataPath : null,
          maxRetainedChars: this.limits.maxRetainedChars,
        });

        return {
          ok: true,
          snapshot: {
            ...identity,
            retrievedAt: instant(this.now()),
            contentHash: normalized.contentHash,
            normalizedContent: normalized.normalizedContent,
            normalizedHash: normalized.normalizedHash,
            normalizedTruncated: normalized.normalizedTruncated,
            rawBytes: normalized.rawBytes,
            selection: normalized.selection,
            finalUrl: response.finalUrl,
            redirects: response.redirects,
            attempts,
            deduplicatedFrom: null,
          },
        };
      } catch (error) {
        lastError = error;

        // Only genuinely transient failures are retried. A 404, a bad
        // content-type and a policy refusal are all *answers*; asking again is
        // noise aimed at a source that has already been definitive, and the
        // reason the retryable flag is carried on the error rather than derived
        // from its kind.
        const retryable = error instanceof SourceRetrievalError && error.retryable;
        if (!retryable || attempts >= this.limits.maxAttempts) break;

        await this.sleep(this.limits.retryBackoffMs * attempts);
      }
    }

    return { ok: false, failure: this.toFailure(identity, lastError, attempts) };
  }

  private toFailure(identity: SourceIdentity, error: unknown, attempts: number): FailedRetrieval {
    const known = error instanceof SourceRetrievalError;
    return {
      ...identity,
      attemptedAt: instant(this.now()),
      // An unclassified error is `SOURCE_UNAVAILABLE` rather than a crash: the
      // resolver must always be able to say what happened to a source, and an
      // unexpected throw is still "we could not read it".
      failure: known ? error.kind : 'SOURCE_UNAVAILABLE',
      detail: known ? error.detail : 'retrieval failed unexpectedly',
      attempts,
    };
  }
}

/**
 * HTTP status policy.
 *
 * Only 200 is a usable answer. 204 and 206 are refused rather than treated as
 * empty successes — an evidence source that returns no content has not answered
 * the question, and hashing an empty body as though it had would be worse than
 * falling through to the approved fallback.
 *
 * @throws {SourceRetrievalError}
 */
export function assertStatus(statusCode: number): void {
  if (statusCode === 200) return;

  if (statusCode === 401 || statusCode === 403) {
    throw new SourceRetrievalError('SOURCE_FORBIDDEN', `source refused the request (${statusCode})`);
  }
  if (statusCode === 404 || statusCode === 410) {
    // Definitive, so not retryable: the resource is not there and asking four
    // more times will not put it there.
    throw new SourceRetrievalError('SOURCE_UNAVAILABLE', `source has no such resource (${statusCode})`);
  }
  if (statusCode === 408 || statusCode === 429) {
    throw new SourceRetrievalError('SOURCE_UNAVAILABLE', `source is throttling (${statusCode})`, {
      retryable: true,
    });
  }
  if (statusCode >= 500) {
    throw new SourceRetrievalError('SOURCE_UNAVAILABLE', `source failed (${statusCode})`, {
      retryable: true,
    });
  }
  throw new SourceRetrievalError('SOURCE_INVALID', `unusable status ${statusCode}`);
}

/**
 * Project a walk onto the `EvidenceSource` records `EvidencePackage` v2.0 needs.
 *
 * Two details carry protocol weight:
 *
 * - **`url` is the specification's string, verbatim.**
 *   `buildEvidenceCommitmentForSpec` refuses a package whose source URL is not
 *   the one approved at the cited position, so writing the normalised form here
 *   would make every package unbindable. Normalisation decides what is
 *   *requested*; the specification decides what is *recorded*.
 * - **Order is approved-source order**, because `sources` is an ordered
 *   collection whose position carries precedence.
 */
export function toEvidenceSources(
  specification: ConditionSpec,
  walk: {
    readonly snapshots: readonly EvidenceSnapshot[];
    readonly failures: readonly FailedRetrieval[];
    readonly skipped: readonly SkippedSource[];
  },
): readonly EvidenceSourceRecord[] {
  const byIndex = new Map<number, EvidenceSourceRecord>();

  for (const snapshot of walk.snapshots) {
    byIndex.set(snapshot.approvedSourceIndex, {
      sourceId: snapshot.sourceId,
      approvedSourceIndex: snapshot.approvedSourceIndex,
      name: snapshot.name,
      url: snapshot.url,
      retrievalKind: snapshot.retrievalKind,
      status: 'RETRIEVED',
      retrievedAt: snapshot.retrievedAt,
      contentHash: snapshot.contentHash,
    });
  }

  for (const failure of walk.failures) {
    byIndex.set(failure.approvedSourceIndex, {
      sourceId: failure.sourceId,
      approvedSourceIndex: failure.approvedSourceIndex,
      name: failure.name,
      url: failure.url,
      retrievalKind: failure.retrievalKind,
      status: FAILURE_TO_STATUS[failure.failure],
      retrievedAt: failure.attemptedAt,
      // Nothing was retrieved, so there is nothing to hash. The schema requires
      // null here, which is the whole reason v2.0 made the field nullable.
      contentHash: null,
    });
  }

  for (const skip of walk.skipped) {
    byIndex.set(skip.approvedSourceIndex, {
      sourceId: skip.sourceId,
      approvedSourceIndex: skip.approvedSourceIndex,
      name: skip.name,
      url: skip.url,
      retrievalKind: skip.retrievalKind,
      status: 'NOT_ATTEMPTED',
      // A source that was never read still needs an instant. The walk's own end
      // is the honest one: "as of this moment, we had not attempted it".
      retrievedAt: mostRecentInstant(walk),
      contentHash: null,
    });
  }

  return specification.approvedSources
    .map((_source, index) => byIndex.get(index))
    .filter((record): record is EvidenceSourceRecord => record !== undefined);
}

function mostRecentInstant(walk: {
  readonly snapshots: readonly EvidenceSnapshot[];
  readonly failures: readonly FailedRetrieval[];
}): string {
  const instants = [
    ...walk.snapshots.map((snapshot) => snapshot.retrievedAt),
    ...walk.failures.map((failure) => failure.attemptedAt),
  ].sort();
  // With no attempt at all there is nothing to anchor to; the caller supplies a
  // package-level `resolvedAt` that a validator checks against, and the epoch
  // would be a lie. This only arises for a specification with zero sources,
  // which the schema forbids.
  return instants[instants.length - 1] ?? new Date(0).toISOString().replace(/\.000Z$/, 'Z');
}

export type { SnapshotSelection } from './normalize.js';
export type { SourceResponse };
