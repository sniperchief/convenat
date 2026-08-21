/**
 * A scripted `ChainClient`.
 *
 * The whole reason `chain/types.ts` defines a port is so the indexer can be
 * tested against a chain whose reorgs happen on demand. Waiting for a real
 * reorganisation on a public testnet is not a test strategy, and mocking viem
 * would test viem rather than the indexer.
 *
 * This implementation keeps an ordered list of blocks, each with a hash and a
 * set of logs, and offers `reorg()` to replace a suffix of them — exactly the
 * event the indexer's rewind logic exists to survive.
 */

import type {
  Address,
  ChainClient,
  DecodedMarketEvent,
  Hex,
  MarketEventName,
  OnChainMarket,
  OnChainPosition,
  ResolverChainWriter,
  TransactionOutcome,
} from '../src/chain/types.js';

export interface FakeLog {
  readonly name: MarketEventName;
  readonly address: Address;
  readonly marketId: bigint | null;
  readonly transactionHash: Hex;
  readonly logIndex: number;
  readonly args: Record<string, string | number | boolean>;
}

interface FakeBlock {
  hash: Hex;
  logs: FakeLog[];
}

const hashFor = (chainId: number, height: bigint, salt: string): Hex =>
  `0x${(chainId.toString(16) + height.toString(16) + salt)
    .padEnd(64, '0')
    .slice(0, 64)}` as Hex;

export class FakeChainClient implements ChainClient {
  readonly chainId: number;
  readonly confirmations: number;

  private readonly blocks: FakeBlock[] = [];
  private readonly markets = new Map<string, OnChainMarket>();
  private readonly positions = new Map<string, OnChainPosition>();
  private readonly balances = new Map<string, bigint>();
  /** Every getLogs range this client was asked for. Asserted by the lag test. */
  readonly logRequests: { from: bigint; to: bigint }[] = [];

  constructor(options: { chainId: number; confirmations: number }) {
    this.chainId = options.chainId;
    this.confirmations = options.confirmations;
    // Block 0 exists so heights line up with array indices.
    this.blocks.push({ hash: hashFor(this.chainId, 0n, 'genesis'), logs: [] });
  }

  // --- scripting ------------------------------------------------------------

  /** Append a block, optionally carrying logs. Returns its height. */
  addBlock(logs: readonly FakeLog[] = [], salt = 'a'): bigint {
    const height = BigInt(this.blocks.length);
    this.blocks.push({ hash: hashFor(this.chainId, height, salt), logs: [...logs] });
    return height;
  }

  addBlocks(count: number, salt = 'a'): void {
    for (let i = 0; i < count; i += 1) this.addBlock([], salt);
  }

  /**
   * Replace every block from `fromHeight` onward with new ones.
   *
   * The replacements get a different salt, so their hashes differ from what the
   * indexer recorded — which is precisely the signal reorg detection looks for.
   */
  reorg(fromHeight: bigint, replacement: readonly (readonly FakeLog[])[]): void {
    this.blocks.length = Number(fromHeight);
    replacement.forEach((logs, offset) => {
      const height = fromHeight + BigInt(offset);
      this.blocks.push({ hash: hashFor(this.chainId, height, 'reorged'), logs: [...logs] });
    });
  }

  setMarket(market: OnChainMarket): void {
    this.markets.set(market.address.toLowerCase(), market);
  }

  setPosition(address: Address, account: Address, position: OnChainPosition): void {
    this.positions.set(`${address.toLowerCase()}:${account.toLowerCase()}`, position);
  }

  setBalance(token: Address, account: Address, amount: bigint): void {
    this.balances.set(`${token.toLowerCase()}:${account.toLowerCase()}`, amount);
  }

  get head(): bigint {
    return BigInt(this.blocks.length - 1);
  }

  // --- ChainClient ----------------------------------------------------------

  assertChainId(): Promise<void> {
    return Promise.resolve();
  }

  getBlockNumber(): Promise<bigint> {
    return Promise.resolve(this.head);
  }

  getSafeBlockNumber(): Promise<bigint> {
    const lag = BigInt(this.confirmations);
    return Promise.resolve(this.head > lag ? this.head - lag : 0n);
  }

  getBlockHash(blockNumber: bigint): Promise<Hex | null> {
    const block = this.blocks[Number(blockNumber)];
    return Promise.resolve(block?.hash ?? null);
  }

  getFactoryLogs(fromBlock: bigint, toBlock: bigint): Promise<readonly DecodedMarketEvent[]> {
    this.logRequests.push({ from: fromBlock, to: toBlock });
    return Promise.resolve(this.collect(fromBlock, toBlock, (log) => log.name === 'MarketCreated'));
  }

  getMarketLogs(
    addresses: readonly Address[],
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<readonly DecodedMarketEvent[]> {
    const set = new Set(addresses.map((a) => a.toLowerCase()));
    return Promise.resolve(
      this.collect(
        fromBlock,
        toBlock,
        (log) => log.name !== 'MarketCreated' && set.has(log.address.toLowerCase()),
      ),
    );
  }

  private collect(
    fromBlock: bigint,
    toBlock: bigint,
    predicate: (log: FakeLog) => boolean,
  ): DecodedMarketEvent[] {
    const out: DecodedMarketEvent[] = [];
    for (let height = fromBlock; height <= toBlock; height += 1n) {
      const block = this.blocks[Number(height)];
      if (block === undefined) continue;
      for (const log of block.logs) {
        if (!predicate(log)) continue;
        out.push({
          name: log.name,
          address: log.address,
          marketId: log.marketId,
          args: log.args,
          identity: {
            chainId: this.chainId,
            transactionHash: log.transactionHash,
            logIndex: log.logIndex,
            blockNumber: height,
            blockHash: block.hash,
          },
        });
      }
    }
    return out;
  }

  readMarket(address: Address): Promise<OnChainMarket> {
    const market = this.markets.get(address.toLowerCase());
    if (market === undefined) {
      return Promise.reject(new Error(`no scripted market at ${address}`));
    }
    return Promise.resolve(market);
  }

  readPosition(address: Address, account: Address): Promise<OnChainPosition> {
    return Promise.resolve(
      this.positions.get(`${address.toLowerCase()}:${account.toLowerCase()}`) ?? {
        yes: 0n,
        no: 0n,
        hasClaimed: false,
        previewClaim: 0n,
      },
    );
  }

  readTokenBalance(token: Address, account: Address): Promise<bigint> {
    return Promise.resolve(this.balances.get(`${token.toLowerCase()}:${account.toLowerCase()}`) ?? 0n);
  }

  findMarketByRulesHash(rulesHash: Hex): Promise<Address | null> {
    for (const market of this.markets.values()) {
      if (market.rulesHash.toLowerCase() === rulesHash.toLowerCase()) {
        return Promise.resolve(market.address);
      }
    }
    return Promise.resolve(null);
  }

  getTransaction(): Promise<TransactionOutcome | null> {
    return Promise.resolve(null);
  }

  /**
   * What `waitForTransaction` reports.
   *
   * Scriptable because a **mined revert** is the case that matters most: the
   * node accepted the transaction, it was included, and the effect did not
   * happen. Any code that treats "mined" as "worked" is wrong, and this is how a
   * test proves it does not.
   */
  transactionStatus: TransactionOutcome['status'] = 'CONFIRMED';

  waitForTransaction(hash: Hex): Promise<TransactionOutcome> {
    return Promise.resolve({
      status: this.transactionStatus,
      transactionHash: hash,
      blockNumber: this.head,
      blockHash: this.blocks[Number(this.head)]?.hash ?? null,
      gasUsed: 21_000n,
      confirmations: this.confirmations,
      reason: this.transactionStatus === 'FAILED' ? 'The transaction was mined but reverted.' : null,
    });
  }
}

/** A market as the contract would report it, with sensible defaults. */
export function fakeMarket(overrides: Partial<OnChainMarket> = {}): OnChainMarket {
  return {
    address: '0x00000000000000000000000000000000000000a1',
    marketId: 1n,
    rulesHash: `0x${'ab'.repeat(32)}` as Hex,
    creator: '0x1111111111111111111111111111111111111111',
    token: '0x000000000000000000000000000000000000dead',
    factory: '0x00000000000000000000000000000000000fac70',
    tradingEndsAt: 1_800_000_000,
    conditionDeadline: 1_800_003_600,
    challengeWindow: 60,
    resolutionWindow: 3_600,
    challengeBond: 25_000_000n,
    state: 'OPEN',
    proposedOutcome: 'UNSET',
    finalOutcome: 'UNSET',
    cancellationReason: 'NONE',
    proposalRound: 0,
    refundMode: false,
    proposedAt: 0,
    challengedAt: 0,
    finalizedAt: 0,
    challengeEndsAt: 0,
    resolutionDeadline: 1_800_007_200,
    reviewDeadline: 0,
    evidenceHash: `0x${'00'.repeat(32)}` as Hex,
    challenger: '0x0000000000000000000000000000000000000000',
    challengeReasonHash: `0x${'00'.repeat(32)}` as Hex,
    challengedOutcome: 'UNSET',
    bondOutstanding: false,
    bondRefundable: false,
    totalYes: 0n,
    totalNo: 0n,
    forfeitedBond: 0n,
    remainingClaimableStake: 0n,
    pool: 0n,
    ...overrides,
  };
}

/**
 * A scripted `ResolverChainWriter`.
 *
 * Records every call instead of sending one, so a test can assert **that no
 * transaction was attempted** — which is the assertion that matters for every
 * review, refusal and dry run. A writer that silently succeeded would make those
 * tests pass for the wrong reason.
 *
 * `onPropose` lets a test advance the fake market's state the way a real
 * proposal would, so the pipeline can be driven through a full challenge round.
 */
export class FakeResolverWriter implements ResolverChainWriter {
  readonly resolverAddress: Address = '0x00000000000000000000000000000000000re5o1' as Address;

  readonly proposals: {
    market: Address;
    outcome: string;
    evidenceHash: Hex;
  }[] = [];
  readonly finalizations: Address[] = [];

  /** Set to throw, so the "the node refused the transaction" path is reachable. */
  failWith: Error | null = null;

  constructor(
    private readonly hooks: {
      onPropose?: (market: Address, outcome: string, evidenceHash: Hex) => void;
      onFinalize?: (market: Address) => void;
    } = {},
  ) {}

  proposeResolution(input: {
    market: Address;
    outcome: 'YES' | 'NO' | 'INVALID';
    evidenceHash: Hex;
  }): Promise<Hex> {
    if (this.failWith !== null) return Promise.reject(this.failWith);
    this.proposals.push({
      market: input.market,
      outcome: input.outcome,
      evidenceHash: input.evidenceHash,
    });
    this.hooks.onPropose?.(input.market, input.outcome, input.evidenceHash);
    return Promise.resolve(`0x${(this.proposals.length + 0xaa).toString(16).padStart(64, 'b')}` as Hex);
  }

  finalize(market: Address): Promise<Hex> {
    if (this.failWith !== null) return Promise.reject(this.failWith);
    this.finalizations.push(market);
    this.hooks.onFinalize?.(market);
    return Promise.resolve(
      `0x${(this.finalizations.length + 0xff).toString(16).padStart(64, 'c')}` as Hex,
    );
  }
}

/** A silent logger, so a passing test prints nothing. */
export const silentLogger = {
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};
