/**
 * Indexer behaviour (§17–§21).
 *
 * These run against `FakeChainClient`, which is a scripted chain rather than a
 * mocked library: it holds real blocks with real hashes and can be told to
 * reorganise. That is the only way to test a rewind — a public testnet will not
 * reorganise on request, and a test that waited for one would never run.
 *
 * The properties asserted here are the ones that make the indexer trustworthy:
 * it never reads past the safe head, replaying produces no duplicates, the
 * checkpoint survives a restart, and a replaced block is detected and undone.
 */

import { describe, expect, it } from 'vitest';

import { MarketIndexer } from '../src/indexer/indexer.js';
import { createInMemoryRepositories } from '../src/repositories/memory.js';
import type { Address, Hex } from '../src/chain/types.js';
import { FakeChainClient, fakeMarket, silentLogger, type FakeLog } from './fake-chain.js';

const CHAIN_ID = 1952;
const MARKET: Address = '0x00000000000000000000000000000000000000a1';
const RULES_HASH = `0x${'ab'.repeat(32)}` as Hex;
const CREATOR = '0x1111111111111111111111111111111111111111';

function createdLog(tx: string, logIndex = 0): FakeLog {
  return {
    name: 'MarketCreated',
    address: '0x00000000000000000000000000000000000fac70',
    marketId: 1n,
    transactionHash: `0x${tx.repeat(64).slice(0, 64)}` as Hex,
    logIndex,
    args: {
      marketId: '1',
      market: MARKET,
      creator: CREATOR,
      rulesHash: RULES_HASH,
      token: '0x000000000000000000000000000000000000dead',
    },
  };
}

function stakeLog(tx: string, logIndex = 0, amount = '100000000'): FakeLog {
  return {
    name: 'StakePlaced',
    address: MARKET,
    marketId: 1n,
    transactionHash: `0x${tx.repeat(64).slice(0, 64)}` as Hex,
    logIndex,
    args: { marketId: '1', staker: CREATOR, side: 1, sideName: 'YES', amount },
  };
}

/** A harness with one registered specification, awaiting its on-chain twin. */
async function harness(options: { confirmations?: number } = {}) {
  const repositories = createInMemoryRepositories();
  const client = new FakeChainClient({
    chainId: CHAIN_ID,
    confirmations: options.confirmations ?? 0,
  });

  client.setMarket(fakeMarket({ address: MARKET, rulesHash: RULES_HASH, totalYes: 100_000_000n }));

  await repositories.markets.register({
    rulesHash: RULES_HASH,
    chainId: CHAIN_ID,
    chainMarketId: null,
    contractAddress: null,
    creator: CREATOR,
    question: 'test',
    specification: {} as never,
    canonical: '{}',
    validationPlan: null,
    deadline: '2026-09-01T00:00:00.000Z',
    tradingEndsAt: '2026-08-31T00:00:00.000Z',
    status: 'PENDING_ONCHAIN',
    at: new Date('2026-08-01T00:00:00Z'),
  });

  const makeIndexer = (startBlock: bigint, reorgWindow = 8): MarketIndexer =>
    new MarketIndexer({
      client,
      repositories,
      startBlock,
      reorgWindow,
      logger: silentLogger,
      now: () => new Date('2026-08-17T00:00:00Z'),
    });

  return { repositories, client, makeIndexer };
}

describe('indexer bootstrap and checkpointing (§21)', () => {
  it('starts at the deployment block, not one after it', async () => {
    const { client, repositories, makeIndexer } = await harness();
    const deploymentBlock = client.addBlock([createdLog('a')]);

    await makeIndexer(deploymentBlock).runOnce();

    const events = await repositories.events.listByRulesHash(RULES_HASH);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventName).toBe('MarketCreated');
  });

  it('persists a checkpoint and resumes from it', async () => {
    const { client, repositories, makeIndexer } = await harness();
    const start = client.addBlock([createdLog('a')]);

    await makeIndexer(start).runOnce();

    const first = await repositories.checkpoints.loadOrCreate({
      chainId: CHAIN_ID,
      stream: 'market-factory',
      startBlock: start.toString(),
      at: new Date(),
    });
    expect(first.lastProcessedBlock).toBe(client.head.toString());

    client.addBlock([stakeLog('b')]);
    const pass = await makeIndexer(start).runOnce();

    // The second pass began after the first one's last block, not at the start.
    expect(pass.fromBlock).toBe(BigInt(first.lastProcessedBlock) + 1n);
    expect(pass.eventsInserted).toBe(1);
  });

  it('reports idle without moving when there is nothing new', async () => {
    const { client, makeIndexer } = await harness();
    const start = client.addBlock([createdLog('a')]);

    await makeIndexer(start).runOnce();
    const second = await makeIndexer(start).runOnce();

    expect(second.idle).toBe(true);
    expect(second.eventsSeen).toBe(0);
    expect(second.eventsInserted).toBe(0);
  });
});

describe('idempotency (§18)', () => {
  it('inserts nothing on a second pass over the same blocks', async () => {
    const { client, repositories, makeIndexer } = await harness();
    const start = client.addBlock([createdLog('a'), stakeLog('a', 1)]);

    const first = await makeIndexer(start).runOnce();
    expect(first.eventsInserted).toBe(2);

    // Force a re-scan of the same range by rewinding the cursor by hand, which
    // is what a crash between "write events" and "save checkpoint" looks like.
    await repositories.checkpoints.rewind({
      chainId: CHAIN_ID,
      stream: 'market-factory',
      toBlock: (start - 1n).toString(),
      at: new Date(),
    });

    const second = await makeIndexer(start).runOnce();

    expect(second.eventsSeen).toBe(2);
    // Seen again, stored once. This is the property that makes a restart safe.
    expect(second.eventsInserted).toBe(0);
    expect(await repositories.events.countByChain(CHAIN_ID)).toBe(2);
  });

  it('treats one transaction hash with different log indices as different events', async () => {
    const { client, repositories, makeIndexer } = await harness();
    const start = client.addBlock([createdLog('a', 0), stakeLog('a', 1), stakeLog('a', 2)]);

    await makeIndexer(start).runOnce();

    expect(await repositories.events.countByChain(CHAIN_ID)).toBe(3);
    expect(await repositories.events.findDuplicateIdentities(CHAIN_ID)).toEqual([]);
  });

  it('attaches the on-chain identity to the registered specification exactly once', async () => {
    const { client, repositories, makeIndexer } = await harness();
    const start = client.addBlock([createdLog('a')]);

    await makeIndexer(start).runOnce();
    const after = await repositories.markets.findByRulesHash(RULES_HASH);

    expect(after?.contractAddress).toBe(MARKET);
    expect(after?.chainMarketId).toBe('1');
    // Status was promoted from the contract's own state, not guessed.
    expect(after?.status).toBe('OPEN');
  });
});

describe('confirmation lag (§19)', () => {
  it('never reads past latest minus the confirmation depth', async () => {
    const { client, makeIndexer } = await harness({ confirmations: 5 });
    const start = client.addBlock([createdLog('a')]);
    client.addBlocks(3);

    const pass = await makeIndexer(start).runOnce();

    // Head is start+3; with 5 confirmations the safe head is below the start
    // block, so there is nothing safe to read yet.
    expect(pass.idle).toBe(true);
    expect(pass.safeHead).toBeLessThan(start);
  });

  it('indexes a block once it is deep enough', async () => {
    const { client, repositories, makeIndexer } = await harness({ confirmations: 5 });
    const start = client.addBlock([createdLog('a')]);
    client.addBlocks(6);

    const pass = await makeIndexer(start).runOnce();

    expect(pass.idle).toBe(false);
    expect(pass.toBlock).toBe(client.head - 5n);
    expect(await repositories.events.countByChain(CHAIN_ID)).toBe(1);
  });
});

describe('reorg handling (§20)', () => {
  it('detects a replaced block, deletes its events, and rewinds the cursor', async () => {
    const { client, repositories, makeIndexer } = await harness();
    const start = client.addBlock([createdLog('a')]);
    const staked = client.addBlock([stakeLog('b')]);

    await makeIndexer(start).runOnce();
    expect(await repositories.events.countByChain(CHAIN_ID)).toBe(2);

    // The chain replaces the staking block with one containing a different
    // transaction. The stake that was indexed never happened.
    client.reorg(staked, [[stakeLog('c')]]);

    const pass = await makeIndexer(start).runOnce();

    expect(pass.rewoundTo).not.toBeNull();
    // The superseded event is gone, the replacement is present, and the count
    // has not doubled.
    const events = await repositories.events.listByRulesHash(RULES_HASH);
    const hashes = events.map((event) => event.transactionHash);
    expect(hashes).toContain(`0x${'c'.repeat(64)}`);
    expect(hashes).not.toContain(`0x${'b'.repeat(64)}`);
    expect(await repositories.events.countByChain(CHAIN_ID)).toBe(2);
  });

  it('counts the rewind on the checkpoint', async () => {
    const { client, repositories, makeIndexer } = await harness();
    const start = client.addBlock([createdLog('a')]);
    const staked = client.addBlock([stakeLog('b')]);

    await makeIndexer(start).runOnce();
    client.reorg(staked, [[stakeLog('c')]]);
    await makeIndexer(start).runOnce();

    const checkpoint = await repositories.checkpoints.loadOrCreate({
      chainId: CHAIN_ID,
      stream: 'market-factory',
      startBlock: start.toString(),
      at: new Date(),
    });
    expect(checkpoint.rewindCount).toBe(1);
  });

  it('does not rewind when the recent window still matches', async () => {
    const { client, makeIndexer } = await harness();
    const start = client.addBlock([createdLog('a')]);
    client.addBlock([stakeLog('b')]);

    await makeIndexer(start).runOnce();
    client.addBlock([stakeLog('d')]);
    const pass = await makeIndexer(start).runOnce();

    expect(pass.rewoundTo).toBeNull();
  });

  it('re-indexes the replacement chain after rewinding', async () => {
    const { client, repositories, makeIndexer } = await harness();
    const start = client.addBlock([createdLog('a')]);
    const staked = client.addBlock([stakeLog('b')]);

    await makeIndexer(start).runOnce();
    // Two replacement blocks carrying two different stakes.
    client.reorg(staked, [[stakeLog('c')], [stakeLog('d')]]);

    await makeIndexer(start).runOnce();

    const events = await repositories.events.listByRulesHash(RULES_HASH);
    const hashes = events.map((event) => event.transactionHash);
    expect(hashes).toContain(`0x${'c'.repeat(64)}`);
    expect(hashes).toContain(`0x${'d'.repeat(64)}`);
    expect(hashes).not.toContain(`0x${'b'.repeat(64)}`);
  });
});

describe('the indexed chain-state view (§27)', () => {
  it('caches what the contract reports, not what the events implied', async () => {
    const { client, repositories, makeIndexer } = await harness();
    const start = client.addBlock([createdLog('a'), stakeLog('a', 1)]);

    client.setMarket(
      fakeMarket({
        address: MARKET,
        rulesHash: RULES_HASH,
        state: 'CLOSED',
        totalYes: 100_000_000n,
        totalNo: 300_000_000n,
        pool: 400_000_000n,
      }),
    );

    await makeIndexer(start).runOnce();

    const cached = await repositories.chainState.findByRulesHash(CHAIN_ID, RULES_HASH);
    expect(cached?.state).toBe('CLOSED');
    expect(cached?.totalYes).toBe('100000000');
    expect(cached?.totalNo).toBe('300000000');
    // A uint256 stays a decimal string all the way through. It is never a
    // JavaScript number anywhere in this path.
    expect(typeof cached?.pool).toBe('string');
  });

  it('keeps watching a market it discovered on-chain, in later passes, with no off-chain record', async () => {
    // The live-bootstrap bug. Anyone may call the factory, so a market can exist
    // with no registered specification. If the watch set is drawn only from the
    // `markets` table, then once the pass containing `MarketCreated` is behind
    // us the market goes dark and every later event it emits is missed.
    const repositories = createInMemoryRepositories();
    const client = new FakeChainClient({ chainId: CHAIN_ID, confirmations: 0 });
    client.setMarket(fakeMarket({ address: MARKET, rulesHash: RULES_HASH }));

    const makeIndexer = (start: bigint): MarketIndexer =>
      new MarketIndexer({ client, repositories, startBlock: start, logger: silentLogger });

    // Pass 1: the market is created. Nothing is registered off-chain.
    const start = client.addBlock([createdLog('a')]);
    await makeIndexer(start).runOnce();
    expect(await repositories.markets.findByRulesHash(RULES_HASH)).toBeNull();

    // Pass 2, a later block: the market emits a stake.
    client.addBlock([stakeLog('b')]);
    await makeIndexer(start).runOnce();

    const events = await repositories.events.listByMarket(CHAIN_ID, '1');
    expect(events.map((event) => event.eventName)).toContain('StakePlaced');
  });

  it('records an event for a market whose specification is unknown, without inventing one', async () => {
    const repositories = createInMemoryRepositories();
    const client = new FakeChainClient({ chainId: CHAIN_ID, confirmations: 0 });
    client.setMarket(fakeMarket({ address: MARKET, rulesHash: RULES_HASH }));

    const start = client.addBlock([createdLog('a')]);
    await new MarketIndexer({
      client,
      repositories,
      startBlock: start,
      logger: silentLogger,
    }).runOnce();

    // The event is stored — it happened.
    expect(await repositories.events.countByChain(CHAIN_ID)).toBe(1);
    // But no market record was fabricated to hang it on.
    expect(await repositories.markets.findByRulesHash(RULES_HASH)).toBeNull();
  });
});
