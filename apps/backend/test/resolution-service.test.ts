/**
 * The resolution pipeline, end to end, with no network and no key.
 *
 * `MarketResolutionService` is the component that decides whether a proposal may
 * be made at all and then sends it. Everything it depends on is a port with a
 * scripted implementation here — the chain, the model, retrieval, storage — so
 * every branch that matters is reachable on demand:
 *
 *   - a specification that does not hash to what the chain committed
 *   - a market in the wrong state, or before its condition is due
 *   - a market with two proposals already made
 *   - a market with no acceptance criteria
 *   - evidence that produced nothing
 *   - a proposal that is built, persisted, and *not* submitted
 *   - a proposal that is submitted and reverts
 *   - a challenge recorded, and three ways of refusing to record one
 *
 * The assertion made most often below is **that no transaction was attempted**.
 * A `FakeResolverWriter` records calls rather than sending them, so "nothing was
 * proposed" is checkable rather than assumed.
 */

import { describe, expect, it } from 'vitest';

import { buildRulesCommitment, hashCanonicalText } from '@covenant/shared';
import type { ConditionSpec } from '@covenant/shared';

import type { RetrievalResult } from '../src/evidence/retriever.js';
import { createInMemoryRepositories, type InMemoryRepositories } from '../src/repositories/memory.js';
import type { MarketRecord } from '../src/repositories/types.js';
import { ResolutionEngine } from '../src/resolution/engine.js';
import { MarketResolutionService } from '../src/resolution/service.js';
import { FakeLLMProvider, type FakeScript } from '../src/llm/fake-provider.js';
import type { Address, OnChainMarket } from '../src/chain/types.js';
import { FakeChainClient, FakeResolverWriter, fakeMarket, silentLogger } from './fake-chain.js';
import {
  deliveredPlan,
  evidenceSources,
  failure,
  modelNo,
  modelYes,
  snapshot,
  spec,
  RESOLVED_AT,
} from './resolution-helpers.js';

const MARKET_ADDRESS = '0x00000000000000000000000000000000000000c1' as Address;
const CHAIN_ID = 1952;
/** Comfortably after the fixture's condition deadline. */
const NOW = new Date('2026-09-02T00:10:00Z');

/**
 * A model response that concurs with a satisfied delivery check.
 *
 * `modelYes()` is the same well-formed output the M5.4 suite uses, so these
 * tests exercise the service's branches rather than re-testing the output gate —
 * which has 84 tests of its own next door.
 */
const CONCURRING: FakeScript = { kind: 'json', value: modelYes() };

function retrieval(result: Partial<RetrievalResult> = {}): { retrieve: () => Promise<RetrievalResult> } {
  const snapshots = result.snapshots ?? [snapshot({ index: 0, status: 'delivered' })];
  const failures = result.failures ?? [];
  const full: RetrievalResult = {
    snapshots,
    failures,
    skipped: result.skipped ?? [],
    primary: result.primary ?? snapshots[0] ?? null,
    evidenceSources: result.evidenceSources ?? evidenceSources(snapshots, failures),
  };
  return { retrieve: () => Promise.resolve(full) };
}

interface Harness {
  readonly service: MarketResolutionService;
  readonly repositories: InMemoryRepositories;
  readonly writer: FakeResolverWriter;
  readonly chain: FakeChainClient;
  readonly market: MarketRecord;
  readonly specification: ConditionSpec;
}

async function harness(
  options: {
    onChain?: Partial<OnChainMarket>;
    scripts?: readonly FakeScript[];
    retrieval?: Partial<RetrievalResult>;
    plan?: unknown;
    withWriter?: boolean;
    specification?: ConditionSpec;
    /** Written into the market record but *not* onto the chain. */
    storedSpecification?: ConditionSpec;
  } = {},
): Promise<Harness> {
  const specification = options.specification ?? spec();
  const stored = options.storedSpecification ?? specification;
  const rulesHash = buildRulesCommitment(specification).rulesHash;

  const chain = new FakeChainClient({ chainId: CHAIN_ID, confirmations: 1 });
  chain.addBlocks(5);
  chain.setMarket(
    fakeMarket({
      address: MARKET_ADDRESS,
      marketId: 7n,
      rulesHash,
      state: 'CLOSED',
      // In the past relative to NOW, so the condition is due.
      conditionDeadline: Math.floor(Date.parse('2026-09-01T00:00:00Z') / 1000),
      ...options.onChain,
    }),
  );

  const repositories = createInMemoryRepositories();
  const market = await repositories.markets.register({
    rulesHash: buildRulesCommitment(stored).rulesHash,
    chainId: CHAIN_ID,
    chainMarketId: '7',
    contractAddress: MARKET_ADDRESS,
    creator: stored.creator,
    question: stored.question,
    specification: stored,
    canonical: buildRulesCommitment(stored).canonical,
    validationPlan: options.plan === undefined ? deliveredPlan() : options.plan,
    deadline: stored.deadline,
    tradingEndsAt: stored.settlement.tradingEndsAt,
    status: 'CLOSED',
    at: NOW,
  });

  const writer = new FakeResolverWriter();

  const service = new MarketResolutionService({
    repositories,
    chain,
    writer: options.withWriter === false ? null : writer,
    retriever: retrieval(options.retrieval ?? {}),
    engine: new ResolutionEngine({
      provider: new FakeLLMProvider([...(options.scripts ?? [CONCURRING])]),
      maxOutputTokens: 4000,
      timeoutMs: 30_000,
    }),
    now: () => NOW,
    logger: silentLogger,
  });

  return { service, repositories, writer, chain, market, specification };
}

// ---------------------------------------------------------------------------

describe('MarketResolutionService — the gates before the model', () => {
  it('refuses when the stored specification does not hash to the on-chain rules', async () => {
    // A one-word edit to the question. Byte-identical in every other respect,
    // and therefore a different agreement.
    const other: ConditionSpec = { ...spec(), question: `${spec().question} (amended)` };
    const h = await harness({ storedSpecification: other });

    const result = await h.service.resolveMarket(h.market);

    expect(result.status).toBe('INVALID');
    expect(result.reason).toBe('RULES_HASH_MISMATCH');
    // The stop is a stop: no proposal, and nothing persisted to point at.
    expect(h.writer.proposals).toHaveLength(0);
    expect(result.persisted).toBeNull();
  });

  it('refuses a market whose trading window is still running', async () => {
    const h = await harness({
      onChain: { state: 'OPEN', tradingEndsAt: Math.floor(NOW.getTime() / 1000) + 3600 },
    });
    const result = await h.service.resolveMarket(h.market);

    expect(result.status).toBe('INVALID');
    expect(result.reason).toBe('TRADING_STILL_OPEN');
    expect(h.writer.proposals).toHaveLength(0);
  });

  it('proposes on an OPEN market whose trading has elapsed, as the contract does', async () => {
    // The regression. `proposeResolution` calls `_closeIfDue()` before its state
    // check, so a market nobody bothered to `close()` is still proposable — and
    // refusing it here stranded a live market that sat OPEN two hours past its
    // deadline. A gate stricter than the contract's is still a gate that can
    // strand a market.
    const h = await harness({
      onChain: { state: 'OPEN', tradingEndsAt: Math.floor(NOW.getTime() / 1000) - 3600 },
    });
    const result = await h.service.resolveMarket(h.market);

    expect(result.status).toBe('RESOLVED');
    expect(result.outcome).toBe('YES');
    expect(h.writer.proposals).toHaveLength(1);
  });

  it('refuses before the condition deadline has passed', async () => {
    const h = await harness({
      onChain: { conditionDeadline: Math.floor(Date.parse('2027-01-01T00:00:00Z') / 1000) },
    });
    const result = await h.service.resolveMarket(h.market);

    expect(result.status).toBe('INVALID');
    expect(result.reason).toBe('CONDITION_NOT_DUE');
    expect(h.writer.proposals).toHaveLength(0);
  });

  it('never attempts a third proposal', async () => {
    // The contract caps rounds at two and reverts with `ProposalRoundsExhausted`.
    // Refusing here means not spending a model call on a transaction that cannot
    // land — and, more importantly, not trying.
    const h = await harness({ onChain: { state: 'CHALLENGED', proposalRound: 2 } });
    const result = await h.service.resolveMarket(h.market);

    expect(result.status).toBe('INVALID');
    expect(result.reason).toBe('PROPOSAL_ROUNDS_EXHAUSTED');
    expect(h.writer.proposals).toHaveLength(0);
  });

  it('reviews rather than guesses when no acceptance criteria are recorded', async () => {
    const h = await harness({ plan: null });
    const result = await h.service.resolveMarket(h.market);

    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.reason).toBe('NO_VALIDATION_PLAN');
    expect(result.outcome).toBeNull();
    expect(h.writer.proposals).toHaveLength(0);

    // Recorded, so an operator can see *why* it did not resolve.
    const stored = await h.repositories.resolutions.findLatestByRulesHash(h.market.rulesHash);
    expect(stored?.status).toBe('NEEDS_REVIEW');
    expect(stored?.outcome).toBeNull();
  });

  it('reviews rather than guesses when a stored plan no longer validates', async () => {
    // A plan written by an earlier build. It is re-validated on every read
    // rather than trusted because it is in the database.
    const h = await harness({ plan: { checks: [{ checkId: 'x', kind: 'NO_SUCH_KIND' }] } });
    const result = await h.service.resolveMarket(h.market);

    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.reason).toBe('NO_VALIDATION_PLAN');
    expect(h.writer.proposals).toHaveLength(0);
  });

  it('reports insufficient evidence distinctly, and never as a NO', async () => {
    const h = await harness({
      retrieval: { snapshots: [], failures: [failure(0), failure(1)] },
    });
    const result = await h.service.resolveMarket(h.market);

    expect(result.status).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.outcome).toBeNull();
    expect(h.writer.proposals).toHaveLength(0);
  });
});

describe('MarketResolutionService — a proposal', () => {
  it('builds, persists and submits, and stores the hash and the block', async () => {
    const h = await harness();
    const result = await h.service.resolveMarket(h.market);

    expect(result.status).toBe('RESOLVED');
    expect(result.outcome).toBe('YES');
    expect(result.evidenceHash).toMatch(/^0x[0-9a-f]{64}$/);

    // Exactly one transaction, carrying exactly the hash that was persisted.
    expect(h.writer.proposals).toHaveLength(1);
    expect(h.writer.proposals[0]?.outcome).toBe('YES');
    expect(h.writer.proposals[0]?.evidenceHash).toBe(result.evidenceHash);

    const stored = await h.repositories.resolutions.findLatestByRulesHash(h.market.rulesHash);
    expect(stored?.status).toBe('PROPOSED');
    expect(stored?.submissionState).toBe('CONFIRMED');
    expect(stored?.proposalTxHash).toBe(result.proposalTxHash);
    expect(stored?.proposalBlock).not.toBeNull();
  });

  it('stores the evidence package under its own digest, re-derivable', async () => {
    const h = await harness();
    const result = await h.service.resolveMarket(h.market);

    const saved = await h.repositories.evidence.findByEvidenceHash(result.evidenceHash!);
    expect(saved).not.toBeNull();
    // The stored document is the one the digest covers — the check anyone
    // reading the published package can repeat.
    const { verifyEvidenceHash } = await import('@covenant/shared');
    expect(verifyEvidenceHash(saved!.package, result.evidenceHash!)).toBe(true);
  });

  it('submits nothing on a dry run, but still persists what it would have sent', async () => {
    const h = await harness();
    const result = await h.service.resolveMarket(h.market, { dryRun: true });

    expect(result.status).toBe('RESOLVED');
    expect(result.evidenceHash).not.toBeNull();
    expect(h.writer.proposals).toHaveLength(0);
    expect(result.submissionState).toBe('NOT_SUBMITTED');

    // What was previewed is what would be submitted: the package is stored, so
    // the preview cannot differ from the thing itself.
    expect(await h.repositories.evidence.findByEvidenceHash(result.evidenceHash!)).not.toBeNull();
  });

  it('produces a proposal but sends nothing when no resolver key is configured', async () => {
    const h = await harness({ withWriter: false });
    const result = await h.service.resolveMarket(h.market);

    expect(result.status).toBe('RESOLVED');
    expect(result.submissionState).toBe('NOT_SUBMITTED');
    expect(result.detail).toContain('no resolver key');
  });

  it('is idempotent: a standing proposal for the round is returned, not re-derived', async () => {
    // One script only. A second model call would exhaust the queue and throw,
    // which is exactly the signal wanted if idempotence were broken.
    const h = await harness({ scripts: [CONCURRING] });
    const first = await h.service.resolveMarket(h.market);
    const second = await h.service.resolveMarket(h.market);

    expect(second.status).toBe('RESOLVED');
    expect(second.evidenceHash).toBe(first.evidenceHash);
    expect(h.writer.proposals).toHaveLength(1);
  });

  it('records a mined revert as a failure, not as a proposal', async () => {
    const h = await harness();
    // The node accepted it; the chain rejected it. `waitForTransaction` reports
    // FAILED for a mined revert, and that must not read as success.
    h.chain.transactionStatus = 'FAILED';

    const result = await h.service.resolveMarket(h.market);

    expect(result.status).toBe('RESOLUTION_FAILED');
    expect(result.reason).toBe('PROPOSAL_REVERTED');
    expect(result.submissionState).toBe('FAILED');
  });

  it('proposes a second time after a challenge, and only a second time', async () => {
    const h = await harness({
      onChain: { state: 'CHALLENGED', proposalRound: 1 },
      scripts: [CONCURRING],
    });

    const result = await h.service.resolveMarket(h.market);

    expect(result.status).toBe('RESOLVED');
    expect(result.round).toBe(2);
    expect(h.writer.proposals).toHaveLength(1);
  });
});

describe('MarketResolutionService — the model cannot reach a transaction', () => {
  it('sends nothing when the model contradicts the deterministic verdict', async () => {
    const h = await harness({
      retrieval: { snapshots: [snapshot({ index: 0, status: 'delivered' })] },
      // A well-formed NO against evidence the checks read as delivered. The
      // output gate passes it; the deterministic contradiction is what stops it.
      scripts: [{ kind: 'json', value: modelNo({ claims: [] }) }],
    });

    const result = await h.service.resolveMarket(h.market);

    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.outcome).toBeNull();
    expect(h.writer.proposals).toHaveLength(0);
  });

  it('sends nothing when the model returns something that is not JSON', async () => {
    const h = await harness({ scripts: [{ kind: 'text', text: 'The answer is probably yes.' }] });
    const result = await h.service.resolveMarket(h.market);

    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.reason).toBe('MODEL_OUTPUT_INVALID');
    expect(h.writer.proposals).toHaveLength(0);
  });

  it('sends nothing when the provider is unreachable, and says so distinctly', async () => {
    const h = await harness({ scripts: [{ kind: 'error', failure: 'unavailable' }] });
    const result = await h.service.resolveMarket(h.market);

    expect(result.status).toBe('RESOLUTION_FAILED');
    expect(h.writer.proposals).toHaveLength(0);
  });

  it('leaves the specification byte-identical after a resolution', async () => {
    const h = await harness();
    const before = JSON.stringify(h.market.specification);
    await h.service.resolveMarket(h.market);
    // A pipeline that edited the specification would change `rulesHash` and
    // unbind the market from its own agreement.
    expect(JSON.stringify(h.market.specification)).toBe(before);
  });
});

describe('MarketResolutionService — finalization', () => {
  it('refuses to finalize while the challenge window is open', async () => {
    const h = await harness({
      onChain: {
        state: 'RESOLUTION_PROPOSED',
        proposalRound: 1,
        challengeEndsAt: Math.floor(NOW.getTime() / 1000) + 600,
      },
    });

    const result = await h.service.finalizeMarket(h.market);

    expect(result.submitted).toBe(false);
    expect(result.txHash).toBeNull();
    expect(h.writer.finalizations).toHaveLength(0);
    expect(result.detail).toContain('challenge window is still open');
  });

  it('finalizes once the window has closed', async () => {
    const h = await harness({
      onChain: {
        state: 'RESOLUTION_PROPOSED',
        proposalRound: 1,
        challengeEndsAt: Math.floor(NOW.getTime() / 1000) - 1,
      },
    });

    const result = await h.service.finalizeMarket(h.market);

    expect(result.submitted).toBe(true);
    expect(h.writer.finalizations).toEqual([MARKET_ADDRESS]);
  });

  it('refuses to finalize a market with no standing proposal', async () => {
    const h = await harness({ onChain: { state: 'CLOSED' } });
    const result = await h.service.finalizeMarket(h.market);

    expect(result.submitted).toBe(false);
    expect(h.writer.finalizations).toHaveLength(0);
  });
});

describe('MarketResolutionService — recording a challenge', () => {
  const REASON = 'The primary source was healthy and reported in_transit, not delivered.';

  async function challenged(overrides: Partial<OnChainMarket> = {}) {
    return harness({
      onChain: {
        state: 'CHALLENGED',
        proposalRound: 1,
        challenger: '0x2222222222222222222222222222222222222222',
        challengeReasonHash: hashCanonicalText(REASON),
        challengedAt: Math.floor(NOW.getTime() / 1000),
        ...overrides,
      },
    });
  }

  it('records the argument behind a challenge that exists on-chain', async () => {
    const h = await challenged();
    const result = await h.service.recordChallenge({
      market: h.market,
      challenger: '0x2222222222222222222222222222222222222222',
      reason: REASON,
      txHash: `0x${'ab'.repeat(32)}`,
    });

    expect(result.ok).toBe(true);
    const stored = await h.repositories.challenges.findByRulesHash(h.market.rulesHash);
    expect(stored?.reason).toBe(REASON);
    expect(stored?.reasonHash).toBe(hashCanonicalText(REASON));
  });

  it('refuses text whose hash is not the one committed', async () => {
    // The challenger committed to specific bytes when they staked their bond.
    // Anything else is not their argument.
    const h = await challenged();
    const result = await h.service.recordChallenge({
      market: h.market,
      challenger: '0x2222222222222222222222222222222222222222',
      reason: `${REASON} And also the resolver is biased.`,
      txHash: `0x${'ab'.repeat(32)}`,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('REASON_HASH_MISMATCH');
    expect(await h.repositories.challenges.findByRulesHash(h.market.rulesHash)).toBeNull();
  });

  it('refuses a wallet that is not the on-chain challenger', async () => {
    const h = await challenged();
    const result = await h.service.recordChallenge({
      market: h.market,
      challenger: '0x3333333333333333333333333333333333333333',
      reason: REASON,
      txHash: `0x${'ab'.repeat(32)}`,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('NOT_THE_CHALLENGER');
  });

  it('refuses when the market is not challenged at all', async () => {
    const h = await harness({ onChain: { state: 'RESOLUTION_PROPOSED', proposalRound: 1 } });
    const result = await h.service.recordChallenge({
      market: h.market,
      challenger: '0x2222222222222222222222222222222222222222',
      reason: REASON,
      txHash: `0x${'ab'.repeat(32)}`,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('NOT_CHALLENGED');
  });

  it('is idempotent for one round', async () => {
    const h = await challenged();
    const input = {
      market: h.market,
      challenger: '0x2222222222222222222222222222222222222222',
      reason: REASON,
      txHash: `0x${'ab'.repeat(32)}`,
    };
    await h.service.recordChallenge(input);
    await h.service.recordChallenge(input);

    expect(h.repositories.challenges.rows).toHaveLength(1);
  });
});

describe('MarketResolutionService — what it never does', () => {
  it('computes no payout anywhere in its source', async () => {
    // The contract owns winning stake, payout, refund mode, bonds and settlement
    // state. A second implementation of any of them would be wrong in a second
    // place, and this is the cheapest possible guard against one appearing.
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(
      resolve(__dirname, '..', 'src', 'resolution', 'service.ts'),
      'utf8',
    );

    for (const forbidden of ['previewClaim(', 'payout =', 'totalYes *', 'totalNo *', '/ pool']) {
      expect(source, `service.ts must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('resolves at the supplied instant and reads no clock of its own', async () => {
    const h = await harness();
    const result = await h.service.resolveMarket(h.market);
    // `now` is injected; the package's `resolvedAt` follows it exactly, which is
    // what makes an evidence hash reproducible.
    expect(result.resolvedAt).toBe(RESOLVED_AT);
  });
});
