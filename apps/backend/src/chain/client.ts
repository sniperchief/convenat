/**
 * The viem-backed `ChainClient`.
 *
 * **The only file in the backend that imports viem.** Everything above it speaks
 * the plain types in `chain/types.ts`, which is what lets the indexer and the
 * routes be tested without a network and what keeps RPC concerns — retries,
 * ranges, decoding, confirmation depth — in one place instead of scattered
 * through handlers (§13).
 *
 * Two rules this file exists to enforce:
 *
 *  1. **A chain id is checked, never assumed.** `assertChainId` is called at
 *     startup and its failure is fatal (§15).
 *  2. **A transaction hash is not a result.** `waitForTransaction` is the only
 *     way to learn that something happened, and it reports `FAILED` for a mined
 *     revert rather than treating "mined" as "worked" (§16).
 */

import {
  createPublicClient,
  decodeEventLog,
  http,
  type Abi,
  type Log,
  type PublicClient,
} from 'viem';

import { ChainDataError, ChainMismatchError, ChainUnavailableError } from '../errors.js';
import { conditionalMarketAbi, erc20ReadAbi, marketFactoryAbi } from './abi.js';
import { toCancellationReason, toMarketState, toOutcome } from './enums.js';
import type {
  Address,
  ChainClient,
  DecodedMarketEvent,
  Hex,
  MarketEventName,
  OnChainMarket,
  OnChainPosition,
  TransactionOutcome,
} from './types.js';

export interface ViemChainClientOptions {
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly factoryAddress: Address;
  readonly confirmations: number;
  /**
   * Largest block span requested in one `eth_getLogs` call.
   *
   * Public endpoints cap this, and the cap is rarely documented. The indexer
   * chunks to this size; if a provider rejects even this, the failure names the
   * range so the operator can lower it rather than guess.
   */
  readonly logRangeLimit?: number;
  readonly requestTimeoutMs?: number;
  /**
   * Multicall3, used to read a whole market in one request instead of ~32.
   *
   * Passed explicitly rather than inherited from a viem chain preset: this
   * client is constructed with no `chain`, because the chain it talks to is
   * whatever the manifest and the chain-id check agree on, not a compile-time
   * constant. Without an address viem raises `client chain not configured.
   * multicallAddress is required.`
   *
   * The default is the canonical CREATE2 deployment, confirmed present on X
   * Layer testnet (3,808 bytes at that address). Override it for a chain where
   * Multicall3 lives elsewhere.
   */
  readonly multicallAddress?: Address;
}

/** Multicall3's canonical cross-chain address. */
const CANONICAL_MULTICALL3: Address = '0xca11bde05977b3631167028862be2a173976ca11';

const DEFAULT_LOG_RANGE = 2_000n;
const DEFAULT_TIMEOUT_MS = 30_000;
const CONFIRMATION_POLL_MS = 2_000;

/** Events emitted by the market clones, i.e. everything except `MarketCreated`. */
const MARKET_EVENT_NAMES = new Set<MarketEventName>([
  'StakePlaced',
  'MarketClosed',
  'ResolutionProposed',
  'ResolutionChallenged',
  'MarketFinalized',
  'MarketCancelled',
  'WinningsClaimed',
  'RefundWithdrawn',
  'ChallengeBondReturned',
  'MarketSettled',
]);

/** Wrap an RPC failure so an endpoint URL cannot reach a client. */
async function rpc<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    const error = new ChainUnavailableError(`The RPC endpoint could not complete ${operation}.`);
    (error as { cause?: unknown }).cause = cause;
    throw error;
  }
}

/** JSON-safe: bigints become decimal strings, addresses and hashes lowercase. */
function plainArg(value: unknown): string | number | boolean {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return value.startsWith('0x') ? value.toLowerCase() : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value);
}

export class ViemChainClient implements ChainClient {
  readonly chainId: number;
  readonly confirmations: number;

  private readonly client: PublicClient;
  private readonly factoryAddress: Address;
  private readonly logRangeLimit: bigint;
  private readonly multicallAddress: Address;

  constructor(options: ViemChainClientOptions) {
    this.chainId = options.chainId;
    this.confirmations = options.confirmations;
    this.factoryAddress = options.factoryAddress.toLowerCase() as Address;
    this.logRangeLimit = BigInt(options.logRangeLimit ?? Number(DEFAULT_LOG_RANGE));
    this.multicallAddress = options.multicallAddress ?? CANONICAL_MULTICALL3;
    this.client = createPublicClient({
      transport: http(options.rpcUrl, {
        timeout: options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
        retryCount: 2,
      }),
    });
  }

  async assertChainId(): Promise<void> {
    const actual = await rpc('eth_chainId', () => this.client.getChainId());
    if (actual !== this.chainId) {
      // Deliberately not recoverable. Continuing would mean reading balances
      // from one chain while believing they came from another.
      throw new ChainMismatchError(
        `The configured RPC endpoint serves chain ${actual}, but this process is configured for ` +
          `chain ${this.chainId}. Refusing to start.`,
        [{ path: 'chainId', message: `node reported ${actual}` }],
      );
    }
  }

  async getBlockNumber(): Promise<bigint> {
    return rpc('eth_blockNumber', () => this.client.getBlockNumber());
  }

  async getSafeBlockNumber(): Promise<bigint> {
    const latest = await this.getBlockNumber();
    const lag = BigInt(this.confirmations);
    return latest > lag ? latest - lag : 0n;
  }

  async getBlockHash(blockNumber: bigint): Promise<Hex | null> {
    try {
      const block = await this.client.getBlock({ blockNumber, includeTransactions: false });
      return block.hash === null ? null : (block.hash.toLowerCase() as Hex);
    } catch {
      // A height past head, or pruned. Distinguishing the two would require a
      // second call and the caller treats both the same way: it cannot check.
      return null;
    }
  }

  async getFactoryLogs(fromBlock: bigint, toBlock: bigint): Promise<readonly DecodedMarketEvent[]> {
    return this.collectLogs([this.factoryAddress], marketFactoryAbi as unknown as Abi, fromBlock, toBlock);
  }

  async getMarketLogs(
    addresses: readonly Address[],
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<readonly DecodedMarketEvent[]> {
    if (addresses.length === 0) return [];
    return this.collectLogs(
      addresses.map((a) => a.toLowerCase() as Address),
      conditionalMarketAbi as unknown as Abi,
      fromBlock,
      toBlock,
    );
  }

  /**
   * Fetch and decode logs over a range, chunked to `logRangeLimit`.
   *
   * Logs are returned in chain order — block, then log index — because the
   * indexer persists a checkpoint after each batch and must never record a
   * height whose earlier logs it has not yet written.
   */
  private async collectLogs(
    addresses: readonly Address[],
    abi: Abi,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<readonly DecodedMarketEvent[]> {
    const collected: DecodedMarketEvent[] = [];

    for (let start = fromBlock; start <= toBlock; start += this.logRangeLimit) {
      const end = start + this.logRangeLimit - 1n > toBlock ? toBlock : start + this.logRangeLimit - 1n;
      const logs = await rpc(`eth_getLogs for blocks ${start}-${end}`, () =>
        this.client.getLogs({ address: [...addresses], fromBlock: start, toBlock: end }),
      );
      for (const log of logs) {
        const decoded = this.decode(log, abi);
        if (decoded !== null) collected.push(decoded);
      }
    }

    collected.sort((a, b) =>
      a.identity.blockNumber === b.identity.blockNumber
        ? a.identity.logIndex - b.identity.logIndex
        : a.identity.blockNumber < b.identity.blockNumber
          ? -1
          : 1,
    );
    return collected;
  }

  /**
   * Decode one log, or null if it is not an event we track.
   *
   * Unknown topics are skipped rather than raised: a contract may emit events
   * this build does not model (an OpenZeppelin `Paused`, say), and refusing to
   * index a block because of one is a liveness bug, not safety.
   */
  private decode(log: Log, abi: Abi): DecodedMarketEvent | null {
    if (
      log.blockNumber === null ||
      log.blockHash === null ||
      log.logIndex === null ||
      log.transactionHash === null
    ) {
      // Pending logs have no position. They are not safe-block logs by
      // definition, so seeing one here means the range was wrong — and a log
      // without a transaction hash has no identity, which would break the
      // uniqueness the indexer depends on.
      throw new ChainDataError('The node returned a pending log inside a confirmed block range.');
    }

    let name: string;
    let args: Record<string, unknown>;
    try {
      const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics });
      // With a runtime `Abi` rather than a literal one, viem cannot promise a
      // name. An unnamed decode is not an event we can route, so it is skipped
      // exactly like an unknown topic.
      if (decoded.eventName === undefined) return null;
      name = decoded.eventName;
      args = (decoded.args ?? {}) as Record<string, unknown>;
    } catch {
      return null;
    }

    if (name !== 'MarketCreated' && !MARKET_EVENT_NAMES.has(name as MarketEventName)) return null;

    const plain: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(args)) {
      if (/^\d+$/.test(key)) continue; // viem duplicates positional keys
      plain[key] = plainArg(value);
    }

    // Enum-valued fields are stored by name as well as ordinal, so a persisted
    // event stays readable without this build's decoder.
    if (typeof args['side'] === 'number') plain['sideName'] = toOutcome(args['side']);
    if (typeof args['outcome'] === 'number') plain['outcomeName'] = toOutcome(args['outcome']);
    if (typeof args['challengedOutcome'] === 'number') {
      plain['challengedOutcomeName'] = toOutcome(args['challengedOutcome']);
    }
    if (name === 'MarketCancelled' && typeof args['reason'] === 'number') {
      plain['reasonName'] = toCancellationReason(args['reason']);
    }

    const marketId = typeof args['marketId'] === 'bigint' ? args['marketId'] : null;

    return {
      name: name as MarketEventName,
      address: log.address.toLowerCase() as Address,
      identity: {
        chainId: this.chainId,
        transactionHash: log.transactionHash.toLowerCase() as Hex,
        logIndex: log.logIndex,
        blockNumber: log.blockNumber,
        blockHash: log.blockHash.toLowerCase() as Hex,
      },
      marketId,
      args: plain,
    };
  }

  async readMarket(address: Address): Promise<OnChainMarket> {
    const names = [
      'marketId', 'rulesHash', 'creator', 'token', 'factory',
      'tradingEndsAt', 'conditionDeadline', 'challengeWindow', 'resolutionWindow', 'challengeBond',
      'state', 'proposedOutcome', 'finalOutcome', 'cancellationReason', 'proposalRound',
      'refundMode', 'proposedAt', 'challengedAt', 'finalizedAt', 'evidenceHash',
      'challenger', 'challengedOutcome', 'bondOutstanding', 'bondRefundable',
      'totalYes', 'totalNo', 'forfeitedBond', 'remainingClaimableStake',
      'challengeEndsAt', 'resolutionDeadline', 'reviewDeadline', 'pool',
    ] as const;

    const results = await rpc(`a market read at ${address}`, () =>
      this.client.multicall({
        multicallAddress: this.multicallAddress,
        contracts: names.map((functionName) => ({
          address,
          abi: conditionalMarketAbi,
          functionName,
        })),
        allowFailure: false,
      }),
    );

    const at = <T>(name: (typeof names)[number]): T => results[names.indexOf(name)] as T;

    return {
      address: address.toLowerCase() as Address,
      marketId: at<bigint>('marketId'),
      rulesHash: at<string>('rulesHash').toLowerCase() as Hex,
      creator: at<string>('creator').toLowerCase() as Address,
      token: at<string>('token').toLowerCase() as Address,
      factory: at<string>('factory').toLowerCase() as Address,
      tradingEndsAt: Number(at<bigint>('tradingEndsAt')),
      conditionDeadline: Number(at<bigint>('conditionDeadline')),
      challengeWindow: Number(at<number>('challengeWindow')),
      resolutionWindow: Number(at<number>('resolutionWindow')),
      challengeBond: at<bigint>('challengeBond'),
      state: toMarketState(Number(at<number>('state'))),
      proposedOutcome: toOutcome(Number(at<number>('proposedOutcome'))),
      finalOutcome: toOutcome(Number(at<number>('finalOutcome'))),
      cancellationReason: toCancellationReason(Number(at<number>('cancellationReason'))),
      proposalRound: Number(at<number>('proposalRound')),
      refundMode: at<boolean>('refundMode'),
      proposedAt: Number(at<bigint>('proposedAt')),
      challengedAt: Number(at<bigint>('challengedAt')),
      finalizedAt: Number(at<bigint>('finalizedAt')),
      challengeEndsAt: Number(at<bigint>('challengeEndsAt')),
      resolutionDeadline: Number(at<bigint>('resolutionDeadline')),
      reviewDeadline: Number(at<bigint>('reviewDeadline')),
      evidenceHash: at<string>('evidenceHash').toLowerCase() as Hex,
      challenger: at<string>('challenger').toLowerCase() as Address,
      challengedOutcome: toOutcome(Number(at<number>('challengedOutcome'))),
      bondOutstanding: at<boolean>('bondOutstanding'),
      bondRefundable: at<boolean>('bondRefundable'),
      totalYes: at<bigint>('totalYes'),
      totalNo: at<bigint>('totalNo'),
      forfeitedBond: at<bigint>('forfeitedBond'),
      remainingClaimableStake: at<bigint>('remainingClaimableStake'),
      pool: at<bigint>('pool'),
    };
  }

  async readPosition(address: Address, account: Address): Promise<OnChainPosition> {
    const [stake, hasClaimed, preview] = await rpc(`a position read at ${address}`, () =>
      this.client.multicall({
        multicallAddress: this.multicallAddress,
        contracts: [
          { address, abi: conditionalMarketAbi, functionName: 'stakeOf', args: [account] },
          { address, abi: conditionalMarketAbi, functionName: 'hasClaimed', args: [account] },
          { address, abi: conditionalMarketAbi, functionName: 'previewClaim', args: [account] },
        ],
        allowFailure: false,
      }),
    );

    const [yes, no] = stake as readonly [bigint, bigint];
    return {
      yes,
      no,
      hasClaimed: hasClaimed as boolean,
      previewClaim: preview as bigint,
    };
  }

  async readTokenBalance(token: Address, account: Address): Promise<bigint> {
    return rpc(`a balance read at ${token}`, () =>
      this.client.readContract({
        address: token,
        abi: erc20ReadAbi,
        functionName: 'balanceOf',
        args: [account],
      }),
    );
  }

  async findMarketByRulesHash(rulesHash: Hex): Promise<Address | null> {
    const found = await rpc('a factory rules-hash lookup', () =>
      this.client.readContract({
        address: this.factoryAddress,
        abi: marketFactoryAbi,
        functionName: 'marketByRulesHash',
        args: [rulesHash],
      }),
    );
    const address = (found as string).toLowerCase();
    return address === '0x0000000000000000000000000000000000000000' ? null : (address as Address);
  }

  async getTransaction(hash: Hex): Promise<TransactionOutcome | null> {
    let receipt;
    try {
      receipt = await this.client.getTransactionReceipt({ hash });
    } catch {
      // No receipt yet. It may be pending, or it may never have existed; the
      // node cannot tell us which, so neither do we.
      return null;
    }

    const head = await this.getBlockNumber();
    const depth = head >= receipt.blockNumber ? Number(head - receipt.blockNumber) : 0;

    // `status: reverted` is a *mined failure*. Reporting it as anything other
    // than FAILED is the specific mistake §16 exists to prevent.
    const succeeded = receipt.status === 'success';
    const confirmed = succeeded && depth >= this.confirmations;

    return {
      status: succeeded ? (confirmed ? 'CONFIRMED' : 'SUBMITTED') : 'FAILED',
      transactionHash: hash.toLowerCase() as Hex,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash.toLowerCase() as Hex,
      gasUsed: receipt.gasUsed,
      confirmations: depth,
      reason: succeeded ? null : 'The transaction was mined but reverted.',
    };
  }

  async waitForTransaction(hash: Hex, timeoutMs = 180_000): Promise<TransactionOutcome> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const outcome = await this.getTransaction(hash);
      if (outcome !== null && outcome.status !== 'SUBMITTED') return outcome;

      if (Date.now() >= deadline) {
        // Not FAILED: we do not know that it failed, only that we stopped
        // waiting. Claiming failure could strand a transaction that lands a
        // second later.
        return (
          outcome ?? {
            status: 'SUBMITTED',
            transactionHash: hash.toLowerCase() as Hex,
            blockNumber: null,
            blockHash: null,
            gasUsed: null,
            confirmations: 0,
            reason: `Not confirmed within ${timeoutMs}ms; still pending as far as this node knows.`,
          }
        );
      }

      await new Promise((resolve) => setTimeout(resolve, CONFIRMATION_POLL_MS));
    }
  }
}
