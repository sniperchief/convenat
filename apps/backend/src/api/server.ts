/**
 * The HTTP surface.
 *
 * `buildServer` takes its dependencies as arguments — no module-level client,
 * no singleton, no `process.env` read at import time. That is what lets a test
 * stand up a real server with a scripted model and in-memory storage in one
 * line, and it is why the route tests exercise the same handlers production
 * runs rather than a parallel implementation.
 *
 * Two routes deliberately return 501: `/resolve` and `/challenge` need the
 * resolution engine, which is Milestone 5. Answering them with plausible-looking
 * data would be worse than answering honestly — a fabricated proposal is
 * exactly the failure this product exists to prevent.
 */

import { randomBytes } from 'node:crypto';

import Fastify from 'fastify';

import {
  buildRulesCommitment,
  validateConditionSpec,
  type ApiSuccess,
  type CompileMarketResponse,
  type EvidenceRecord as EvidenceApiRecord,
  type GetMarketResponse,
  type ListMarketsResponse,
  type MarketSummary,
  type RegisterMarketResponse,
  type ResolutionProposal,
} from '@covenant/shared';

import { assertOwns, bearerToken, type AuthenticatedWallet, AuthService } from '../auth/service.js';
import type { ChainClient } from '../chain/types.js';
import type { Address } from '../chain/types.js';
import type { AppConfig } from '../config.js';
import { ConditionCompiler, type CompilerTurn } from '../compiler/compiler.js';
import {
  ForbiddenError,
  NotFoundError,
  NotImplementedError,
  ValidationError,
  toHttpError,
} from '../errors.js';
import { buildLoggerOptions, describeUserContent } from '../logging.js';
import type {
  MarketChainStateRecord,
  MarketRecord,
  Repositories,
} from '../repositories/types.js';
import {
  DEFAULT_PAGE_SIZE,
  authNonceRequestSchema,
  authVerifyRequestSchema,
  challengeRequestSchema,
  compileRequestSchema,
  listMarketsQuerySchema,
  listPositionsQuerySchema,
  marketIdParamSchema,
  registerMarketRequestSchema,
  resolveRequestSchema,
} from './schemas.js';

export interface ServerDependencies {
  readonly config: AppConfig;
  readonly repositories: Repositories;
  readonly compiler: ConditionCompiler;
  readonly auth: AuthService;
  /**
   * The chain, when one is configured.
   *
   * Null is a real state, not a test convenience: a backend can be brought up
   * before a deployment exists. Routes that need the chain then say so with a
   * 501 rather than inventing values — the same posture the M3 stubs took.
   */
  readonly chain?: ChainClient | null;
  /** Contract addresses from the deployment manifest. Never compiled in. */
  readonly contracts?: {
    readonly factory: Address;
    readonly settlementToken: Address;
  } | null;
  /** Injected so tests can freeze time. */
  readonly now?: () => Date;
}

const ok = <T>(data: T): ApiSuccess<T> => ({ data });

/** Parse with a Zod schema, raising the backend validation error on failure. */
function parse<T>(schema: { safeParse: (input: unknown) => { success: boolean } }, input: unknown): T {
  const result = schema.safeParse(input) as
    | { success: true; data: T }
    | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } };
  if (result.success) return result.data;
  throw new ValidationError(
    'Request validation failed.',
    result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  );
}

/**
 * The return type is inferred rather than annotated as `FastifyInstance`:
 * Fastify's own instance type is parameterised by the server flavour its
 * options select, and pinning it to the default would fight the overload.
 */
export function buildServer(dependencies: ServerDependencies) {
  const { config, repositories, compiler, auth } = dependencies;
  const chain = dependencies.chain ?? null;
  const contracts = dependencies.contracts ?? null;
  const now = dependencies.now ?? ((): Date => new Date());

  const app = Fastify({
    logger: buildLoggerOptions(config),
    // Fastify generates a request id; it is logged on every line and returned
    // on errors so a user-reported failure can be found in the log.
    disableRequestLogging: false,
  });

  app.setErrorHandler((error, request, reply) => {
    const { status, body } = toHttpError(error);
    // The full error, including any cause, goes to the server log. The client
    // gets the projection, which carries no stack and no internals.
    if (status >= 500) {
      request.log.error({ err: error, status }, 'request failed');
    } else {
      request.log.info({ status, code: body.error.code }, 'request rejected');
    }
    void reply.status(status).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    const { status, body } = toHttpError(
      new NotFoundError(`No route for ${request.method} ${request.url}.`),
    );
    void reply.status(status).send(body);
  });

  // --- health --------------------------------------------------------------

  app.get('/health', () =>
    ok({
      status: 'ok' as const,
      compilerVersion: compiler.version,
      chainId: config.chainId,
      network: config.chain.networkKey,
      environment: config.chain.environment,
      // Whether the chain layer is wired, not whether it is reachable. A health
      // endpoint that made an RPC call would fail for reasons outside this
      // process and would be useless as a liveness probe.
      chainConfigured: chain !== null,
      confirmations: config.chain.confirmations,
      time: now().toISOString(),
    }),
  );

  // --- authentication (§30) -------------------------------------------------

  app.post('/api/auth/nonce', async (request, reply) => {
    const body = parse<{ address: string }>(authNonceRequestSchema, request.body);
    const challenge = await auth.createChallenge(body.address);
    // The rendered message is returned so the wallet displays exactly what the
    // server will verify against. The client never composes it.
    return reply.status(200).send(ok(challenge));
  });

  app.post('/api/auth/verify', async (request, reply) => {
    const body = parse<{ nonce: string; signature: string }>(
      authVerifyRequestSchema,
      request.body,
    );
    const { wallet, token } = await auth.verify(body);
    await repositories.wallets.touch(wallet.address, now());

    request.log.info({ address: wallet.address }, 'wallet authenticated');
    // The token is returned once and stored only as a digest.
    return reply.status(200).send(ok({ token, wallet }));
  });

  app.get('/api/auth/me', async (request, reply) => {
    const wallet = await requireWallet(request.headers.authorization);
    return reply.status(200).send(ok({ wallet }));
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const wallet = await requireWallet(request.headers.authorization);
    await auth.revoke(wallet.sessionId);
    return reply.status(200).send(ok({ revoked: true }));
  });

  // --- POST /api/markets/compile ------------------------------------------

  app.post('/api/markets/compile', async (request, reply) => {
    // The creator is the proved wallet, not a field in the body (§30).
    const wallet = await requireWallet(request.headers.authorization);

    const body = parse<{
      message: string;
      chainId: number;
      sessionId?: string;
    }>(compileRequestSchema, request.body);

    if (body.chainId !== config.chainId) {
      throw new ValidationError('This backend does not serve that chain.', [
        { path: 'chainId', message: `expected ${config.chainId}` },
      ]);
    }

    const creator = wallet.address;
    const at = now();
    await repositories.wallets.touch(creator, at);

    // Resume an existing session, or start one.
    let session = body.sessionId === undefined
      ? null
      : await repositories.sessions.findById(body.sessionId);

    if (body.sessionId !== undefined && session === null) {
      throw new NotFoundError('That compiler session does not exist.');
    }
    if (session !== null) {
      // Now a real permission check rather than a consistency check (§31): a
      // session is one wallet's private conversation, and the caller has proved
      // which wallet they are.
      assertOwns(wallet, session.creator, 'compiler session');
    }
    session ??= await repositories.sessions.create({
      creator,
      chainId: body.chainId,
      compilerVersion: compiler.version,
      createdAt: at,
    });

    const history = await repositories.sessions.listTurns(session.id);
    request.log.info(
      {
        sessionId: session.id,
        compilerVersion: compiler.version,
        turns: history.length,
        prompt: describeUserContent(body.message, config),
      },
      'compiling condition',
    );

    await repositories.sessions.appendTurn({
      sessionId: session.id,
      role: 'user',
      content: body.message,
      createdAt: at,
    });

    const result = await compiler.compile({
      message: body.message,
      creator,
      history: history.map<CompilerTurn>((turn) => ({ role: turn.role, content: turn.content })),
    });

    await repositories.sessions.appendTurn({
      sessionId: session.id,
      role: 'assistant',
      content: result.rawOutput,
      createdAt: now(),
    });

    if (result.status === 'INCOMPLETE') {
      request.log.info(
        { sessionId: session.id, status: 'INCOMPLETE', questions: result.questions.length },
        'condition incomplete',
      );
      const response: CompileMarketResponse = {
        status: 'INCOMPLETE',
        sessionId: session.id,
        compilerVersion: result.compilerVersion,
        interpretation: result.interpretation,
        questions: result.questions,
        missing: result.missing,
        partial: result.partial,
      };
      return reply.status(200).send(ok(response));
    }

    await repositories.compilations.save({
      rulesHash: result.rulesHash,
      sessionId: session.id,
      creator,
      chainId: body.chainId,
      specification: result.specification,
      canonical: result.canonical,
      compilerVersion: result.compilerVersion,
      createdAt: now(),
    });
    await repositories.sessions.markCompiled(session.id, now());

    request.log.info(
      { sessionId: session.id, status: 'COMPILED', rulesHash: result.rulesHash },
      'condition compiled',
    );

    const response: CompileMarketResponse = {
      status: 'COMPILED',
      sessionId: session.id,
      compilerVersion: result.compilerVersion,
      interpretation: result.interpretation,
      specification: result.specification,
      rulesHash: result.rulesHash,
      canonical: result.canonical,
    };
    return reply.status(200).send(ok(response));
  });

  // --- POST /api/markets ---------------------------------------------------

  app.post('/api/markets', async (request, reply) => {
    const wallet = await requireWallet(request.headers.authorization);

    const body = parse<{ specification: Record<string, unknown>; rulesHash: string }>(
      registerMarketRequestSchema,
      request.body,
    );

    // The shared schema is the only validator for a specification.
    const validated = validateConditionSpec(body.specification);
    if (!validated.ok) {
      throw new ValidationError('The specification is not valid.', validated.issues);
    }

    // Recompute the hash rather than trusting the client's. A client that sends
    // a hash for a different document would otherwise register a market whose
    // stored rules are not the rules that were committed.
    const commitment = buildRulesCommitment(validated.value);
    if (commitment.rulesHash !== body.rulesHash) {
      throw new ValidationError(
        'The supplied rules hash does not match the specification.',
        [
          {
            path: 'rulesHash',
            message: `expected ${commitment.rulesHash} for this specification`,
          },
        ],
      );
    }

    const spec = commitment.spec;
    if (spec.settlement.token.chainId !== config.chainId) {
      throw new ValidationError('This backend does not serve that chain.', [
        { path: 'specification.settlement.token.chainId', message: `expected ${config.chainId}` },
      ]);
    }

    // The creator is inside the hash, so registering a specification naming
    // someone else would attribute an approval to a wallet that never gave one
    // (§31). The check is against the hashed field, not a body field, because
    // the hashed field is the one the contract will carry.
    assertOwns(wallet, spec.creator, 'specification');

    // The settlement token must be the one this deployment actually uses.
    // A specification naming some other ERC-20 would produce a market whose
    // funds this backend cannot account for.
    if (
      contracts !== null &&
      spec.settlement.token.address.toLowerCase() !== contracts.settlementToken.toLowerCase()
    ) {
      throw new ValidationError('That settlement token is not the one this deployment uses.', [
        {
          path: 'specification.settlement.token.address',
          message: `expected ${contracts.settlementToken}`,
        },
      ]);
    }

    const at = now();
    await repositories.wallets.touch(spec.creator, at);
    await repositories.compilations.save({
      rulesHash: commitment.rulesHash,
      sessionId: null,
      creator: spec.creator,
      chainId: spec.settlement.token.chainId,
      specification: spec,
      canonical: commitment.canonical,
      compilerVersion: compiler.version,
      createdAt: at,
    });

    // PENDING_ONCHAIN, not OPEN: the backend does not create the market. The
    // creator's own wallet commits the hash, and the indexer promotes this
    // record when it observes MarketCreated (ADR-0006).
    await repositories.markets.register({
      rulesHash: commitment.rulesHash,
      chainId: spec.settlement.token.chainId,
      chainMarketId: null,
      contractAddress: null,
      creator: spec.creator,
      question: spec.question,
      specification: spec,
      canonical: commitment.canonical,
      deadline: spec.deadline,
      tradingEndsAt: spec.settlement.tradingEndsAt,
      status: 'PENDING_ONCHAIN',
      at,
    });

    request.log.info({ rulesHash: commitment.rulesHash }, 'specification registered');

    const response: RegisterMarketResponse = {
      rulesHash: commitment.rulesHash,
      canonical: commitment.canonical,
      status: 'PENDING_ONCHAIN',
    };
    return reply.status(201).send(ok(response));
  });

  // --- GET /api/markets ----------------------------------------------------

  app.get('/api/markets', async (request, reply) => {
    const query = parse<{
      chainId?: number;
      status?: MarketSummary['status'];
      creator?: string;
      limit?: number;
      cursor?: string;
    }>(listMarketsQuerySchema, request.query);

    const page = await repositories.markets.list({
      ...(query.chainId === undefined ? {} : { chainId: query.chainId }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.creator === undefined ? {} : { creator: query.creator }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      limit: query.limit ?? DEFAULT_PAGE_SIZE,
    });

    // Stake totals for a page come from one bulk read of the indexed view
    // rather than one lookup per row.
    const cached = await repositories.chainState.list(config.chainId);
    const byRulesHash = new Map(cached.map((state) => [state.rulesHash.toLowerCase(), state]));

    const response: ListMarketsResponse = {
      markets: page.markets.map((market) =>
        toMarketSummary(market, byRulesHash.get(market.rulesHash.toLowerCase()) ?? null),
      ),
      nextCursor: page.nextCursor,
    };
    return reply.status(200).send(ok(response));
  });

  // --- GET /api/markets/:id -----------------------------------------------

  app.get('/api/markets/:id', async (request, reply) => {
    const market = await resolveMarket(request.params);
    const resolution = await repositories.resolutions.findLatestByRulesHash(market.rulesHash);
    const chainState = await repositories.chainState.findByRulesHash(
      config.chainId,
      market.rulesHash,
    );
    const events = await repositories.events.listByRulesHash(market.rulesHash);

    // Re-derive the hash from the stored specification rather than trusting the
    // stored key. If they ever disagree the record is corrupt, and the client
    // should be told rather than shown rules that do not match their hash.
    const recomputed = buildRulesCommitment(market.specification);

    const creation = events.find((event) => event.eventName === 'MarketCreated');

    // The shared `GetMarketResponse` is the M3 contract; `chain`, `events` and
    // `challengeOnChain` are M4 additions the future frontend needs (§33). They
    // are added alongside rather than forced into `challenge`, whose type
    // describes an off-chain challenge record the resolution engine will
    // produce in M5 and which does not exist yet.
    const response: GetMarketResponse & Record<string, unknown> = {
      ...toMarketSummary(market, chainState),
      specification: market.specification,
      rulesHashVerified: recomputed.rulesHash === market.rulesHash,
      resolution: resolution === null ? null : toResolutionProposal(resolution, market),
      challenge: null,
      challengeOnChain: toChallengeView(chainState),
      creationTxHash: (creation?.transactionHash ?? null) as `0x${string}` | null,
      // Everything the future frontend needs to render this market (§33),
      // labelled with where each number came from.
      chain: toChainView(chainState),
      events: events.map((event) => ({
        name: event.eventName,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
        logIndex: event.logIndex,
        args: event.args,
      })),
    };
    return reply.status(200).send(ok(response));
  });

  // --- GET /api/markets/:id/evidence --------------------------------------

  app.get('/api/markets/:id/evidence', async (request, reply) => {
    const market = await resolveMarket(request.params);
    const record = await repositories.evidence.findByRulesHash(market.rulesHash);
    if (record === null) {
      // A 404 because no evidence exists — not an empty package. Serving a
      // hollow evidence document would imply a resolution that never happened.
      throw new NotFoundError('No evidence has been published for this market yet.');
    }

    const response: EvidenceApiRecord = {
      marketId: market.chainMarketId ?? market.rulesHash,
      evidenceHash: record.evidenceHash,
      package: record.package,
      verified: true,
    };
    return reply.status(200).send(ok(response));
  });

  // --- POST /api/markets/:id/resolve --------------------------------------

  app.post('/api/markets/:id/resolve', async (request) => {
    parse(marketIdParamSchema, request.params);
    parse(resolveRequestSchema, request.body ?? {});
    throw new NotImplementedError(
      'Resolution is not available yet. The resolution engine, evidence retrieval and on-chain ' +
        'proposal arrive in a later milestone; until then this endpoint will not return an outcome.',
    );
  });

  // --- POST /api/markets/:id/challenge -------------------------------------

  app.post('/api/markets/:id/challenge', async (request) => {
    parse(marketIdParamSchema, request.params);
    parse(challengeRequestSchema, request.body);
    throw new NotImplementedError(
      'Challenges are not available yet. Filing one requires an on-chain proposal to contest and ' +
        'a bond transaction to verify, both of which arrive in a later milestone.',
    );
  });

  // --- GET /api/positions --------------------------------------------------

  /**
   * Positions, read from the contracts.
   *
   * The M3 version of this route was a 501 because an empty list would have
   * claimed the caller holds nothing when the truth was that we could not see.
   * We can see now — so it answers, and it answers from the **contract**, not
   * from the indexed cache. A position is a claim on money; it is read from the
   * only authority on that.
   */
  app.get('/api/positions', async (request, reply) => {
    const wallet = await requireWallet(request.headers.authorization);
    const query = parse<{ wallet?: string; chainId?: number }>(
      listPositionsQuerySchema,
      request.query,
    );

    if (query.chainId !== undefined && query.chainId !== config.chainId) {
      throw new ValidationError('This backend does not serve that chain.', [
        { path: 'chainId', message: `expected ${config.chainId}` },
      ]);
    }

    if (chain === null) {
      throw new NotImplementedError(
        'Positions need a configured chain connection, and this backend has none. It is running ' +
          'without a deployment manifest.',
      );
    }

    const subject = (query.wallet ?? wallet.address).toLowerCase() as Address;
    const markets = await repositories.chainState.list(config.chainId);

    const positions = [];
    for (const market of markets) {
      const position = await chain.readPosition(market.contractAddress as Address, subject);
      if (position.yes === 0n && position.no === 0n) continue;

      positions.push({
        marketId: market.chainMarketId,
        address: market.contractAddress,
        rulesHash: market.rulesHash,
        state: market.state,
        yesBaseUnits: position.yes.toString(),
        noBaseUnits: position.no.toString(),
        hasClaimed: position.hasClaimed,
        claimableBaseUnits: position.previewClaim.toString(),
        // Said explicitly so a UI never has to guess whether a number is cached.
        origin: 'chain' as const,
      });
    }

    return reply.status(200).send(ok({ wallet: subject, positions }));
  });

  // -------------------------------------------------------------------------

  async function resolveMarket(params: unknown): Promise<MarketRecord> {
    const { id } = parse<{ id: string }>(marketIdParamSchema, params);
    const market = id.startsWith('0x')
      ? await repositories.markets.findByRulesHash(id)
      : await repositories.markets.findByChainMarketId(config.chainId, id);
    if (market === null) throw new NotFoundError('No such market.');
    return market;
  }

  /** Resolve the bearer token, or refuse the request. */
  async function requireWallet(header: string | undefined): Promise<AuthenticatedWallet> {
    const wallet = await auth.authenticate(bearerToken(header));
    if (wallet.chainId !== config.chainId) {
      // A session opened against a different chain is not this backend's
      // session, even though the signature was valid.
      throw new ForbiddenError('That session was opened for a different chain.');
    }
    return wallet;
  }

  return app;
}

/**
 * The list/summary projection.
 *
 * Stake totals come from the indexed chain state when it exists. When it does
 * not, they are reported as `'0'` with `origin: 'indexer'` — which says the
 * number is a cache that has not been filled, not that the market is empty. A
 * UI that shows a total must show where it came from.
 */
function toMarketSummary(
  market: MarketRecord,
  chainState?: MarketChainStateRecord | null,
): MarketSummary {
  return {
    // Before the factory assigns one, the rules hash is the market's identity.
    marketId: market.chainMarketId ?? market.rulesHash,
    chainId: market.chainId,
    address: (market.contractAddress ?? '0x') as `0x${string}`,
    status: market.status,
    question: market.question,
    rulesHash: market.rulesHash,
    deadline: market.deadline,
    tradingEndsAt: market.tradingEndsAt,
    totalYesBaseUnits: chainState?.totalYes ?? '0',
    totalNoBaseUnits: chainState?.totalNo ?? '0',
    createdAt: market.createdAt,
    origin: 'indexer',
  };
}

/** The cached chain view, or null when the indexer has not reached this market. */
function toChainView(state: MarketChainStateRecord | null): unknown {
  if (state === null) return null;
  return {
    address: state.contractAddress,
    marketId: state.chainMarketId,
    state: state.state,
    totalYesBaseUnits: state.totalYes,
    totalNoBaseUnits: state.totalNo,
    poolBaseUnits: state.pool,
    challengeBondBaseUnits: state.challengeBond,
    proposedOutcome: state.proposedOutcome,
    finalOutcome: state.finalOutcome,
    cancellationReason: state.cancellationReason,
    proposalRound: state.proposalRound,
    refundMode: state.refundMode,
    evidenceHash: state.evidenceHash,
    challengeEndsAt: state.challengeEndsAt,
    lastEventBlock: state.lastEventBlock,
    observedAt: state.updatedAt,
    // The contract is authoritative; this is a cache of it. Saying so in the
    // payload means a client never has to assume.
    origin: 'indexer',
  };
}

/** Challenge status, when a challenge has actually been filed on-chain. */
function toChallengeView(state: MarketChainStateRecord | null): null | Record<string, unknown> {
  if (state === null) return null;
  if (state.challenger === '0x0000000000000000000000000000000000000000') return null;
  return {
    challenger: state.challenger,
    bondBaseUnits: state.challengeBond,
    bondOutstanding: state.bondOutstanding,
    challengedAt: state.challengedAt,
    round: state.proposalRound,
  };
}

function toResolutionProposal(
  record: {
    status: ResolutionProposal['status'];
    outcome: ResolutionProposal['outcome'];
    confidenceBps: number;
    reason: string;
    evidenceHash: ResolutionProposal['evidenceHash'];
    resolverVersion: string;
    round: number;
    proposedAt: string | null;
    finalizedAt: string | null;
  },
  market: MarketRecord,
): ResolutionProposal {
  return {
    marketId: market.chainMarketId ?? market.rulesHash,
    status: record.status,
    outcome: record.outcome,
    confidenceBps: record.confidenceBps,
    reason: record.reason,
    evidenceHash: record.evidenceHash,
    resolverVersion: record.resolverVersion,
    round: record.round,
    proposedAt: record.proposedAt,
    challengeEndsAt: null,
    finalizedAt: record.finalizedAt,
    proposalTxHash: null,
  };
}

/** A 32-byte hex nonce, used to make each approved specification unique. */
export function randomNonce(): string {
  return `0x${randomBytes(32).toString('hex')}`;
}
