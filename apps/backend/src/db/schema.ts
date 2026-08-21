/**
 * Drizzle schema.
 *
 * Scope note: this is the minimum the backend needs today, not the eventual
 * production data model. Positions, stakes and claims are deliberately absent —
 * they are on-chain facts, they arrive via the indexer in Milestone 4, and a
 * table for them now would be an empty invitation to treat the database as the
 * authority for money.
 *
 * What is here is application state: specifications, compiler transcripts, and
 * the indexed view of markets. **The chain remains the source of truth for
 * every financial fact.** No column below records a balance.
 *
 * `rules_hash` is the join key throughout. It is the 66-character `0x` form of
 * a bytes32, stored as text rather than `bytea` so it reads the same in a psql
 * session, an event log, and an explorer.
 *
 * No table stores a private key, an API key, or any credential.
 */

import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** A 0x-prefixed bytes32, lowercase. */
const bytes32 = (name: string) => text(name);
/** A 0x-prefixed 20-byte address, lowercase. */
const address = (name: string) => text(name);
/**
 * A uint256, stored exactly.
 *
 * `numeric(78, 0)` holds every uint256 without loss; `bigint` would silently
 * wrap at 2^63 and a double would lose precision long before that. Drizzle
 * surfaces it as a string, which is also how it leaves this backend — no token
 * amount is ever converted to a JavaScript number.
 */
const uint256 = (name: string) => numeric(name, { precision: 78, scale: 0 });
/** A block height or unix second. Read as bigint, never as a float. */
const blockNumber = (name: string) => bigint(name, { mode: 'bigint' });

export const wallets = pgTable('wallets', {
  address: address('address').primaryKey(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
});

export const compilerSessions = pgTable(
  'compiler_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    creator: address('creator').notNull(),
    chainId: integer('chain_id').notNull(),
    compilerVersion: text('compiler_version').notNull(),
    /** OPEN | COMPILED */
    status: text('status').notNull().default('OPEN'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('compiler_sessions_creator_idx').on(table.creator)],
);

/**
 * The compiler transcript.
 *
 * Stored so a compilation can be explained after the fact: which prompt, which
 * clarifications, which compiler version. `content` holds user prompts, so it
 * is subject to the same "don't log user content by default" posture as the
 * request log — persisting it is a deliberate product decision, not incidental.
 */
export const compilerTurns = pgTable(
  'compiler_turns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => compilerSessions.id, { onDelete: 'cascade' }),
    /** user | assistant */
    role: text('role').notNull(),
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('compiler_turns_session_idx').on(table.sessionId, table.createdAt)],
);

/**
 * A compiled specification, keyed by its rules hash.
 *
 * Separate from `markets` because most compilations never become markets. The
 * hash is the primary key: the same specification always produces the same
 * hash, so re-registering it is idempotent rather than a duplicate.
 */
export const compilations = pgTable('compilations', {
  rulesHash: bytes32('rules_hash').primaryKey(),
  sessionId: uuid('session_id').references(() => compilerSessions.id, { onDelete: 'set null' }),
  creator: address('creator').notNull(),
  chainId: integer('chain_id').notNull(),
  /** The normalised ConditionSpec. The canonical text is what was hashed. */
  specification: jsonb('specification').notNull(),
  canonical: text('canonical').notNull(),
  compilerVersion: text('compiler_version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

/**
 * A market, from approval onward.
 *
 * `chain_market_id` and `contract_address` stay null until the creator's wallet
 * opens the market and the indexer observes `MarketCreated`. The backend never
 * fills them in optimistically — a row claiming an on-chain market that does
 * not exist is worse than a row that admits it is still pending.
 */
export const markets = pgTable(
  'markets',
  {
    rulesHash: bytes32('rules_hash').primaryKey(),
    chainId: integer('chain_id').notNull(),
    chainMarketId: bigint('chain_market_id', { mode: 'bigint' }),
    contractAddress: address('contract_address'),
    creator: address('creator').notNull(),
    question: text('question').notNull(),
    specification: jsonb('specification').notNull(),
    canonical: text('canonical').notNull(),
    /**
     * The deterministic acceptance criteria this market resolves on.
     *
     * **Not inside `rulesHash`, and that is a real weakening**, recorded rather
     * than hidden — see ADR-0017 and the M5.3 note in BUILD_STATE. `ConditionSpec`
     * v1.0 has nowhere to put a numeric threshold, so the plan is supplied
     * alongside the specification instead of inside it. Two constraints bound the
     * damage: a plan may only reference approved sources, and a deadline
     * comparison may only use the specification's own deadline.
     *
     * Null means no plan was supplied. A market with no plan resolves to
     * `NEEDS_REVIEW`, never to a guess.
     */
    validationPlan: jsonb('validation_plan'),
    deadline: timestamp('deadline', { withTimezone: true }).notNull(),
    tradingEndsAt: timestamp('trading_ends_at', { withTimezone: true }).notNull(),
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('markets_chain_market_idx').on(table.chainId, table.chainMarketId),
    index('markets_creator_idx').on(table.creator),
    index('markets_status_idx').on(table.status, table.createdAt),
  ],
);

/**
 * A resolution attempt.
 *
 * Written by the resolution engine. `outcome` is null for a `NEEDS_REVIEW` or
 * `RESOLUTION_FAILED` attempt — the engine declining to guess is recorded as an
 * attempt with no outcome, never as an outcome with low confidence.
 *
 * **Every attempt is recorded, including the ones that proposed nothing.** A
 * table holding only successes cannot answer "why has this market not
 * resolved", which is the question an operator actually has.
 */
export const resolutions = pgTable(
  'resolutions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    rulesHash: bytes32('rules_hash')
      .notNull()
      .references(() => markets.rulesHash, { onDelete: 'cascade' }),
    /** PROPOSED | NEEDS_REVIEW | RESOLUTION_FAILED — the engine's vocabulary. */
    status: text('status').notNull(),
    /** YES | NO | INVALID, or null when there is no outcome. */
    outcome: text('outcome'),
    /** Integer basis points. Audit metadata; it authorises nothing. */
    confidenceBps: integer('confidence_bps').notNull().default(0),
    reason: text('reason').notNull(),
    evidenceHash: bytes32('evidence_hash'),
    resolverVersion: text('resolver_version').notNull(),
    round: integer('round').notNull().default(1),
    proposedAt: timestamp('proposed_at', { withTimezone: true }),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),

    /**
     * The engine's full record: verdict, checks, sources, claims, reasoning,
     * violations.
     *
     * Stored whole so the resolution panel can show *why* an attempt ended where
     * it did without re-running retrieval against sources that may since have
     * changed. For a `PROPOSED` attempt this duplicates what is inside the
     * evidence package; for the others it is the only record there is.
     *
     * **This column is never hashed and never read back into a package.** It is
     * a projection for humans, which is why an extra field appearing here cannot
     * change `evidenceHash`.
     */
    record: jsonb('record'),

    /**
     * The proposal transaction, once one has been sent.
     *
     * Null while a proposal exists off-chain but has not been submitted — a
     * distinction the UI must be able to draw, because an unsubmitted proposal
     * binds nobody.
     */
    proposalTxHash: bytes32('proposal_tx_hash'),
    proposalBlock: blockNumber('proposal_block'),
    /** NOT_SUBMITTED | SUBMITTED | CONFIRMED | FAILED. A hash is not an outcome. */
    submissionState: text('submission_state').notNull().default('NOT_SUBMITTED'),
  },
  (table) => [
    index('resolutions_market_idx').on(table.rulesHash, table.round),
    index('resolutions_created_idx').on(table.rulesHash, table.createdAt),
  ],
);

/**
 * A challenge document, attached to a challenge that already exists on-chain.
 *
 * The backend does not file challenges — a challenge moves the challenger's own
 * bond, so their wallet sends the transaction. This table holds the argument
 * behind the `reasonHash` the contract recorded, and a row is only written once
 * the two have been verified to agree.
 *
 * **Nothing here decides whether a challenge wins.** `finalize()` does that,
 * on-chain, by comparing the replacement outcome against the challenged one.
 */
export const challenges = pgTable(
  'challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    rulesHash: bytes32('rules_hash')
      .notNull()
      .references(() => markets.rulesHash, { onDelete: 'cascade' }),
    challenger: address('challenger').notNull(),
    /** keccak256 of `reason`, verified equal to the contract's stored value. */
    reasonHash: bytes32('reason_hash').notNull(),
    reason: text('reason').notNull(),
    bond: uint256('bond').notNull(),
    txHash: bytes32('tx_hash').notNull(),
    /** The round that was challenged. The contract permits only round 1. */
    round: integer('round').notNull(),
    challengedAt: timestamp('challenged_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('challenges_market_round_idx').on(table.rulesHash, table.round),
    index('challenges_challenger_idx').on(table.challenger),
  ],
);

/**
 * An evidence package, stored whole.
 *
 * The served copy is tamper-evident because `evidence_hash` is committed
 * on-chain: anyone can re-derive it from `package` and compare. Storing the
 * document rather than a summary is what makes that check possible.
 */
export const evidence = pgTable(
  'evidence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    rulesHash: bytes32('rules_hash')
      .notNull()
      .references(() => markets.rulesHash, { onDelete: 'cascade' }),
    evidenceHash: bytes32('evidence_hash').notNull(),
    package: jsonb('package').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('evidence_market_idx').on(table.rulesHash)],
);

/**
 * Indexer cursor.
 *
 * One row per (chain, stream). `lastProcessedBlock` is the highest block whose
 * logs are fully written — not the highest seen — so a crash mid-batch resumes
 * by redoing that batch rather than skipping it. Redoing it is safe because
 * `market_events` is keyed on event identity (§18).
 *
 * `lastProcessedBlockHash` is what makes restart-time reorg detection possible:
 * on startup the indexer re-reads that height and compares. A height alone
 * cannot tell you the block beneath it was replaced.
 */
export const indexerCheckpoints = pgTable(
  'indexer_checkpoints',
  {
    chainId: integer('chain_id').notNull(),
    /** Stream name, e.g. `market-factory`. One indexer may run several. */
    stream: text('stream').notNull(),
    /** Deployment block; where a fresh indexer starts. */
    startBlock: blockNumber('start_block').notNull(),
    lastProcessedBlock: blockNumber('last_processed_block').notNull(),
    lastProcessedBlockHash: bytes32('last_processed_block_hash'),
    /** Incremented whenever a reorg forces a rewind. Operational signal only. */
    rewindCount: integer('rewind_count').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.chainId, table.stream] })],
);

/**
 * Recent block hashes, kept only as far back as the reorg window (§20).
 *
 * The indexer records the hash of every block it processes and, on each pass,
 * re-checks the most recent ones against the chain. A mismatch means those
 * blocks were replaced, and the indexer rewinds to the last height that still
 * agrees. Older rows are pruned: this table is a reorg window, not an archive.
 */
export const indexerBlocks = pgTable(
  'indexer_blocks',
  {
    chainId: integer('chain_id').notNull(),
    blockNumber: blockNumber('block_number').notNull(),
    blockHash: bytes32('block_hash').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.chainId, table.blockNumber] })],
);

/**
 * Indexed contract events.
 *
 * **The primary key is the event's own identity**: `(chain_id,
 * transaction_hash, log_index)` (§18). That is what makes the indexer safe to
 * restart — reprocessing a block re-inserts the same rows, the conflict is
 * ignored, and no duplicate state appears. A surrogate id with a timestamp would
 * have made replay produce two rows for one event, which is precisely the
 * failure mode the requirement names.
 *
 * `args` holds the decoded event, with every uint256 as a decimal string. It is
 * stored whole so an event remains readable without this build's decoder.
 */
export const marketEvents = pgTable(
  'market_events',
  {
    chainId: integer('chain_id').notNull(),
    transactionHash: bytes32('transaction_hash').notNull(),
    logIndex: integer('log_index').notNull(),

    blockNumber: blockNumber('block_number').notNull(),
    blockHash: bytes32('block_hash').notNull(),
    contractAddress: address('contract_address').notNull(),

    eventName: text('event_name').notNull(),
    /** Contract-assigned id, null for events that carry none. */
    chainMarketId: bigint('chain_market_id', { mode: 'bigint' }),
    /** Join key to `markets`. Null until a `MarketCreated` supplies it. */
    rulesHash: bytes32('rules_hash'),
    args: jsonb('args').notNull(),

    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.chainId, table.transactionHash, table.logIndex] }),
    index('market_events_market_idx').on(table.chainId, table.chainMarketId, table.blockNumber),
    index('market_events_rules_hash_idx').on(table.rulesHash),
    // Rewinding a reorg deletes by height, so that lookup gets its own index.
    index('market_events_block_idx').on(table.chainId, table.blockNumber),
  ],
);

/**
 * The indexed view of on-chain market state (§27).
 *
 * Separate from `markets` on purpose. `markets` is application state — what a
 * user approved, what the compiler produced. This table is a *cache of the
 * chain*, and every column in it has an authoritative counterpart in the
 * contract. When the two disagree the contract is right; `reconcile` is what
 * says so out loud.
 *
 * No value here may be used to decide a payout.
 */
export const marketChainState = pgTable(
  'market_chain_state',
  {
    chainId: integer('chain_id').notNull(),
    contractAddress: address('contract_address').notNull(),

    chainMarketId: bigint('chain_market_id', { mode: 'bigint' }).notNull(),
    rulesHash: bytes32('rules_hash').notNull(),
    creator: address('creator').notNull(),
    token: address('token').notNull(),

    state: text('state').notNull(),
    totalYes: uint256('total_yes').notNull(),
    totalNo: uint256('total_no').notNull(),
    pool: uint256('pool').notNull(),
    challengeBond: uint256('challenge_bond').notNull(),

    proposedOutcome: text('proposed_outcome').notNull(),
    finalOutcome: text('final_outcome').notNull(),
    cancellationReason: text('cancellation_reason').notNull(),
    proposalRound: integer('proposal_round').notNull(),
    refundMode: boolean('refund_mode').notNull(),

    tradingEndsAt: blockNumber('trading_ends_at').notNull(),
    conditionDeadline: blockNumber('condition_deadline').notNull(),
    proposedAt: blockNumber('proposed_at').notNull(),
    challengedAt: blockNumber('challenged_at').notNull(),
    finalizedAt: blockNumber('finalized_at').notNull(),
    challengeEndsAt: blockNumber('challenge_ends_at').notNull(),

    evidenceHash: bytes32('evidence_hash').notNull(),
    challenger: address('challenger').notNull(),
    bondOutstanding: boolean('bond_outstanding').notNull(),

    /** Height of the most recent event that produced this row. */
    lastEventBlock: blockNumber('last_event_block').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.chainId, table.contractAddress] }),
    uniqueIndex('market_chain_state_rules_hash_idx').on(table.chainId, table.rulesHash),
    uniqueIndex('market_chain_state_market_id_idx').on(table.chainId, table.chainMarketId),
  ],
);

/**
 * Sign-in nonces (§30).
 *
 * A nonce is issued for one address, used once, and expires. `consumed_at` is
 * what closes the replay window: verification updates the row and the update is
 * conditional on it still being null, so two concurrent requests carrying the
 * same signature cannot both succeed.
 *
 * The full message fields are stored rather than only the nonce. Verification
 * reconstructs the signed message from *these* values, not from what the client
 * sends back, so a client cannot present a signature over a message with a
 * different domain, chain or address than the one we issued.
 */
export const authNonces = pgTable(
  'auth_nonces',
  {
    nonce: text('nonce').primaryKey(),
    address: address('address').notNull(),
    chainId: integer('chain_id').notNull(),
    domain: text('domain').notNull(),
    uri: text('uri').notNull(),
    statement: text('statement').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (table) => [index('auth_nonces_address_idx').on(table.address, table.expiresAt)],
);

/**
 * Authenticated wallet sessions.
 *
 * **`token_hash`, never the token.** The bearer token is returned to the client
 * once and never stored; the database holds only its SHA-256. A dump of this
 * table therefore cannot be used to impersonate anyone, which is the same reason
 * a password table stores hashes.
 */
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull(),
    address: address('address').notNull(),
    chainId: integer('chain_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('auth_sessions_token_idx').on(table.tokenHash),
    index('auth_sessions_address_idx').on(table.address, table.expiresAt),
  ],
);
