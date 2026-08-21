/**
 * The composition root.
 *
 * One place where real dependencies are constructed, shared by the API process,
 * the indexer process and the reconciliation command. Everything below this file
 * takes what it needs as an argument, which is why the test suite needs no key,
 * no database and no network.
 *
 * The startup order here is deliberate and is a safety property, not a
 * convenience:
 *
 *   1. Build configuration — every missing variable reported at once.
 *   2. Load the deployment manifest, and refuse it if it is for another chain or
 *      another environment (§14).
 *   3. Ask the node what chain it serves, and **fail if it is not the configured
 *      one** (§15).
 *
 * Step 3 is what makes "backend configured for testnet, RPC pointed at mainnet"
 * a startup crash instead of a silent, expensive mistake. It happens before the
 * HTTP listener binds and before the indexer reads a single log.
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import type { DeploymentManifest } from '@covenant/shared';

import { AuthService } from './auth/service.js';
import { ViemChainClient } from './chain/client.js';
import { addressesFrom, loadDeploymentManifest, type DeployedAddresses } from './chain/manifest.js';
import type { ChainClient, ResolverChainWriter } from './chain/types.js';
import { ViemResolverWriter } from './chain/writer.js';
import { MarketResolutionService } from './resolution/service.js';
import { ConditionCompiler } from './compiler/compiler.js';
import { loadConfig, type AppConfig } from './config.js';
import { EvidenceRetriever } from './evidence/retriever.js';
import { HttpsSourceAdapter } from './evidence/https-adapter.js';
import { AnthropicLLMProvider } from './llm/anthropic-provider.js';
import { ResolutionEngine } from './resolution/engine.js';
import { createDrizzleRepositories } from './repositories/drizzle.js';
import type { Repositories } from './repositories/types.js';
import { randomNonce } from './api/server.js';

export interface Runtime {
  readonly config: AppConfig;
  readonly repositories: Repositories;
  readonly compiler: ConditionCompiler;
  readonly auth: AuthService;
  readonly manifest: DeploymentManifest;
  readonly addresses: DeployedAddresses;
  readonly chain: ChainClient;
  /**
   * Reads approved evidence sources. Constructed here so the address policy and
   * every bound come from configuration rather than from a default buried in
   * whichever module happens to need it first.
   */
  readonly evidence: EvidenceRetriever;
  /**
   * Interprets retrieved evidence against a specification and the deterministic
   * checks, producing a proposal or a review.
   *
   * Constructed here, alongside the compiler, and given the same provider type
   * through the same `LLMProvider` port. Nothing in the engine names a vendor —
   * swapping this one line is the whole of replacing the model.
   *
   * It has no chain client and no signer, deliberately: proposing on-chain is
   * not part of this component and there is no path from it to a transaction.
   */
  readonly resolver: ResolutionEngine;
  /**
   * The signer, or null when no resolver key is configured.
   *
   * Null is a usable posture, not a broken one: the backend then produces and
   * persists proposals without submitting them, which is what an operator wants
   * while reviewing what the resolver would do.
   */
  readonly resolverWriter: ResolverChainWriter | null;
  /**
   * The pipeline that turns a market into a proposal on-chain.
   *
   * It is given the engine, the retriever, the read client and the writer — and
   * it is the only component holding all four. That concentration is deliberate:
   * the path from "a model said something" to "a transaction was sent" should be
   * readable in one file.
   */
  readonly resolution: MarketResolutionService;
  /** Releases the connection pool. Every entry point must call it on shutdown. */
  close(): Promise<void>;
}

/**
 * Build everything, with the chain-id check already performed.
 *
 * @throws {ConfigurationError} on bad configuration or an unusable manifest.
 * @throws {ChainMismatchError} when the RPC endpoint serves a different chain.
 */
export async function createRuntime(env: NodeJS.ProcessEnv = process.env): Promise<Runtime> {
  const config = loadConfig(env);

  // The manifest is the only source of contract addresses (§14). It is loaded
  // before anything connects, so a wrong-environment manifest fails fast and
  // cheaply.
  const manifest = loadDeploymentManifest({
    path: config.chain.manifestPath,
    chainId: config.chainId,
    environment: config.chain.environment,
  });
  const addresses = addressesFrom(manifest);

  const chain = new ViemChainClient({
    chainId: config.chainId,
    rpcUrl: config.chain.rpcUrl,
    factoryAddress: addresses.factory,
    confirmations: config.chain.confirmations,
    logRangeLimit: config.chain.logRangeLimit,
  });

  // §15. Fatal, and before anything else touches the network.
  await chain.assertChainId();

  // Pool settings sized for a serverless Postgres that scales to zero.
  //
  // Neon (and Supabase, and Aurora Serverless) suspend an idle database and take
  // seconds to wake. Two defaults in `pg` are wrong for that:
  //
  //  - `connectionTimeoutMillis: 0` means "wait forever", which in practice
  //    means the OS TCP timeout fires first and surfaces as `ETIMEDOUT` — a
  //    confusing error for what is really a cold start.
  //  - `idleTimeoutMillis: 10000` keeps sockets the provider has already closed,
  //    so the *next* request fails with `Client network socket disconnected
  //    before secure TLS connection was established` before it can retry.
  //
  // Both were observed against the live database. The values below give a cold
  // start room to finish and drop idle sockets before the provider does.
  const pool = new Pool({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 30_000,
    idleTimeoutMillis: 5_000,
    // Small on purpose. This process is one of several sharing one database —
    // the API, the indexer and the reconciler all connect — and a provider that
    // caps concurrent connections punishes a large pool per process rather than
    // rewarding it. Measured behaviour on the live database: the first two
    // connections succeed and subsequent ones time out.
    max: 3,
    // TCP keepalive on the sockets that do stay open, so a silently dropped
    // connection is detected rather than discovered mid-query.
    keepAlive: true,
  });

  // A pool-level error would otherwise be an unhandled 'error' event and take
  // the process down. A dropped idle socket is normal here, not fatal: the pool
  // discards it and the next checkout opens a fresh one.
  pool.on('error', () => undefined);
  const db = drizzle(pool, { schema: await import('./db/schema.js') });
  const repositories = createDrizzleRepositories(db);

  const compiler = new ConditionCompiler({
    provider: new AnthropicLLMProvider({
      apiKey: config.llm.apiKey,
      model: config.llm.model,
    }),
    token: {
      ...config.settlementToken,
      // The token address comes from the manifest, never from an environment
      // variable that could disagree with what was deployed.
      address: addresses.settlementToken,
    },
    policy: config.marketPolicy,
    maxOutputTokens: config.llm.maxOutputTokens,
    timeoutMs: config.llm.timeoutMs,
    now: () => new Date(),
    nonce: randomNonce,
  });

  const resolver = new ResolutionEngine({
    provider: new AnthropicLLMProvider({
      apiKey: config.llm.apiKey,
      model: config.llm.model,
    }),
    maxOutputTokens: config.llm.maxOutputTokens,
    timeoutMs: config.llm.timeoutMs,
    confidenceFloorBps: config.resolution.confidenceFloorBps,
    maxEvidenceCharsPerSource: config.resolution.maxEvidenceCharsPerSource,
  });

  const auth = new AuthService({
    nonces: repositories.authNonces,
    sessions: repositories.authSessions,
    policy: {
      domain: config.auth.domain,
      uri: config.auth.uri,
      chainId: config.chainId,
      nonceTtlSeconds: config.auth.nonceTtlSeconds,
      sessionTtlSeconds: config.auth.sessionTtlSeconds,
    },
    now: () => new Date(),
  });

  const urlPolicy = {
    allowedPorts: config.evidence.allowedPorts,
    allowedHosts: config.evidence.allowedHosts,
  };

  const evidence = new EvidenceRetriever({
    adapters: [new HttpsSourceAdapter({ urlPolicy })],
    urlPolicy,
    limits: {
      timeoutMs: config.evidence.timeoutMs,
      maxResponseBytes: config.evidence.maxResponseBytes,
      maxRetainedChars: config.evidence.maxRetainedChars,
      maxAttempts: config.evidence.maxAttempts,
      retryBackoffMs: config.evidence.retryBackoffMs,
      maxRedirects: config.evidence.maxRedirects,
      totalBudgetMs: config.evidence.totalBudgetMs,
    },
    now: () => new Date(),
  });

  // The signer is built only when a key is present. It is constructed *after*
  // `assertChainId`, so a key can never be used against a chain this process has
  // not confirmed.
  const resolverWriter =
    config.resolverPrivateKey === null
      ? null
      : new ViemResolverWriter({
          chainId: config.chainId,
          rpcUrl: config.chain.rpcUrl,
          privateKey: config.resolverPrivateKey,
        });

  const resolution = new MarketResolutionService({
    repositories,
    chain,
    writer: resolverWriter,
    retriever: evidence,
    engine: resolver,
    confirmationTimeoutMs: config.chain.confirmationTimeoutMs,
    now: () => new Date(),
  });

  return {
    config,
    repositories,
    compiler,
    auth,
    manifest,
    addresses,
    chain,
    evidence,
    resolver,
    resolverWriter,
    resolution,
    close: async () => {
      await pool.end();
    },
  };
}
