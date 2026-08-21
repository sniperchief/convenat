/**
 * The market resolution service: the wire between the engine and the chain.
 *
 * `ResolutionEngine` (M5.4) decides *what* to propose. This decides *whether the
 * proposal may be made at all* against a specific market on a specific chain,
 * persists it, and — only then — submits it.
 *
 * ```
 *  marketId
 *    │
 *    ├─ load the market record ................. no specification → INVALID
 *    ├─ load the on-chain market ............... no address → INVALID
 *    ├─ compare rulesHash ...................... derived ≠ on-chain → INVALID, STOP
 *    ├─ check contract state ................... not proposable → INVALID
 *    ├─ check the two-proposal limit ........... exhausted → INVALID, never a third
 *    ├─ load the validation plan ............... absent → NEEDS_REVIEW
 *    ├─ retrieve evidence (approved sources only)
 *    ├─ deterministic validation
 *    ├─ ResolutionEngine.resolve()  ← the only model call
 *    ├─ persist the attempt, whatever its status
 *    ├─ persist the evidence package and its hash
 *    ▼
 *  submit  →  wait for confirmation  →  persist tx hash and block
 * ```
 *
 * ## The hash comparison is a stop, not a warning
 *
 * Step 3 compares the hash derived from the stored specification against the
 * hash the market committed on-chain. A mismatch means the document in hand is
 * not the agreement the parties approved — and there is no evidence good enough
 * to fix that. The service returns `INVALID` and **never reaches the submission
 * path**. The engine performs the same check independently, which is deliberate:
 * a boundary this important is worth having in both places, and neither can be
 * bypassed by calling the other directly.
 *
 * ## What this service is not allowed to do
 *
 * - It does not compute a payout. Not one line of settlement arithmetic exists
 *   here; the contract owns winning stake, payout, refund mode, bonds and
 *   settlement state, and this service only reads them.
 * - It does not decide whether a challenge wins. `finalize()` does, on-chain, by
 *   comparing the replacement outcome against the challenged one.
 * - It does not finalize early. It relays a `finalize()` call and lets the
 *   contract refuse it with `ChallengePeriodActive` if the window is open — the
 *   pre-check below exists to give a useful message, not to be the enforcement.
 * - It never proposes a third time. The contract caps proposals at two; this
 *   refuses before spending a model call on a transaction that would revert.
 */

import { buildRulesCommitment, hashCanonicalText, type ConditionSpec } from '@covenant/shared';
import type { Bytes32Hex, EvidencePackage, Outcome } from '@covenant/shared';

import type {
  Address,
  ChainClient,
  Hex,
  OnChainMarket,
  ResolverChainWriter,
} from '../chain/types.js';
import type { RetrievalResult } from '../evidence/retriever.js';
import type { MarketRecord, Repositories, ResolutionRecord } from '../repositories/types.js';
import { DeterministicValidationEngine } from '../validation/engine.js';
import { validateValidationPlan, type ValidationPlan } from '../validation/plan.js';
import type { ResolutionEngine } from './engine.js';
import type { ProposedResolution, ResolutionResult } from './types.js';
import { RESOLVER_VERSION } from './version.js';

/**
 * The service's own vocabulary, which is coarser than the engine's on purpose.
 *
 * The engine answers "did the evidence settle the condition". This answers "is
 * this market resolvable, and did we resolve it" — a question that includes
 * failure modes the engine cannot see, like a market that is still open or a
 * specification that does not match the chain.
 */
export type MarketResolutionStatus =
  | 'RESOLVED'
  | 'NEEDS_REVIEW'
  | 'INSUFFICIENT_EVIDENCE'
  | 'INVALID'
  | 'RESOLUTION_FAILED';

/** How far a proposal got towards being a fact on-chain. */
export type SubmissionState = 'NOT_SUBMITTED' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED';

export interface MarketResolutionOutcome {
  readonly status: MarketResolutionStatus;
  /** Machine-readable. Null only when `RESOLVED`. */
  readonly reason: string | null;
  /** One line, safe to show a user. Never carries infrastructure detail. */
  readonly detail: string;
  readonly outcome: Outcome | null;
  readonly confidenceBps: number;
  readonly evidenceHash: Bytes32Hex | null;
  readonly evidence: EvidencePackage | null;
  readonly round: number;
  readonly resolvedAt: string;
  /** The engine's full record, when the pipeline got far enough to produce one. */
  readonly engine: ResolutionResult | null;
  readonly submissionState: SubmissionState;
  readonly proposalTxHash: string | null;
  readonly proposalBlock: string | null;
  /** The persisted row, so a caller can project it without a second read. */
  readonly persisted: ResolutionRecord | null;
}

export interface ResolveOptions {
  /** Re-run even when a proposal already stands for this round. */
  readonly force?: boolean;
  /** Build and persist the proposal, but send no transaction. */
  readonly dryRun?: boolean;
}

/**
 * The retrieval step, as a port.
 *
 * `EvidenceRetriever` satisfies it structurally. Naming the one method the
 * service uses — rather than depending on the class — is what lets a test drive
 * the whole pipeline from fixed snapshots with no adapter and no network, which
 * is the same trade `ChainClient` and `LLMProvider` already make.
 */
export interface EvidenceRetrievalPort {
  retrieve(specification: ConditionSpec): Promise<RetrievalResult>;
}

export interface MarketResolutionServiceOptions {
  readonly repositories: Repositories;
  readonly chain: ChainClient;
  /**
   * The signer, or null.
   *
   * Null is a real state: a backend can run with no resolver key at all, and
   * then it can produce and persist proposals but not submit them. That is a
   * useful posture — it is exactly what an operator wants while reviewing what
   * the resolver would do — and it is why submission is a separate step rather
   * than the tail of `resolve`.
   */
  readonly writer: ResolverChainWriter | null;
  readonly retriever: EvidenceRetrievalPort;
  readonly engine: ResolutionEngine;
  readonly validation?: DeterministicValidationEngine;
  /** How long to wait for a proposal transaction to confirm. */
  readonly confirmationTimeoutMs?: number;
  readonly now?: () => Date;
  readonly logger?: {
    info(payload: Record<string, unknown>, message: string): void;
    warn(payload: Record<string, unknown>, message: string): void;
  };
}

const DEFAULT_CONFIRMATION_TIMEOUT_MS = 180_000;

/** The contract's hard limit. `ProposalRoundsExhausted` above this. */
const MAX_PROPOSAL_ROUNDS = 2;

/**
 * States from which the contract will accept a proposal.
 *
 * `OPEN` is included, and that is not a loosening — it mirrors the contract.
 * `proposeResolution` calls `_closeIfDue()` before its state check, so a market
 * whose trading window has elapsed but which nobody has bothered to `close()`
 * transitions to `CLOSED` inside the same transaction and the proposal is
 * accepted. Closing is permissionless and harms nobody, so the contract does not
 * make liveness depend on someone else having called it.
 *
 * Refusing `OPEN` here was a real defect, found against the live chain: the demo
 * market sat `OPEN` two hours past its deadline because no one had closed it,
 * and the resolver declined a proposal the contract would have taken. A gate
 * stricter than the contract's is still a gate that can strand a market.
 *
 * The elapsed-trading condition is checked separately below — `OPEN` with
 * trading still running is genuinely not proposable.
 */
const PROPOSABLE_STATES = new Set(['OPEN', 'CLOSED', 'CHALLENGED']);

/** UTC instant at whole-second resolution — the protocol's time granularity. */
function instant(date: Date): string {
  return new Date(Math.floor(date.getTime() / 1000) * 1000).toISOString().replace(/\.000Z$/, 'Z');
}

/** Case-insensitive hash comparison; see the note in `engine.ts`. */
function hashesEqual(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export class MarketResolutionService {
  private readonly repositories: Repositories;
  private readonly chain: ChainClient;
  private readonly writer: ResolverChainWriter | null;
  private readonly retriever: EvidenceRetrievalPort;
  private readonly engine: ResolutionEngine;
  private readonly validation: DeterministicValidationEngine;
  private readonly confirmationTimeoutMs: number;
  private readonly now: () => Date;
  private readonly logger: MarketResolutionServiceOptions['logger'];

  constructor(options: MarketResolutionServiceOptions) {
    this.repositories = options.repositories;
    this.chain = options.chain;
    this.writer = options.writer;
    this.retriever = options.retriever;
    this.engine = options.engine;
    this.validation = options.validation ?? new DeterministicValidationEngine();
    this.confirmationTimeoutMs = options.confirmationTimeoutMs ?? DEFAULT_CONFIRMATION_TIMEOUT_MS;
    this.now = options.now ?? ((): Date => new Date());
    this.logger = options.logger;
  }

  /** True when this backend holds a key that can propose. */
  get canSubmit(): boolean {
    return this.writer !== null;
  }

  get resolverAddress(): string | null {
    return this.writer?.resolverAddress ?? null;
  }

  // -------------------------------------------------------------------------

  /**
   * Resolve one market, end to end.
   *
   * Never throws for an unresolvable market: "this cannot be resolved and here
   * is why" is a first-class result, not an exception. Infrastructure failures
   * (a dead database, an unreachable node) do still throw, because those are not
   * facts about the market.
   */
  async resolveMarket(market: MarketRecord, options: ResolveOptions = {}): Promise<MarketResolutionOutcome> {
    // When the attempt began. Used to stamp the refusals below, which happen
    // before any evidence is read.
    //
    // **Not** the resolution's own timestamp: `resolvedAt` is captured after
    // retrieval, further down. A package whose `resolvedAt` precedes its
    // sources' `retrievedAt` is refused by the v2.0 schema — correctly, since a
    // resolution cannot predate the evidence it rests on — and computing it here
    // made every live resolution fail that rule, because retrieval takes real
    // seconds against a real source.
    const startedAt = instant(this.now());
    const resolvedAt = startedAt;

    if (market.contractAddress === null) {
      return invalid(
        'MARKET_NOT_ON_CHAIN',
        'this market has not been created on-chain yet, so there is nothing to resolve',
        resolvedAt,
      );
    }

    const onChain = await this.chain.readMarket(market.contractAddress as Address);

    // --- the stop ----------------------------------------------------------
    // Derived from the stored specification, compared against what the market
    // committed. Everything after this point assumes the two agree.
    const derived = buildRulesCommitment(market.specification).rulesHash;
    if (!hashesEqual(derived, onChain.rulesHash)) {
      return invalid(
        'RULES_HASH_MISMATCH',
        `the stored specification hashes to ${derived}, but the market committed ` +
          `${onChain.rulesHash}; this is not the agreement that was approved`,
        resolvedAt,
      );
    }

    if (!PROPOSABLE_STATES.has(onChain.state)) {
      return invalid(
        'MARKET_NOT_PROPOSABLE',
        `the market is ${onChain.state}; the contract accepts a proposal only from OPEN (with ` +
          'trading elapsed), CLOSED or CHALLENGED',
        resolvedAt,
      );
    }

    const nowSeconds = Math.floor(this.now().getTime() / 1000);

    // An OPEN market with trading still running is genuinely not proposable:
    // `_closeIfDue()` would leave it OPEN and the contract's own state check
    // would then revert with `InvalidState`.
    if (onChain.state === 'OPEN' && nowSeconds < onChain.tradingEndsAt) {
      return invalid(
        'TRADING_STILL_OPEN',
        `trading does not end until ${new Date(onChain.tradingEndsAt * 1000).toISOString()}; ` +
          'a market still accepting stakes cannot be resolved',
        resolvedAt,
      );
    }

    // The contract measures the condition at its deadline; before that there is
    // nothing to have observed, and `proposeResolution` reverts with
    // `ConditionNotDue`.
    if (nowSeconds < onChain.conditionDeadline) {
      return invalid(
        'CONDITION_NOT_DUE',
        `the condition deadline (${new Date(onChain.conditionDeadline * 1000).toISOString()}) ` +
          'has not passed; there is nothing to have observed yet',
        resolvedAt,
      );
    }

    if (onChain.proposalRound >= MAX_PROPOSAL_ROUNDS) {
      return invalid(
        'PROPOSAL_ROUNDS_EXHAUSTED',
        `the contract permits ${MAX_PROPOSAL_ROUNDS} proposals and ${onChain.proposalRound} have ` +
          'been made; a third is not possible and will not be attempted',
        resolvedAt,
      );
    }

    const round = onChain.proposalRound + 1;

    // Idempotence. A proposal that already stands for this round is returned
    // rather than re-derived: re-running would spend a model call and could
    // produce a different package for a market whose outcome is already
    // committed on-chain.
    if (options.force !== true) {
      const standing = await this.repositories.resolutions.findProposedByRound(
        market.rulesHash,
        round,
      );
      if (standing !== null && standing.submissionState !== 'FAILED') {
        return {
          status: 'RESOLVED',
          reason: null,
          detail: 'a proposal for this round already exists',
          outcome: standing.outcome,
          confidenceBps: standing.confidenceBps,
          evidenceHash: standing.evidenceHash,
          evidence:
            standing.evidenceHash === null
              ? null
              : ((await this.repositories.evidence.findByEvidenceHash(standing.evidenceHash))
                  ?.package ?? null),
          round: standing.round,
          resolvedAt: standing.createdAt,
          engine: null,
          submissionState: standing.submissionState,
          proposalTxHash: standing.proposalTxHash,
          proposalBlock: standing.proposalBlock,
          persisted: standing,
        };
      }
    }

    // --- the acceptance criteria -------------------------------------------
    const plan = this.loadPlan(market);
    if (plan === null) {
      const record = await this.persist({
        market,
        round,
        status: 'NEEDS_REVIEW',
        reason: 'NO_VALIDATION_PLAN',
        detail:
          'no deterministic acceptance criteria are recorded for this market, so there is ' +
          'nothing for the checks to compare against. A resolution will not be guessed.',
        resolvedAt,
        engine: null,
      });
      return {
        status: 'NEEDS_REVIEW',
        reason: 'NO_VALIDATION_PLAN',
        detail: record.reason,
        outcome: null,
        confidenceBps: 0,
        evidenceHash: null,
        evidence: null,
        round,
        resolvedAt,
        engine: null,
        submissionState: 'NOT_SUBMITTED',
        proposalTxHash: null,
        proposalBlock: null,
        persisted: record,
      };
    }

    // --- evidence, checks, model -------------------------------------------
    const specification: ConditionSpec = market.specification;
    const retrieval = await this.retriever.retrieve(specification);
    const validation = this.validation.validate({
      specification,
      plan,
      snapshots: retrieval.snapshots,
      failures: retrieval.failures,
    });

    // Captured now, after the sources have been read, so the resolution is
    // stamped at the moment it was actually produced rather than the moment the
    // attempt started.
    const producedAt = instant(this.now());

    const engineResult = await this.engine.resolve({
      specification,
      // The on-chain value, not the stored key: the chain is what a proposal is
      // being made against.
      expectedRulesHash: onChain.rulesHash,
      market: {
        chainId: this.chain.chainId,
        marketId: onChain.marketId.toString(),
        marketAddress: onChain.address,
      },
      snapshots: retrieval.snapshots,
      failures: retrieval.failures,
      sources: retrieval.evidenceSources,
      validation,
      plan,
      resolvedAt: producedAt,
    });

    const status = toServiceStatus(engineResult);
    const detail = describeEngineResult(engineResult);

    const persisted = await this.persist({
      market,
      round,
      status: engineResult.status,
      reason: engineResult.status === 'PROPOSED' ? 'PROPOSED' : engineResult.reason,
      detail,
      resolvedAt: producedAt,
      engine: engineResult,
    });

    if (engineResult.status !== 'PROPOSED') {
      this.logger?.info(
        { rulesHash: market.rulesHash, status, reason: engineResult.reason },
        'resolution produced no proposal',
      );
      return {
        status,
        reason: engineResult.reason,
        detail,
        outcome: null,
        confidenceBps:
          engineResult.status === 'NEEDS_REVIEW' ? (engineResult.confidenceBps ?? 0) : 0,
        evidenceHash: null,
        evidence: null,
        round,
        resolvedAt: producedAt,
        engine: engineResult,
        submissionState: 'NOT_SUBMITTED',
        proposalTxHash: null,
        proposalBlock: null,
        persisted,
      };
    }

    // --- a proposal exists --------------------------------------------------
    await this.repositories.evidence.save({
      rulesHash: market.rulesHash,
      evidenceHash: engineResult.evidenceHash,
      package: engineResult.evidence,
      createdAt: this.now(),
    });

    const base: MarketResolutionOutcome = {
      status: 'RESOLVED',
      reason: null,
      detail,
      outcome: engineResult.outcome,
      confidenceBps: engineResult.confidenceBps,
      evidenceHash: engineResult.evidenceHash,
      evidence: engineResult.evidence,
      round,
      resolvedAt: producedAt,
      engine: engineResult,
      submissionState: 'NOT_SUBMITTED',
      proposalTxHash: null,
      proposalBlock: null,
      persisted,
    };

    if (options.dryRun === true) {
      return { ...base, detail: `${detail} (dry run: nothing was submitted)` };
    }
    if (this.writer === null) {
      return {
        ...base,
        detail: `${detail} (no resolver key is configured, so nothing was submitted)`,
      };
    }

    return this.submit(base, engineResult, onChain, persisted.id);
  }

  // -------------------------------------------------------------------------

  /**
   * Send the proposal and wait for it.
   *
   * The hash is persisted *before* the wait, so a process that dies mid-wait
   * leaves a record pointing at a transaction that can be looked up, rather than
   * a proposal nobody can find. `waitForTransaction` reports a mined revert as
   * `FAILED`, and that is recorded as a failure rather than as a proposal.
   */
  private async submit(
    base: MarketResolutionOutcome,
    proposal: ProposedResolution,
    onChain: OnChainMarket,
    resolutionId: string,
  ): Promise<MarketResolutionOutcome> {
    const writer = this.writer;
    if (writer === null) return base;

    // `INVALID` is a legitimate proposal — it routes to refunds — but `UNSET` is
    // not an outcome and the contract rejects it. The type excludes it; this is
    // the runtime counterpart.
    const outcome = proposal.outcome;
    if (outcome !== 'YES' && outcome !== 'NO' && outcome !== 'INVALID') {
      return { ...base, detail: `${base.detail} (outcome ${String(outcome)} cannot be proposed)` };
    }

    const txHash = await writer.proposeResolution({
      market: onChain.address,
      outcome,
      evidenceHash: proposal.evidenceHash as Hex,
    });

    await this.repositories.resolutions.markSubmission({
      id: resolutionId,
      submissionState: 'SUBMITTED',
      proposalTxHash: txHash,
      proposalBlock: null,
      proposedAt: this.now(),
      at: this.now(),
    });

    this.logger?.info(
      { rulesHash: base.evidenceHash, txHash, outcome },
      'resolution proposal submitted',
    );

    const receipt = await this.chain.waitForTransaction(txHash, this.confirmationTimeoutMs);

    const persisted = await this.repositories.resolutions.markSubmission({
      id: resolutionId,
      submissionState: receipt.status === 'CONFIRMED' ? 'CONFIRMED' : receipt.status,
      proposalTxHash: txHash,
      proposalBlock: receipt.blockNumber === null ? null : receipt.blockNumber.toString(),
      proposedAt: null,
      at: this.now(),
    });

    if (receipt.status === 'FAILED') {
      this.logger?.warn({ txHash, reason: receipt.reason }, 'resolution proposal reverted');
      return {
        ...base,
        status: 'RESOLUTION_FAILED',
        reason: 'PROPOSAL_REVERTED',
        detail:
          'the proposal transaction was mined but reverted; nothing was committed. The evidence ' +
          'package is stored and can be re-submitted.',
        submissionState: 'FAILED',
        proposalTxHash: txHash,
        proposalBlock: receipt.blockNumber === null ? null : receipt.blockNumber.toString(),
        persisted: persisted ?? base.persisted,
      };
    }

    return {
      ...base,
      submissionState: receipt.status === 'CONFIRMED' ? 'CONFIRMED' : 'SUBMITTED',
      proposalTxHash: txHash,
      proposalBlock: receipt.blockNumber === null ? null : receipt.blockNumber.toString(),
      persisted: persisted ?? base.persisted,
    };
  }

  // -------------------------------------------------------------------------

  /**
   * Finalize a standing proposal.
   *
   * The contract's own `ChallengePeriodActive` guard is the enforcement. The
   * check here exists so a caller gets "the window closes at T" instead of a
   * reverted transaction, and it is deliberately the *same* comparison the
   * contract makes rather than a more permissive one.
   */
  async finalizeMarket(market: MarketRecord): Promise<{
    readonly submitted: boolean;
    readonly txHash: string | null;
    readonly onChain: OnChainMarket;
    readonly detail: string;
  }> {
    if (market.contractAddress === null) {
      throw new Error('finalizeMarket called for a market with no on-chain address');
    }

    const before = await this.chain.readMarket(market.contractAddress as Address);

    if (before.state !== 'RESOLUTION_PROPOSED') {
      return {
        submitted: false,
        txHash: null,
        onChain: before,
        detail: `the market is ${before.state}; only a standing proposal can be finalized`,
      };
    }

    const nowSeconds = Math.floor(this.now().getTime() / 1000);
    if (nowSeconds < before.challengeEndsAt) {
      return {
        submitted: false,
        txHash: null,
        onChain: before,
        detail:
          'the challenge window is still open until ' +
          `${new Date(before.challengeEndsAt * 1000).toISOString()}; finalizing early is refused ` +
          'by the contract and is not attempted here',
      };
    }

    if (this.writer === null) {
      return {
        submitted: false,
        txHash: null,
        onChain: before,
        detail:
          'no key is configured to send the transaction. `finalize()` is permissionless, so any ' +
          'wallet may call it directly.',
      };
    }

    const txHash = await this.writer.finalize(before.address);
    const receipt = await this.chain.waitForTransaction(txHash, this.confirmationTimeoutMs);
    const after = await this.chain.readMarket(before.address);

    if (receipt.status !== 'FAILED') {
      await this.repositories.resolutions.markFinalized({
        rulesHash: market.rulesHash,
        at: this.now(),
      });
    }

    return {
      submitted: receipt.status !== 'FAILED',
      txHash,
      onChain: after,
      detail:
        receipt.status === 'FAILED'
          ? 'the finalize transaction was mined but reverted; the market is unchanged'
          : `finalized as ${after.finalOutcome}`,
    };
  }

  // -------------------------------------------------------------------------

  /**
   * Attach a challenge document to a challenge that already exists on-chain.
   *
   * Three checks, and all three are necessary:
   *
   * 1. The market is `CHALLENGED`. Anything else means there is no challenge to
   *    describe.
   * 2. The on-chain `challenger` is the authenticated wallet. Without this,
   *    anyone could put words in a challenger's mouth.
   * 3. `keccak256(reason)` equals the contract's `challengeReasonHash`. This is
   *    what makes the stored text *the* argument rather than *an* argument — the
   *    challenger committed to these bytes when they staked their bond.
   *
   * The hash comes from `@covenant/shared`, like every other hash in this system.
   */
  async recordChallenge(input: {
    readonly market: MarketRecord;
    readonly challenger: string;
    readonly reason: string;
    readonly txHash: string;
  }): Promise<
    | { readonly ok: true; readonly reasonHash: Bytes32Hex; readonly onChain: OnChainMarket }
    | { readonly ok: false; readonly code: string; readonly detail: string }
  > {
    if (input.market.contractAddress === null) {
      return {
        ok: false,
        code: 'MARKET_NOT_ON_CHAIN',
        detail: 'this market has not been created on-chain, so it cannot have been challenged',
      };
    }

    const onChain = await this.chain.readMarket(input.market.contractAddress as Address);

    if (onChain.state !== 'CHALLENGED') {
      return {
        ok: false,
        code: 'NOT_CHALLENGED',
        detail:
          `the market is ${onChain.state}. A challenge is filed by the challenger's own wallet ` +
          'calling `challenge(reasonHash)` with the bond; this endpoint only records the argument ' +
          'behind one that already exists.',
      };
    }

    if (!hashesEqual(onChain.challenger, input.challenger)) {
      return {
        ok: false,
        code: 'NOT_THE_CHALLENGER',
        detail: `the on-chain challenger is ${onChain.challenger}, not the authenticated wallet`,
      };
    }

    const reasonHash = hashCanonicalText(input.reason);
    if (!hashesEqual(reasonHash, onChain.challengeReasonHash)) {
      return {
        ok: false,
        code: 'REASON_HASH_MISMATCH',
        detail:
          `the supplied text hashes to ${reasonHash}, but the challenge committed ` +
          `${onChain.challengeReasonHash}. Only the text that was committed can be recorded.`,
      };
    }

    // The transaction hash is stored as the challenger reported it, having
    // verified the *state* it produced. Verifying the hash itself would mean
    // trusting a receipt to say which contract call it was, and the contract's
    // own state is the stronger evidence.
    await this.repositories.challenges.save({
      rulesHash: input.market.rulesHash,
      challenger: onChain.challenger,
      reasonHash,
      reason: input.reason,
      bond: onChain.challengeBond.toString(),
      txHash: input.txHash,
      round: onChain.proposalRound,
      challengedAt: new Date(onChain.challengedAt * 1000),
      createdAt: this.now(),
    });

    return { ok: true, reasonHash, onChain };
  }

  // -------------------------------------------------------------------------

  /**
   * Parse the stored plan.
   *
   * Re-validated on every read rather than trusted because it is in the
   * database: a plan written under an earlier build may not satisfy this one,
   * and a plan that no longer validates must produce a review rather than a
   * best-effort interpretation of criteria that settle money.
   */
  private loadPlan(market: MarketRecord): ValidationPlan | null {
    if (market.validationPlan === null || market.validationPlan === undefined) return null;
    const parsed = validateValidationPlan(market.validationPlan);
    if (!parsed.ok) {
      this.logger?.warn(
        { rulesHash: market.rulesHash, issues: parsed.issues },
        'stored validation plan no longer validates',
      );
      return null;
    }
    return parsed.plan;
  }

  /** Record the attempt. Every attempt, including the ones that proposed nothing. */
  private async persist(input: {
    market: MarketRecord;
    round: number;
    status: ResolutionResult['status'];
    reason: string;
    detail: string;
    resolvedAt: string;
    engine: ResolutionResult | null;
  }): Promise<ResolutionRecord> {
    const proposed = input.engine?.status === 'PROPOSED' ? input.engine : null;

    return this.repositories.resolutions.record({
      rulesHash: input.market.rulesHash,
      status: input.status,
      outcome: proposed?.outcome ?? null,
      confidenceBps: proposed?.confidenceBps ?? 0,
      reason: input.detail,
      evidenceHash: proposed?.evidenceHash ?? null,
      resolverVersion: RESOLVER_VERSION,
      round: input.round,
      record: input.engine === null ? { reason: input.reason } : toStoredRecord(input.engine),
      createdAt: this.now(),
    });
  }
}

// ---------------------------------------------------------------------------

/**
 * The engine's status, widened to the service's vocabulary.
 *
 * `INSUFFICIENT_EVIDENCE` is pulled out of `NEEDS_REVIEW` because the two call
 * for different actions: one means nothing was read and the sources should be
 * looked at, the other means something was read and a person has to judge it.
 * `RULES_HASH_MISMATCH` and `PACKAGE_INVALID` become `INVALID` for the same
 * reason — they are not questions about the evidence at all.
 */
function toServiceStatus(result: ResolutionResult): MarketResolutionStatus {
  if (result.status === 'PROPOSED') return 'RESOLVED';
  if (result.status === 'RESOLUTION_FAILED') return 'RESOLUTION_FAILED';

  switch (result.reason) {
    case 'INSUFFICIENT_EVIDENCE':
      return 'INSUFFICIENT_EVIDENCE';
    case 'RULES_HASH_MISMATCH':
    case 'PACKAGE_INVALID':
      return 'INVALID';
    default:
      return 'NEEDS_REVIEW';
  }
}

function describeEngineResult(result: ResolutionResult): string {
  if (result.status === 'PROPOSED') {
    return `proposing ${result.outcome} at ${result.confidenceBps} bps: ${result.rationale}`;
  }
  return result.detail;
}

/**
 * What is kept for the resolution panel.
 *
 * A projection, not the engine's object: it is stored as JSON in a column that
 * is never hashed, so it must be flat, stable and free of anything a reader
 * should not see. The model's reasoning *is* included — it is inside
 * `evidenceHash` when a package exists, and showing it is the entire point of
 * the panel.
 */
function toStoredRecord(result: ResolutionResult): Record<string, unknown> {
  const common = {
    status: result.status,
    verdict: result.verdict,
    model: result.model,
    deterministicChecks: result.deterministicChecks,
    sources: result.sources,
    claims: result.claims,
  };

  if (result.status === 'PROPOSED') {
    return {
      ...common,
      reason: null,
      detail: null,
      outcome: result.outcome,
      confidenceBps: result.confidenceBps,
      reasoning: result.reasoning,
      rationale: result.rationale,
      evidenceHash: result.evidenceHash,
      rulesHash: result.rulesHash,
      issues: [],
      violations: [],
    };
  }

  if (result.status === 'NEEDS_REVIEW') {
    return {
      ...common,
      reason: result.reason,
      detail: result.detail,
      outcome: null,
      confidenceBps: result.confidenceBps,
      reasoning: result.reasoning,
      rationale: null,
      evidenceHash: null,
      issues: result.issues,
      violations: result.violations,
    };
  }

  return {
    ...common,
    reason: result.reason,
    detail: result.detail,
    outcome: null,
    confidenceBps: null,
    reasoning: null,
    rationale: null,
    evidenceHash: null,
    issues: [],
    violations: [],
  };
}

/** An outcome that never reached the engine, and therefore has no engine record. */
function invalid(reason: string, detail: string, resolvedAt: string): MarketResolutionOutcome {
  return {
    status: 'INVALID',
    reason,
    detail,
    outcome: null,
    confidenceBps: 0,
    evidenceHash: null,
    evidence: null,
    round: 0,
    resolvedAt,
    engine: null,
    submissionState: 'NOT_SUBMITTED',
    proposalTxHash: null,
    proposalBlock: null,
    persisted: null,
  };
}
