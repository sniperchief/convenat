/**
 * Manifest loading and chain decoding (§14, §15).
 *
 * The manifest is how a contract address reaches this backend. These tests are
 * about what happens when it is wrong, because "loads a good manifest" is not
 * the interesting case — "refuses a mainnet manifest" is.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { addressesFrom, loadDeploymentManifest } from '../src/chain/manifest.js';
import {
  CANCELLATION_REASONS,
  MARKET_STATES,
  OUTCOMES,
  outcomeOrdinal,
  toCancellationReason,
  toMarketState,
  toOutcome,
} from '../src/chain/enums.js';

const dir = mkdtempSync(join(tmpdir(), 'covenant-manifest-'));

function write(name: string, manifest: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(manifest), 'utf8');
  return path;
}

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const contract = (address: string) => ({
    address,
    transactionHash: `0x${'11'.repeat(32)}`,
    blockNumber: 100,
    constructorArgs: [],
    verification: { status: 'not-attempted', url: null, note: '' },
  });

  return {
    schemaVersion: 1,
    environment: 'testnet',
    network: 'xlayer-testnet',
    chainId: 1952,
    deployedAt: '2026-08-17T00:00:00.000Z',
    deployer: '0x1111111111111111111111111111111111111111',
    resolver: '0x2222222222222222222222222222222222222222',
    compiler: { solc: '0.8.24', evmVersion: 'paris', optimizer: { enabled: true, runs: 200 } },
    startBlock: 100,
    contracts: {
      TestUSD: contract('0x000000000000000000000000000000000000dead'),
      ConditionalMarketImplementation: contract('0x00000000000000000000000000000000000000c1'),
      MarketFactory: contract('0x00000000000000000000000000000000000fac70'),
    },
    ...overrides,
  };
}

const TESTNET = { chainId: 1952, environment: 'testnet' as const };

describe('loading a deployment manifest', () => {
  it('accepts a well-formed testnet manifest and lowercases every address', () => {
    const path = write(
      'good.json',
      validManifest({
        deployer: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      }),
    );

    const manifest = loadDeploymentManifest({ path, ...TESTNET });

    expect(manifest.chainId).toBe(1952);
    expect(manifest.deployer).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(addressesFrom(manifest).factory).toBe('0x00000000000000000000000000000000000fac70');
    expect(addressesFrom(manifest).startBlock).toBe(100n);
  });

  it('refuses a mainnet manifest even when it is otherwise valid', () => {
    const path = write(
      'mainnet.json',
      validManifest({ environment: 'mainnet', network: 'xlayer-mainnet', chainId: 196 }),
    );

    // This is the check that stops a mainnet deployment being consumed by a
    // process nobody intended to point at mainnet.
    expect(() => loadDeploymentManifest({ path, ...TESTNET })).toThrow(/mainnet/i);
  });

  it('refuses a manifest from another environment', () => {
    const path = write('local.json', validManifest({ network: 'local', chainId: 31_337, environment: 'local' }));

    // The environment check runs first, and deliberately: it is the coarser,
    // more consequential guard.
    expect(() => loadDeploymentManifest({ path, ...TESTNET })).toThrow(/local/i);
  });

  it('refuses a manifest for a chain this process was not configured for', () => {
    const path = write('other-chain.json', validManifest());

    expect(() =>
      loadDeploymentManifest({ path, chainId: 4242, environment: 'testnet' }),
    ).toThrow(/chain/i);
  });

  it('refuses a manifest whose network and chain id disagree', () => {
    // Hand-edited: the network says testnet, the chain id says something else.
    const path = write('mismatched.json', validManifest({ chainId: 31_337 }));

    expect(() => loadDeploymentManifest({ path, ...TESTNET })).toThrow();
  });

  it('refuses an invalid contract address rather than passing it through', () => {
    const manifest = validManifest();
    const contracts = manifest['contracts'] as Record<string, { address: string }>;
    const factory = contracts['MarketFactory'];
    if (factory === undefined) throw new Error('fixture is missing MarketFactory');
    factory.address = '0xnot-an-address';
    const path = write('bad-address.json', manifest);

    expect(() => loadDeploymentManifest({ path, ...TESTNET })).toThrow();
  });

  it('refuses an unknown field instead of ignoring it', () => {
    // A manifest with a field this build does not understand was written by
    // something else. Ignoring it would mean acting on half a document.
    const path = write('extra.json', validManifest({ mainnetOverride: true }));

    expect(() => loadDeploymentManifest({ path, ...TESTNET })).toThrow();
  });

  it('names the file when it does not exist', () => {
    expect(() =>
      loadDeploymentManifest({ path: join(dir, 'absent.json'), ...TESTNET }),
    ).toThrow(/absent\.json/);
  });

  it('reports malformed JSON as a configuration problem, not a crash', () => {
    const path = join(dir, 'broken.json');
    writeFileSync(path, '{ not json', 'utf8');

    expect(() => loadDeploymentManifest({ path, ...TESTNET })).toThrow(/JSON/i);
  });
});

describe('enum decoding', () => {
  it('matches the ordinals in MarketTypes.sol', () => {
    // Ordering is protocol surface: the contract's comments say so, and the
    // indexer decodes by ordinal.
    expect(MARKET_STATES).toEqual([
      'OPEN',
      'CLOSED',
      'RESOLUTION_PROPOSED',
      'CHALLENGED',
      'FINALIZED',
      'SETTLED',
      'CANCELLED',
    ]);
    expect(OUTCOMES).toEqual(['UNSET', 'YES', 'NO', 'INVALID']);
    expect(CANCELLATION_REASONS).toEqual([
      'NONE',
      'NO_RESOLUTION',
      'NO_REVIEW',
      'RESOLVED_INVALID',
    ]);
  });

  it('round-trips an outcome through its ordinal', () => {
    for (const outcome of OUTCOMES) {
      expect(toOutcome(outcomeOrdinal(outcome))).toBe(outcome);
    }
  });

  it('throws on an ordinal this build does not know rather than defaulting', () => {
    // Defaulting to index 0 would read a newer contract as an older one — a
    // market in an unknown state would silently display as OPEN.
    expect(() => toMarketState(99)).toThrow(/does not know/);
    expect(() => toOutcome(99)).toThrow(/does not know/);
    expect(() => toCancellationReason(99)).toThrow(/does not know/);
  });
});
