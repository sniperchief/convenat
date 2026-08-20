/**
 * Test scaffolding.
 *
 * Everything a test needs to stand up the real compiler and the real server
 * with a scripted model and in-memory storage. No network, no database, no key.
 */

import { privateKeyToAccount } from 'viem/accounts';

import type { AppConfig, MarketPolicy, SettlementTokenConfig } from '../src/config.js';
import { AuthService } from '../src/auth/service.js';
import { ConditionCompiler } from '../src/compiler/compiler.js';
import { FakeLLMProvider, type FakeScript } from '../src/llm/fake-provider.js';
import { buildServer } from '../src/api/server.js';
import { createInMemoryRepositories, type InMemoryRepositories } from '../src/repositories/memory.js';
import type { ConditionDraft } from '../src/compiler/output-schema.js';
import type { ChainClient } from '../src/chain/types.js';

/** Frozen clock. Every deadline in the fixtures is relative to this. */
export const NOW = new Date('2026-08-01T00:00:00Z');

export const TEST_TOKEN: SettlementTokenConfig = {
  chainId: 1952,
  address: '0x000000000000000000000000000000000000dead',
  symbol: 'TUSD',
  decimals: 6,
};

export const TEST_POLICY: MarketPolicy = {
  tradingEndsLeadSeconds: 86_400,
  challengeWindowSeconds: 7_200,
  challengeBondBaseUnits: '50000000',
  resolutionWindowSeconds: 604_800,
};

/**
 * A fixed test key.
 *
 * A published, worthless secp256k1 key used to produce real signatures in the
 * authentication tests. Real signatures matter here: a mocked verifier would
 * prove nothing about whether `recoverMessageAddress` is being called correctly,
 * which is the only part of sign-in that actually keeps anyone out.
 */
export const CREATOR_KEY = `0x${'11'.repeat(32)}` as const;
export const CREATOR_ACCOUNT = privateKeyToAccount(CREATOR_KEY);
export const CREATOR = CREATOR_ACCOUNT.address.toLowerCase();

/** A second, independent key, for the cross-wallet authorization tests. */
export const OTHER_KEY = `0x${'22'.repeat(32)}` as const;
export const OTHER_ACCOUNT = privateKeyToAccount(OTHER_KEY);
export const OTHER_WALLET = OTHER_ACCOUNT.address.toLowerCase();

/** A fixed nonce, so the same input produces the same hash across a test run. */
export const FIXED_NONCE = `0x${'11'.repeat(32)}`;

export const TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://user:hunter2@localhost:5432/covenant_test',
  ANTHROPIC_API_KEY: 'sk-ant-test-key-do-not-use',
  RESOLVER_PRIVATE_KEY: `0x${'ab'.repeat(32)}`,
  NETWORK: 'xlayer-testnet',
  CHAIN_ID: '1952',
  SETTLEMENT_TOKEN_ADDRESS: TEST_TOKEN.address,
  SETTLEMENT_TOKEN_SYMBOL: 'TUSD',
  SETTLEMENT_TOKEN_DECIMALS: '6',
};

export const TEST_AUTH_DOMAIN = 'covenant.test';
export const TEST_AUTH_URI = 'https://covenant.test';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: 'test',
    api: { host: '127.0.0.1', port: 0 },
    logLevel: 'silent',
    logUserContent: false,
    databaseUrl: TEST_ENV['DATABASE_URL'] as string,
    llm: {
      apiKey: TEST_ENV['ANTHROPIC_API_KEY'] as string,
      model: 'fake-model',
      maxOutputTokens: 8000,
      timeoutMs: 30_000,
    },
    resolverPrivateKey: TEST_ENV['RESOLVER_PRIVATE_KEY'] as string,
    chainId: 1952,
    settlementToken: TEST_TOKEN,
    marketPolicy: TEST_POLICY,
    chain: {
      networkKey: 'xlayer-testnet',
      environment: 'testnet',
      rpcUrl: 'https://rpc.invalid/never-called',
      confirmations: 5,
      manifestPath: 'deployments/xlayer-testnet.json',
      logRangeLimit: 2_000,
      reorgWindow: 32,
      pollIntervalMs: 12_000,
      /** Tests always bootstrap from the manifest; the override is an operator escape hatch. */
      startBlockOverride: null,
    },
    auth: {
      domain: TEST_AUTH_DOMAIN,
      uri: TEST_AUTH_URI,
      nonceTtlSeconds: 300,
      sessionTtlSeconds: 86_400,
    },
    evidence: {
      // Small and fast: the retrieval suite drives every bound deliberately and
      // never waits on a real clock. Production defaults live in config.ts.
      timeoutMs: 1_000,
      maxResponseBytes: 64 * 1024,
      maxRetainedChars: 4_000,
      maxAttempts: 3,
      retryBackoffMs: 1,
      maxRedirects: 3,
      totalBudgetMs: 5_000,
      allowedPorts: [443],
      allowedHosts: [],
    },
    ...overrides,
  };
}

/** A complete, objectively resolvable condition draft. */
export function validDraft(overrides: Partial<ConditionDraft> = {}): ConditionDraft {
  return {
    question: 'Did BTC trade above 100000 USD at 2026-09-01T00:00:00Z?',
    conditionType: 'binary',
    successCondition:
      'The primary approved source reports a BTC/USD price strictly above 100000 at 2026-09-01T00:00:00Z.',
    failureCondition:
      'The primary approved source reports a BTC/USD price at or below 100000 at 2026-09-01T00:00:00Z.',
    deadline: '2026-09-01T00:00:00Z',
    timezone: 'UTC',
    resolutionMethod: 'deterministic_numeric_threshold',
    approvedSources: [
      {
        name: 'Exchange official price API',
        url: 'https://api.exchange.test/v2/prices/BTC-USD/spot',
        retrievalKind: 'http_json',
        dataPath: '/data/amount',
      },
      {
        name: 'Exchange public price page',
        url: 'https://www.exchange.test/price/btc',
        retrievalKind: 'http_html',
        dataPath: null,
      },
    ],
    evidenceRequirements: ['The BTC/USD price at the deadline instant.'],
    ambiguities: [],
    edgeCases: [{ scenario: 'The price is exactly 100000.', outcome: 'NO' }],
    risk: 'low',
    ...overrides,
  };
}

export function compiledOutput(draft: ConditionDraft = validDraft()): unknown {
  return {
    status: 'COMPILED',
    interpretation: 'A price threshold checked against an exchange API at a fixed instant.',
    questions: [],
    condition: draft,
  };
}

export function incompleteOutput(
  questions: { field: string; question: string; why: string }[],
  condition: ConditionDraft | null = null,
): unknown {
  return {
    status: 'INCOMPLETE',
    interpretation: 'The request is not yet objectively resolvable.',
    questions,
    condition,
  };
}

export interface Harness {
  readonly compiler: ConditionCompiler;
  readonly provider: FakeLLMProvider;
  readonly repositories: InMemoryRepositories;
  readonly config: AppConfig;
}

export function createCompiler(scripts: readonly FakeScript[]): Harness {
  const provider = new FakeLLMProvider(scripts);
  const config = testConfig();
  return {
    provider,
    config,
    repositories: createInMemoryRepositories(),
    compiler: new ConditionCompiler({
      provider,
      token: TEST_TOKEN,
      policy: TEST_POLICY,
      maxOutputTokens: 8000,
      timeoutMs: 30_000,
      now: () => NOW,
      nonce: () => FIXED_NONCE,
    }),
  };
}

export interface ServerHarness extends Harness {
  readonly app: ReturnType<typeof buildServer>;
  readonly auth: AuthService;
}

export function createServer(
  scripts: readonly FakeScript[],
  overrides: {
    repositories?: InMemoryRepositories;
    chain?: ChainClient | null;
    now?: () => Date;
  } = {},
): ServerHarness {
  const harness = createCompiler(scripts);
  const repositories = overrides.repositories ?? harness.repositories;
  const now = overrides.now ?? ((): Date => NOW);

  const auth = new AuthService({
    nonces: repositories.authNonces,
    sessions: repositories.authSessions,
    policy: {
      domain: harness.config.auth.domain,
      uri: harness.config.auth.uri,
      chainId: harness.config.chainId,
      nonceTtlSeconds: harness.config.auth.nonceTtlSeconds,
      sessionTtlSeconds: harness.config.auth.sessionTtlSeconds,
    },
    now,
  });

  const app = buildServer({
    config: harness.config,
    repositories,
    compiler: harness.compiler,
    auth,
    chain: overrides.chain ?? null,
    contracts: {
      factory: '0x00000000000000000000000000000000000fac70',
      settlementToken: TEST_TOKEN.address as `0x${string}`,
    },
    now,
  });
  return { ...harness, repositories, app, auth };
}

/**
 * Complete a real sign-in and return the bearer token.
 *
 * The whole exchange: request a challenge, sign the exact message the server
 * rendered, post the signature back. No shortcut is taken — the tests that use
 * this are exercising the same path a wallet would.
 */
export async function signIn(
  harness: ServerHarness,
  account: typeof CREATOR_ACCOUNT = CREATOR_ACCOUNT,
): Promise<string> {
  const challenge = await harness.app.inject({
    method: 'POST',
    url: '/api/auth/nonce',
    payload: { address: account.address },
  });
  const { message, nonce } = challenge.json().data as { message: string; nonce: string };

  const signature = await account.signMessage({ message });

  const verified = await harness.app.inject({
    method: 'POST',
    url: '/api/auth/verify',
    payload: { nonce, signature },
  });
  if (verified.statusCode !== 200) {
    throw new Error(`sign-in failed: ${verified.statusCode} ${verified.body}`);
  }
  return (verified.json().data as { token: string }).token;
}

/** An Authorization header for an already-obtained token. */
export const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});
