/**
 * Backend configuration.
 *
 * Configuration is *constructed*, never imported as a side effect. `loadConfig`
 * takes the environment as an argument and returns a value; nothing here reads
 * `process.env` at module scope. That is what lets every test build a config
 * without a `.env` file, a database, or an API key.
 *
 * Secrets live in this object and nowhere else. `describeConfig` produces the
 * only representation that may be logged, and it carries no secret values —
 * see logging.ts, and the test that asserts no secret reaches a log line.
 */

import { z } from 'zod';

import {
  environmentForNetwork,
  getNetwork,
  isNetworkKey,
  resolveConfirmations,
  type DeploymentEnvironment,
  type NetworkKey,
} from '@covenant/shared';

import { ConfigurationError } from './errors.js';

/** Market terms the backend applies. Deliberately not chosen by the model. */
export interface MarketPolicy {
  /** Seconds before the condition deadline that staking closes. */
  readonly tradingEndsLeadSeconds: number;
  readonly challengeWindowSeconds: number;
  readonly challengeBondBaseUnits: string;
  readonly resolutionWindowSeconds: number;
}

export interface SettlementTokenConfig {
  readonly chainId: number;
  readonly address: string;
  readonly symbol: string;
  readonly decimals: number;
}

export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly api: { readonly host: string; readonly port: number };
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  /** True when raw user prompts may be written to logs. Off by default. */
  readonly logUserContent: boolean;

  readonly databaseUrl: string;

  readonly llm: {
    readonly apiKey: string;
    readonly model: string;
    readonly maxOutputTokens: number;
    readonly timeoutMs: number;
  };

  /**
   * Resolver wallet key. Held so M5 can sign proposals; nothing reads it yet.
   * Never returned by an API, never logged, never persisted.
   */
  readonly resolverPrivateKey: string | null;

  readonly chainId: number;
  readonly settlementToken: SettlementTokenConfig;
  readonly marketPolicy: MarketPolicy;
  readonly chain: ChainConfig;
  readonly auth: AuthConfig;
  readonly evidence: EvidenceConfig;
}

/**
 * Bounds on reading an approved evidence source.
 *
 * Every one of these is a ceiling, and none has an "unlimited" spelling. A
 * resolver that can be made to wait forever, or to buffer an arbitrary body, is
 * a resolver a hostile source can take offline — and liveness failures are the
 * failure mode this protocol takes most seriously (docs/security.md §3).
 */
export interface EvidenceConfig {
  /** Per-attempt wall clock, including redirects. */
  readonly timeoutMs: number;
  /** Hard body ceiling. Exceeding it fails the source; nothing is truncated. */
  readonly maxResponseBytes: number;
  /** Ceiling on the retained normalised text, in characters. */
  readonly maxRetainedChars: number;
  /** Total attempts per source, including the first. 1 disables retries. */
  readonly maxAttempts: number;
  readonly retryBackoffMs: number;
  readonly maxRedirects: number;
  /** Ceiling across a whole precedence walk. */
  readonly totalBudgetMs: number;
  /** Ports a source may be read from. 443 unless an operator widens it. */
  readonly allowedPorts: readonly number[];
  /**
   * Optional operator allowlist of hostnames. Empty means the ConditionSpec's
   * approved sources are the only name-level control — which is the design —
   * with the private-address policy as the backstop that always runs.
   */
  readonly allowedHosts: readonly string[];
}

/** Everything the chain layer needs, resolved from the network and the manifest. */
export interface ChainConfig {
  readonly networkKey: NetworkKey;
  readonly environment: DeploymentEnvironment;
  readonly rpcUrl: string;
  /**
   * Confirmation depth (§16, §19).
   *
   * Resolved through `resolveConfirmations`, which refuses a value below the
   * network's own minimum — an operator may lag further behind head, never less.
   */
  readonly confirmations: number;
  /** Path to the deployment manifest. Addresses come from there, never source. */
  readonly manifestPath: string;
  /** Largest block span per `eth_getLogs`. Public endpoints cap this. */
  readonly logRangeLimit: number;
  /** How far back the indexer re-checks block hashes for a reorg (§20). */
  readonly reorgWindow: number;
  readonly pollIntervalMs: number;
  /** Operational override for the bootstrap block. Null means use the manifest. */
  readonly startBlockOverride: bigint | null;
}

export interface AuthConfig {
  /** Domain bound into the sign-in message. Must match the frontend's origin. */
  readonly domain: string;
  readonly uri: string;
  readonly nonceTtlSeconds: number;
  readonly sessionTtlSeconds: number;
}

const optionalString = z
  .string()
  .transform((value) => value.trim())
  .transform((value) => (value === '' ? undefined : value))
  .optional();

const requiredString = (label: string) =>
  z
    .string({ required_error: `${label} is required` })
    .transform((value) => value.trim())
    .refine((value) => value.length > 0, `${label} must not be empty`);

const integerFromEnv = (label: string) =>
  z
    .string()
    .transform((value) => value.trim())
    .refine((value) => /^-?\d+$/.test(value), `${label} must be an integer`)
    .transform((value) => Number.parseInt(value, 10));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: integerFromEnv('API_PORT').default('8080'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  LOG_USER_CONTENT: z.enum(['true', 'false']).default('false'),

  DATABASE_URL: requiredString('DATABASE_URL'),

  ANTHROPIC_API_KEY: requiredString('ANTHROPIC_API_KEY'),
  /**
   * Compilation model.
   *
   * Defaults to Claude Haiku 4.5 — $1/$5 per million tokens against Opus 5's
   * $5/$25 — because this task does not need a frontier model. The compiler's
   * job is to turn prose into a fixed JSON schema, and **the system, not the
   * model, is what enforces correctness**: the output is parsed by a strict Zod
   * schema, the specification is validated by `@covenant/shared`, and the
   * economics are supplied by operator policy rather than by anything the model
   * says. A weaker model produces more INCOMPLETE results, which is a product
   * outcome, not a safety failure.
   *
   * One practical note if this is raised to an Opus-tier model: thinking is on
   * by default there and is billed against the same `LLM_MAX_OUTPUT_TOKENS`
   * budget as the answer, so the token limit must be raised with it or the JSON
   * gets truncated mid-object.
   */
  LLM_MODEL: z.string().default('claude-haiku-4-5'),
  LLM_MAX_OUTPUT_TOKENS: integerFromEnv('LLM_MAX_OUTPUT_TOKENS').default('16000'),
  LLM_TIMEOUT_MS: integerFromEnv('LLM_TIMEOUT_MS').default('120000'),

  RESOLVER_PRIVATE_KEY: optionalString,

  // --- M4: network, manifest, indexing ---------------------------------------
  NETWORK: requiredString('NETWORK').refine(
    isNetworkKey,
    'NETWORK must be one of: local, xlayer-testnet, xlayer-mainnet',
  ),
  XLAYER_RPC_URL: optionalString,
  XLAYER_TESTNET_RPC_URL: optionalString,
  X_LAYER_DEPLOYMENT_MANIFEST: optionalString,
  INDEXER_CONFIRMATIONS: optionalString,
  /**
   * Largest block span per `eth_getLogs`.
   *
   * 100, because that is X Layer testnet's actual cap — a wider request is
   * rejected with `block range greater than 100 max`. Measured against the live
   * endpoint in M4, not guessed: the limit is not in any documentation this
   * project could find, and the previous default of 2000 failed on the first
   * real call.
   */
  INDEXER_LOG_RANGE: integerFromEnv('INDEXER_LOG_RANGE').default('100'),
  INDEXER_REORG_WINDOW: integerFromEnv('INDEXER_REORG_WINDOW').default('32'),
  /**
   * Override the block the indexer bootstraps from.
   *
   * The manifest's `startBlock` is the factory's deployment block and is the
   * correct default — starting later silently misses markets. This override
   * exists for operational reasons only: re-indexing a known-empty prefix on a
   * chain that caps `eth_getLogs` at 100 blocks costs an hour of requests for
   * nothing.
   *
   * **Setting it forward of a real market is a way to lose data**, so it is not
   * a tuning knob. Anywhere it is used, that fact belongs in the record.
   */
  INDEXER_START_BLOCK: optionalString,
  INDEXER_POLL_INTERVAL_MS: integerFromEnv('INDEXER_POLL_INTERVAL_MS').default('12000'),

  // --- M4: authentication -----------------------------------------------------
  AUTH_DOMAIN: z.string().default('localhost:8080'),
  AUTH_URI: z.string().default('http://localhost:8080'),
  AUTH_NONCE_TTL_SECONDS: integerFromEnv('AUTH_NONCE_TTL_SECONDS').default('300'),
  AUTH_SESSION_TTL_SECONDS: integerFromEnv('AUTH_SESSION_TTL_SECONDS').default('86400'),

  CHAIN_ID: integerFromEnv('CHAIN_ID'),
  SETTLEMENT_TOKEN_ADDRESS: requiredString('SETTLEMENT_TOKEN_ADDRESS').refine(
    (value) => /^0x[0-9a-fA-F]{40}$/.test(value),
    'SETTLEMENT_TOKEN_ADDRESS must be a 0x-prefixed 20-byte hex address',
  ),
  SETTLEMENT_TOKEN_SYMBOL: requiredString('SETTLEMENT_TOKEN_SYMBOL'),
  SETTLEMENT_TOKEN_DECIMALS: integerFromEnv('SETTLEMENT_TOKEN_DECIMALS').default('6'),

  MARKET_TRADING_LEAD_SECONDS: integerFromEnv('MARKET_TRADING_LEAD_SECONDS').default('86400'),
  MARKET_CHALLENGE_WINDOW_SECONDS: integerFromEnv('MARKET_CHALLENGE_WINDOW_SECONDS').default(
    '7200',
  ),
  MARKET_CHALLENGE_BOND_BASE_UNITS: z.string().default('50000000'),
  MARKET_RESOLUTION_WINDOW_SECONDS: integerFromEnv('MARKET_RESOLUTION_WINDOW_SECONDS').default(
    '604800',
  ),

  // --- M5.2: evidence retrieval ----------------------------------------------
  EVIDENCE_TIMEOUT_MS: integerFromEnv('EVIDENCE_TIMEOUT_MS').default('10000'),
  /**
   * 2 MiB. Large enough for any JSON API response and a substantial HTML page,
   * small enough that a hostile source cannot make the resolver buffer its way
   * out of memory. Exceeding it fails the source rather than truncating it —
   * `contentHash` commits to the *complete* body, and a hash over a prefix that
   * claims to be the response would be a quiet lie.
   */
  EVIDENCE_MAX_RESPONSE_BYTES: integerFromEnv('EVIDENCE_MAX_RESPONSE_BYTES').default('2097152'),
  /**
   * How much normalised text is retained for later extraction. Unlike the byte
   * ceiling this one *does* truncate, and the snapshot records that it did.
   */
  EVIDENCE_MAX_RETAINED_CHARS: integerFromEnv('EVIDENCE_MAX_RETAINED_CHARS').default('20000'),
  EVIDENCE_MAX_ATTEMPTS: integerFromEnv('EVIDENCE_MAX_ATTEMPTS').default('3'),
  EVIDENCE_RETRY_BACKOFF_MS: integerFromEnv('EVIDENCE_RETRY_BACKOFF_MS').default('500'),
  EVIDENCE_MAX_REDIRECTS: integerFromEnv('EVIDENCE_MAX_REDIRECTS').default('3'),
  EVIDENCE_TOTAL_BUDGET_MS: integerFromEnv('EVIDENCE_TOTAL_BUDGET_MS').default('60000'),
  /** Comma-separated. 443 only by default; widening it widens the SSRF surface. */
  EVIDENCE_ALLOWED_PORTS: z.string().default('443'),
  /** Comma-separated hostnames. Empty means no operator allowlist. */
  EVIDENCE_ALLOWED_HOSTS: z.string().default(''),
});

/** Split a comma-separated environment list, dropping empties. */
function commaList(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/**
 * Build configuration from an environment map.
 *
 * @throws {ConfigurationError} listing every problem at once — a process that
 * is going to fail on a missing variable should say so on the first run, not
 * one variable per restart.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigurationError(
      'Backend configuration is invalid',
      parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }

  const value = parsed.data;

  // --- network coherence ----------------------------------------------------
  // NETWORK and CHAIN_ID are two spellings of one fact. Letting them disagree
  // would mean a process that believes it serves testnet while resolving
  // addresses and confirmations for something else.
  const networkKey = value.NETWORK as NetworkKey;
  const network = getNetwork(networkKey);
  const issues: { path: string; message: string }[] = [];

  if (network.chainId !== value.CHAIN_ID) {
    issues.push({
      path: 'CHAIN_ID',
      message: `NETWORK=${networkKey} is chain ${network.chainId}, not ${value.CHAIN_ID}`,
    });
  }

  // Mainnet is refused outright rather than merely unconfigured. M4 does not
  // deploy to mainnet, and a process that could be pointed at it by one
  // environment variable is a process that eventually will be.
  if (environmentForNetwork(networkKey) === 'mainnet') {
    issues.push({
      path: 'NETWORK',
      message:
        'mainnet is not supported by this build. Testnet end-to-end and an external audit come first.',
    });
  }

  const rpcUrl =
    value.XLAYER_RPC_URL ??
    value.XLAYER_TESTNET_RPC_URL ??
    network.rpcUrls[0] ??
    undefined;
  if (rpcUrl === undefined) {
    issues.push({ path: 'XLAYER_RPC_URL', message: 'no RPC URL configured for this network' });
  }

  let confirmations = network.minConfirmations;
  if (value.INDEXER_CONFIRMATIONS !== undefined) {
    const requested = Number.parseInt(value.INDEXER_CONFIRMATIONS, 10);
    try {
      confirmations = resolveConfirmations(network, requested);
    } catch (error) {
      issues.push({
        path: 'INDEXER_CONFIRMATIONS',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const allowedPorts = commaList(value.EVIDENCE_ALLOWED_PORTS).map((entry) =>
    Number.parseInt(entry, 10),
  );
  if (allowedPorts.length === 0 || allowedPorts.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    issues.push({
      path: 'EVIDENCE_ALLOWED_PORTS',
      message: 'must be a non-empty comma-separated list of port numbers',
    });
  }

  if (issues.length > 0) {
    throw new ConfigurationError('Backend configuration is invalid', issues);
  }

  return {
    nodeEnv: value.NODE_ENV,
    api: { host: value.API_HOST, port: value.API_PORT },
    logLevel: value.LOG_LEVEL,
    logUserContent: value.LOG_USER_CONTENT === 'true',
    databaseUrl: value.DATABASE_URL,
    llm: {
      apiKey: value.ANTHROPIC_API_KEY,
      model: value.LLM_MODEL,
      maxOutputTokens: value.LLM_MAX_OUTPUT_TOKENS,
      timeoutMs: value.LLM_TIMEOUT_MS,
    },
    resolverPrivateKey: value.RESOLVER_PRIVATE_KEY ?? null,
    chainId: value.CHAIN_ID,
    chain: {
      networkKey,
      environment: environmentForNetwork(networkKey),
      rpcUrl: rpcUrl as string,
      confirmations,
      manifestPath:
        value.X_LAYER_DEPLOYMENT_MANIFEST ?? `../../${network.deploymentManifest}`,
      logRangeLimit: value.INDEXER_LOG_RANGE,
      reorgWindow: value.INDEXER_REORG_WINDOW,
      pollIntervalMs: value.INDEXER_POLL_INTERVAL_MS,
      startBlockOverride:
        value.INDEXER_START_BLOCK === undefined ? null : BigInt(value.INDEXER_START_BLOCK),
    },
    auth: {
      domain: value.AUTH_DOMAIN,
      uri: value.AUTH_URI,
      nonceTtlSeconds: value.AUTH_NONCE_TTL_SECONDS,
      sessionTtlSeconds: value.AUTH_SESSION_TTL_SECONDS,
    },
    settlementToken: {
      chainId: value.CHAIN_ID,
      address: value.SETTLEMENT_TOKEN_ADDRESS.toLowerCase(),
      symbol: value.SETTLEMENT_TOKEN_SYMBOL,
      decimals: value.SETTLEMENT_TOKEN_DECIMALS,
    },
    marketPolicy: {
      tradingEndsLeadSeconds: value.MARKET_TRADING_LEAD_SECONDS,
      challengeWindowSeconds: value.MARKET_CHALLENGE_WINDOW_SECONDS,
      challengeBondBaseUnits: value.MARKET_CHALLENGE_BOND_BASE_UNITS,
      resolutionWindowSeconds: value.MARKET_RESOLUTION_WINDOW_SECONDS,
    },
    evidence: {
      timeoutMs: value.EVIDENCE_TIMEOUT_MS,
      maxResponseBytes: value.EVIDENCE_MAX_RESPONSE_BYTES,
      maxRetainedChars: value.EVIDENCE_MAX_RETAINED_CHARS,
      maxAttempts: value.EVIDENCE_MAX_ATTEMPTS,
      retryBackoffMs: value.EVIDENCE_RETRY_BACKOFF_MS,
      maxRedirects: value.EVIDENCE_MAX_REDIRECTS,
      totalBudgetMs: value.EVIDENCE_TOTAL_BUDGET_MS,
      allowedPorts,
      allowedHosts: commaList(value.EVIDENCE_ALLOWED_HOSTS).map((host) => host.toLowerCase()),
    },
  };
}

/**
 * The only safe-to-log view of the configuration.
 *
 * Every secret-bearing field is reduced to a boolean or a length. There is no
 * redaction pass to forget to apply, because the secret values never enter the
 * returned object in the first place.
 */
export function describeConfig(config: AppConfig): Record<string, unknown> {
  return {
    nodeEnv: config.nodeEnv,
    host: config.api.host,
    port: config.api.port,
    logLevel: config.logLevel,
    logUserContent: config.logUserContent,
    chainId: config.chainId,
    settlementTokenSymbol: config.settlementToken.symbol,
    llmModel: config.llm.model,
    network: config.chain.networkKey,
    environment: config.chain.environment,
    confirmations: config.chain.confirmations,
    databaseConfigured: config.databaseUrl.length > 0,
    llmKeyConfigured: config.llm.apiKey.length > 0,
    resolverKeyConfigured: config.resolverPrivateKey !== null,
    // The URL itself is withheld: an RPC endpoint can carry an API key in its
    // path, which makes it a credential and not a piece of topology.
    rpcConfigured: config.chain.rpcUrl.length > 0,
    authDomain: config.auth.domain,
    // Retrieval bounds are operational policy, not secrets, and are worth having
    // in the startup log: "why did that source time out" is answered by knowing
    // what the ceiling was.
    evidenceTimeoutMs: config.evidence.timeoutMs,
    evidenceMaxResponseBytes: config.evidence.maxResponseBytes,
    evidenceMaxAttempts: config.evidence.maxAttempts,
    evidenceAllowedPorts: config.evidence.allowedPorts.join(','),
    evidenceHostAllowlistSize: config.evidence.allowedHosts.length,
  };
}
