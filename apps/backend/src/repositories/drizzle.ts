/**
 * PostgreSQL repositories.
 *
 * The only module that issues SQL. Every method wraps its query so a driver
 * error becomes a `RepositoryError` — a connection string, a failing statement,
 * or a constraint name must never travel out of this file and into an HTTP
 * response.
 *
 * These are not exercised by the unit suite, which runs against the in-memory
 * implementations. That is a deliberate trade: unit tests stay fast and
 * dependency-free, and this layer is covered by integration tests against a
 * real PostgreSQL when one is available (Milestone 4, alongside the indexer).
 * The gap is stated in BUILD_STATE rather than hidden behind a mock that would
 * only prove Drizzle's own API to itself.
 */

import { and, asc, desc, eq, gte, isNotNull, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { ConditionSpec, EvidencePackage, MarketStatus, Outcome, ResolutionStatus } from '@covenant/shared';

import { RepositoryError } from '../errors.js';
import * as schema from '../db/schema.js';
import type {
  AuthNonceRecord,
  AuthNonceRepository,
  AuthSessionRecord,
  AuthSessionRepository,
  CompilationRecord,
  CompilationRepository,
  CompilerSessionRecord,
  CompilerSessionRepository,
  CompilerTurnRecord,
  EvidenceRecord,
  EvidenceRepository,
  IndexerCheckpointRecord,
  IndexerCheckpointRepository,
  ListMarketsFilter,
  MarketChainStateRecord,
  MarketChainStateRepository,
  MarketEventRecord,
  MarketEventRepository,
  MarketPage,
  MarketRecord,
  MarketRepository,
  Repositories,
  ResolutionRecord,
  ResolutionRepository,
  WalletRecord,
  WalletRepository,
} from './types.js';

export type Database = NodePgDatabase<typeof schema>;

/**
 * Run a query, converting any failure into a `RepositoryError`.
 *
 * The original is attached to `cause` for server-side logging and dropped from
 * the client-facing projection.
 */
async function guard<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    const error = new RepositoryError(`The datastore could not complete ${operation}.`);
    (error as { cause?: unknown }).cause = cause;
    throw error;
  }
}

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

class DrizzleWalletRepository implements WalletRepository {
  constructor(private readonly db: Database) {}

  async touch(address: string, seenAt: Date): Promise<WalletRecord> {
    const key = address.toLowerCase();
    return guard('a wallet upsert', async () => {
      const [row] = await this.db
        .insert(schema.wallets)
        .values({ address: key, firstSeenAt: seenAt })
        .onConflictDoUpdate({
          target: schema.wallets.address,
          // A no-op update so the insert always returns the row, whether it
          // was created now or already existed.
          set: { address: key },
        })
        .returning();
      if (row === undefined) throw new Error('wallet upsert returned no row');
      return { address: row.address, firstSeenAt: iso(row.firstSeenAt) };
    });
  }
}

class DrizzleCompilerSessionRepository implements CompilerSessionRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    creator: string;
    chainId: number;
    compilerVersion: string;
    createdAt: Date;
  }): Promise<CompilerSessionRecord> {
    return guard('a compiler session insert', async () => {
      const [row] = await this.db
        .insert(schema.compilerSessions)
        .values({
          creator: input.creator.toLowerCase(),
          chainId: input.chainId,
          compilerVersion: input.compilerVersion,
          status: 'OPEN',
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        })
        .returning();
      if (row === undefined) throw new Error('session insert returned no row');
      return toSessionRecord(row);
    });
  }

  async findById(id: string): Promise<CompilerSessionRecord | null> {
    return guard('a compiler session lookup', async () => {
      const rows = await this.db
        .select()
        .from(schema.compilerSessions)
        .where(eq(schema.compilerSessions.id, id))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : toSessionRecord(row);
    });
  }

  async listTurns(sessionId: string): Promise<readonly CompilerTurnRecord[]> {
    return guard('a compiler turn listing', async () => {
      const rows = await this.db
        .select()
        .from(schema.compilerTurns)
        .where(eq(schema.compilerTurns.sessionId, sessionId))
        .orderBy(asc(schema.compilerTurns.createdAt));
      return rows.map(toTurnRecord);
    });
  }

  async appendTurn(input: {
    sessionId: string;
    role: 'user' | 'assistant';
    content: string;
    createdAt: Date;
  }): Promise<CompilerTurnRecord> {
    return guard('a compiler turn insert', async () => {
      const [row] = await this.db
        .insert(schema.compilerTurns)
        .values({
          sessionId: input.sessionId,
          role: input.role,
          content: input.content,
          createdAt: input.createdAt,
        })
        .returning();
      if (row === undefined) throw new Error('turn insert returned no row');
      return toTurnRecord(row);
    });
  }

  async markCompiled(sessionId: string, at: Date): Promise<void> {
    await guard('a compiler session update', async () => {
      await this.db
        .update(schema.compilerSessions)
        .set({ status: 'COMPILED', updatedAt: at })
        .where(eq(schema.compilerSessions.id, sessionId));
    });
  }
}

class DrizzleCompilationRepository implements CompilationRepository {
  constructor(private readonly db: Database) {}

  async save(
    record: Omit<CompilationRecord, 'createdAt'> & { createdAt: Date },
  ): Promise<CompilationRecord> {
    return guard('a compilation insert', async () => {
      const [row] = await this.db
        .insert(schema.compilations)
        .values({
          rulesHash: record.rulesHash.toLowerCase(),
          sessionId: record.sessionId,
          creator: record.creator.toLowerCase(),
          chainId: record.chainId,
          specification: record.specification,
          canonical: record.canonical,
          compilerVersion: record.compilerVersion,
          createdAt: record.createdAt,
        })
        // Idempotent: the same specification always hashes to the same key, so
        // recompiling it is not a conflict.
        .onConflictDoNothing({ target: schema.compilations.rulesHash })
        .returning();

      if (row !== undefined) return toCompilationRecord(row);

      const existing = await this.findByRulesHash(record.rulesHash);
      if (existing === null) throw new Error('compilation insert returned no row');
      return existing;
    });
  }

  async findByRulesHash(rulesHash: string): Promise<CompilationRecord | null> {
    return guard('a compilation lookup', async () => {
      const rows = await this.db
        .select()
        .from(schema.compilations)
        .where(eq(schema.compilations.rulesHash, rulesHash.toLowerCase()))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : toCompilationRecord(row);
    });
  }
}

class DrizzleMarketRepository implements MarketRepository {
  constructor(private readonly db: Database) {}

  async register(
    record: Omit<MarketRecord, 'createdAt' | 'updatedAt'> & { at: Date },
  ): Promise<MarketRecord> {
    return guard('a market registration', async () => {
      const [row] = await this.db
        .insert(schema.markets)
        .values({
          rulesHash: record.rulesHash.toLowerCase(),
          chainId: record.chainId,
          chainMarketId: record.chainMarketId === null ? null : BigInt(record.chainMarketId),
          contractAddress: record.contractAddress,
          creator: record.creator.toLowerCase(),
          question: record.question,
          specification: record.specification,
          canonical: record.canonical,
          deadline: new Date(record.deadline),
          tradingEndsAt: new Date(record.tradingEndsAt),
          status: record.status,
          createdAt: record.at,
          updatedAt: record.at,
        })
        .onConflictDoNothing({ target: schema.markets.rulesHash })
        .returning();

      if (row !== undefined) return toMarketRecord(row);

      const existing = await this.findByRulesHash(record.rulesHash);
      if (existing === null) throw new Error('market registration returned no row');
      return existing;
    });
  }

  async findByRulesHash(rulesHash: string): Promise<MarketRecord | null> {
    return guard('a market lookup', async () => {
      const rows = await this.db
        .select()
        .from(schema.markets)
        .where(eq(schema.markets.rulesHash, rulesHash.toLowerCase()))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : toMarketRecord(row);
    });
  }

  async findByChainMarketId(chainId: number, chainMarketId: string): Promise<MarketRecord | null> {
    return guard('a market lookup by chain id', async () => {
      const rows = await this.db
        .select()
        .from(schema.markets)
        .where(
          and(
            eq(schema.markets.chainId, chainId),
            eq(schema.markets.chainMarketId, BigInt(chainMarketId)),
          ),
        )
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : toMarketRecord(row);
    });
  }

  async attachOnChainIdentity(input: {
    rulesHash: string;
    chainId: number;
    chainMarketId: string;
    contractAddress: string;
    at: Date;
  }): Promise<MarketRecord | null> {
    return guard('a market identity update', async () => {
      const [row] = await this.db
        .update(schema.markets)
        .set({
          chainMarketId: BigInt(input.chainMarketId),
          contractAddress: input.contractAddress.toLowerCase(),
          updatedAt: input.at,
        })
        .where(
          and(
            eq(schema.markets.rulesHash, input.rulesHash.toLowerCase()),
            eq(schema.markets.chainId, input.chainId),
          ),
        )
        .returning();
      return row === undefined ? null : toMarketRecord(row);
    });
  }

  async updateStatus(input: {
    rulesHash: string;
    status: MarketStatus;
    at: Date;
  }): Promise<MarketRecord | null> {
    return guard('a market status update', async () => {
      const [row] = await this.db
        .update(schema.markets)
        .set({ status: input.status, updatedAt: input.at })
        .where(eq(schema.markets.rulesHash, input.rulesHash.toLowerCase()))
        .returning();
      return row === undefined ? null : toMarketRecord(row);
    });
  }

  async listOnChainAddresses(chainId: number): Promise<readonly string[]> {
    return guard('an on-chain address listing', async () => {
      const rows = await this.db
        .select({ address: schema.markets.contractAddress })
        .from(schema.markets)
        .where(
          and(eq(schema.markets.chainId, chainId), isNotNull(schema.markets.contractAddress)),
        );
      return rows.flatMap((row) => (row.address === null ? [] : [row.address.toLowerCase()]));
    });
  }

  async list(filter: ListMarketsFilter): Promise<MarketPage> {
    return guard('a market listing', async () => {
      const conditions: SQL[] = [];
      if (filter.chainId !== undefined) conditions.push(eq(schema.markets.chainId, filter.chainId));
      if (filter.status !== undefined) conditions.push(eq(schema.markets.status, filter.status));
      if (filter.creator !== undefined) {
        conditions.push(eq(schema.markets.creator, filter.creator.toLowerCase()));
      }
      // Keyset pagination on the ordering column, so a page boundary stays
      // stable while rows are being inserted.
      if (filter.cursor !== undefined) {
        conditions.push(lt(schema.markets.createdAt, new Date(filter.cursor)));
      }

      const rows = await this.db
        .select()
        .from(schema.markets)
        .where(conditions.length === 0 ? undefined : and(...conditions))
        .orderBy(desc(schema.markets.createdAt))
        .limit(filter.limit + 1);

      const page = rows.slice(0, filter.limit).map(toMarketRecord);
      const hasMore = rows.length > filter.limit;
      const last = page[page.length - 1];
      return {
        markets: page,
        nextCursor: hasMore && last !== undefined ? last.createdAt : null,
      };
    });
  }
}

class DrizzleResolutionRepository implements ResolutionRepository {
  constructor(private readonly db: Database) {}

  async findLatestByRulesHash(rulesHash: string): Promise<ResolutionRecord | null> {
    return guard('a resolution lookup', async () => {
      const rows = await this.db
        .select()
        .from(schema.resolutions)
        .where(eq(schema.resolutions.rulesHash, rulesHash.toLowerCase()))
        .orderBy(desc(schema.resolutions.round), desc(schema.resolutions.createdAt))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : toResolutionRecord(row);
    });
  }
}

class DrizzleEvidenceRepository implements EvidenceRepository {
  constructor(private readonly db: Database) {}

  async findByRulesHash(rulesHash: string): Promise<EvidenceRecord | null> {
    return guard('an evidence lookup', async () => {
      const rows = await this.db
        .select()
        .from(schema.evidence)
        .where(eq(schema.evidence.rulesHash, rulesHash.toLowerCase()))
        .orderBy(desc(schema.evidence.createdAt))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : toEvidenceRecord(row);
    });
  }
}

/**
 * Indexed events.
 *
 * `append` is one multi-row insert with `onConflictDoNothing` against the
 * composite primary key. That is what makes reprocessing a block free: the
 * conflict target *is* the event identity, so a replay inserts nothing and the
 * returned count is zero (§18). Doing this as select-then-insert would leave a
 * race between the two statements that a restart could hit.
 */
class DrizzleMarketEventRepository implements MarketEventRepository {
  constructor(private readonly db: Database) {}

  async append(events: readonly Omit<MarketEventRecord, 'indexedAt'>[], at: Date): Promise<number> {
    if (events.length === 0) return 0;
    return guard('an event insert', async () => {
      const inserted = await this.db
        .insert(schema.marketEvents)
        .values(
          events.map((event) => ({
            chainId: event.chainId,
            transactionHash: event.transactionHash.toLowerCase(),
            logIndex: event.logIndex,
            blockNumber: BigInt(event.blockNumber),
            blockHash: event.blockHash.toLowerCase(),
            contractAddress: event.contractAddress.toLowerCase(),
            eventName: event.eventName,
            chainMarketId: event.chainMarketId === null ? null : BigInt(event.chainMarketId),
            rulesHash: event.rulesHash?.toLowerCase() ?? null,
            args: event.args,
            indexedAt: at,
          })),
        )
        .onConflictDoNothing()
        .returning({ logIndex: schema.marketEvents.logIndex });
      return inserted.length;
    });
  }

  async listByMarket(chainId: number, chainMarketId: string): Promise<readonly MarketEventRecord[]> {
    return guard('an event listing', async () => {
      const rows = await this.db
        .select()
        .from(schema.marketEvents)
        .where(
          and(
            eq(schema.marketEvents.chainId, chainId),
            eq(schema.marketEvents.chainMarketId, BigInt(chainMarketId)),
          ),
        )
        .orderBy(asc(schema.marketEvents.blockNumber), asc(schema.marketEvents.logIndex));
      return rows.map(toEventRecord);
    });
  }

  async listByRulesHash(rulesHash: string): Promise<readonly MarketEventRecord[]> {
    return guard('an event listing by rules hash', async () => {
      const rows = await this.db
        .select()
        .from(schema.marketEvents)
        .where(eq(schema.marketEvents.rulesHash, rulesHash.toLowerCase()))
        .orderBy(asc(schema.marketEvents.blockNumber), asc(schema.marketEvents.logIndex));
      return rows.map(toEventRecord);
    });
  }

  async deleteFromBlock(chainId: number, fromBlock: string): Promise<number> {
    return guard('an event rewind', async () => {
      const removed = await this.db
        .delete(schema.marketEvents)
        .where(
          and(
            eq(schema.marketEvents.chainId, chainId),
            gte(schema.marketEvents.blockNumber, BigInt(fromBlock)),
          ),
        )
        .returning({ logIndex: schema.marketEvents.logIndex });
      return removed.length;
    });
  }

  async countByChain(chainId: number): Promise<number> {
    return guard('an event count', async () => {
      const rows = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.marketEvents)
        .where(eq(schema.marketEvents.chainId, chainId));
      return rows[0]?.count ?? 0;
    });
  }

  async findDuplicateIdentities(chainId: number): Promise<readonly string[]> {
    // The primary key makes this impossible. Asked anyway — the reconciler's
    // job is to check claims, including the schema's.
    return guard('a duplicate-event check', async () => {
      const rows = await this.db
        .select({
          transactionHash: schema.marketEvents.transactionHash,
          logIndex: schema.marketEvents.logIndex,
          count: sql<number>`count(*)::int`,
        })
        .from(schema.marketEvents)
        .where(eq(schema.marketEvents.chainId, chainId))
        .groupBy(schema.marketEvents.transactionHash, schema.marketEvents.logIndex)
        .having(sql`count(*) > 1`);
      return rows.map((row) => `${chainId}:${row.transactionHash}:${row.logIndex}`);
    });
  }
}

class DrizzleIndexerCheckpointRepository implements IndexerCheckpointRepository {
  constructor(private readonly db: Database) {}

  async loadOrCreate(input: {
    chainId: number;
    stream: string;
    startBlock: string;
    at: Date;
  }): Promise<IndexerCheckpointRecord> {
    return guard('an indexer checkpoint load', async () => {
      const existing = await this.db
        .select()
        .from(schema.indexerCheckpoints)
        .where(
          and(
            eq(schema.indexerCheckpoints.chainId, input.chainId),
            eq(schema.indexerCheckpoints.stream, input.stream),
          ),
        )
        .limit(1);

      const found = existing[0];
      if (found !== undefined) return toCheckpointRecord(found);

      const start = BigInt(input.startBlock);
      const [row] = await this.db
        .insert(schema.indexerCheckpoints)
        .values({
          chainId: input.chainId,
          stream: input.stream,
          startBlock: start,
          // One below, so the first pass covers the deployment block itself.
          lastProcessedBlock: start > 0n ? start - 1n : 0n,
          lastProcessedBlockHash: null,
          rewindCount: 0,
          updatedAt: input.at,
        })
        .onConflictDoNothing()
        .returning();

      if (row !== undefined) return toCheckpointRecord(row);

      // Lost an insert race with another indexer process. Re-read.
      const retry = await this.db
        .select()
        .from(schema.indexerCheckpoints)
        .where(
          and(
            eq(schema.indexerCheckpoints.chainId, input.chainId),
            eq(schema.indexerCheckpoints.stream, input.stream),
          ),
        )
        .limit(1);
      const settled = retry[0];
      if (settled === undefined) throw new Error('checkpoint insert returned no row');
      return toCheckpointRecord(settled);
    });
  }

  async save(input: {
    chainId: number;
    stream: string;
    lastProcessedBlock: string;
    lastProcessedBlockHash: string | null;
    at: Date;
  }): Promise<void> {
    await guard('an indexer checkpoint save', async () => {
      await this.db
        .update(schema.indexerCheckpoints)
        .set({
          lastProcessedBlock: BigInt(input.lastProcessedBlock),
          lastProcessedBlockHash: input.lastProcessedBlockHash?.toLowerCase() ?? null,
          updatedAt: input.at,
        })
        .where(
          and(
            eq(schema.indexerCheckpoints.chainId, input.chainId),
            eq(schema.indexerCheckpoints.stream, input.stream),
          ),
        );
    });
  }

  async rewind(input: {
    chainId: number;
    stream: string;
    toBlock: string;
    at: Date;
  }): Promise<IndexerCheckpointRecord> {
    return guard('an indexer rewind', async () => {
      const [row] = await this.db
        .update(schema.indexerCheckpoints)
        .set({
          lastProcessedBlock: BigInt(input.toBlock),
          lastProcessedBlockHash: null,
          rewindCount: sql`${schema.indexerCheckpoints.rewindCount} + 1`,
          updatedAt: input.at,
        })
        .where(
          and(
            eq(schema.indexerCheckpoints.chainId, input.chainId),
            eq(schema.indexerCheckpoints.stream, input.stream),
          ),
        )
        .returning();
      if (row === undefined) throw new Error('rewind matched no checkpoint');
      return toCheckpointRecord(row);
    });
  }

  async recordBlock(input: {
    chainId: number;
    blockNumber: string;
    blockHash: string;
    at: Date;
  }): Promise<void> {
    await guard('a block-hash record', async () => {
      await this.db
        .insert(schema.indexerBlocks)
        .values({
          chainId: input.chainId,
          blockNumber: BigInt(input.blockNumber),
          blockHash: input.blockHash.toLowerCase(),
          observedAt: input.at,
        })
        // A re-scan of the same height after a reorg must overwrite, not keep
        // the stale hash — otherwise the next comparison would re-detect a
        // reorg that has already been handled.
        .onConflictDoUpdate({
          target: [schema.indexerBlocks.chainId, schema.indexerBlocks.blockNumber],
          set: { blockHash: input.blockHash.toLowerCase(), observedAt: input.at },
        });
    });
  }

  async recentBlocks(
    chainId: number,
    fromBlock: string,
  ): Promise<readonly { blockNumber: string; blockHash: string }[]> {
    return guard('a recent-block listing', async () => {
      const rows = await this.db
        .select()
        .from(schema.indexerBlocks)
        .where(
          and(
            eq(schema.indexerBlocks.chainId, chainId),
            gte(schema.indexerBlocks.blockNumber, BigInt(fromBlock)),
          ),
        )
        .orderBy(desc(schema.indexerBlocks.blockNumber));
      return rows.map((row) => ({
        blockNumber: row.blockNumber.toString(),
        blockHash: row.blockHash,
      }));
    });
  }

  async deleteBlocksFrom(chainId: number, fromBlock: string): Promise<number> {
    return guard('a block-hash rewind', async () => {
      const removed = await this.db
        .delete(schema.indexerBlocks)
        .where(
          and(
            eq(schema.indexerBlocks.chainId, chainId),
            gte(schema.indexerBlocks.blockNumber, BigInt(fromBlock)),
          ),
        )
        .returning({ blockNumber: schema.indexerBlocks.blockNumber });
      return removed.length;
    });
  }

  async pruneBlocksBelow(chainId: number, blockNumber: string): Promise<number> {
    return guard('a block-hash prune', async () => {
      const removed = await this.db
        .delete(schema.indexerBlocks)
        .where(
          and(
            eq(schema.indexerBlocks.chainId, chainId),
            lt(schema.indexerBlocks.blockNumber, BigInt(blockNumber)),
          ),
        )
        .returning({ blockNumber: schema.indexerBlocks.blockNumber });
      return removed.length;
    });
  }
}

class DrizzleMarketChainStateRepository implements MarketChainStateRepository {
  constructor(private readonly db: Database) {}

  async upsert(
    record: Omit<MarketChainStateRecord, 'updatedAt'> & { at: Date },
  ): Promise<MarketChainStateRecord> {
    return guard('a chain-state upsert', async () => {
      const values = {
        chainId: record.chainId,
        contractAddress: record.contractAddress.toLowerCase(),
        chainMarketId: BigInt(record.chainMarketId),
        rulesHash: record.rulesHash.toLowerCase(),
        creator: record.creator.toLowerCase(),
        token: record.token.toLowerCase(),
        state: record.state,
        totalYes: record.totalYes,
        totalNo: record.totalNo,
        pool: record.pool,
        challengeBond: record.challengeBond,
        proposedOutcome: record.proposedOutcome,
        finalOutcome: record.finalOutcome,
        cancellationReason: record.cancellationReason,
        proposalRound: record.proposalRound,
        refundMode: record.refundMode,
        tradingEndsAt: BigInt(record.tradingEndsAt),
        conditionDeadline: BigInt(record.conditionDeadline),
        proposedAt: BigInt(record.proposedAt),
        challengedAt: BigInt(record.challengedAt),
        finalizedAt: BigInt(record.finalizedAt),
        challengeEndsAt: BigInt(record.challengeEndsAt),
        evidenceHash: record.evidenceHash.toLowerCase(),
        challenger: record.challenger.toLowerCase(),
        bondOutstanding: record.bondOutstanding,
        lastEventBlock: BigInt(record.lastEventBlock),
        updatedAt: record.at,
      };

      const [row] = await this.db
        .insert(schema.marketChainState)
        .values(values)
        .onConflictDoUpdate({
          target: [schema.marketChainState.chainId, schema.marketChainState.contractAddress],
          set: values,
        })
        .returning();
      if (row === undefined) throw new Error('chain-state upsert returned no row');
      return toChainStateRecord(row);
    });
  }

  async findByAddress(chainId: number, address: string): Promise<MarketChainStateRecord | null> {
    return guard('a chain-state lookup', async () => {
      const rows = await this.db
        .select()
        .from(schema.marketChainState)
        .where(
          and(
            eq(schema.marketChainState.chainId, chainId),
            eq(schema.marketChainState.contractAddress, address.toLowerCase()),
          ),
        )
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : toChainStateRecord(row);
    });
  }

  async findByRulesHash(chainId: number, rulesHash: string): Promise<MarketChainStateRecord | null> {
    return guard('a chain-state lookup by rules hash', async () => {
      const rows = await this.db
        .select()
        .from(schema.marketChainState)
        .where(
          and(
            eq(schema.marketChainState.chainId, chainId),
            eq(schema.marketChainState.rulesHash, rulesHash.toLowerCase()),
          ),
        )
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : toChainStateRecord(row);
    });
  }

  async list(chainId: number): Promise<readonly MarketChainStateRecord[]> {
    return guard('a chain-state listing', async () => {
      const rows = await this.db
        .select()
        .from(schema.marketChainState)
        .where(eq(schema.marketChainState.chainId, chainId));
      return rows.map(toChainStateRecord);
    });
  }

  async deleteByAddress(chainId: number, address: string): Promise<void> {
    await guard('a chain-state delete', async () => {
      await this.db
        .delete(schema.marketChainState)
        .where(
          and(
            eq(schema.marketChainState.chainId, chainId),
            eq(schema.marketChainState.contractAddress, address.toLowerCase()),
          ),
        );
    });
  }
}

class DrizzleAuthNonceRepository implements AuthNonceRepository {
  constructor(private readonly db: Database) {}

  async issue(
    input: Omit<AuthNonceRecord, 'consumedAt' | 'issuedAt' | 'expiresAt'> & {
      issuedAt: Date;
      expiresAt: Date;
    },
  ): Promise<AuthNonceRecord> {
    return guard('a sign-in nonce insert', async () => {
      const [row] = await this.db
        .insert(schema.authNonces)
        .values({
          nonce: input.nonce,
          address: input.address.toLowerCase(),
          chainId: input.chainId,
          domain: input.domain,
          uri: input.uri,
          statement: input.statement,
          issuedAt: input.issuedAt,
          expiresAt: input.expiresAt,
          consumedAt: null,
        })
        .returning();
      if (row === undefined) throw new Error('nonce insert returned no row');
      return toNonceRecord(row);
    });
  }

  /**
   * One conditional UPDATE ... RETURNING.
   *
   * `consumed_at IS NULL` in the WHERE clause is the entire replay defence: the
   * database decides the winner of a race, and the loser gets no row back. A
   * select-then-update would let two concurrent replays of the same signature
   * both observe `null` and both proceed.
   */
  async consume(nonce: string, at: Date): Promise<AuthNonceRecord | null> {
    return guard('a sign-in nonce consume', async () => {
      const [row] = await this.db
        .update(schema.authNonces)
        .set({ consumedAt: at })
        .where(
          and(
            eq(schema.authNonces.nonce, nonce),
            isNull(schema.authNonces.consumedAt),
            sql`${schema.authNonces.expiresAt} > ${at}`,
          ),
        )
        .returning();
      return row === undefined ? null : toNonceRecord(row);
    });
  }

  async deleteExpired(before: Date): Promise<number> {
    return guard('a sign-in nonce prune', async () => {
      const removed = await this.db
        .delete(schema.authNonces)
        .where(sql`${schema.authNonces.expiresAt} <= ${before}`)
        .returning({ nonce: schema.authNonces.nonce });
      return removed.length;
    });
  }
}

class DrizzleAuthSessionRepository implements AuthSessionRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    tokenHash: string;
    address: string;
    chainId: number;
    createdAt: Date;
    expiresAt: Date;
  }): Promise<AuthSessionRecord> {
    return guard('a session insert', async () => {
      const [row] = await this.db
        .insert(schema.authSessions)
        .values({
          tokenHash: input.tokenHash,
          address: input.address.toLowerCase(),
          chainId: input.chainId,
          createdAt: input.createdAt,
          expiresAt: input.expiresAt,
          revokedAt: null,
        })
        .returning();
      if (row === undefined) throw new Error('session insert returned no row');
      return toSessionAuthRecord(row);
    });
  }

  async findByTokenHash(tokenHash: string): Promise<AuthSessionRecord | null> {
    return guard('a session lookup', async () => {
      const rows = await this.db
        .select()
        .from(schema.authSessions)
        .where(eq(schema.authSessions.tokenHash, tokenHash))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : toSessionAuthRecord(row);
    });
  }

  async revoke(id: string, at: Date): Promise<void> {
    await guard('a session revoke', async () => {
      await this.db
        .update(schema.authSessions)
        .set({ revokedAt: at })
        .where(eq(schema.authSessions.id, id));
    });
  }
}

export function createDrizzleRepositories(db: Database): Repositories {
  return {
    wallets: new DrizzleWalletRepository(db),
    sessions: new DrizzleCompilerSessionRepository(db),
    compilations: new DrizzleCompilationRepository(db),
    markets: new DrizzleMarketRepository(db),
    resolutions: new DrizzleResolutionRepository(db),
    evidence: new DrizzleEvidenceRepository(db),
    events: new DrizzleMarketEventRepository(db),
    checkpoints: new DrizzleIndexerCheckpointRepository(db),
    chainState: new DrizzleMarketChainStateRepository(db),
    authNonces: new DrizzleAuthNonceRepository(db),
    authSessions: new DrizzleAuthSessionRepository(db),
  };
}

/** Round-trip check used by the health endpoint. */
export async function pingDatabase(db: Database): Promise<void> {
  await guard('a health check', async () => {
    await db.execute(sql`select 1`);
  });
}

// --- row mapping -----------------------------------------------------------

type SessionRow = typeof schema.compilerSessions.$inferSelect;
type TurnRow = typeof schema.compilerTurns.$inferSelect;
type CompilationRow = typeof schema.compilations.$inferSelect;
type MarketRow = typeof schema.markets.$inferSelect;
type ResolutionRow = typeof schema.resolutions.$inferSelect;
type EvidenceRow = typeof schema.evidence.$inferSelect;
type EventRow = typeof schema.marketEvents.$inferSelect;
type CheckpointRow = typeof schema.indexerCheckpoints.$inferSelect;
type ChainStateRow = typeof schema.marketChainState.$inferSelect;
type NonceRow = typeof schema.authNonces.$inferSelect;
type AuthSessionRow = typeof schema.authSessions.$inferSelect;

function toEventRecord(row: EventRow): MarketEventRecord {
  return {
    chainId: row.chainId,
    transactionHash: row.transactionHash,
    logIndex: row.logIndex,
    blockNumber: row.blockNumber.toString(),
    blockHash: row.blockHash,
    contractAddress: row.contractAddress,
    eventName: row.eventName,
    chainMarketId: row.chainMarketId === null ? null : row.chainMarketId.toString(),
    rulesHash: row.rulesHash,
    args: row.args as Record<string, unknown>,
    indexedAt: iso(row.indexedAt),
  };
}

function toCheckpointRecord(row: CheckpointRow): IndexerCheckpointRecord {
  return {
    chainId: row.chainId,
    stream: row.stream,
    startBlock: row.startBlock.toString(),
    lastProcessedBlock: row.lastProcessedBlock.toString(),
    lastProcessedBlockHash: row.lastProcessedBlockHash,
    rewindCount: row.rewindCount,
    updatedAt: iso(row.updatedAt),
  };
}

function toChainStateRecord(row: ChainStateRow): MarketChainStateRecord {
  return {
    chainId: row.chainId,
    contractAddress: row.contractAddress,
    chainMarketId: row.chainMarketId.toString(),
    rulesHash: row.rulesHash,
    creator: row.creator,
    token: row.token,
    state: row.state,
    // `numeric` arrives as a string, which is exactly how it leaves: a uint256
    // is never converted to a JavaScript number anywhere in this backend.
    totalYes: row.totalYes,
    totalNo: row.totalNo,
    pool: row.pool,
    challengeBond: row.challengeBond,
    proposedOutcome: row.proposedOutcome,
    finalOutcome: row.finalOutcome,
    cancellationReason: row.cancellationReason,
    proposalRound: row.proposalRound,
    refundMode: row.refundMode,
    tradingEndsAt: row.tradingEndsAt.toString(),
    conditionDeadline: row.conditionDeadline.toString(),
    proposedAt: row.proposedAt.toString(),
    challengedAt: row.challengedAt.toString(),
    finalizedAt: row.finalizedAt.toString(),
    challengeEndsAt: row.challengeEndsAt.toString(),
    evidenceHash: row.evidenceHash,
    challenger: row.challenger,
    bondOutstanding: row.bondOutstanding,
    lastEventBlock: row.lastEventBlock.toString(),
    updatedAt: iso(row.updatedAt),
  };
}

function toNonceRecord(row: NonceRow): AuthNonceRecord {
  return {
    nonce: row.nonce,
    address: row.address,
    chainId: row.chainId,
    domain: row.domain,
    uri: row.uri,
    statement: row.statement,
    issuedAt: iso(row.issuedAt),
    expiresAt: iso(row.expiresAt),
    consumedAt: row.consumedAt === null ? null : iso(row.consumedAt),
  };
}

function toSessionAuthRecord(row: AuthSessionRow): AuthSessionRecord {
  return {
    id: row.id,
    tokenHash: row.tokenHash,
    address: row.address,
    chainId: row.chainId,
    createdAt: iso(row.createdAt),
    expiresAt: iso(row.expiresAt),
    revokedAt: row.revokedAt === null ? null : iso(row.revokedAt),
  };
}

function toSessionRecord(row: SessionRow): CompilerSessionRecord {
  return {
    id: row.id,
    creator: row.creator,
    chainId: row.chainId,
    compilerVersion: row.compilerVersion,
    status: row.status === 'COMPILED' ? 'COMPILED' : 'OPEN',
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function toTurnRecord(row: TurnRow): CompilerTurnRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content,
    createdAt: iso(row.createdAt),
  };
}

function toCompilationRecord(row: CompilationRow): CompilationRecord {
  return {
    rulesHash: row.rulesHash as `0x${string}`,
    sessionId: row.sessionId,
    creator: row.creator,
    chainId: row.chainId,
    specification: row.specification as ConditionSpec,
    canonical: row.canonical,
    compilerVersion: row.compilerVersion,
    createdAt: iso(row.createdAt),
  };
}

function toMarketRecord(row: MarketRow): MarketRecord {
  return {
    rulesHash: row.rulesHash as `0x${string}`,
    chainId: row.chainId,
    chainMarketId: row.chainMarketId === null ? null : row.chainMarketId.toString(),
    contractAddress: row.contractAddress,
    creator: row.creator,
    question: row.question,
    specification: row.specification as ConditionSpec,
    canonical: row.canonical,
    deadline: iso(row.deadline),
    tradingEndsAt: iso(row.tradingEndsAt),
    status: row.status as MarketStatus,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function toResolutionRecord(row: ResolutionRow): ResolutionRecord {
  return {
    id: row.id,
    rulesHash: row.rulesHash as `0x${string}`,
    status: row.status as ResolutionStatus,
    outcome: row.outcome === null ? null : (row.outcome as Outcome),
    confidenceBps: row.confidenceBps,
    reason: row.reason,
    evidenceHash: row.evidenceHash === null ? null : (row.evidenceHash as `0x${string}`),
    resolverVersion: row.resolverVersion,
    round: row.round,
    proposedAt: row.proposedAt === null ? null : iso(row.proposedAt),
    finalizedAt: row.finalizedAt === null ? null : iso(row.finalizedAt),
  };
}

function toEvidenceRecord(row: EvidenceRow): EvidenceRecord {
  return {
    id: row.id,
    rulesHash: row.rulesHash as `0x${string}`,
    evidenceHash: row.evidenceHash as `0x${string}`,
    package: row.package as EvidencePackage,
    createdAt: iso(row.createdAt),
  };
}
