/**
 * Repository contract tests.
 *
 * Written against the interface, so the same suite can later be pointed at the
 * Drizzle implementations with a live PostgreSQL and prove the two behave
 * alike. Until that integration suite exists (Milestone 4), these cover the
 * in-memory implementations the unit tests depend on.
 */

import { describe, expect, it } from 'vitest';

import { RepositoryError } from '../src/errors.js';
import { createFailingRepositories, createInMemoryRepositories } from '../src/repositories/memory.js';
import { CREATOR, NOW, compiledOutput, createCompiler } from './helpers.js';

async function sampleSpec() {
  const harness = createCompiler([{ kind: 'json', value: compiledOutput() }]);
  const result = await harness.compiler.compile({ message: 'x', creator: CREATOR, history: [] });
  if (result.status !== 'COMPILED') throw new Error('expected COMPILED');
  return result;
}

describe('wallets', () => {
  it('records first sight once and is idempotent thereafter', async () => {
    const repos = createInMemoryRepositories();
    const first = await repos.wallets.touch(CREATOR, NOW);
    const second = await repos.wallets.touch(CREATOR.toUpperCase(), new Date('2027-01-01Z'));
    expect(second.firstSeenAt).toBe(first.firstSeenAt);
    expect(second.address).toBe(CREATOR.toLowerCase());
  });
});

describe('compiler sessions', () => {
  it('stores turns in order', async () => {
    const repos = createInMemoryRepositories();
    const session = await repos.sessions.create({
      creator: CREATOR,
      chainId: 1952,
      compilerVersion: '1.0.0',
      createdAt: NOW,
    });

    await repos.sessions.appendTurn({
      sessionId: session.id,
      role: 'user',
      content: 'first',
      createdAt: NOW,
    });
    await repos.sessions.appendTurn({
      sessionId: session.id,
      role: 'assistant',
      content: 'second',
      createdAt: NOW,
    });

    const turns = await repos.sessions.listTurns(session.id);
    expect(turns.map((turn) => turn.content)).toEqual(['first', 'second']);
    expect(turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
  });

  it('rejects a turn on a session that does not exist', async () => {
    const repos = createInMemoryRepositories();
    await expect(
      repos.sessions.appendTurn({
        sessionId: '00000000-0000-4000-8000-000000000000',
        role: 'user',
        content: 'x',
        createdAt: NOW,
      }),
    ).rejects.toBeInstanceOf(RepositoryError);
  });

  it('marks a session compiled', async () => {
    const repos = createInMemoryRepositories();
    const session = await repos.sessions.create({
      creator: CREATOR,
      chainId: 1952,
      compilerVersion: '1.0.0',
      createdAt: NOW,
    });
    await repos.sessions.markCompiled(session.id, NOW);
    expect((await repos.sessions.findById(session.id))?.status).toBe('COMPILED');
  });
});

describe('compilations', () => {
  it('is keyed by rules hash and looks up case-insensitively', async () => {
    const repos = createInMemoryRepositories();
    const compiled = await sampleSpec();

    await repos.compilations.save({
      rulesHash: compiled.rulesHash,
      sessionId: null,
      creator: CREATOR,
      chainId: 1952,
      specification: compiled.specification,
      canonical: compiled.canonical,
      compilerVersion: '1.0.0',
      createdAt: NOW,
    });

    const upper = compiled.rulesHash.toUpperCase().replace('0X', '0x');
    expect(await repos.compilations.findByRulesHash(upper)).not.toBeNull();
  });
});

describe('markets', () => {
  async function seed(count: number) {
    const repos = createInMemoryRepositories();
    const compiled = await sampleSpec();

    for (let i = 0; i < count; i += 1) {
      await repos.markets.register({
        rulesHash: `0x${String(i + 1).padStart(64, '0')}` as `0x${string}`,
        chainId: 1952,
        chainMarketId: null,
        contractAddress: null,
        creator: CREATOR,
        question: `Question ${i}`,
        specification: compiled.specification,
        canonical: compiled.canonical,
        deadline: compiled.specification.deadline,
        tradingEndsAt: compiled.specification.settlement.tradingEndsAt,
        status: 'PENDING_ONCHAIN',
        at: new Date(NOW.getTime() + i * 1000),
      });
    }
    return repos;
  }

  it('is idempotent on rules hash', async () => {
    const repos = await seed(1);
    const compiled = await sampleSpec();
    const again = await repos.markets.register({
      rulesHash: `0x${'1'.padStart(64, '0')}` as `0x${string}`,
      chainId: 1952,
      chainMarketId: null,
      contractAddress: null,
      creator: CREATOR,
      question: 'A different question',
      specification: compiled.specification,
      canonical: compiled.canonical,
      deadline: compiled.specification.deadline,
      tradingEndsAt: compiled.specification.settlement.tradingEndsAt,
      status: 'PENDING_ONCHAIN',
      at: NOW,
    });
    // The first write wins; a re-registration does not overwrite.
    expect(again.question).toBe('Question 0');
  });

  it('leaves the on-chain identity null until the chain assigns one', async () => {
    const repos = await seed(1);
    const record = await repos.markets.findByRulesHash(`0x${'1'.padStart(64, '0')}`);
    expect(record?.chainMarketId).toBeNull();
    expect(record?.contractAddress).toBeNull();
    expect(record?.status).toBe('PENDING_ONCHAIN');
  });

  it('pages newest-first and reports a cursor', async () => {
    const repos = await seed(5);
    const first = await repos.markets.list({ limit: 2 });
    expect(first.markets).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    expect(first.markets[0]?.question).toBe('Question 4');

    const second = await repos.markets.list({ limit: 2, cursor: first.nextCursor as string });
    expect(second.markets[0]?.question).toBe('Question 2');

    const last = await repos.markets.list({ limit: 10 });
    expect(last.nextCursor).toBeNull();
  });

  it('filters by chain, status and creator', async () => {
    const repos = await seed(3);
    expect((await repos.markets.list({ limit: 10, chainId: 1952 })).markets).toHaveLength(3);
    expect((await repos.markets.list({ limit: 10, chainId: 1 })).markets).toHaveLength(0);
    expect((await repos.markets.list({ limit: 10, status: 'SETTLED' })).markets).toHaveLength(0);
    expect(
      (await repos.markets.list({ limit: 10, creator: CREATOR.toUpperCase() })).markets,
    ).toHaveLength(3);
  });
});

describe('failing repositories', () => {
  it('reject every call with a typed repository error', async () => {
    const repos = createFailingRepositories();
    await expect(repos.wallets.touch(CREATOR, NOW)).rejects.toBeInstanceOf(RepositoryError);
    await expect(repos.markets.findByRulesHash('0x00')).rejects.toBeInstanceOf(RepositoryError);
    await expect(repos.compilations.findByRulesHash('0x00')).rejects.toBeInstanceOf(RepositoryError);
    await expect(repos.resolutions.findLatestByRulesHash('0x00')).rejects.toBeInstanceOf(
      RepositoryError,
    );
    await expect(repos.evidence.findByRulesHash('0x00')).rejects.toBeInstanceOf(RepositoryError);
  });
});
