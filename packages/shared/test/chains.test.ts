/**
 * Network configuration.
 *
 * The value of these tests is less "does the lookup work" and more "is the
 * configuration honest": unconfirmed values must be marked unconfirmed, and no
 * contract or token address may leak into source.
 */

import { describe, expect, it } from 'vitest';

import {
  CHAIN_IDS,
  getNetwork,
  getNetworkByChainId,
  isNetworkVerified,
  isSupportedChainId,
  NETWORK_KEYS,
  NETWORKS,
  UnsupportedNetworkError,
} from '../src/index.js';

describe('lookup', () => {
  it('resolves each network by key', () => {
    for (const key of NETWORK_KEYS) {
      expect(getNetwork(key).key).toBe(key);
    }
  });

  it('resolves each network by chain id', () => {
    expect(getNetworkByChainId(CHAIN_IDS.xlayerTestnet).key).toBe('xlayer-testnet');
    expect(getNetworkByChainId(CHAIN_IDS.xlayerMainnet).key).toBe('xlayer-mainnet');
    expect(getNetworkByChainId(CHAIN_IDS.local).key).toBe('local');
  });

  it('throws a typed error for an unknown network', () => {
    expect(() => getNetwork('ethereum')).toThrow(UnsupportedNetworkError);
    expect(() => getNetworkByChainId(1)).toThrow(UnsupportedNetworkError);
    expect(isSupportedChainId(1)).toBe(false);
  });

  it('assigns a unique chain id to each network', () => {
    const ids = NETWORK_KEYS.map((key) => NETWORKS[key].chainId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('X Layer values from the project specification', () => {
  it('records testnet as chain 1952 over the terigon RPC', () => {
    const testnet = NETWORKS['xlayer-testnet'];
    expect(testnet.chainId).toBe(1952);
    expect(testnet.rpcUrls).toEqual(['https://testrpc.xlayer.tech/terigon']);
    expect(testnet.isTestnet).toBe(true);
    expect(testnet.nativeCurrency.symbol).toBe('OKB');
  });

  it('records mainnet as chain 196', () => {
    const mainnet = NETWORKS['xlayer-mainnet'];
    expect(mainnet.chainId).toBe(196);
    expect(mainnet.rpcUrls).toEqual(['https://rpc.xlayer.tech']);
    expect(mainnet.isTestnet).toBe(false);
    expect(mainnet.nativeCurrency.symbol).toBe('OKB');
  });
});

describe('honesty of unconfirmed values', () => {
  it('marks X Layer testnet verified, now that a live node has confirmed it', () => {
    // Milestone 4 called eth_chainId against https://testrpc.xlayer.tech/terigon
    // and got 0x7a0 (1952). This flag is the record of that, and flipping it is
    // what unlocks deployment — the deploy script refuses an unverified chain.
    expect(isNetworkVerified(NETWORKS['xlayer-testnet'])).toBe(true);
    expect(NETWORKS['xlayer-testnet'].chainId).toBe(1952);
  });

  it('leaves mainnet unverified, because nothing has confirmed it', () => {
    // Deliberately untouched by M4. Mainnet is out of scope, and a verified
    // flag it did not earn would be the exact dishonesty this suite exists to
    // prevent.
    expect(isNetworkVerified(NETWORKS['xlayer-mainnet'])).toBe(false);
    expect(NETWORKS['xlayer-mainnet'].verification.confirmedAt).toBeNull();
  });

  it('records when each confirmed value was confirmed, and explains it', () => {
    const testnet = NETWORKS['xlayer-testnet'].verification;
    expect(testnet.confirmedAt).not.toBeNull();
    // The note must name the evidence, not merely assert the conclusion.
    expect(testnet.note).toMatch(/eth_chainId/);
    expect(testnet.note).toMatch(/0x7a0|1952/);

    for (const key of ['xlayer-testnet', 'xlayer-mainnet'] as const) {
      expect(NETWORKS[key].verification.note.length).toBeGreaterThan(20);
    }
  });

  it('gives every network a confirmation depth, floored at the chain minimum', () => {
    // An indexer may lag further behind head than this, never less.
    expect(NETWORKS['xlayer-testnet'].minConfirmations).toBeGreaterThan(0);
    expect(NETWORKS.local.minConfirmations).toBe(0);
  });

  it('treats the local chain as verified, having nothing external to confirm', () => {
    expect(isNetworkVerified(NETWORKS.local)).toBe(true);
  });
});

describe('no addresses in configuration', () => {
  it('carries no contract or token addresses', () => {
    // Addresses are deployment outputs and belong in the manifests. A 20-byte
    // hex literal appearing here would be exactly the hardcoded-address problem
    // the architecture forbids.
    const serialised = JSON.stringify(NETWORKS);
    expect(serialised).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });

  it('points each network at its deployment manifest instead', () => {
    for (const key of NETWORK_KEYS) {
      expect(NETWORKS[key].deploymentManifest).toMatch(
        /^packages\/contracts\/deployments\/.+\.json$/,
      );
    }
  });

  it('leaves the explorer null where none has been confirmed', () => {
    // Guessing an explorer URL would be inventing an external service.
    expect(NETWORKS['xlayer-testnet'].blockExplorer).toBeNull();
    expect(NETWORKS['xlayer-mainnet'].blockExplorer).toBeNull();
  });
});
