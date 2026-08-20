/**
 * The market event indexer (§17–§21).
 *
 * What it is
 * ----------
 * A cursor over the chain that reads logs, decodes them, writes them down, and
 * keeps a cached view of market state. **It is not authoritative.** Every number
 * it produces has a counterpart in a contract, and where they disagree the
 * contract is right — `reconcile.ts` exists to find exactly those disagreements.
 *
 * Three properties this file is built around, each of which is a requirement
 * rather than a nicety:
 *
 * **Idempotence (§18).** Events are stored under their own identity —
 * `(chainId, transactionHash, logIndex)` — and inserted with a conflict-ignore.
 * Reprocessing a block is therefore a no-op, which is what lets the indexer
 * crash anywhere and restart without producing a second copy of anything. The
 * checkpoint is saved *after* the writes it covers, so the only failure mode is
 * redoing work, never skipping it.
 *
 * **Confirmation lag (§19).** The indexer never reads past
 * `latest - confirmations`. Blocks nearer than that are still allowed to change,
 * and indexing them would mean persisting facts that can be retracted.
 *
 * **Reorg handling (§20).** Every processed block's hash is recorded. Each pass
 * begins by re-reading the recent window and comparing; a mismatch means those
 * blocks were replaced, and the indexer deletes the events it wrote above the
 * last height that still agrees and rewinds its cursor there. This is
 * deliberately minimal — it is a rewind, not a reorganisation-aware state
 * machine — but it is real, and it is tested.
 */

import type { MarketStatus } from '@covenant/shared';

import type { ChainClient } from '../chain/types.js';
import type { Address, DecodedMarketEvent, Hex } from '../chain/types.js';
import type { Repositories } from '../repositories/types.js';

export interface IndexerLogger {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
}

export interface MarketIndexerOptions {
  readonly client: ChainClient;
  readonly repositories: Repositories;
  /** Where a fresh index starts: the factory's deployment block. */
  readonly startBlock: bigint;
  /**
   * How far back a reorg is considered possible.
   *
   * Blocks older than this are treated as settled history and are not
   * re-checked. It is also the depth of the block-hash window kept in the
   * database, so it bounds that table.
   */
  readonly reorgWindow?: number;
  readonly stream?: string;
  /**
   * Most blocks one pass will cover before persisting its checkpoint.
   *
   * A bootstrap can span hundreds of thousands of blocks, and on a chain that
   * caps `eth_getLogs` at 100 that is thousands of requests. Doing it as one
   * pass means the checkpoint is written once, at the end — so a connection
   * dropped at minute nineteen of twenty throws away all of it.
   *
   * Bounding the pass makes catch-up incremental: each pass commits what it
   * covered, and a failure costs one window rather than the whole run. It does
   * not affect correctness, only how much work a failure repeats.
   */
  readonly maxBlocksPerPass?: number;
  readonly logger: IndexerLogger;
  readonly now?: () => Date;
}

/** What one pass did. Returned so tests and the CLI can assert on it. */
export interface IndexerPass {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly safeHead: bigint;
  readonly eventsSeen: number;
  readonly eventsInserted: number;
  readonly marketsTouched: number;
  readonly rewoundTo: bigint | null;
  readonly idle: boolean;
  /** True when this pass reached the safe head; false when more remains. */
  readonly caughtUp: boolean;
}

const DEFAULT_REORG_WINDOW = 32;
const DEFAULT_STREAM = 'market-factory';
/** ~50 requests per pass on a chain capped at 100 blocks per `eth_getLogs`. */
const DEFAULT_MAX_BLOCKS_PER_PASS = 5_000;

/** On-chain state name → the shared market status. They coincide by design. */
const STATUS_BY_STATE: Readonly<Record<string, MarketStatus>> = {
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
  RESOLUTION_PROPOSED: 'RESOLUTION_PROPOSED',
  CHALLENGED: 'CHALLENGED',
  FINALIZED: 'FINALIZED',
  SETTLED: 'SETTLED',
  CANCELLED: 'CANCELLED',
};

export class MarketIndexer {
  private readonly client: ChainClient;
  private readonly repositories: Repositories;
  private readonly startBlock: bigint;
  private readonly reorgWindow: bigint;
  private readonly maxBlocksPerPass: bigint;
  private readonly stream: string;
  private readonly logger: IndexerLogger;
  private readonly now: () => Date;
  private stopped = false;

  constructor(options: MarketIndexerOptions) {
    this.client = options.client;
    this.repositories = options.repositories;
    this.startBlock = options.startBlock;
    this.reorgWindow = BigInt(options.reorgWindow ?? DEFAULT_REORG_WINDOW);
    this.maxBlocksPerPass = BigInt(options.maxBlocksPerPass ?? DEFAULT_MAX_BLOCKS_PER_PASS);
    this.stream = options.stream ?? DEFAULT_STREAM;
    this.logger = options.logger;
    this.now = options.now ?? ((): Date => new Date());
  }

  get chainId(): number {
    return this.client.chainId;
  }

  /**
   * Run one pass: check for a reorg, scan to the safe head, persist.
   *
   * Safe to call repeatedly and safe to abandon halfway — see the idempotence
   * note at the top of the file.
   */
  async runOnce(): Promise<IndexerPass> {
    const chainId = this.client.chainId;

    const checkpoint = await this.repositories.checkpoints.loadOrCreate({
      chainId,
      stream: this.stream,
      startBlock: this.startBlock.toString(),
      // A fresh checkpoint sits one block *below* the start block, so the first
      // pass includes the deployment block itself rather than stepping over it.
      at: this.now(),
    });

    const rewoundTo = await this.detectAndHandleReorg(BigInt(checkpoint.lastProcessedBlock));
    const cursor = rewoundTo ?? BigInt(checkpoint.lastProcessedBlock);

    const safeHead = await this.client.getSafeBlockNumber();
    const fromBlock = cursor + 1n;

    if (fromBlock > safeHead) {
      return {
        fromBlock,
        toBlock: cursor,
        safeHead,
        eventsSeen: 0,
        eventsInserted: 0,
        marketsTouched: 0,
        rewoundTo,
        idle: true,
        caughtUp: true,
      };
    }

    // Bounded, so the checkpoint below commits incremental progress during a
    // long catch-up instead of only at the very end.
    const ceiling = fromBlock + this.maxBlocksPerPass - 1n;
    const toBlock = ceiling < safeHead ? ceiling : safeHead;

    // Factory first. A market created in this range must be in the address set
    // before its own clone's logs are fetched, or its stakes would be missed
    // until the next pass.
    const factoryEvents = await this.client.getFactoryLogs(fromBlock, toBlock);

    // The watch set is the union of three sources, and all three are needed:
    //
    //   1. markets registered off-chain, which is the normal path;
    //   2. markets this indexer has already seen on-chain, whether or not a
    //      specification was ever registered for them;
    //   3. markets created inside this very range.
    //
    // (2) is not redundant. Anyone may call the factory, so a market can exist
    // with no off-chain record — and drawing the set from `markets` alone meant
    // that once the pass containing its `MarketCreated` was behind us, every
    // later event it emitted was invisible. That is exactly what happened on the
    // first live bootstrap: six markets were discovered and their stakes
    // recorded, then closes, proposals, challenges, finalizations and claims
    // were all silently missed.
    const registered = await this.repositories.markets.listOnChainAddresses(chainId);
    const observed = await this.repositories.chainState.list(chainId);

    const addresses = new Set<Address>([
      ...registered.map((a) => a.toLowerCase() as Address),
      ...observed.map((row) => row.contractAddress.toLowerCase() as Address),
    ]);
    for (const event of factoryEvents) {
      const market = event.args['market'];
      if (typeof market === 'string') addresses.add(market.toLowerCase() as Address);
    }

    const marketEvents = await this.client.getMarketLogs([...addresses], fromBlock, toBlock);

    const all = [...factoryEvents, ...marketEvents].sort((a, b) =>
      a.identity.blockNumber === b.identity.blockNumber
        ? a.identity.logIndex - b.identity.logIndex
        : a.identity.blockNumber < b.identity.blockNumber
          ? -1
          : 1,
    );

    const inserted = await this.persistEvents(all);
    const touched = await this.applyEvents(all);
    await this.recordBlockWindow(fromBlock, toBlock);

    await this.repositories.checkpoints.save({
      chainId,
      stream: this.stream,
      lastProcessedBlock: toBlock.toString(),
      lastProcessedBlockHash: await this.client.getBlockHash(toBlock),
      at: this.now(),
    });

    await this.repositories.checkpoints.pruneBlocksBelow(
      chainId,
      (toBlock > this.reorgWindow * 4n ? toBlock - this.reorgWindow * 4n : 0n).toString(),
    );

    this.logger.info(
      {
        chainId,
        fromBlock: fromBlock.toString(),
        toBlock: toBlock.toString(),
        events: all.length,
        inserted,
        markets: touched,
      },
      'indexer pass complete',
    );

    return {
      fromBlock,
      toBlock,
      safeHead,
      eventsSeen: all.length,
      eventsInserted: inserted,
      marketsTouched: touched,
      rewoundTo,
      idle: all.length === 0,
      caughtUp: toBlock >= safeHead,
    };
  }

  /**
   * Run passes until the safe head is reached.
   *
   * Each pass commits its own checkpoint, so an interruption costs one window.
   */
  async catchUp(onPass?: (pass: IndexerPass) => void): Promise<IndexerPass> {
    for (;;) {
      const pass = await this.runOnce();
      onPass?.(pass);
      if (pass.caughtUp) return pass;
    }
  }

  /** Poll until `stop()`. */
  async run(intervalMs = 12_000): Promise<void> {
    this.stopped = false;
    while (!this.stopped) {
      try {
        await this.runOnce();
      } catch (error) {
        // A pass that throws leaves the checkpoint where it was, so the next
        // attempt redoes the same range. Failing loudly and retrying is correct;
        // advancing past an error would lose events silently.
        this.logger.error({ err: error }, 'indexer pass failed; will retry');
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  stop(): void {
    this.stopped = true;
  }

  // --- reorg ---------------------------------------------------------------

  /**
   * Compare recorded block hashes against the chain, and rewind if they differ.
   *
   * @returns the height rewound to, or null when the recent window still
   *   agrees with the chain.
   */
  private async detectAndHandleReorg(lastProcessed: bigint): Promise<bigint | null> {
    if (lastProcessed < this.startBlock) return null;

    const windowStart = lastProcessed > this.reorgWindow ? lastProcessed - this.reorgWindow : 0n;
    const observed = await this.repositories.checkpoints.recentBlocks(
      this.client.chainId,
      windowStart.toString(),
    );
    if (observed.length === 0) return null;

    // Newest first: find the highest recorded height whose hash the chain still
    // agrees with. Everything above it was replaced.
    const descending = [...observed].sort((a, b) =>
      BigInt(a.blockNumber) > BigInt(b.blockNumber) ? -1 : 1,
    );

    let divergedAt: bigint | null = null;
    let agreedAt: bigint | null = null;

    for (const entry of descending) {
      const height = BigInt(entry.blockNumber);
      const actual = await this.client.getBlockHash(height);
      if (actual === null) {
        // The chain no longer has a block at this height — it shrank. Treat it
        // as divergence and keep walking down.
        divergedAt = height;
        continue;
      }
      if (actual.toLowerCase() === entry.blockHash.toLowerCase()) {
        agreedAt = height;
        break;
      }
      divergedAt = height;
    }

    if (divergedAt === null) return null;

    // Rewind to the last height that still matches, or to just below the start
    // block if nothing in the window does.
    const rewindTo = agreedAt ?? this.startBlock - 1n;
    const deleteFrom = rewindTo + 1n;

    const removedEvents = await this.repositories.events.deleteFromBlock(
      this.client.chainId,
      deleteFrom.toString(),
    );
    await this.repositories.checkpoints.deleteBlocksFrom(this.client.chainId, deleteFrom.toString());
    await this.repositories.checkpoints.rewind({
      chainId: this.client.chainId,
      stream: this.stream,
      toBlock: rewindTo.toString(),
      at: this.now(),
    });

    // Chain state rows are rebuilt from the contract on the next pass, so they
    // need no rewind of their own — they are a cache, not a log.
    this.logger.warn(
      {
        chainId: this.client.chainId,
        divergedAt: divergedAt.toString(),
        rewoundTo: rewindTo.toString(),
        removedEvents,
      },
      'reorg detected; rewound indexer',
    );

    return rewindTo;
  }

  // --- persistence ---------------------------------------------------------

  private async persistEvents(events: readonly DecodedMarketEvent[]): Promise<number> {
    if (events.length === 0) return 0;

    // A clone's own events do not carry the rules hash, so it is resolved from
    // the market record. Null is fine and expected for a market whose
    // specification this backend has never seen.
    const rulesHashByMarketId = new Map<string, string>();
    for (const event of events) {
      if (event.name !== 'MarketCreated') continue;
      const hash = event.args['rulesHash'];
      if (event.marketId !== null && typeof hash === 'string') {
        rulesHashByMarketId.set(event.marketId.toString(), hash.toLowerCase());
      }
    }

    const rows = await Promise.all(
      events.map(async (event) => {
        const marketIdKey = event.marketId?.toString() ?? null;
        let rulesHash = marketIdKey === null ? null : (rulesHashByMarketId.get(marketIdKey) ?? null);
        if (rulesHash === null && marketIdKey !== null) {
          const record = await this.repositories.markets.findByChainMarketId(
            this.client.chainId,
            marketIdKey,
          );
          rulesHash = record?.rulesHash ?? null;
        }

        return {
          chainId: event.identity.chainId,
          transactionHash: event.identity.transactionHash,
          logIndex: event.identity.logIndex,
          blockNumber: event.identity.blockNumber.toString(),
          blockHash: event.identity.blockHash,
          contractAddress: event.address,
          eventName: event.name,
          chainMarketId: marketIdKey,
          rulesHash,
          args: event.args,
        };
      }),
    );

    return this.repositories.events.append(rows, this.now());
  }

  /**
   * Fold events into the indexed view.
   *
   * `MarketCreated` attaches the on-chain identity to the specification record
   * the creator registered before opening the market — the join on `rulesHash`
   * that ADR-0006 specified.
   *
   * For every market any event touched, the current state is then read back
   * **from the contract** rather than reconstructed from the event stream. The
   * events say what happened; the contract says what is true, and reading it is
   * one call against a market that just changed.
   */
  private async applyEvents(events: readonly DecodedMarketEvent[]): Promise<number> {
    const at = this.now();
    const touched = new Set<Address>();

    for (const event of events) {
      if (event.name === 'MarketCreated') {
        const market = event.args['market'];
        const rulesHash = event.args['rulesHash'];
        if (typeof market === 'string' && typeof rulesHash === 'string' && event.marketId !== null) {
          const updated = await this.repositories.markets.attachOnChainIdentity({
            rulesHash: rulesHash.toLowerCase(),
            chainId: this.client.chainId,
            chainMarketId: event.marketId.toString(),
            contractAddress: market.toLowerCase(),
            at,
          });
          if (updated === null) {
            // A market whose specification we have never seen. Recorded, not
            // invented: the event is in `market_events` and the reconciler will
            // report it. Fabricating a specification to match would be worse
            // than an admitted gap.
            this.logger.warn(
              { rulesHash, market, marketId: event.marketId.toString() },
              'MarketCreated for an unknown specification',
            );
          }
          touched.add(market.toLowerCase() as Address);
        }
        continue;
      }
      touched.add(event.address);
    }

    for (const address of touched) {
      await this.refreshChainState(address, at);
    }

    return touched.size;
  }

  /** Re-read one market from the contract and cache it. */
  private async refreshChainState(address: Address, at: Date): Promise<void> {
    const market = await this.client.readMarket(address);

    await this.repositories.chainState.upsert({
      chainId: this.client.chainId,
      contractAddress: market.address,
      chainMarketId: market.marketId.toString(),
      rulesHash: market.rulesHash,
      creator: market.creator,
      token: market.token,
      state: market.state,
      totalYes: market.totalYes.toString(),
      totalNo: market.totalNo.toString(),
      pool: market.pool.toString(),
      challengeBond: market.challengeBond.toString(),
      proposedOutcome: market.proposedOutcome,
      finalOutcome: market.finalOutcome,
      cancellationReason: market.cancellationReason,
      proposalRound: market.proposalRound,
      refundMode: market.refundMode,
      tradingEndsAt: market.tradingEndsAt.toString(),
      conditionDeadline: market.conditionDeadline.toString(),
      proposedAt: market.proposedAt.toString(),
      challengedAt: market.challengedAt.toString(),
      finalizedAt: market.finalizedAt.toString(),
      challengeEndsAt: market.challengeEndsAt.toString(),
      evidenceHash: market.evidenceHash,
      challenger: market.challenger,
      bondOutstanding: market.bondOutstanding,
      lastEventBlock: (await this.client.getBlockNumber()).toString(),
      at,
    });

    const status = STATUS_BY_STATE[market.state];
    if (status !== undefined) {
      await this.repositories.markets.updateStatus({ rulesHash: market.rulesHash, status, at });
    }
  }

  /**
   * Record block hashes for the tail of the processed range.
   *
   * Only the last `reorgWindow` blocks are recorded, not every block in the
   * range. A catch-up pass can span millions of blocks and fetching a header for
   * each would be both slow and pointless — anything older than the reorg window
   * is never re-checked, so storing its hash would buy nothing.
   */
  private async recordBlockWindow(fromBlock: bigint, toBlock: bigint): Promise<void> {
    const windowStart =
      toBlock - this.reorgWindow > fromBlock ? toBlock - this.reorgWindow : fromBlock;
    const at = this.now();

    for (let height = windowStart; height <= toBlock; height += 1n) {
      const hash = await this.client.getBlockHash(height);
      if (hash === null) continue;
      await this.repositories.checkpoints.recordBlock({
        chainId: this.client.chainId,
        blockNumber: height.toString(),
        blockHash: hash,
        at,
      });
    }
  }
}

export type { Hex };
