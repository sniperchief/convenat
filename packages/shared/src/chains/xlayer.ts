/**
 * Network configuration — the single source of truth.
 *
 * No chain id, RPC URL or explorer endpoint may appear anywhere else in the
 * codebase. Applications resolve a network here and read what they need.
 *
 * Deliberately absent: **contract and token addresses**. Those are deployment
 * outputs, not build-time constants, and belong in
 * `packages/contracts/deployments/<network>.json`. Putting a token address in
 * source is how a testnet value ends up shipped to production.
 *
 * Verification status
 * -------------------
 * `verification` records, per network, whether the transcribed values have been
 * confirmed against a live node. No deployment may proceed against a network
 * whose chain id is still `unverified`.
 *
 * X Layer testnet was confirmed live in Milestone 4 (see BUILD_STATE.md §M4):
 * `eth_chainId` → `0x7a0` (1952) and `net_version` → `1952` from
 * `https://testrpc.xlayer.tech/terigon`. Mainnet remains unverified and
 * out of scope.
 */

import { UnsupportedNetworkError } from '../errors.js';

export const CHAIN_IDS = {
  /** Hardhat / anvil in-process chain. */
  local: 31_337,
  xlayerTestnet: 1_952,
  xlayerMainnet: 196,
} as const;

export type NetworkKey = 'local' | 'xlayer-testnet' | 'xlayer-mainnet';

export type VerificationState = 'verified' | 'unverified';

export interface NativeCurrency {
  readonly name: string;
  readonly symbol: string;
  readonly decimals: 18;
}

export interface BlockExplorer {
  readonly name: string;
  readonly url: string;
  readonly apiUrl: string;
}

export interface NetworkConfig {
  readonly key: NetworkKey;
  readonly chainId: number;
  readonly name: string;
  readonly isTestnet: boolean;
  /** Default public endpoints. Overridable per environment. */
  readonly rpcUrls: readonly string[];
  readonly nativeCurrency: NativeCurrency;
  /**
   * Explorer endpoints, or null when none has been confirmed for this network.
   * Resolved in Milestone 4; left null rather than guessed.
   */
  readonly blockExplorer: BlockExplorer | null;
  /** Path, relative to the repo root, of this network's deployment manifest. */
  readonly deploymentManifest: string;
  /**
   * Blocks an indexer stays behind head before treating a block as safe.
   *
   * A network property rather than an application preference: it follows from
   * how this chain reorganises, not from what a reader would like. Operators may
   * raise it through configuration; lowering it below this value is refused.
   */
  readonly minConfirmations: number;
  readonly verification: {
    readonly chainId: VerificationState;
    readonly rpcUrl: VerificationState;
    /** UTC instant the values were last confirmed against a live node. */
    readonly confirmedAt: string | null;
    readonly note: string;
  };
}

const OKB: NativeCurrency = { name: 'OKB', symbol: 'OKB', decimals: 18 };

export const NETWORKS: Readonly<Record<NetworkKey, NetworkConfig>> = {
  local: {
    key: 'local',
    chainId: CHAIN_IDS.local,
    name: 'Local (Hardhat)',
    isTestnet: true,
    rpcUrls: ['http://127.0.0.1:8545'],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    blockExplorer: null,
    deploymentManifest: 'packages/contracts/deployments/local.json',
    // An in-process chain does not reorganise; waiting would only make the
    // integration tests slow.
    minConfirmations: 0,
    verification: {
      chainId: 'verified',
      rpcUrl: 'verified',
      confirmedAt: null,
      note: 'Hardhat default chain id and RPC; nothing external to confirm.',
    },
  },

  'xlayer-testnet': {
    key: 'xlayer-testnet',
    chainId: CHAIN_IDS.xlayerTestnet,
    name: 'X Layer Testnet',
    isTestnet: true,
    rpcUrls: ['https://testrpc.xlayer.tech/terigon'],
    nativeCurrency: OKB,
    blockExplorer: null,
    deploymentManifest: 'packages/contracts/deployments/xlayer-testnet.json',
    // X Layer is an OP Stack rollup: blocks are produced by a single sequencer
    // and are only truly final once settled on L1, which is far longer than any
    // interactive product can wait. Five blocks is the explicit MVP compromise —
    // enough to survive a sequencer-local reflow, short enough to stay usable,
    // and backed by the indexer's block-hash check rather than trusted alone.
    minConfirmations: 5,
    verification: {
      chainId: 'verified',
      rpcUrl: 'verified',
      confirmedAt: '2026-08-17T00:00:00.000Z',
      note:
        'Confirmed live in Milestone 4: eth_chainId returned 0x7a0 (1952) and net_version returned ' +
        '1952 from https://testrpc.xlayer.tech/terigon, served by reth/v2.3.0 (xlayer/v0.0.7).',
    },
  },

  'xlayer-mainnet': {
    key: 'xlayer-mainnet',
    chainId: CHAIN_IDS.xlayerMainnet,
    name: 'X Layer',
    isTestnet: false,
    rpcUrls: ['https://rpc.xlayer.tech'],
    nativeCurrency: OKB,
    blockExplorer: null,
    deploymentManifest: 'packages/contracts/deployments/xlayer-mainnet.json',
    minConfirmations: 15,
    verification: {
      chainId: 'unverified',
      rpcUrl: 'unverified',
      confirmedAt: null,
      note:
        'Transcribed from the project specification. Mainnet deployment is out of scope until testnet end-to-end and security review are complete.',
    },
  },
} as const;

export const NETWORK_KEYS = Object.keys(NETWORKS) as readonly NetworkKey[];

export function isNetworkKey(value: string): value is NetworkKey {
  return Object.prototype.hasOwnProperty.call(NETWORKS, value);
}

/** @throws {UnsupportedNetworkError} if `key` is not a configured network. */
export function getNetwork(key: string): NetworkConfig {
  if (!isNetworkKey(key)) {
    throw new UnsupportedNetworkError(
      `Unknown network "${key}". Configured networks: ${NETWORK_KEYS.join(', ')}.`,
    );
  }
  return NETWORKS[key];
}

/** @throws {UnsupportedNetworkError} if no configured network has this chain id. */
export function getNetworkByChainId(chainId: number): NetworkConfig {
  const match = NETWORK_KEYS.map((key) => NETWORKS[key]).find(
    (network) => network.chainId === chainId,
  );
  if (match === undefined) {
    throw new UnsupportedNetworkError(`Unknown chain id ${chainId}.`);
  }
  return match;
}

export function isSupportedChainId(chainId: number): boolean {
  return NETWORK_KEYS.some((key) => NETWORKS[key].chainId === chainId);
}

/** True when every transcribed value for this network has been confirmed live. */
export function isNetworkVerified(network: NetworkConfig): boolean {
  return network.verification.chainId === 'verified' && network.verification.rpcUrl === 'verified';
}

/**
 * The confirmation depth an indexer must use on `network`.
 *
 * An operator may lag further behind head than the network requires; they may
 * not lag less. A configuration that asked for fewer confirmations than the
 * chain warrants would not be a tuning choice, it would be a decision to index
 * blocks that can still disappear — so it is refused rather than clamped
 * silently.
 *
 * @throws {UnsupportedNetworkError} if `requested` is below the network minimum
 *   or is not a non-negative integer.
 */
export function resolveConfirmations(
  network: NetworkConfig,
  requested: number | null | undefined,
): number {
  if (requested === null || requested === undefined) return network.minConfirmations;
  if (!Number.isInteger(requested) || requested < 0) {
    throw new UnsupportedNetworkError(
      `Confirmation depth must be a non-negative integer; received ${String(requested)}.`,
    );
  }
  if (requested < network.minConfirmations) {
    throw new UnsupportedNetworkError(
      `Confirmation depth ${requested} is below the minimum of ${network.minConfirmations} for ` +
        `${network.name}. Indexing closer to head than this would persist blocks that can still ` +
        'be reorganised away.',
    );
  }
  return requested;
}
