/**
 * Configuration, and the guarantee that secrets stay out of logs and responses.
 *
 * The secret-leak tests use distinctive sentinel values, so a failure names the
 * exact secret that escaped rather than reporting an abstract policy breach.
 */

import { describe, expect, it } from 'vitest';

import { describeConfig, loadConfig } from '../src/config.js';
import { ConfigurationError } from '../src/errors.js';
import { REDACT_PATHS, describeUserContent } from '../src/logging.js';
import {
  TEST_ENV,
  bearer,
  compiledOutput,
  createServer,
  signIn,
  testConfig,
} from './helpers.js';

const API_KEY = TEST_ENV['ANTHROPIC_API_KEY'] as string;
const RESOLVER_KEY = TEST_ENV['RESOLVER_PRIVATE_KEY'] as string;
const DB_PASSWORD = 'hunter2';

describe('loadConfig', () => {
  it('builds a config from an explicit environment', () => {
    const config = loadConfig(TEST_ENV);
    expect(config.chainId).toBe(1952);
    expect(config.settlementToken.symbol).toBe('TUSD');
    // Haiku 4.5 by default: the cheapest current model, and sufficient because
    // the system rather than the model enforces correctness.
    expect(config.llm.model).toBe('claude-haiku-4-5');
    expect(config.llm.timeoutMs).toBe(120_000);
  });

  it('reads no process state of its own', () => {
    // Nothing at module scope touched process.env; passing an environment with
    // one variable missing fails predictably regardless of the real one.
    const { CHAIN_ID: _omitted, ...withoutChain } = TEST_ENV;
    expect(() => loadConfig(withoutChain)).toThrow(ConfigurationError);
  });

  it('reports every missing variable at once', () => {
    try {
      loadConfig({ NODE_ENV: 'test' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      const paths = (error as ConfigurationError).issues.map((issue) => issue.path);
      expect(paths).toEqual(
        expect.arrayContaining([
          'DATABASE_URL',
          'ANTHROPIC_API_KEY',
          'CHAIN_ID',
          'SETTLEMENT_TOKEN_ADDRESS',
        ]),
      );
    }
  });

  it('rejects a malformed settlement token address', () => {
    expect(() =>
      loadConfig({ ...TEST_ENV, SETTLEMENT_TOKEN_ADDRESS: '0x123' }),
    ).toThrow(ConfigurationError);
  });

  it('rejects a non-numeric chain id', () => {
    expect(() => loadConfig({ ...TEST_ENV, CHAIN_ID: 'xlayer' })).toThrow(ConfigurationError);
  });

  it('treats the resolver key as optional, and falls back to the network default RPC', () => {
    const { RESOLVER_PRIVATE_KEY: _key, ...withoutResolver } = TEST_ENV;
    const config = loadConfig(withoutResolver);
    expect(config.resolverPrivateKey).toBeNull();
    // M4: an RPC is no longer optional — it defaults to the endpoint recorded
    // for the network in @covenant/shared, which is the verified one.
    expect(config.chain.rpcUrl).toBe('https://testrpc.xlayer.tech/terigon');
  });

  it('rejects a NETWORK that disagrees with CHAIN_ID', () => {
    // Two spellings of one fact. Letting them differ would mean a process that
    // believes it serves testnet while resolving another chain's settings.
    expect(() => loadConfig({ ...TEST_ENV, CHAIN_ID: '31337' })).toThrow(ConfigurationError);
  });

  it('refuses mainnet outright', () => {
    expect(() =>
      loadConfig({ ...TEST_ENV, NETWORK: 'xlayer-mainnet', CHAIN_ID: '196' }),
    ).toThrow(ConfigurationError);
  });

  it('refuses a confirmation depth below the network minimum', () => {
    // Indexing closer to head than the chain warrants is not a tuning choice,
    // it is a decision to persist blocks that can still be replaced.
    expect(() => loadConfig({ ...TEST_ENV, INDEXER_CONFIRMATIONS: '1' })).toThrow(
      ConfigurationError,
    );
  });

  it('accepts a confirmation depth above the network minimum', () => {
    expect(loadConfig({ ...TEST_ENV, INDEXER_CONFIRMATIONS: '20' }).chain.confirmations).toBe(20);
  });

  it('keeps user-content logging off unless explicitly enabled', () => {
    expect(loadConfig(TEST_ENV).logUserContent).toBe(false);
    expect(loadConfig({ ...TEST_ENV, LOG_USER_CONTENT: 'true' }).logUserContent).toBe(true);
  });
});

describe('describeConfig', () => {
  it('reports whether secrets are present, never what they are', () => {
    const described = describeConfig(loadConfig(TEST_ENV));
    const serialised = JSON.stringify(described);

    expect(serialised).not.toContain(API_KEY);
    expect(serialised).not.toContain(RESOLVER_KEY);
    expect(serialised).not.toContain(DB_PASSWORD);
    expect(serialised).not.toContain('postgresql://');

    expect(described['llmKeyConfigured']).toBe(true);
    expect(described['resolverKeyConfigured']).toBe(true);
    expect(described['databaseConfigured']).toBe(true);
  });

  it('carries no field that would hold a credential', () => {
    const keys = Object.keys(describeConfig(loadConfig(TEST_ENV)));
    for (const key of keys) {
      // A field named for a secret is the shape a leak takes. Presence flags
      // (`llmKeyConfigured`) are fine; a bare `apiKey` or `databaseUrl` is not.
      expect(key).not.toMatch(/^(apiKey|privateKey|resolverPrivateKey|databaseUrl|password)$/i);
      expect(key).not.toMatch(/secret/i);
    }
  });
});

describe('log redaction', () => {
  it('covers the fields a future serialiser is most likely to add', () => {
    for (const path of [
      'req.headers.authorization',
      'apiKey',
      'privateKey',
      'resolverPrivateKey',
      'databaseUrl',
      'DATABASE_URL',
    ]) {
      expect(REDACT_PATHS).toContain(path);
    }
  });
});

describe('describeUserContent', () => {
  it('reports a length rather than the prompt by default', () => {
    const described = describeUserContent('pay Sarah 5000 USD on delivery', testConfig());
    expect(described.length).toBe(30);
    expect(described.content).toBeUndefined();
  });

  it('includes the prompt only when an operator opts in', () => {
    const described = describeUserContent('secret business terms', testConfig({ logUserContent: true }));
    expect(described.content).toBe('secret business terms');
  });
});

describe('no secret reaches an HTTP response', () => {
  it('holds across success, validation failure, and upstream failure', async () => {
    const harness = createServer([
      { kind: 'json', value: compiledOutput() },
      { kind: 'error', failure: 'auth', message: `bad key ${API_KEY}` },
    ]);
    const { app } = harness;
    const token = await signIn(harness);
    const auth = bearer(token);

    const bodies: string[] = [];
    bodies.push(
      (
        await app.inject({
          method: 'POST',
          url: '/api/markets/compile',
          payload: { message: 'Pay if BTC is above 100k.', chainId: 1952 },
          headers: auth,
        })
      ).body,
    );
    bodies.push(
      (
        await app.inject({
          method: 'POST',
          url: '/api/markets/compile',
          payload: {},
          headers: auth,
        })
      ).body,
    );
    bodies.push(
      (
        await app.inject({
          method: 'POST',
          url: '/api/markets/compile',
          payload: { message: 'again', chainId: 1952 },
          headers: auth,
        })
      ).body,
    );
    bodies.push((await app.inject({ method: 'GET', url: '/health' })).body);
    // An unauthenticated request must not leak anything either.
    bodies.push((await app.inject({ method: 'GET', url: '/api/auth/me' })).body);

    for (const body of bodies) {
      expect(body).not.toContain(API_KEY);
      expect(body).not.toContain(RESOLVER_KEY);
      expect(body).not.toContain(DB_PASSWORD);
      expect(body).not.toContain('postgresql://');
      expect(body).not.toContain('sk-ant');
    }

    await app.close();
  });
});
