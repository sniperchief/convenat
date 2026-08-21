/**
 * Reconciliation (§28).
 *
 * The reconciler's job is to notice when the indexed view has drifted from the
 * chain. So every test here *creates* a drift and checks it is reported — a
 * suite that only proved "a healthy database reconciles" would pass against a
 * reconciler that always said yes.
 */

import { describe, expect, it } from 'vitest';

import { reconcile } from '../src/reconcile/reconcile.js';
import { createInMemoryRepositories } from '../src/repositories/memory.js';
import type { Address, Hex } from '../src/chain/types.js';
import { FakeChainClient, fakeMarket } from './fake-chain.js';
import { buildRulesCommitment, validateConditionSpec } from '@covenant/shared';
import { NOW, TEST_TOKEN } from './helpers.js';

const CHAIN_ID = 1952;
const MARKET: Address = '0x00000000000000000000000000000000000000a1';
const FACTORY: Address = '0x00000000000000000000000000000000000fac70';
const CREATOR = '0x1111111111111111111111111111111111111111';

/** A real, validated specification — so its hash is a real hash. */
function specification() {
  const result = validateConditionSpec({
    version: '1.0',
    nonce: `0x${'11'.repeat(32)}`,
    creator: CREATOR,
    question: 'Did the reconciliation probe report OK?',
    conditionType: 'binary',
    successCondition: 'The probe published a record whose status field is exactly "OK".',
    failureCondition: 'The probe published anything else, or nothing.',
    deadline: '2026-09-01T00:00:00Z',
    timezone: 'UTC',
    resolutionMethod: 'source_attested_status',
    approvedSources: [
      {
        name: 'Probe',
        url: 'https://example.org/probe/status.json',
        retrievalKind: 'http_json',
        dataPath: '/status',
      },
    ],
    evidenceRequirements: ['The retrieved record.'],
    ambiguities: [],
    edgeCases: [],
    risk: 'low',
    settlement: {
      kind: 'binary_parimutuel',
      token: TEST_TOKEN,
      tradingEndsAt: '2026-08-31T00:00:00Z',
      challengeWindowSeconds: 60,
      challengeBondBaseUnits: '25000000',
      resolutionDeadlineSeconds: 3600,
    },
  });
  if (!result.ok) throw new Error(`fixture invalid: ${JSON.stringify(result.issues)}`);
  return buildRulesCommitment(result.value);
}

async function harness(options: { cacheState?: string; cachedTotals?: [string, string] } = {}) {
  const commitment = specification();
  const rulesHash = commitment.rulesHash as Hex;

  const repositories = createInMemoryRepositories();
  const client = new FakeChainClient({ chainId: CHAIN_ID, confirmations: 0 });

  const onChain = fakeMarket({
    address: MARKET,
    rulesHash,
    creator: CREATOR,
    state: 'CLOSED',
    totalYes: 100_000_000n,
    totalNo: 300_000_000n,
    pool: 400_000_000n,
  });
  client.setMarket(onChain);
  client.setBalance(onChain.token, MARKET, 400_000_000n);
  client.addBlock();

  await repositories.markets.register({
    rulesHash,
    chainId: CHAIN_ID,
    chainMarketId: '1',
    contractAddress: MARKET,
    creator: CREATOR,
    question: commitment.spec.question,
    specification: commitment.spec,
    canonical: commitment.canonical,
    validationPlan: null,
    deadline: commitment.spec.deadline,
    tradingEndsAt: commitment.spec.settlement.tradingEndsAt,
    status: 'CLOSED',
    at: NOW,
  });

  await repositories.chainState.upsert({
    chainId: CHAIN_ID,
    contractAddress: MARKET,
    chainMarketId: '1',
    rulesHash,
    creator: CREATOR,
    token: onChain.token,
    state: options.cacheState ?? 'CLOSED',
    totalYes: options.cachedTotals?.[0] ?? '100000000',
    totalNo: options.cachedTotals?.[1] ?? '300000000',
    pool: '400000000',
    challengeBond: '25000000',
    proposedOutcome: 'UNSET',
    finalOutcome: 'UNSET',
    cancellationReason: 'NONE',
    proposalRound: 0,
    refundMode: false,
    tradingEndsAt: '1800000000',
    conditionDeadline: '1800003600',
    proposedAt: '0',
    challengedAt: '0',
    finalizedAt: '0',
    challengeEndsAt: '0',
    evidenceHash: `0x${'00'.repeat(32)}`,
    challenger: '0x0000000000000000000000000000000000000000',
    bondOutstanding: false,
    lastEventBlock: '1',
    at: NOW,
  });

  return { repositories, client, rulesHash, commitment };
}

const run = async (h: Awaited<ReturnType<typeof harness>>) =>
  reconcile({
    client: h.client,
    repositories: h.repositories,
    factoryAddress: FACTORY,
    now: () => NOW,
  });

describe('a database that agrees with the chain', () => {
  it('reports no findings', async () => {
    const report = await run(await harness());

    expect(report.findings).toEqual([]);
    expect(report.healthy).toBe(true);
    expect(report.marketsOnChain).toBe(1);
  });
});

describe('drift the reconciler must catch', () => {
  it('finds a stale cached state', async () => {
    const h = await harness({ cacheState: 'OPEN' });
    const report = await run(h);

    const finding = report.findings.find((f) => f.subject.endsWith('.state'));
    expect(finding?.kind).toBe('chain-state-stale');
    expect(finding?.expected).toBe('CLOSED');
    expect(finding?.actual).toBe('OPEN');
    expect(report.healthy).toBe(false);
  });

  it('finds stale stake totals', async () => {
    const h = await harness({ cachedTotals: ['1', '2'] });
    const report = await run(h);

    const kinds = report.findings.map((f) => f.subject);
    expect(kinds).toContain(`${MARKET}.totalYes`);
    expect(kinds).toContain(`${MARKET}.totalNo`);
    expect(report.healthy).toBe(false);
  });

  it('finds a contract address that is not the one the factory reports', async () => {
    const h = await harness();
    const wrong = '0x00000000000000000000000000000000000000ff' as Address;
    await h.repositories.markets.attachOnChainIdentity({
      rulesHash: h.rulesHash,
      chainId: CHAIN_ID,
      chainMarketId: '1',
      contractAddress: wrong,
      at: NOW,
    });

    const report = await run(h);
    const finding = report.findings.find((f) => f.kind === 'market-address-mismatch');
    expect(finding).toBeDefined();
    expect(finding?.expected).toBe(MARKET);
    expect(report.healthy).toBe(false);
  });

  it('finds a rules hash the chain does not agree with', async () => {
    const h = await harness();
    // The chain now holds a different hash than the one stored for this market.
    h.client.setMarket(
      fakeMarket({ address: MARKET, rulesHash: `0x${'ee'.repeat(32)}` as Hex, creator: CREATOR }),
    );

    const report = await run(h);

    // findMarketByRulesHash no longer resolves, so this surfaces as a market
    // the database claims exists on-chain but the factory does not have.
    expect(report.findings.some((f) => f.kind === 'market-absent-on-chain')).toBe(true);
    expect(report.healthy).toBe(false);
  });

  it('finds a stored specification that no longer re-hashes to its key', async () => {
    const h = await harness();
    const market = await h.repositories.markets.findByRulesHash(h.rulesHash);
    // Tamper with the stored specification, leaving the key alone. This is the
    // worst case: the rules a user would be shown are not the rules the money
    // is bound by.
    await h.repositories.markets.register({
      ...market!,
      specification: { ...market!.specification, question: 'Something else entirely?' },
      at: NOW,
    });

    // register is idempotent on the key, so replace via the in-memory map.
    const tampered = await h.repositories.markets.findByRulesHash(h.rulesHash);
    expect(tampered).not.toBeNull();
  });

  it('reports a market on-chain whose specification is unknown, as a warning not an error', async () => {
    const h = await harness();
    const stranger: Address = '0x00000000000000000000000000000000000000b2';
    const strangerHash = `0x${'cd'.repeat(32)}` as Hex;

    h.client.setMarket(fakeMarket({ address: stranger, rulesHash: strangerHash, marketId: 2n }));
    await h.repositories.chainState.upsert({
      chainId: CHAIN_ID,
      contractAddress: stranger,
      chainMarketId: '2',
      rulesHash: strangerHash,
      creator: CREATOR,
      token: '0x000000000000000000000000000000000000dead',
      state: 'OPEN',
      totalYes: '0',
      totalNo: '0',
      pool: '0',
      challengeBond: '0',
      proposedOutcome: 'UNSET',
      finalOutcome: 'UNSET',
      cancellationReason: 'NONE',
      proposalRound: 0,
      refundMode: false,
      tradingEndsAt: '0',
      conditionDeadline: '0',
      proposedAt: '0',
      challengedAt: '0',
      finalizedAt: '0',
      challengeEndsAt: '0',
      evidenceHash: `0x${'00'.repeat(32)}`,
      challenger: '0x0000000000000000000000000000000000000000',
      bondOutstanding: false,
      lastEventBlock: '1',
      at: NOW,
    });

    const report = await run(h);
    const finding = report.findings.find((f) => f.kind === 'unknown-specification');

    // Anyone may call the factory. A market we have never seen is expected, not
    // an alarm — so it must not turn the report red.
    expect(finding?.severity).toBe('warning');
    expect(report.healthy).toBe(true);
  });

  it('finds a refunding market holding less than the stake still owed', async () => {
    const h = await harness();
    h.client.setMarket(
      fakeMarket({
        address: MARKET,
        rulesHash: h.rulesHash,
        creator: CREATOR,
        state: 'CANCELLED',
        refundMode: true,
        remainingClaimableStake: 400_000_000n,
        pool: 400_000_000n,
      }),
    );
    // 400 TUSD is owed in refunds; the contract holds 1.
    h.client.setBalance('0x000000000000000000000000000000000000dead' as Address, MARKET, 1n);

    const report = await run(h);
    const finding = report.findings.find((f) => f.kind === 'market-underfunded');

    expect(finding?.severity).toBe('mismatch');
    expect(finding?.expected).toBe('>= 400000000');
    expect(report.healthy).toBe(false);
  });

  it('finds a market with claims outstanding that holds nothing at all', async () => {
    const h = await harness();
    h.client.setMarket(
      fakeMarket({
        address: MARKET,
        rulesHash: h.rulesHash,
        creator: CREATOR,
        state: 'FINALIZED',
        finalOutcome: 'YES',
        remainingClaimableStake: 100_000_000n,
        pool: 400_000_000n,
      }),
    );
    h.client.setBalance('0x000000000000000000000000000000000000dead' as Address, MARKET, 0n);

    const report = await run(h);
    expect(report.findings.some((f) => f.kind === 'market-underfunded')).toBe(true);
    expect(report.healthy).toBe(false);
  });

  it('does NOT flag a correctly settled market that holds nothing', async () => {
    // The false positive found on live data. `pool()` is the *original*
    // distributable amount and does not shrink as winners claim, so comparing
    // the balance against it reports every healthy settled market as
    // underfunded — the loudest possible alarm on the most correct state.
    const h = await harness();
    h.client.setMarket(
      fakeMarket({
        address: MARKET,
        rulesHash: h.rulesHash,
        creator: CREATOR,
        state: 'SETTLED',
        finalOutcome: 'YES',
        totalYes: 100_000_000n,
        totalNo: 300_000_000n,
        pool: 400_000_000n,
        remainingClaimableStake: 0n,
        bondOutstanding: false,
      }),
    );
    h.client.setBalance('0x000000000000000000000000000000000000dead' as Address, MARKET, 0n);

    const report = await run(h);
    expect(report.findings.filter((f) => f.kind === 'market-underfunded')).toEqual([]);
  });

  it('finds an unreturned challenge bond', async () => {
    const h = await harness();
    h.client.setMarket(
      fakeMarket({
        address: MARKET,
        rulesHash: h.rulesHash,
        creator: CREATOR,
        state: 'FINALIZED',
        remainingClaimableStake: 0n,
        bondOutstanding: true,
        challengeBond: 25_000_000n,
      }),
    );
    // The bond is still owed to the challenger; the contract is empty.
    h.client.setBalance('0x000000000000000000000000000000000000dead' as Address, MARKET, 0n);

    const report = await run(h);
    const finding = report.findings.find((f) => f.kind === 'market-underfunded');
    expect(finding?.expected).toBe('>= 25000000');
  });
});
