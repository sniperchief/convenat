/**
 * The resolution API, with a real pipeline behind it.
 *
 * `resolution-service.test.ts` covers what the pipeline decides. This covers
 * what a client can *see* — which is the product requirement, stated in the
 * brief as: the user should be able to see WHY the AI reached the outcome.
 *
 * So the assertions here are about the payload:
 *
 *   RULES     → `rulesHash`, and the specification behind it
 *   EVIDENCE  → which approved sources were read, and their content hashes
 *   CHECKS    → what was compared, against what, and what was found
 *   REASONING → the model's words, and which claims are reproducible
 *   OUTCOME   → the proposal and its `evidenceHash`
 *   ON-CHAIN  → the transaction, the window, whether the digests agree
 *
 * A payload missing any of those makes the panel a black box, which is the thing
 * this system exists not to be.
 */

import type { InjectOptions } from 'fastify';
import { describe, expect, it } from 'vitest';

import { buildRulesCommitment, verifyEvidenceHash } from '@covenant/shared';

import type { RetrievalResult } from '../src/evidence/retriever.js';
import { FakeLLMProvider } from '../src/llm/fake-provider.js';
import { ResolutionEngine } from '../src/resolution/engine.js';
import { MarketResolutionService } from '../src/resolution/service.js';
import type { Address } from '../src/chain/types.js';
import { createInMemoryRepositories } from '../src/repositories/memory.js';
import { FakeChainClient, FakeResolverWriter, fakeMarket, silentLogger } from './fake-chain.js';
import { bearer, createServer, signIn } from './helpers.js';
import {
  deliveredPlan,
  evidenceSources,
  modelYes,
  snapshot,
  spec,
} from './resolution-helpers.js';

const MARKET_ADDRESS = '0x00000000000000000000000000000000000000c1' as Address;
const NOW = new Date('2026-09-02T00:10:00Z');

async function serveResolvable(options: { challengeEndsAt?: number } = {}) {
  const specification = spec();
  const commitment = buildRulesCommitment(specification);

  const chain = new FakeChainClient({ chainId: 1952, confirmations: 1 });
  chain.addBlocks(5);

  const base = fakeMarket({
    address: MARKET_ADDRESS,
    marketId: 7n,
    rulesHash: commitment.rulesHash,
    state: 'CLOSED',
    conditionDeadline: Math.floor(Date.parse('2026-09-01T00:00:00Z') / 1000),
    challengeEndsAt: options.challengeEndsAt ?? Math.floor(NOW.getTime() / 1000) + 3600,
    totalYes: 100_000_000n,
    totalNo: 300_000_000n,
    pool: 400_000_000n,
  });
  chain.setMarket(base);

  // The writer advances the scripted market the way `proposeResolution` does:
  // round increments, state becomes RESOLUTION_PROPOSED, the digest is stored.
  // Without this the fixture would sit at round 0 forever and the assertions
  // below would be measuring the double rather than the behaviour.
  const writer = new FakeResolverWriter({
    onPropose: (_market, outcome, evidenceHash) => {
      chain.setMarket({
        ...base,
        state: 'RESOLUTION_PROPOSED',
        proposalRound: 1,
        proposedOutcome: outcome as 'YES' | 'NO' | 'INVALID',
        evidenceHash,
        proposedAt: Math.floor(NOW.getTime() / 1000),
      });
    },
  });

  // Repositories are built first, so the service and the server share one store
  // without either having to exist before the other.
  const repositories = createInMemoryRepositories();
  const snapshots = [snapshot({ index: 0, status: 'delivered' })];

  const service = new MarketResolutionService({
    repositories,
    chain,
    writer,
    retriever: {
      retrieve: () =>
        Promise.resolve<RetrievalResult>({
          snapshots,
          failures: [],
          skipped: [],
          primary: snapshots[0] ?? null,
          evidenceSources: evidenceSources(snapshots),
        }),
    },
    engine: new ResolutionEngine({
      provider: new FakeLLMProvider([{ kind: 'json', value: modelYes() }]),
      maxOutputTokens: 4000,
      timeoutMs: 30_000,
    }),
    now: () => NOW,
    logger: silentLogger,
  });

  const withService = createServer([], {
    repositories,
    chain,
    resolution: service,
    now: () => NOW,
  });

  const token = await signIn(withService);
  const me = await withService.auth.authenticate(token);

  // Registered with the signed-in wallet as creator, so the creator-only routes
  // are exercised rather than short-circuited by an ownership failure. The
  // *specification's* creator is the fixture's and is untouched — it is inside
  // `rulesHash` and editing it would change the hash.
  await withService.repositories.markets.register({
    rulesHash: commitment.rulesHash,
    chainId: 1952,
    chainMarketId: '7',
    contractAddress: MARKET_ADDRESS,
    creator: me.address,
    question: specification.question,
    specification,
    canonical: commitment.canonical,
    validationPlan: deliveredPlan(),
    deadline: specification.deadline,
    tradingEndsAt: specification.settlement.tradingEndsAt,
    status: 'CLOSED',
    at: NOW,
  });

  return {
    ...withService,
    token,
    rulesHash: commitment.rulesHash,
    specification,
    // The bearer token is attached by default, as in `routes.test.ts`. A test
    // that cares about the unauthenticated case uses `app.inject` directly.
    inject: (options: InjectOptions) =>
      withService.app.inject({
        ...options,
        headers: { ...bearer(token), ...(options.headers ?? {}) },
      }),
  };
}

describe('POST /api/markets/:id/resolve', () => {
  it('returns the whole chain of reasoning, not just an outcome', async () => {
    const h = await serveResolvable();
    const response = await h.inject({
      method: 'POST',
      url: `/api/markets/${h.rulesHash}/resolve`,
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const detail = response.json().data;

    // 1 RULES
    expect(detail.rulesHash).toBe(h.rulesHash);
    // 2 EVIDENCE — attributable: a name, a URL, a status, and a content hash.
    expect(detail.sources.length).toBeGreaterThan(0);
    expect(detail.sources[0]).toMatchObject({
      sourceId: 'source-0',
      approvedSourceIndex: 0,
      status: 'RETRIEVED',
    });
    expect(detail.sources[0].url).toBe(h.specification.approvedSources[0]?.url);
    expect(detail.sources[0].contentHash).toMatch(/^0x[0-9a-f]{64}$/);
    // 3 CHECKS — the comparison, not a verdict word.
    expect(detail.deterministicChecks.length).toBeGreaterThan(0);
    expect(detail.deterministicChecks[0]).toHaveProperty('expected');
    expect(detail.deterministicChecks[0]).toHaveProperty('observed');
    expect(detail.verdict).toBe('SATISFIED');
    // 4 REASONING — the model's own words, and how each claim was extracted.
    expect(typeof detail.reasoning).toBe('string');
    expect(detail.reasoning.length).toBeGreaterThan(0);
    expect(detail.claims.length).toBeGreaterThan(0);
    expect(detail.claims[0]).toHaveProperty('extractionMethod');
    // 5 OUTCOME
    expect(detail.status).toBe('RESOLVED');
    expect(detail.outcome).toBe('YES');
    expect(detail.confidenceBps).toBeGreaterThan(0);
    expect(detail.evidenceHash).toMatch(/^0x[0-9a-f]{64}$/);
    // 6 ON-CHAIN
    expect(detail.submissionState).toBe('CONFIRMED');
    expect(detail.proposalTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    // Written by code, not the model.
    expect(typeof detail.rationale).toBe('string');
  });

  it('never returns a settlement figure', async () => {
    // The contract owns payout, refund mode and bonds. A resolution payload that
    // carried one would invite a UI to display a number nothing computed.
    const h = await serveResolvable();
    const response = await h.inject({
      method: 'POST',
      url: `/api/markets/${h.rulesHash}/resolve`,
      payload: {},
    });

    const body = JSON.stringify(response.json().data);
    for (const forbidden of ['payout', 'refundMode', 'bondBaseUnits', 'winningTotal']) {
      expect(body).not.toContain(forbidden);
    }
  });

  it('answers 200 for a market it will not resolve, with the reason', async () => {
    // Not a 4xx. The engine declining is the system working, and a failure
    // status would tell a UI to show an error where it should show reasoning.
    const h = await serveResolvable();
    await h.repositories.markets.setValidationPlan({
      rulesHash: h.rulesHash,
      plan: null,
      at: NOW,
    });

    const response = await h.inject({
      method: 'POST',
      url: `/api/markets/${h.rulesHash}/resolve`,
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe('NEEDS_REVIEW');
    expect(response.json().data.reason).toBe('NO_VALIDATION_PLAN');
    expect(response.json().data.outcome).toBeNull();
  });

  it('requires a proved wallet to trigger', async () => {
    const h = await serveResolvable();
    const response = await h.app.inject({
      method: 'POST',
      url: `/api/markets/${h.rulesHash}/resolve`,
      payload: {},
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('GET /api/markets/:id/resolution', () => {
  it('carries the on-chain proposal view alongside the record', async () => {
    const h = await serveResolvable();
    await h.inject({ method: 'POST', url: `/api/markets/${h.rulesHash}/resolve`, payload: {} });

    const response = await h.inject({
      method: 'GET',
      url: `/api/markets/${h.rulesHash}/resolution`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json().data;
    expect(body.latest.outcome).toBe('YES');
    expect(body.history.length).toBeGreaterThanOrEqual(1);
    // The window and the two-proposal limit are what a challenger needs.
    expect(body.onChain).toHaveProperty('challengeWindowOpen');
    expect(body.onChain).toHaveProperty('finalizable');
    expect(body.onChain).toHaveProperty('proposalsExhausted');
  });

  it('reports no resolution rather than an empty one', async () => {
    const h = await serveResolvable();
    const response = await h.inject({
      method: 'GET',
      url: `/api/markets/${h.rulesHash}/resolution`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.latest).toBeNull();
    expect(response.json().data.history).toEqual([]);
  });
});

describe('GET /api/markets/:id/evidence', () => {
  it('serves a package that re-derives to its own digest', async () => {
    const h = await serveResolvable();
    await h.inject({ method: 'POST', url: `/api/markets/${h.rulesHash}/resolve`, payload: {} });

    const response = await h.inject({
      method: 'GET',
      url: `/api/markets/${h.rulesHash}/evidence`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json().data;
    // `verified` is computed by the server, and then checked again here from the
    // served bytes — which is the check any third party can repeat.
    expect(body.verified).toBe(true);
    expect(verifyEvidenceHash(body.package, body.evidenceHash)).toBe(true);
  });

  it('404s when no evidence exists, rather than serving a hollow package', async () => {
    const h = await serveResolvable();
    const response = await h.inject({
      method: 'GET',
      url: `/api/markets/${h.rulesHash}/evidence`,
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('POST /api/markets/:id/validation-plan', () => {
  it('refuses a plan referencing a source the specification did not approve', async () => {
    // The plan is unhashed operator input (ADR-0017). This is the check that
    // stops it widening the evidence policy `approvedSources` exists to fix.
    const h = await serveResolvable();
    const response = await h.inject({
      method: 'POST',
      url: `/api/markets/${h.rulesHash}/validation-plan`,
      payload: {
        validationPlan: {
          checks: [
            {
              checkId: 'out-of-range',
              kind: 'CATEGORICAL_MATCH',
              observation: { sourceId: 'source-9', pointer: null },
              accepted: ['delivered'],
            },
          ],
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.issues[0].path).toContain('sourceId');
  });

  it('refuses a plan from a wallet that is not the creator', async () => {
    const h = await serveResolvable();

    // A second market whose creator is somebody else. The criteria decide what
    // a market settles on, so the only defensible holder of them is the wallet
    // that approved the rules.
    const other = await h.repositories.markets.register({
      rulesHash: `0x${'e5'.repeat(32)}` as `0x${string}`,
      chainId: 1952,
      chainMarketId: '8',
      contractAddress: '0x00000000000000000000000000000000000000c2',
      creator: '0x9999999999999999999999999999999999999999',
      question: h.specification.question,
      specification: h.specification,
      canonical: buildRulesCommitment(h.specification).canonical,
      validationPlan: null,
      deadline: h.specification.deadline,
      tradingEndsAt: h.specification.settlement.tradingEndsAt,
      status: 'CLOSED',
      at: NOW,
    });

    const response = await h.inject({
      method: 'POST',
      url: `/api/markets/${other.rulesHash}/validation-plan`,
      payload: { validationPlan: deliveredPlan() },
    });

    expect(response.statusCode).toBe(403);
  });

  it('accepts a plan from the creator, and stores the normalised form', async () => {
    const h = await serveResolvable();
    const response = await h.inject({
      method: 'POST',
      url: `/api/markets/${h.rulesHash}/validation-plan`,
      payload: {
        validationPlan: {
          checks: [
            {
              checkId: 'status-delivered',
              kind: 'CATEGORICAL_MATCH',
              observation: { sourceId: 'source-0', pointer: null },
              accepted: ['delivered'],
            },
          ],
        },
      },
    });

    expect(response.statusCode).toBe(200);
    // Defaults are applied before storing, so what is stored is what will run —
    // `encodes` in particular, which decides whether SATISFIED means YES or NO.
    expect(response.json().data.validationPlan.encodes).toBe('successCondition');
  });
});
