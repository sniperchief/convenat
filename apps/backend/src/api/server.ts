/**
 * The HTTP surface.
 *
 * `buildServer` takes its dependencies as arguments — no module-level client,
 * no singleton, no `process.env` read at import time. That is what lets a test
 * stand up a real server with a scripted model and in-memory storage in one
 * line, and it is why the route tests exercise the same handlers production
 * runs rather than a parallel implementation.
 *
 * A route answers honestly or not at all. Where a capability is genuinely
 * absent — no chain configured, no resolver key — the route says so with a 501
 * and a reason, because a fabricated proposal is exactly the failure this
 * product exists to prevent.
 *
 * ## Who may do what
 *
 * | Route | Who |
 * | --- | --- |
 * | `POST /api/markets/compile`, `POST /api/markets` | The authenticated creator; the hashed `creator` must be their wallet |
 * | `POST /api/markets/:id/resolve` | Any authenticated wallet may *trigger* it. The **resolver identity is the server's key** and is never taken from a request |
 * | `POST /api/markets/:id/challenge` | The authenticated wallet, and only if the contract already records it as the challenger |
 * | `POST /api/markets/:id/finalize` | Anyone. `finalize()` is permissionless on the contract and takes no arguments |
 * | Everything else | Public reads of public facts |
 *
 * Triggering a resolution is not an authority over its result: the outcome comes
 * from the evidence and the checks, and the caller cannot influence either.
 */

import { randomBytes } from 'node:crypto';

import Fastify from 'fastify';

import {
  buildRulesCommitment,
  hashCanonicalText,
  validateConditionSpec,
  verifyEvidenceHash,
  type ApiSuccess,
  type ChallengeMarketResponse,
  type CompileMarketResponse,
  type EvidenceRecord as EvidenceApiRecord,
  type FinalizeMarketResponse,
  type GetMarketResponse,
  type GetResolutionResponse,
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
import type { MarketResolutionService } from '../resolution/service.js';
import { validateValidationPlan } from '../validation/plan.js';
import { toResolutionDetail } from './resolution-view.js';
import {
  DEFAULT_PAGE_SIZE,
  authNonceRequestSchema,
  authVerifyRequestSchema,
  challengePrepareRequestSchema,
  challengeRequestSchema,
  compileRequestSchema,
  listMarketsQuerySchema,
  listPositionsQuerySchema,
  marketIdParamSchema,
  registerMarketRequestSchema,
  resolveRequestSchema,
  validationPlanRequestSchema,
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
  /**
   * The resolution service, when one is configured.
   *
   * Null for the same reason `chain` may be null: a backend can serve the
   * compiler and the market registry without an evidence pipeline. `/resolve`
   * then returns 501 with the reason rather than pretending.
   */
  readonly resolution?: MarketResolutionService | null;
  /**
   * Origins the browser client is served from, for CORS.
   *
   * An explicit list, never `*`: this API carries bearer tokens, and a wildcard
   * would let any page a user visits spend their session.
   */
  readonly corsOrigins?: readonly string[];
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
  const resolution = dependencies.resolution ?? null;
  const corsOrigins = new Set((dependencies.corsOrigins ?? []).map((origin) => origin.toLowerCase()));
  const now = dependencies.now ?? ((): Date => new Date());

  const app = Fastify({
    logger: buildLoggerOptions(config),
    // Fastify generates a request id; it is logged on every line and returned
    // on errors so a user-reported failure can be found in the log.
    disableRequestLogging: false,
  });

  // --- CORS ----------------------------------------------------------------
  //
  // Hand-rolled rather than a plugin, because the policy is four lines and the
  // one property that matters is that it is not `*`. The origin is echoed only
  // when it is on the configured list, so a page the user did not intend to
  // trust cannot read a response carrying their session's data.
  if (corsOrigins.size > 0) {
    app.addHook('onRequest', async (request, reply) => {
      const origin = request.headers.origin;
      if (typeof origin === 'string' && corsOrigins.has(origin.toLowerCase())) {
        void reply.header('access-control-allow-origin', origin);
        void reply.header('vary', 'Origin');
        void reply.header('access-control-allow-headers', 'content-type, authorization');
        void reply.header('access-control-allow-methods', 'GET, POST, OPTIONS');
        void reply.header('access-control-max-age', '600');
      }
      if (request.method === 'OPTIONS') {
        // Answered here rather than falling through to the 404 handler, which
        // would make every preflight look like a routing bug in the log.
        await reply.status(204).send();
      }
    });
  }

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
      resolutionConfigured: resolution !== null,
      // Whether a key capable of proposing is loaded — never the key, and never
      // the address's balance or any other fact that would need an RPC call.
      resolverConfigured: resolution?.canSubmit ?? false,
      resolverAddress: resolution?.resolverAddress ?? null,
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

    const body = parse<{
      specification: Record<string, unknown>;
      rulesHash: string;
      validationPlan?: Record<string, unknown>;
    }>(registerMarketRequestSchema, request.body);

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

    // The plan is validated before anything is written, so a market is never
    // registered alongside criteria that would fail at resolution time.
    const plan = body.validationPlan === undefined ? null : parseValidationPlan(body.validationPlan, spec.approvedSources.length);

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
      validationPlan: plan,
      deadline: spec.deadline,
      tradingEndsAt: spec.settlement.tradingEndsAt,
      status: 'PENDING_ONCHAIN',
      at,
    });

    // `register` is idempotent on `rulesHash` and returns the existing row
    // unchanged, so a plan supplied on a re-registration would be silently
    // dropped. Writing it explicitly is what makes "register, then add criteria"
    // work as a two-step flow.
    if (plan !== null) {
      await repositories.markets.setValidationPlan({
        rulesHash: commitment.rulesHash,
        plan,
        at,
      });
    }

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
    const latestResolution = await repositories.resolutions.findLatestByRulesHash(market.rulesHash);
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
    const challengeDoc = await repositories.challenges.findByRulesHash(market.rulesHash);

    const response: GetMarketResponse & Record<string, unknown> = {
      ...toMarketSummary(market, chainState),
      specification: market.specification,
      rulesHashVerified: recomputed.rulesHash === market.rulesHash,
      resolution: latestResolution === null ? null : toResolutionProposal(latestResolution, market, chainState),
      // The full "why", so the detail page needs one request rather than two.
      resolutionDetail:
        latestResolution === null ? null : toResolutionDetail(latestResolution, market),
      validationPlan: market.validationPlan,
      challenge:
        challengeDoc === null
          ? null
          : {
              marketId: market.chainMarketId ?? market.rulesHash,
              challenger: challengeDoc.challenger as `0x${string}`,
              reasonHash: challengeDoc.reasonHash,
              reason: challengeDoc.reason,
              bondBaseUnits: challengeDoc.bond,
              challengedAt: challengeDoc.challengedAt,
              txHash: challengeDoc.txHash as `0x${string}`,
              bondRefunded: null,
            },
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

    // Re-derived, not asserted. `verified: true` as a constant would be exactly
    // the theatre this product exists to replace — the point of publishing a
    // package is that the digest can be recomputed from it, so the server does
    // that too rather than repeating what it stored.
    const verified = verifyEvidenceHash(record.package, record.evidenceHash);

    const chainState = await repositories.chainState.findByRulesHash(
      config.chainId,
      market.rulesHash,
    );
    const committed = chainState?.evidenceHash ?? null;

    const response: EvidenceApiRecord & Record<string, unknown> = {
      marketId: market.chainMarketId ?? market.rulesHash,
      evidenceHash: record.evidenceHash,
      package: record.package,
      verified,
      // Whether the served document is the one the *contract* holds, which is a
      // different and stronger question than whether it re-hashes to itself.
      committedOnChain: committed,
      matchesOnChain:
        committed === null
          ? null
          : committed.toLowerCase() === record.evidenceHash.toLowerCase(),
    };
    return reply.status(200).send(ok(response));
  });

  // --- PUT /api/markets/:id/validation-plan -------------------------------

  /**
   * Attach deterministic acceptance criteria to a market.
   *
   * Restricted to the creator: the plan decides what the market settles on, and
   * it is not inside `rulesHash` (ADR-0017), so the only defensible holder of it
   * is the wallet that approved the rules in the first place.
   */
  app.post('/api/markets/:id/validation-plan', async (request, reply) => {
    const wallet = await requireWallet(request.headers.authorization);
    const market = await resolveMarket(request.params);
    assertOwns(wallet, market.creator, 'market');

    const body = parse<{ validationPlan: Record<string, unknown> }>(
      validationPlanRequestSchema,
      request.body,
    );
    const plan = parseValidationPlan(
      body.validationPlan,
      market.specification.approvedSources.length,
    );

    const updated = await repositories.markets.setValidationPlan({
      rulesHash: market.rulesHash,
      plan,
      at: now(),
    });
    if (updated === null) throw new NotFoundError('No such market.');

    return reply.status(200).send(ok({ rulesHash: market.rulesHash, validationPlan: plan }));
  });

  // --- POST /api/markets/:id/resolve --------------------------------------

  /**
   * Run the resolution pipeline.
   *
   * Authenticated, but not privileged: *triggering* a resolution is not an
   * authority over its result. The outcome comes from the approved sources and
   * the committed criteria, the resolver identity is the server's key, and
   * nothing in the request body can reach either.
   */
  app.post('/api/markets/:id/resolve', async (request, reply) => {
    // Order matters, and it is the M3 order: who you are, then whether the
    // request is well-formed, then whether the capability exists, then whether
    // the thing exists. Validating last would let a malformed request be
    // answered with a 501 that says nothing about what was wrong with it.
    await requireWallet(request.headers.authorization);
    parse(marketIdParamSchema, request.params);
    const body = parse<{ force?: boolean; dryRun?: boolean }>(
      resolveRequestSchema,
      request.body ?? {},
    );

    const service = requireResolution();
    const market = await resolveMarket(request.params);

    const outcome = await service.resolveMarket(market, {
      ...(body.force === undefined ? {} : { force: body.force }),
      ...(body.dryRun === undefined ? {} : { dryRun: body.dryRun }),
    });

    request.log.info(
      {
        rulesHash: market.rulesHash,
        status: outcome.status,
        reason: outcome.reason,
        submission: outcome.submissionState,
      },
      'resolution attempted',
    );

    // Every terminal state is a 200. A market the engine will not resolve is the
    // system working, not a client error — and a 4xx would tell a UI to show a
    // failure banner where it should show the reasoning.
    const detail =
      outcome.persisted === null
        ? syntheticDetail(outcome, market)
        : toResolutionDetail(outcome.persisted, market);

    return reply.status(200).send(ok(detail));
  });

  // --- GET /api/markets/:id/resolution ------------------------------------

  app.get('/api/markets/:id/resolution', async (request, reply) => {
    const market = await resolveMarket(request.params);
    const history = await repositories.resolutions.listByRulesHash(market.rulesHash);
    const details = history.map((record) => toResolutionDetail(record, market));

    const response: GetResolutionResponse = {
      marketId: market.chainMarketId ?? market.rulesHash,
      latest: details[0] ?? null,
      history: details,
      onChain: await readProposalView(market),
    };
    return reply.status(200).send(ok(response));
  });

  // --- POST /api/markets/:id/challenge/prepare -----------------------------

  /**
   * Hash a challenge argument, so the challenger can commit exactly those bytes.
   *
   * This exists because the protocol has **one** implementation of every hash
   * (ADR-0001) and it lives in `@covenant/shared`. A browser cannot keccak256
   * without a library, and shipping one so the client could compute a protocol
   * hash is precisely what that ADR forbids — two implementations of one digest
   * eventually disagree, and the disagreement surfaces as a challenge the
   * contract rejects.
   *
   * Nothing is stored and nothing is decided here. The value returned is
   * `keccak256(utf8(reason))` and the caller is free to compute it themselves;
   * the check that matters happens later, when the recorded text is compared
   * against what the contract actually holds.
   */
  app.post('/api/markets/:id/challenge/prepare', async (request, reply) => {
    await requireWallet(request.headers.authorization);
    parse(marketIdParamSchema, request.params);
    const body = parse<{ reason: string }>(challengePrepareRequestSchema, request.body);
    await resolveMarket(request.params);
    return reply.status(200).send(ok({ reasonHash: hashCanonicalText(body.reason) }));
  });

  // --- POST /api/markets/:id/challenge -------------------------------------

  /**
   * Record the argument behind a challenge that already exists on-chain.
   *
   * The backend does not file the challenge and does not judge it. Filing moves
   * the challenger's own bond, so their wallet sends `challenge(reasonHash)`;
   * whether the challenge wins is decided by `finalize()` comparing the
   * replacement outcome against the challenged one. This endpoint attaches the
   * text behind the committed hash, and refuses anything that does not match.
   */
  app.post('/api/markets/:id/challenge', async (request, reply) => {
    const wallet = await requireWallet(request.headers.authorization);
    parse(marketIdParamSchema, request.params);
    const body = parse<{ reason: string; txHash: string }>(challengeRequestSchema, request.body);

    const service = requireResolution();
    const market = await resolveMarket(request.params);
    const result = await service.recordChallenge({
      market,
      challenger: wallet.address,
      reason: body.reason,
      txHash: body.txHash,
    });

    if (!result.ok) {
      // A 409: the request is well-formed and the caller may be entitled to
      // challenge — the *state* is what refuses it.
      throw new ValidationError(result.detail, [{ path: 'txHash', message: result.code }]);
    }

    const response: ChallengeMarketResponse = {
      marketId: market.chainMarketId ?? market.rulesHash,
      challenger: result.onChain.challenger,
      reasonHash: result.reasonHash,
      reason: body.reason,
      bondBaseUnits: result.onChain.challengeBond.toString(),
      challengedAt: new Date(result.onChain.challengedAt * 1000).toISOString(),
      txHash: body.txHash as `0x${string}`,
      // Null while the review is outstanding: whether the bond comes back is
      // decided at finalization, by the contract, and claiming to know now would
      // be a guess about someone else's money.
      bondRefunded:
        result.onChain.state === 'FINALIZED' || result.onChain.state === 'SETTLED'
          ? result.onChain.bondRefundable
          : null,
    };
    return reply.status(201).send(ok(response));
  });

  // --- POST /api/markets/:id/finalize --------------------------------------

  /**
   * Make a standing proposal final.
   *
   * Unauthenticated on purpose: `finalize()` is permissionless on the contract,
   * takes no arguments, and can only be called once the challenge window has
   * closed. Requiring a login here would invent a gate the protocol does not
   * have — and liveness that depends on this backend is exactly what ADR-0004
   * refuses.
   */
  app.post('/api/markets/:id/finalize', async (request, reply) => {
    parse(marketIdParamSchema, request.params);
    const service = requireResolution();
    const market = await resolveMarket(request.params);

    if (market.contractAddress === null) {
      throw new ValidationError('This market has not been created on-chain yet.', [
        { path: 'id', message: 'no contract address' },
      ]);
    }

    const result = await service.finalizeMarket(market);
    const response: FinalizeMarketResponse = {
      marketId: market.chainMarketId ?? market.rulesHash,
      submitted: result.submitted,
      txHash: result.txHash === null ? null : (result.txHash as `0x${string}`),
      state: result.onChain.state,
      finalOutcome: result.onChain.finalOutcome,
      refundMode: result.onChain.refundMode,
      detail: result.detail,
    };
    return reply.status(200).send(ok(response));
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

  /** The resolution service, or an honest 501 saying why there is none. */
  function requireResolution(): MarketResolutionService {
    if (resolution === null) {
      throw new NotImplementedError(
        'This backend is running without a resolution pipeline — it has no chain connection or no ' +
          'deployment manifest. No outcome will be invented in its place.',
      );
    }
    return resolution;
  }

  /**
   * The on-chain view of the standing proposal.
   *
   * Read from the contract rather than from the indexed cache: this is what a
   * user decides whether to challenge on, and a stale challenge deadline is the
   * one number here that could cost someone their chance to contest.
   */
  async function readProposalView(
    market: MarketRecord,
  ): Promise<GetResolutionResponse['onChain']> {
    if (chain === null || market.contractAddress === null) return null;

    const onChain = await chain.readMarket(market.contractAddress as Address);
    if (onChain.proposalRound === 0) return null;

    const nowSeconds = Math.floor(now().getTime() / 1000);
    const standing = onChain.state === 'RESOLUTION_PROPOSED';

    return {
      state: onChain.state,
      proposedOutcome: onChain.proposedOutcome,
      finalOutcome: onChain.finalOutcome,
      evidenceHash: onChain.evidenceHash,
      proposalRound: onChain.proposalRound,
      proposedAt: new Date(onChain.proposedAt * 1000).toISOString(),
      challengeEndsAt: new Date(onChain.challengeEndsAt * 1000).toISOString(),
      // Only round 1 is contestable; the replacement is final (ADR-0004).
      challengeWindowOpen:
        standing && onChain.proposalRound === 1 && nowSeconds < onChain.challengeEndsAt,
      finalizable: standing && nowSeconds >= onChain.challengeEndsAt,
      proposalsExhausted: onChain.proposalRound >= 2,
      secondProposalRequired: onChain.state === 'CHALLENGED',
    };
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
    proposalTxHash: string | null;
  },
  market: MarketRecord,
  chainState: MarketChainStateRecord | null,
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
    // From the indexed chain state, which is where the deadline actually lives —
    // it is `proposedAt + challengeWindow`, computed by the contract. Null when
    // the indexer has not reached this market rather than computed here, because
    // two implementations of one deadline eventually disagree.
    challengeEndsAt:
      chainState === null || chainState.challengeEndsAt === '0'
        ? null
        : new Date(Number(chainState.challengeEndsAt) * 1000).toISOString(),
    finalizedAt: record.finalizedAt,
    proposalTxHash: record.proposalTxHash === null ? null : (record.proposalTxHash as `0x${string}`),
  };
}

/**
 * Validate a supplied validation plan.
 *
 * Two gates, and the second is the one that matters. The schema check rejects a
 * malformed plan; the source check rejects a *well-formed* plan that points at a
 * source the user never approved. Without it, an unhashed operator document
 * could quietly widen the evidence policy that `approvedSources` exists to fix.
 */
function parseValidationPlan(input: unknown, approvedSourceCount: number): Record<string, unknown> {
  const parsed = validateValidationPlan(input);
  if (!parsed.ok) {
    throw new ValidationError(
      'The validation plan is not valid.',
      parsed.issues.map((issue) => ({
        path: `validationPlan.${issue.path}`,
        message: issue.message,
      })),
    );
  }

  parsed.plan.checks.forEach((check, index) => {
    const match = /^source-(\d+)$/.exec(check.observation.sourceId);
    const position = match === null ? null : Number.parseInt(match[1] ?? '', 10);
    if (position === null || !Number.isSafeInteger(position) || position >= approvedSourceCount) {
      throw new ValidationError('The validation plan references a source this market did not approve.', [
        {
          path: `validationPlan.checks.${index}.observation.sourceId`,
          message:
            `must be source-0 through source-${approvedSourceCount - 1}; this specification ` +
            `approved ${approvedSourceCount} source(s)`,
        },
      ]);
    }
  });

  // Returned as the normalised plan rather than the caller's object: defaults
  // (notably `encodes`) are applied, so what is stored is what will be run.
  return parsed.plan as unknown as Record<string, unknown>;
}

/**
 * A resolution outcome that never reached the engine, so was never persisted.
 *
 * Only `INVALID` outcomes take this path — a market that is still open, or one
 * whose stored specification does not hash to what the chain holds. Nothing was
 * proposed and nothing was recorded, and this says so rather than inventing a
 * row to point at.
 */
function syntheticDetail(
  outcome: {
    status: string;
    reason: string | null;
    detail: string;
    resolvedAt: string;
    round: number;
  },
  market: MarketRecord,
): Record<string, unknown> {
  return {
    marketId: market.chainMarketId ?? market.rulesHash,
    rulesHash: market.rulesHash,
    status: outcome.status,
    reason: outcome.reason,
    detail: outcome.detail,
    outcome: null,
    confidenceBps: 0,
    reasoning: null,
    rationale: null,
    verdict: null,
    deterministicChecks: [],
    sources: [],
    claims: [],
    evidenceHash: null,
    resolverVersion: '',
    model: null,
    round: outcome.round,
    resolvedAt: outcome.resolvedAt,
    proposalTxHash: null,
    proposalBlockNumber: null,
    submissionState: 'NOT_SUBMITTED',
  };
}

/** A 32-byte hex nonce, used to make each approved specification unique. */
export function randomNonce(): string {
  return `0x${randomBytes(32).toString('hex')}`;
}
