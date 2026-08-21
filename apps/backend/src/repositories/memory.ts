/**
 * In-memory repositories.
 *
 * The substitute that makes `npm test` require no PostgreSQL. They implement
 * the same interfaces as the Drizzle versions, so a route tested against these
 * exercises the same code path it will in production — everything above the
 * repository boundary is identical.
 *
 * `failing()` produces a set that rejects every call, so the "database is down"
 * branch can be tested without arranging an actual outage.
 */

import { randomUUID } from 'node:crypto';

import type { MarketStatus } from '@covenant/shared';

import { RepositoryError } from '../errors.js';
import type {
  AuthNonceRecord,
  AuthNonceRepository,
  AuthSessionRecord,
  AuthSessionRepository,
  ChallengeDocumentRecord,
  ChallengeRepository,
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

const iso = (date: Date): string => date.toISOString();

class InMemoryWalletRepository implements WalletRepository {
  private readonly rows = new Map<string, WalletRecord>();

  touch(address: string, seenAt: Date): Promise<WalletRecord> {
    const key = address.toLowerCase();
    const existing = this.rows.get(key);
    if (existing !== undefined) return Promise.resolve(existing);
    const record: WalletRecord = { address: key, firstSeenAt: iso(seenAt) };
    this.rows.set(key, record);
    return Promise.resolve(record);
  }
}

class InMemoryCompilerSessionRepository implements CompilerSessionRepository {
  private readonly sessions = new Map<string, CompilerSessionRecord>();
  private readonly turns = new Map<string, CompilerTurnRecord[]>();

  create(input: {
    creator: string;
    chainId: number;
    compilerVersion: string;
    createdAt: Date;
  }): Promise<CompilerSessionRecord> {
    const record: CompilerSessionRecord = {
      id: randomUUID(),
      creator: input.creator.toLowerCase(),
      chainId: input.chainId,
      compilerVersion: input.compilerVersion,
      status: 'OPEN',
      createdAt: iso(input.createdAt),
      updatedAt: iso(input.createdAt),
    };
    this.sessions.set(record.id, record);
    this.turns.set(record.id, []);
    return Promise.resolve(record);
  }

  findById(id: string): Promise<CompilerSessionRecord | null> {
    return Promise.resolve(this.sessions.get(id) ?? null);
  }

  listTurns(sessionId: string): Promise<readonly CompilerTurnRecord[]> {
    return Promise.resolve([...(this.turns.get(sessionId) ?? [])]);
  }

  appendTurn(input: {
    sessionId: string;
    role: 'user' | 'assistant';
    content: string;
    createdAt: Date;
  }): Promise<CompilerTurnRecord> {
    const record: CompilerTurnRecord = {
      id: randomUUID(),
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      createdAt: iso(input.createdAt),
    };
    const list = this.turns.get(input.sessionId);
    if (list === undefined) {
      return Promise.reject(new RepositoryError('Compiler session not found.'));
    }
    list.push(record);
    return Promise.resolve(record);
  }

  markCompiled(sessionId: string, at: Date): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session !== undefined) {
      this.sessions.set(sessionId, { ...session, status: 'COMPILED', updatedAt: iso(at) });
    }
    return Promise.resolve();
  }
}

class InMemoryCompilationRepository implements CompilationRepository {
  private readonly rows = new Map<string, CompilationRecord>();

  save(
    record: Omit<CompilationRecord, 'createdAt'> & { createdAt: Date },
  ): Promise<CompilationRecord> {
    const stored: CompilationRecord = {
      rulesHash: record.rulesHash,
      sessionId: record.sessionId,
      creator: record.creator,
      chainId: record.chainId,
      specification: record.specification,
      canonical: record.canonical,
      compilerVersion: record.compilerVersion,
      createdAt: iso(record.createdAt),
    };
    this.rows.set(stored.rulesHash.toLowerCase(), stored);
    return Promise.resolve(stored);
  }

  findByRulesHash(rulesHash: string): Promise<CompilationRecord | null> {
    return Promise.resolve(this.rows.get(rulesHash.toLowerCase()) ?? null);
  }
}

class InMemoryMarketRepository implements MarketRepository {
  private readonly rows = new Map<string, MarketRecord>();

  register(
    record: Omit<MarketRecord, 'createdAt' | 'updatedAt'> & { at: Date },
  ): Promise<MarketRecord> {
    const key = record.rulesHash.toLowerCase();
    const existing = this.rows.get(key);
    if (existing !== undefined) return Promise.resolve(existing);

    const stored: MarketRecord = {
      rulesHash: record.rulesHash,
      chainId: record.chainId,
      chainMarketId: record.chainMarketId,
      contractAddress: record.contractAddress,
      creator: record.creator,
      question: record.question,
      specification: record.specification,
      canonical: record.canonical,
      validationPlan: record.validationPlan,
      deadline: record.deadline,
      tradingEndsAt: record.tradingEndsAt,
      status: record.status,
      createdAt: iso(record.at),
      updatedAt: iso(record.at),
    };
    this.rows.set(key, stored);
    return Promise.resolve(stored);
  }

  findByRulesHash(rulesHash: string): Promise<MarketRecord | null> {
    return Promise.resolve(this.rows.get(rulesHash.toLowerCase()) ?? null);
  }

  findByChainMarketId(chainId: number, chainMarketId: string): Promise<MarketRecord | null> {
    for (const record of this.rows.values()) {
      if (record.chainId === chainId && record.chainMarketId === chainMarketId) {
        return Promise.resolve(record);
      }
    }
    return Promise.resolve(null);
  }

  attachOnChainIdentity(input: {
    rulesHash: string;
    chainId: number;
    chainMarketId: string;
    contractAddress: string;
    at: Date;
  }): Promise<MarketRecord | null> {
    const key = input.rulesHash.toLowerCase();
    const existing = this.rows.get(key);
    if (existing === undefined) return Promise.resolve(null);

    const updated: MarketRecord = {
      ...existing,
      chainMarketId: input.chainMarketId,
      contractAddress: input.contractAddress.toLowerCase(),
      updatedAt: iso(input.at),
    };
    this.rows.set(key, updated);
    return Promise.resolve(updated);
  }

  updateStatus(input: {
    rulesHash: string;
    status: MarketStatus;
    at: Date;
  }): Promise<MarketRecord | null> {
    const key = input.rulesHash.toLowerCase();
    const existing = this.rows.get(key);
    if (existing === undefined) return Promise.resolve(null);

    const updated: MarketRecord = { ...existing, status: input.status, updatedAt: iso(input.at) };
    this.rows.set(key, updated);
    return Promise.resolve(updated);
  }

  setValidationPlan(input: {
    rulesHash: string;
    plan: unknown;
    at: Date;
  }): Promise<MarketRecord | null> {
    const key = input.rulesHash.toLowerCase();
    const existing = this.rows.get(key);
    if (existing === undefined) return Promise.resolve(null);

    const updated: MarketRecord = {
      ...existing,
      validationPlan: input.plan,
      updatedAt: iso(input.at),
    };
    this.rows.set(key, updated);
    return Promise.resolve(updated);
  }

  listOnChainAddresses(chainId: number): Promise<readonly string[]> {
    const addresses: string[] = [];
    for (const record of this.rows.values()) {
      if (record.chainId === chainId && record.contractAddress !== null) {
        addresses.push(record.contractAddress.toLowerCase());
      }
    }
    return Promise.resolve(addresses);
  }

  list(filter: ListMarketsFilter): Promise<MarketPage> {
    let all = [...this.rows.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    if (filter.chainId !== undefined) all = all.filter((m) => m.chainId === filter.chainId);
    if (filter.status !== undefined) all = all.filter((m) => m.status === filter.status);
    if (filter.creator !== undefined) {
      const creator = filter.creator.toLowerCase();
      all = all.filter((m) => m.creator.toLowerCase() === creator);
    }

    const start = filter.cursor === undefined ? 0 : Number.parseInt(filter.cursor, 10);
    const offset = Number.isSafeInteger(start) && start >= 0 ? start : 0;
    const page = all.slice(offset, offset + filter.limit);
    const nextOffset = offset + page.length;

    return Promise.resolve({
      markets: page,
      nextCursor: nextOffset < all.length ? String(nextOffset) : null,
    });
  }
}

class InMemoryResolutionRepository implements ResolutionRepository {
  readonly rows: ResolutionRecord[] = [];

  findLatestByRulesHash(rulesHash: string): Promise<ResolutionRecord | null> {
    const key = rulesHash.toLowerCase();
    const matches = this.rows.filter((row) => row.rulesHash.toLowerCase() === key);
    return Promise.resolve(matches[matches.length - 1] ?? null);
  }

  listByRulesHash(rulesHash: string): Promise<readonly ResolutionRecord[]> {
    const key = rulesHash.toLowerCase();
    return Promise.resolve(
      this.rows.filter((row) => row.rulesHash.toLowerCase() === key).slice().reverse(),
    );
  }

  findProposedByRound(rulesHash: string, round: number): Promise<ResolutionRecord | null> {
    const key = rulesHash.toLowerCase();
    const matches = this.rows.filter(
      (row) =>
        row.rulesHash.toLowerCase() === key && row.round === round && row.status === 'PROPOSED',
    );
    return Promise.resolve(matches[matches.length - 1] ?? null);
  }

  record(input: {
    rulesHash: string;
    status: ResolutionRecord['status'];
    outcome: ResolutionRecord['outcome'];
    confidenceBps: number;
    reason: string;
    evidenceHash: string | null;
    resolverVersion: string;
    round: number;
    record: unknown | null;
    createdAt: Date;
  }): Promise<ResolutionRecord> {
    const stored: ResolutionRecord = {
      id: randomUUID(),
      rulesHash: input.rulesHash.toLowerCase() as `0x${string}`,
      status: input.status,
      outcome: input.outcome,
      confidenceBps: input.confidenceBps,
      reason: input.reason,
      evidenceHash:
        input.evidenceHash === null ? null : (input.evidenceHash.toLowerCase() as `0x${string}`),
      resolverVersion: input.resolverVersion,
      round: input.round,
      proposedAt: null,
      finalizedAt: null,
      createdAt: iso(input.createdAt),
      record: input.record,
      proposalTxHash: null,
      proposalBlock: null,
      submissionState: 'NOT_SUBMITTED',
    };
    this.rows.push(stored);
    return Promise.resolve(stored);
  }

  markSubmission(input: {
    id: string;
    submissionState: ResolutionRecord['submissionState'];
    proposalTxHash: string | null;
    proposalBlock: string | null;
    proposedAt: Date | null;
    at: Date;
  }): Promise<ResolutionRecord | null> {
    const index = this.rows.findIndex((row) => row.id === input.id);
    if (index < 0) return Promise.resolve(null);
    const existing = this.rows[index] as ResolutionRecord;

    const updated: ResolutionRecord = {
      ...existing,
      submissionState: input.submissionState,
      proposalTxHash: input.proposalTxHash ?? existing.proposalTxHash,
      proposalBlock: input.proposalBlock ?? existing.proposalBlock,
      proposedAt: input.proposedAt === null ? existing.proposedAt : iso(input.proposedAt),
    };
    this.rows[index] = updated;
    return Promise.resolve(updated);
  }

  markFinalized(input: { rulesHash: string; at: Date }): Promise<number> {
    const key = input.rulesHash.toLowerCase();
    let updated = 0;
    this.rows.forEach((row, index) => {
      if (row.rulesHash.toLowerCase() !== key || row.finalizedAt !== null) return;
      this.rows[index] = { ...row, finalizedAt: iso(input.at) };
      updated += 1;
    });
    return Promise.resolve(updated);
  }
}

class InMemoryEvidenceRepository implements EvidenceRepository {
  readonly rows: EvidenceRecord[] = [];

  findByRulesHash(rulesHash: string): Promise<EvidenceRecord | null> {
    const key = rulesHash.toLowerCase();
    const matches = this.rows.filter((row) => row.rulesHash.toLowerCase() === key);
    return Promise.resolve(matches[matches.length - 1] ?? null);
  }

  findByEvidenceHash(evidenceHash: string): Promise<EvidenceRecord | null> {
    const key = evidenceHash.toLowerCase();
    return Promise.resolve(this.rows.find((row) => row.evidenceHash.toLowerCase() === key) ?? null);
  }

  save(input: {
    rulesHash: string;
    evidenceHash: string;
    package: EvidenceRecord['package'];
    createdAt: Date;
  }): Promise<EvidenceRecord> {
    const key = input.evidenceHash.toLowerCase();
    const existing = this.rows.find((row) => row.evidenceHash.toLowerCase() === key);
    if (existing !== undefined) return Promise.resolve(existing);

    const stored: EvidenceRecord = {
      id: randomUUID(),
      rulesHash: input.rulesHash.toLowerCase() as `0x${string}`,
      evidenceHash: key as `0x${string}`,
      package: input.package,
      createdAt: iso(input.createdAt),
    };
    this.rows.push(stored);
    return Promise.resolve(stored);
  }
}

class InMemoryChallengeRepository implements ChallengeRepository {
  readonly rows: ChallengeDocumentRecord[] = [];

  save(input: {
    rulesHash: string;
    challenger: string;
    reasonHash: string;
    reason: string;
    bond: string;
    txHash: string;
    round: number;
    challengedAt: Date;
    createdAt: Date;
  }): Promise<ChallengeDocumentRecord> {
    const key = input.rulesHash.toLowerCase();
    const existing = this.rows.find(
      (row) => row.rulesHash.toLowerCase() === key && row.round === input.round,
    );
    if (existing !== undefined) return Promise.resolve(existing);

    const stored: ChallengeDocumentRecord = {
      id: randomUUID(),
      rulesHash: key as `0x${string}`,
      challenger: input.challenger.toLowerCase(),
      reasonHash: input.reasonHash.toLowerCase() as `0x${string}`,
      reason: input.reason,
      bond: input.bond,
      txHash: input.txHash.toLowerCase(),
      round: input.round,
      challengedAt: iso(input.challengedAt),
      createdAt: iso(input.createdAt),
    };
    this.rows.push(stored);
    return Promise.resolve(stored);
  }

  findByRulesHash(rulesHash: string): Promise<ChallengeDocumentRecord | null> {
    const key = rulesHash.toLowerCase();
    const matches = this.rows.filter((row) => row.rulesHash.toLowerCase() === key);
    return Promise.resolve(matches[matches.length - 1] ?? null);
  }
}

/**
 * Events, keyed exactly as PostgreSQL keys them.
 *
 * The map key is `chainId:txHash:logIndex` — the same identity the real table's
 * primary key uses (§18). Using a different key here would make the in-memory
 * idempotency tests prove nothing about production, which is the whole point of
 * having both implementations answer to one interface.
 */
class InMemoryMarketEventRepository implements MarketEventRepository {
  private readonly rows = new Map<string, MarketEventRecord>();

  private static key(chainId: number, transactionHash: string, logIndex: number): string {
    return `${chainId}:${transactionHash.toLowerCase()}:${logIndex}`;
  }

  append(events: readonly Omit<MarketEventRecord, 'indexedAt'>[], at: Date): Promise<number> {
    let inserted = 0;
    for (const event of events) {
      const key = InMemoryMarketEventRepository.key(
        event.chainId,
        event.transactionHash,
        event.logIndex,
      );
      if (this.rows.has(key)) continue;
      this.rows.set(key, {
        ...event,
        transactionHash: event.transactionHash.toLowerCase(),
        contractAddress: event.contractAddress.toLowerCase(),
        rulesHash: event.rulesHash?.toLowerCase() ?? null,
        indexedAt: iso(at),
      });
      inserted += 1;
    }
    return Promise.resolve(inserted);
  }

  private sorted(): MarketEventRecord[] {
    return [...this.rows.values()].sort((a, b) => {
      const byBlock = BigInt(a.blockNumber) - BigInt(b.blockNumber);
      if (byBlock !== 0n) return byBlock < 0n ? -1 : 1;
      return a.logIndex - b.logIndex;
    });
  }

  listByMarket(chainId: number, chainMarketId: string): Promise<readonly MarketEventRecord[]> {
    return Promise.resolve(
      this.sorted().filter((row) => row.chainId === chainId && row.chainMarketId === chainMarketId),
    );
  }

  listByRulesHash(rulesHash: string): Promise<readonly MarketEventRecord[]> {
    const key = rulesHash.toLowerCase();
    return Promise.resolve(this.sorted().filter((row) => row.rulesHash === key));
  }

  deleteFromBlock(chainId: number, fromBlock: string): Promise<number> {
    const floor = BigInt(fromBlock);
    let removed = 0;
    for (const [key, row] of this.rows) {
      if (row.chainId === chainId && BigInt(row.blockNumber) >= floor) {
        this.rows.delete(key);
        removed += 1;
      }
    }
    return Promise.resolve(removed);
  }

  countByChain(chainId: number): Promise<number> {
    return Promise.resolve(this.sorted().filter((row) => row.chainId === chainId).length);
  }

  findDuplicateIdentities(): Promise<readonly string[]> {
    // Structurally impossible here: the map key *is* the identity.
    return Promise.resolve([]);
  }
}

class InMemoryIndexerCheckpointRepository implements IndexerCheckpointRepository {
  private readonly checkpoints = new Map<string, IndexerCheckpointRecord>();
  private readonly blocks = new Map<string, { blockNumber: string; blockHash: string }>();

  loadOrCreate(input: {
    chainId: number;
    stream: string;
    startBlock: string;
    at: Date;
  }): Promise<IndexerCheckpointRecord> {
    const key = `${input.chainId}:${input.stream}`;
    const existing = this.checkpoints.get(key);
    if (existing !== undefined) return Promise.resolve(existing);

    // One below the start block, so the first pass includes it.
    const start = BigInt(input.startBlock);
    const record: IndexerCheckpointRecord = {
      chainId: input.chainId,
      stream: input.stream,
      startBlock: input.startBlock,
      lastProcessedBlock: (start > 0n ? start - 1n : 0n).toString(),
      lastProcessedBlockHash: null,
      rewindCount: 0,
      updatedAt: iso(input.at),
    };
    this.checkpoints.set(key, record);
    return Promise.resolve(record);
  }

  save(input: {
    chainId: number;
    stream: string;
    lastProcessedBlock: string;
    lastProcessedBlockHash: string | null;
    at: Date;
  }): Promise<void> {
    const key = `${input.chainId}:${input.stream}`;
    const existing = this.checkpoints.get(key);
    if (existing === undefined) return Promise.resolve();
    this.checkpoints.set(key, {
      ...existing,
      lastProcessedBlock: input.lastProcessedBlock,
      lastProcessedBlockHash: input.lastProcessedBlockHash,
      updatedAt: iso(input.at),
    });
    return Promise.resolve();
  }

  rewind(input: {
    chainId: number;
    stream: string;
    toBlock: string;
    at: Date;
  }): Promise<IndexerCheckpointRecord> {
    const key = `${input.chainId}:${input.stream}`;
    const existing = this.checkpoints.get(key);
    if (existing === undefined) {
      return Promise.reject(new RepositoryError('No such indexer checkpoint.'));
    }
    const updated: IndexerCheckpointRecord = {
      ...existing,
      lastProcessedBlock: input.toBlock,
      lastProcessedBlockHash: null,
      rewindCount: existing.rewindCount + 1,
      updatedAt: iso(input.at),
    };
    this.checkpoints.set(key, updated);
    return Promise.resolve(updated);
  }

  recordBlock(input: {
    chainId: number;
    blockNumber: string;
    blockHash: string;
    at: Date;
  }): Promise<void> {
    this.blocks.set(`${input.chainId}:${input.blockNumber}`, {
      blockNumber: input.blockNumber,
      blockHash: input.blockHash.toLowerCase(),
    });
    return Promise.resolve();
  }

  recentBlocks(
    chainId: number,
    fromBlock: string,
  ): Promise<readonly { blockNumber: string; blockHash: string }[]> {
    const floor = BigInt(fromBlock);
    const rows: { blockNumber: string; blockHash: string }[] = [];
    for (const [key, value] of this.blocks) {
      if (!key.startsWith(`${chainId}:`)) continue;
      if (BigInt(value.blockNumber) >= floor) rows.push(value);
    }
    rows.sort((a, b) => (BigInt(a.blockNumber) > BigInt(b.blockNumber) ? -1 : 1));
    return Promise.resolve(rows);
  }

  deleteBlocksFrom(chainId: number, fromBlock: string): Promise<number> {
    const floor = BigInt(fromBlock);
    let removed = 0;
    for (const [key, value] of this.blocks) {
      if (!key.startsWith(`${chainId}:`)) continue;
      if (BigInt(value.blockNumber) >= floor) {
        this.blocks.delete(key);
        removed += 1;
      }
    }
    return Promise.resolve(removed);
  }

  pruneBlocksBelow(chainId: number, blockNumber: string): Promise<number> {
    const floor = BigInt(blockNumber);
    let removed = 0;
    for (const [key, value] of this.blocks) {
      if (!key.startsWith(`${chainId}:`)) continue;
      if (BigInt(value.blockNumber) < floor) {
        this.blocks.delete(key);
        removed += 1;
      }
    }
    return Promise.resolve(removed);
  }
}

class InMemoryMarketChainStateRepository implements MarketChainStateRepository {
  private readonly rows = new Map<string, MarketChainStateRecord>();

  private static key(chainId: number, address: string): string {
    return `${chainId}:${address.toLowerCase()}`;
  }

  upsert(
    record: Omit<MarketChainStateRecord, 'updatedAt'> & { at: Date },
  ): Promise<MarketChainStateRecord> {
    const { at, ...rest } = record;
    const stored: MarketChainStateRecord = {
      ...rest,
      contractAddress: rest.contractAddress.toLowerCase(),
      rulesHash: rest.rulesHash.toLowerCase(),
      updatedAt: iso(at),
    };
    this.rows.set(
      InMemoryMarketChainStateRepository.key(stored.chainId, stored.contractAddress),
      stored,
    );
    return Promise.resolve(stored);
  }

  findByAddress(chainId: number, address: string): Promise<MarketChainStateRecord | null> {
    return Promise.resolve(
      this.rows.get(InMemoryMarketChainStateRepository.key(chainId, address)) ?? null,
    );
  }

  findByRulesHash(chainId: number, rulesHash: string): Promise<MarketChainStateRecord | null> {
    const key = rulesHash.toLowerCase();
    for (const row of this.rows.values()) {
      if (row.chainId === chainId && row.rulesHash === key) return Promise.resolve(row);
    }
    return Promise.resolve(null);
  }

  list(chainId: number): Promise<readonly MarketChainStateRecord[]> {
    return Promise.resolve([...this.rows.values()].filter((row) => row.chainId === chainId));
  }

  deleteByAddress(chainId: number, address: string): Promise<void> {
    this.rows.delete(InMemoryMarketChainStateRepository.key(chainId, address));
    return Promise.resolve();
  }
}

class InMemoryAuthNonceRepository implements AuthNonceRepository {
  private readonly rows = new Map<string, AuthNonceRecord>();

  issue(
    input: Omit<AuthNonceRecord, 'consumedAt' | 'issuedAt' | 'expiresAt'> & {
      issuedAt: Date;
      expiresAt: Date;
    },
  ): Promise<AuthNonceRecord> {
    const record: AuthNonceRecord = {
      nonce: input.nonce,
      address: input.address.toLowerCase(),
      chainId: input.chainId,
      domain: input.domain,
      uri: input.uri,
      statement: input.statement,
      issuedAt: iso(input.issuedAt),
      expiresAt: iso(input.expiresAt),
      consumedAt: null,
    };
    this.rows.set(record.nonce, record);
    return Promise.resolve(record);
  }

  /**
   * Consume, mirroring the SQL version's single conditional update.
   *
   * JavaScript's single-threaded execution makes this trivially atomic here; the
   * ordering is written out anyway so the two implementations agree about the
   * contract — a nonce already consumed, or expired, yields null.
   */
  consume(nonce: string, at: Date): Promise<AuthNonceRecord | null> {
    const record = this.rows.get(nonce);
    if (record === undefined) return Promise.resolve(null);
    if (record.consumedAt !== null) return Promise.resolve(null);
    if (new Date(record.expiresAt) <= at) return Promise.resolve(null);

    const consumed: AuthNonceRecord = { ...record, consumedAt: iso(at) };
    this.rows.set(nonce, consumed);
    return Promise.resolve(consumed);
  }

  deleteExpired(before: Date): Promise<number> {
    let removed = 0;
    for (const [key, row] of this.rows) {
      if (new Date(row.expiresAt) <= before) {
        this.rows.delete(key);
        removed += 1;
      }
    }
    return Promise.resolve(removed);
  }
}

class InMemoryAuthSessionRepository implements AuthSessionRepository {
  private readonly rows = new Map<string, AuthSessionRecord>();

  create(input: {
    tokenHash: string;
    address: string;
    chainId: number;
    createdAt: Date;
    expiresAt: Date;
  }): Promise<AuthSessionRecord> {
    const record: AuthSessionRecord = {
      id: randomUUID(),
      tokenHash: input.tokenHash,
      address: input.address.toLowerCase(),
      chainId: input.chainId,
      createdAt: iso(input.createdAt),
      expiresAt: iso(input.expiresAt),
      revokedAt: null,
    };
    this.rows.set(record.id, record);
    return Promise.resolve(record);
  }

  findByTokenHash(tokenHash: string): Promise<AuthSessionRecord | null> {
    for (const row of this.rows.values()) {
      if (row.tokenHash === tokenHash) return Promise.resolve(row);
    }
    return Promise.resolve(null);
  }

  revoke(id: string, at: Date): Promise<void> {
    const row = this.rows.get(id);
    if (row !== undefined) this.rows.set(id, { ...row, revokedAt: iso(at) });
    return Promise.resolve();
  }
}

export interface InMemoryRepositories extends Repositories {
  readonly resolutions: InMemoryResolutionRepository;
  readonly evidence: InMemoryEvidenceRepository;
  readonly challenges: InMemoryChallengeRepository;
}

export function createInMemoryRepositories(): InMemoryRepositories {
  return {
    wallets: new InMemoryWalletRepository(),
    sessions: new InMemoryCompilerSessionRepository(),
    compilations: new InMemoryCompilationRepository(),
    markets: new InMemoryMarketRepository(),
    resolutions: new InMemoryResolutionRepository(),
    evidence: new InMemoryEvidenceRepository(),
    challenges: new InMemoryChallengeRepository(),
    events: new InMemoryMarketEventRepository(),
    checkpoints: new InMemoryIndexerCheckpointRepository(),
    chainState: new InMemoryMarketChainStateRepository(),
    authNonces: new InMemoryAuthNonceRepository(),
    authSessions: new InMemoryAuthSessionRepository(),
  };
}

/**
 * Repositories where every call rejects.
 *
 * Lets the storage-failure branch be tested for real: the assertion is that a
 * dead database produces a 503 with no driver detail, not a 500 with a
 * connection string in the body.
 */
export function createFailingRepositories(
  message = 'The datastore is unavailable.',
): Repositories {
  const fail = (): Promise<never> => Promise.reject(new RepositoryError(message));
  return {
    wallets: { touch: fail },
    sessions: {
      create: fail,
      findById: fail,
      listTurns: fail,
      appendTurn: fail,
      markCompiled: fail,
    },
    compilations: { save: fail, findByRulesHash: fail },
    markets: {
      register: fail,
      findByRulesHash: fail,
      findByChainMarketId: fail,
      list: fail,
      attachOnChainIdentity: fail,
      updateStatus: fail,
      listOnChainAddresses: fail,
      setValidationPlan: fail,
    },
    resolutions: {
      findLatestByRulesHash: fail,
      listByRulesHash: fail,
      findProposedByRound: fail,
      record: fail,
      markSubmission: fail,
      markFinalized: fail,
    },
    evidence: { findByRulesHash: fail, findByEvidenceHash: fail, save: fail },
    challenges: { save: fail, findByRulesHash: fail },
    events: {
      append: fail,
      listByMarket: fail,
      listByRulesHash: fail,
      deleteFromBlock: fail,
      countByChain: fail,
      findDuplicateIdentities: fail,
    },
    checkpoints: {
      loadOrCreate: fail,
      save: fail,
      rewind: fail,
      recordBlock: fail,
      recentBlocks: fail,
      deleteBlocksFrom: fail,
      pruneBlocksBelow: fail,
    },
    chainState: {
      upsert: fail,
      findByAddress: fail,
      findByRulesHash: fail,
      list: fail,
      deleteByAddress: fail,
    },
    authNonces: { issue: fail, consume: fail, deleteExpired: fail },
    authSessions: { create: fail, findByTokenHash: fail, revoke: fail },
  };
}
