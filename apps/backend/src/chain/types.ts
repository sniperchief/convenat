/**
 * The chain vocabulary the rest of the backend is allowed to know.
 *
 * Everything below is plain data. No viem type crosses this boundary, which is
 * what keeps the indexer, the routes and the reconciler independent of the
 * client library — and what makes the whole chain layer substitutable in a test
 * without a network.
 *
 * Numbers that are money or block heights are `bigint`, never `number`. A
 * uint256 of token base units does not fit in a double, and a silently truncated
 * balance is the kind of defect that only shows up once real amounts are
 * involved.
 */

export type Hex = `0x${string}`;
export type Address = `0x${string}`;

/**
 * Market lifecycle position, mirroring `MarketTypes.State`.
 *
 * Decoded by ordinal, which is why `MarketTypes` documents reordering as a
 * breaking protocol change rather than a refactor. The order here must match
 * the Solidity enum exactly; `chain/enums.ts` holds the single conversion.
 */
export type OnChainState =
  | 'OPEN'
  | 'CLOSED'
  | 'RESOLUTION_PROPOSED'
  | 'CHALLENGED'
  | 'FINALIZED'
  | 'SETTLED'
  | 'CANCELLED';

export type OnChainOutcome = 'UNSET' | 'YES' | 'NO' | 'INVALID';

export type OnChainCancellationReason =
  | 'NONE'
  | 'NO_RESOLUTION'
  | 'NO_REVIEW'
  | 'RESOLVED_INVALID';

/**
 * A market as the contract itself reports it.
 *
 * This is the authoritative record. The database holds an indexed *view* of it;
 * where the two disagree, this one is right and the reconciler says so.
 */
export interface OnChainMarket {
  readonly address: Address;
  readonly marketId: bigint;
  readonly rulesHash: Hex;
  readonly creator: Address;
  readonly token: Address;
  readonly factory: Address;

  readonly tradingEndsAt: number;
  readonly conditionDeadline: number;
  readonly challengeWindow: number;
  readonly resolutionWindow: number;
  readonly challengeBond: bigint;

  readonly state: OnChainState;
  readonly proposedOutcome: OnChainOutcome;
  readonly finalOutcome: OnChainOutcome;
  readonly cancellationReason: OnChainCancellationReason;
  readonly proposalRound: number;
  readonly refundMode: boolean;

  readonly proposedAt: number;
  readonly challengedAt: number;
  readonly finalizedAt: number;
  readonly challengeEndsAt: number;
  readonly resolutionDeadline: number;
  readonly reviewDeadline: number;

  readonly evidenceHash: Hex;
  readonly challenger: Address;
  /**
   * keccak256 of the challenger's off-chain argument.
   *
   * Read so the backend can verify that a challenge document offered to it is
   * the one the challenger actually committed. Without it, anyone could attach
   * any text to someone else's challenge.
   */
  readonly challengeReasonHash: Hex;
  readonly challengedOutcome: OnChainOutcome;
  readonly bondOutstanding: boolean;
  readonly bondRefundable: boolean;

  readonly totalYes: bigint;
  readonly totalNo: bigint;
  readonly forfeitedBond: bigint;
  readonly remainingClaimableStake: bigint;
  readonly pool: bigint;
}

/** A participant's position in one market, read from the contract. */
export interface OnChainPosition {
  readonly yes: bigint;
  readonly no: bigint;
  readonly hasClaimed: boolean;
  readonly previewClaim: bigint;
}

// --- logs -------------------------------------------------------------------

/**
 * The identity of an event occurrence.
 *
 * `chainId + transactionHash + logIndex` is the natural key, and it is what the
 * indexer's uniqueness constraint is built on (§18). A timestamp is not part of
 * identity: two events in the same block share one, and a block's timestamp is
 * proposer-influenced.
 *
 * `blockHash` is carried alongside because reorg detection needs to compare the
 * hash we recorded against the hash the chain now reports for that height —
 * height alone cannot tell you the block changed underneath you.
 */
export interface LogIdentity {
  readonly chainId: number;
  readonly transactionHash: Hex;
  readonly logIndex: number;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
}

export type MarketEventName =
  | 'MarketCreated'
  | 'StakePlaced'
  | 'MarketClosed'
  | 'ResolutionProposed'
  | 'ResolutionChallenged'
  | 'MarketFinalized'
  | 'MarketCancelled'
  | 'WinningsClaimed'
  | 'RefundWithdrawn'
  | 'ChallengeBondReturned'
  | 'MarketSettled';

/**
 * A decoded market event.
 *
 * `args` is kept as a JSON-safe record rather than a per-event union: it is
 * persisted whole so an event can be re-read years later without the reader
 * needing this build's types, and bigints are serialised as decimal strings for
 * the same reason. Callers that need a specific field narrow on `name` and read
 * it from `args`.
 */
export interface DecodedMarketEvent {
  readonly name: MarketEventName;
  readonly address: Address;
  readonly identity: LogIdentity;
  /** Contract-assigned market id, when the event carries one. */
  readonly marketId: bigint | null;
  readonly args: Readonly<Record<string, string | number | boolean>>;
}

// --- transactions -----------------------------------------------------------

/**
 * Where a transaction has got to.
 *
 * A hash is not an outcome (§16). `SUBMITTED` means the node accepted the
 * transaction and nothing more — it may still be replaced, dropped, or revert.
 * Only `CONFIRMED` means the effect happened and has the configured depth of
 * blocks behind it, and only then may the backend report the effect as real.
 */
export type TransactionStatus = 'SUBMITTED' | 'CONFIRMED' | 'FAILED';

export interface TransactionOutcome {
  readonly status: TransactionStatus;
  readonly transactionHash: Hex;
  readonly blockNumber: bigint | null;
  readonly blockHash: Hex | null;
  readonly gasUsed: bigint | null;
  readonly confirmations: number;
  /** Populated when the transaction reverted, for the log. Never a raw payload. */
  readonly reason: string | null;
}

// --- the port ---------------------------------------------------------------

/**
 * The backend's one route to a blockchain.
 *
 * Every RPC call the backend makes goes through an implementation of this
 * interface. Route handlers, the indexer and the reconciler depend on it and on
 * nothing lower — there is no viem import outside `chain/`, and a test can
 * supply a scripted implementation without a network.
 */
export interface ChainClient {
  readonly chainId: number;
  /** Blocks behind head that this client treats as safe to read (§19). */
  readonly confirmations: number;

  /**
   * Confirm the endpoint really serves the configured chain (§15).
   *
   * @throws {ChainMismatchError} when the node reports a different chain id.
   */
  assertChainId(): Promise<void>;

  getBlockNumber(): Promise<bigint>;
  /** `latest - confirmations`, floored at zero. The indexer's ceiling. */
  getSafeBlockNumber(): Promise<bigint>;
  /** Null when the height is beyond the node's head or has been pruned. */
  getBlockHash(blockNumber: bigint): Promise<Hex | null>;

  /** Factory `MarketCreated` logs in `[fromBlock, toBlock]`, inclusive. */
  getFactoryLogs(fromBlock: bigint, toBlock: bigint): Promise<readonly DecodedMarketEvent[]>;
  /** Market logs from the given clone addresses in `[fromBlock, toBlock]`. */
  getMarketLogs(
    addresses: readonly Address[],
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<readonly DecodedMarketEvent[]>;

  readMarket(address: Address): Promise<OnChainMarket>;
  readPosition(address: Address, account: Address): Promise<OnChainPosition>;
  readTokenBalance(token: Address, account: Address): Promise<bigint>;
  /** The clone address the factory recorded for a rules hash, or null. */
  findMarketByRulesHash(rulesHash: Hex): Promise<Address | null>;

  getTransaction(hash: Hex): Promise<TransactionOutcome | null>;
  /** Poll until confirmed, failed, or `timeoutMs` elapses. */
  waitForTransaction(hash: Hex, timeoutMs?: number): Promise<TransactionOutcome>;
}

// --- the write port ---------------------------------------------------------

/**
 * The two transactions this backend is ever allowed to send.
 *
 * Deliberately a separate, tiny interface rather than methods on `ChainClient`:
 * a component that only reads should not be handed an object that can sign, and
 * separating them makes "who can transact" a question answered by looking at
 * which type a constructor asks for.
 *
 * **What is not here matters more than what is.** There is no `stake`, no
 * `claim`, no `withdrawRefund`, no `challenge`, no token `transfer` or
 * `approve`, and no factory call. The resolver key cannot reach a fund-moving
 * function through this interface because no such method exists on it, and the
 * ABI the implementation is built from declares no such function either.
 *
 * - `proposeResolution` records an outcome and an evidence commitment. It moves
 *   no money and names no recipient; the contract's own `NotProposer` check is
 *   what authorises it.
 * - `finalize` is **permissionless on the contract** — anyone may call it once
 *   the challenge window has closed, and it takes no arguments, so calling it
 *   cannot express a preference about the result. The backend performing it is
 *   a convenience for liveness, not an authority.
 */
export interface ResolverChainWriter {
  /** The address the resolver key controls. Server-side identity, never client input. */
  readonly resolverAddress: Address;

  /**
   * Submit a proposal.
   *
   * @returns the transaction hash only. A hash is not an outcome (§16) — the
   *   caller must wait for confirmation through `ChainClient.waitForTransaction`
   *   before treating the proposal as real.
   */
  proposeResolution(input: {
    readonly market: Address;
    readonly outcome: Exclude<OnChainOutcome, 'UNSET'>;
    readonly evidenceHash: Hex;
  }): Promise<Hex>;

  /** Call `finalize()`. Reverts on-chain if the window has not closed. */
  finalize(market: Address): Promise<Hex>;
}
