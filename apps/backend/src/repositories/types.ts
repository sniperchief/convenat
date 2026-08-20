/**
 * Repository interfaces.
 *
 * Route handlers and services depend on these, never on Drizzle. That is what
 * lets the whole test suite run against in-memory implementations with no
 * PostgreSQL, and it keeps SQL failures from leaking into HTTP responses as
 * driver messages.
 *
 * Nothing here is authoritative about money. These records are application
 * state — specifications, compiler transcripts, indexed views. The chain is the
 * source of truth for balances and settlement, and no method below writes one.
 */

import type {
  Bytes32Hex,
  ConditionSpec,
  EvidencePackage,
  MarketStatus,
  Outcome,
  ResolutionStatus,
} from '@covenant/shared';

// --- wallets ---------------------------------------------------------------

export interface WalletRecord {
  readonly address: string;
  readonly firstSeenAt: string;
}

export interface WalletRepository {
  /** Insert on first sight; return the existing record otherwise. */
  touch(address: string, seenAt: Date): Promise<WalletRecord>;
}

// --- compiler sessions -----------------------------------------------------

export interface CompilerSessionRecord {
  readonly id: string;
  readonly creator: string;
  readonly chainId: number;
  readonly compilerVersion: string;
  readonly status: 'OPEN' | 'COMPILED';
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CompilerTurnRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly createdAt: string;
}

export interface CompilerSessionRepository {
  create(input: {
    creator: string;
    chainId: number;
    compilerVersion: string;
    createdAt: Date;
  }): Promise<CompilerSessionRecord>;

  findById(id: string): Promise<CompilerSessionRecord | null>;

  /** Turns for a session, oldest first. */
  listTurns(sessionId: string): Promise<readonly CompilerTurnRecord[]>;

  appendTurn(input: {
    sessionId: string;
    role: 'user' | 'assistant';
    content: string;
    createdAt: Date;
  }): Promise<CompilerTurnRecord>;

  markCompiled(sessionId: string, at: Date): Promise<void>;
}

// --- compiled conditions ---------------------------------------------------

/**
 * A specification the compiler produced, keyed by its `rulesHash`.
 *
 * Distinct from a market: a compilation is a draft that may never be approved.
 * A market record appears only once someone commits to opening one.
 */
export interface CompilationRecord {
  readonly rulesHash: Bytes32Hex;
  readonly sessionId: string | null;
  readonly creator: string;
  readonly chainId: number;
  readonly specification: ConditionSpec;
  readonly canonical: string;
  readonly compilerVersion: string;
  readonly createdAt: string;
}

export interface CompilationRepository {
  save(record: Omit<CompilationRecord, 'createdAt'> & { createdAt: Date }): Promise<CompilationRecord>;
  findByRulesHash(rulesHash: string): Promise<CompilationRecord | null>;
}

// --- markets ---------------------------------------------------------------

/**
 * A market, from approval onward.
 *
 * `chainMarketId` and `contractAddress` are null until the creator's wallet
 * commits the rules on-chain and the indexer observes `MarketCreated`. The
 * backend never fills them in speculatively: a market this record claims exists
 * on-chain, but which does not, would be a lie the UI would repeat.
 */
export interface MarketRecord {
  readonly rulesHash: Bytes32Hex;
  readonly chainId: number;
  readonly chainMarketId: string | null;
  readonly contractAddress: string | null;
  readonly creator: string;
  readonly question: string;
  readonly specification: ConditionSpec;
  readonly canonical: string;
  readonly deadline: string;
  readonly tradingEndsAt: string;
  readonly status: MarketStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ListMarketsFilter {
  readonly chainId?: number;
  readonly status?: MarketStatus;
  readonly creator?: string;
  readonly limit: number;
  readonly cursor?: string;
}

export interface MarketPage {
  readonly markets: readonly MarketRecord[];
  readonly nextCursor: string | null;
}

export interface MarketRepository {
  /** Idempotent on `rulesHash`: registering the same approved spec twice is not an error. */
  register(record: Omit<MarketRecord, 'createdAt' | 'updatedAt'> & { at: Date }): Promise<MarketRecord>;
  findByRulesHash(rulesHash: string): Promise<MarketRecord | null>;
  findByChainMarketId(chainId: number, chainMarketId: string): Promise<MarketRecord | null>;
  list(filter: ListMarketsFilter): Promise<MarketPage>;

  /**
   * Attach the on-chain identity the indexer observed.
   *
   * Called only from a confirmed `MarketCreated` log — never optimistically. A
   * row that claimed an address before the chain assigned one would be a lie the
   * UI repeats, which is why these columns start null.
   *
   * Idempotent: replaying the same log writes the same values.
   */
  attachOnChainIdentity(input: {
    rulesHash: string;
    chainId: number;
    chainMarketId: string;
    contractAddress: string;
    at: Date;
  }): Promise<MarketRecord | null>;

  /** Move a market's indexed status. Returns null when no such market. */
  updateStatus(input: {
    rulesHash: string;
    status: MarketStatus;
    at: Date;
  }): Promise<MarketRecord | null>;

  /** Every market with an on-chain address, for the indexer's log filter. */
  listOnChainAddresses(chainId: number): Promise<readonly string[]>;
}

// --- chain: indexed events -------------------------------------------------

/**
 * A persisted contract event.
 *
 * Identity is `(chainId, transactionHash, logIndex)` (§18). Nothing here is
 * keyed by time, and nothing is keyed by a surrogate id, so replaying a block
 * cannot produce a second row for one event.
 */
export interface MarketEventRecord {
  readonly chainId: number;
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly contractAddress: string;
  readonly eventName: string;
  readonly chainMarketId: string | null;
  readonly rulesHash: string | null;
  readonly args: Readonly<Record<string, unknown>>;
  readonly indexedAt: string;
}

export interface MarketEventRepository {
  /**
   * Insert events, ignoring any already present.
   *
   * @returns how many rows were actually new — the number the indexer logs, and
   *   the number an idempotency test asserts is zero on a second pass.
   */
  append(events: readonly Omit<MarketEventRecord, 'indexedAt'>[], at: Date): Promise<number>;

  listByMarket(chainId: number, chainMarketId: string): Promise<readonly MarketEventRecord[]>;
  listByRulesHash(rulesHash: string): Promise<readonly MarketEventRecord[]>;

  /** Delete every event at or above `fromBlock`. The rewind half of a reorg. */
  deleteFromBlock(chainId: number, fromBlock: string): Promise<number>;

  countByChain(chainId: number): Promise<number>;
  /** Duplicate detection for the reconciler (§28). Empty when healthy. */
  findDuplicateIdentities(chainId: number): Promise<readonly string[]>;
}

// --- chain: indexer checkpoint ---------------------------------------------

export interface IndexerCheckpointRecord {
  readonly chainId: number;
  readonly stream: string;
  readonly startBlock: string;
  readonly lastProcessedBlock: string;
  readonly lastProcessedBlockHash: string | null;
  readonly rewindCount: number;
  readonly updatedAt: string;
}

export interface IndexerCheckpointRepository {
  /** Load, creating it at `startBlock - 1` on first run so nothing is skipped. */
  loadOrCreate(input: {
    chainId: number;
    stream: string;
    startBlock: string;
    at: Date;
  }): Promise<IndexerCheckpointRecord>;

  save(input: {
    chainId: number;
    stream: string;
    lastProcessedBlock: string;
    lastProcessedBlockHash: string | null;
    at: Date;
  }): Promise<void>;

  /** Rewind the cursor and count the rewind. */
  rewind(input: {
    chainId: number;
    stream: string;
    toBlock: string;
    at: Date;
  }): Promise<IndexerCheckpointRecord>;

  recordBlock(input: {
    chainId: number;
    blockNumber: string;
    blockHash: string;
    at: Date;
  }): Promise<void>;

  /** Observed blocks at or above a height, newest first. Reorg comparison input. */
  recentBlocks(chainId: number, fromBlock: string): Promise<
    readonly { blockNumber: string; blockHash: string }[]
  >;

  deleteBlocksFrom(chainId: number, fromBlock: string): Promise<number>;
  /** Drop observations older than the reorg window. Keeps the table bounded. */
  pruneBlocksBelow(chainId: number, blockNumber: string): Promise<number>;
}

// --- chain: indexed market state -------------------------------------------

/**
 * The cached view of a market's on-chain state.
 *
 * Every field mirrors a contract getter. **Nothing here decides a payout.** It
 * exists so a list page does not need thirty RPC round trips, and the
 * reconciler's job is to keep it honest about that.
 */
export interface MarketChainStateRecord {
  readonly chainId: number;
  readonly contractAddress: string;
  readonly chainMarketId: string;
  readonly rulesHash: string;
  readonly creator: string;
  readonly token: string;
  readonly state: string;
  readonly totalYes: string;
  readonly totalNo: string;
  readonly pool: string;
  readonly challengeBond: string;
  readonly proposedOutcome: string;
  readonly finalOutcome: string;
  readonly cancellationReason: string;
  readonly proposalRound: number;
  readonly refundMode: boolean;
  readonly tradingEndsAt: string;
  readonly conditionDeadline: string;
  readonly proposedAt: string;
  readonly challengedAt: string;
  readonly finalizedAt: string;
  readonly challengeEndsAt: string;
  readonly evidenceHash: string;
  readonly challenger: string;
  readonly bondOutstanding: boolean;
  readonly lastEventBlock: string;
  readonly updatedAt: string;
}

export interface MarketChainStateRepository {
  upsert(record: Omit<MarketChainStateRecord, 'updatedAt'> & { at: Date }): Promise<MarketChainStateRecord>;
  findByAddress(chainId: number, address: string): Promise<MarketChainStateRecord | null>;
  findByRulesHash(chainId: number, rulesHash: string): Promise<MarketChainStateRecord | null>;
  list(chainId: number): Promise<readonly MarketChainStateRecord[]>;
  deleteByAddress(chainId: number, address: string): Promise<void>;
}

// --- authentication ---------------------------------------------------------

export interface AuthNonceRecord {
  readonly nonce: string;
  readonly address: string;
  readonly chainId: number;
  readonly domain: string;
  readonly uri: string;
  readonly statement: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
}

export interface AuthNonceRepository {
  issue(input: Omit<AuthNonceRecord, 'consumedAt' | 'issuedAt' | 'expiresAt'> & {
    issuedAt: Date;
    expiresAt: Date;
  }): Promise<AuthNonceRecord>;

  /**
   * Atomically mark a nonce used and return it.
   *
   * **Must be a single conditional statement**, not read-then-write: the update
   * has to fail for the second caller, or two concurrent replays of one
   * signature both succeed. Returns null when the nonce is unknown, already
   * consumed, or expired — the caller cannot tell which, deliberately.
   */
  consume(nonce: string, at: Date): Promise<AuthNonceRecord | null>;

  /** Housekeeping. Expired nonces are unusable regardless; this bounds the table. */
  deleteExpired(before: Date): Promise<number>;
}

export interface AuthSessionRecord {
  readonly id: string;
  readonly tokenHash: string;
  readonly address: string;
  readonly chainId: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

export interface AuthSessionRepository {
  create(input: {
    tokenHash: string;
    address: string;
    chainId: number;
    createdAt: Date;
    expiresAt: Date;
  }): Promise<AuthSessionRecord>;

  /** Lookup by digest. A plaintext token never reaches a query. */
  findByTokenHash(tokenHash: string): Promise<AuthSessionRecord | null>;
  revoke(id: string, at: Date): Promise<void>;
}

// --- resolutions -----------------------------------------------------------

export interface ResolutionRecord {
  readonly id: string;
  readonly rulesHash: Bytes32Hex;
  readonly status: ResolutionStatus;
  readonly outcome: Outcome | null;
  readonly confidenceBps: number;
  readonly reason: string;
  readonly evidenceHash: Bytes32Hex | null;
  readonly resolverVersion: string;
  readonly round: number;
  readonly proposedAt: string | null;
  readonly finalizedAt: string | null;
}

export interface ResolutionRepository {
  findLatestByRulesHash(rulesHash: string): Promise<ResolutionRecord | null>;
}

// --- evidence --------------------------------------------------------------

export interface EvidenceRecord {
  readonly id: string;
  readonly rulesHash: Bytes32Hex;
  readonly evidenceHash: Bytes32Hex;
  readonly package: EvidencePackage;
  readonly createdAt: string;
}

export interface EvidenceRepository {
  findByRulesHash(rulesHash: string): Promise<EvidenceRecord | null>;
}

// --- aggregate -------------------------------------------------------------

export interface Repositories {
  readonly wallets: WalletRepository;
  readonly sessions: CompilerSessionRepository;
  readonly compilations: CompilationRepository;
  readonly markets: MarketRepository;
  readonly resolutions: ResolutionRepository;
  readonly evidence: EvidenceRepository;
  readonly events: MarketEventRepository;
  readonly checkpoints: IndexerCheckpointRepository;
  readonly chainState: MarketChainStateRepository;
  readonly authNonces: AuthNonceRepository;
  readonly authSessions: AuthSessionRepository;
}
