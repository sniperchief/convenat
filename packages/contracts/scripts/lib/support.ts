/**
 * Deployment support: guards, environment access, manifest writing.
 *
 * Everything here exists to make one class of accident impossible — deploying
 * to, or transacting against, a network nobody meant to touch (§8, §9).
 *
 * On types: this package is a CommonJS island (ADR-0010) and only JSON crosses
 * the seam to `@covenant/shared`, so the manifest shape is declared here rather
 * than imported. It is not trusted on that account: the written file is
 * validated against the shared schema by a test in `packages/shared` and again
 * by the backend at startup. Two independent checks of one artefact, neither of
 * them this file's own assertion about itself.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { ethers, network } from 'hardhat';

// --- networks --------------------------------------------------------------

export const XLAYER_TESTNET_CHAIN_ID = 1952n;
export const LOCAL_CHAIN_ID = 31337n;

export interface NetworkTarget {
  readonly hardhatName: string;
  readonly manifestNetwork: string;
  readonly environment: 'local' | 'testnet';
  readonly chainId: bigint;
}

/** The networks a script in this package may target. Mainnet is not among them. */
export const TARGETS: Readonly<Record<string, NetworkTarget>> = {
  xlayerTestnet: {
    hardhatName: 'xlayerTestnet',
    manifestNetwork: 'xlayer-testnet',
    environment: 'testnet',
    chainId: XLAYER_TESTNET_CHAIN_ID,
  },
  localhost: {
    hardhatName: 'localhost',
    manifestNetwork: 'local',
    environment: 'local',
    chainId: LOCAL_CHAIN_ID,
  },
  hardhat: {
    hardhatName: 'hardhat',
    manifestNetwork: 'local',
    environment: 'local',
    chainId: LOCAL_CHAIN_ID,
  },
};

/**
 * Resolve the target, and confirm the live node agrees.
 *
 * **This runs before any transaction is sent** (§9). Hardhat's own `chainId`
 * setting is a declaration about what we expect; this is a question put to the
 * node. Only the answer counts, so a mismatch throws and the process exits
 * without having broadcast anything.
 */
export async function requireNetwork(expected: keyof typeof TARGETS): Promise<NetworkTarget> {
  const target = TARGETS[expected];
  if (target === undefined) {
    throw new Error(`Unknown deployment target "${String(expected)}".`);
  }

  if (network.name !== target.hardhatName) {
    throw new Error(
      `This script targets ${target.hardhatName}, but Hardhat is on "${network.name}". ` +
        `Run it with --network ${target.hardhatName}.`,
    );
  }

  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== target.chainId) {
    throw new Error(
      `REFUSING TO PROCEED. The RPC endpoint reports chain ${chainId}, but ${target.hardhatName} ` +
        `is chain ${target.chainId}. Nothing has been sent. Check XLAYER_TESTNET_RPC_URL.`,
    );
  }

  return target;
}

/**
 * Read a required environment variable.
 *
 * @throws with the variable's *name* and never its value — several of these are
 *   private keys, and a message that echoed one would put it in a terminal
 *   scrollback, a CI log, and a screenshot.
 */
export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is not set. Add it to the repo-root .env before running this script.`);
  }
  return value;
}

/**
 * The named signers a script needs.
 *
 * Hardhat derives these from the `accounts` array in the network config, in the
 * order the config lists them. Asking for them by role here keeps the ordering
 * assumption in one place instead of every script.
 */
export interface Signers {
  readonly deployer: Awaited<ReturnType<typeof ethers.getSigners>>[number];
  readonly resolver: Awaited<ReturnType<typeof ethers.getSigners>>[number];
  readonly walletA: Awaited<ReturnType<typeof ethers.getSigners>>[number];
  readonly walletB: Awaited<ReturnType<typeof ethers.getSigners>>[number];
}

export async function requireSigners(count = 4): Promise<Signers> {
  const signers = await ethers.getSigners();
  if (signers.length < count) {
    throw new Error(
      `Expected ${count} configured accounts, found ${signers.length}. The network's accounts come ` +
        'from DEPLOYER_PRIVATE_KEY, RESOLVER_PRIVATE_KEY, WALLET_A_PRIVATE_KEY and ' +
        'WALLET_B_PRIVATE_KEY, in that order.',
    );
  }
  const [deployer, resolver, walletA, walletB] = signers;
  if (!deployer || !resolver || !walletA || !walletB) {
    throw new Error('Signer list was shorter than reported.');
  }
  return { deployer, resolver, walletA, walletB };
}

/**
 * A loosely typed contract handle.
 *
 * The same accommodation the M2 tests make (ADR-0010): without TypeChain,
 * ethers' `getContractAt` returns a `BaseContract` with no knowledge of the
 * ABI's methods, and `connect()` drops the dynamic-method index signature. The
 * cost is real and accepted — every call in these scripts is checked against
 * on-chain state immediately afterwards, which is a stronger guarantee than a
 * compile-time shape.
 */
export interface ContractHandle {
  getAddress(): Promise<string>;
  connect(runner: unknown): ContractHandle;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [member: string]: any;
}

export const handle = (contract: unknown): ContractHandle => contract as ContractHandle;

// --- manifest --------------------------------------------------------------

export interface ManifestContract {
  address: string;
  transactionHash: string | null;
  blockNumber: number | null;
  constructorArgs: string[];
  verification: {
    status: 'verified' | 'attempted-failed' | 'not-attempted' | 'unsupported';
    url: string | null;
    note: string;
  };
}

export interface DeploymentManifestFile {
  schemaVersion: 1;
  environment: 'local' | 'testnet' | 'mainnet';
  network: string;
  chainId: number;
  deployedAt: string;
  deployer: string;
  resolver: string;
  compiler: {
    solc: string;
    evmVersion: string;
    optimizer: { enabled: boolean; runs: number };
  };
  startBlock: number;
  contracts: {
    TestUSD: ManifestContract;
    ConditionalMarketImplementation: ManifestContract;
    MarketFactory: ManifestContract;
  };
}

export function manifestPath(manifestNetwork: string): string {
  return resolve(__dirname, '..', '..', 'deployments', `${manifestNetwork}.json`);
}

export function writeManifest(manifest: DeploymentManifestFile): string {
  const path = manifestPath(manifest.network);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return path;
}

export function readManifest(manifestNetwork: string): DeploymentManifestFile {
  // Required rather than imported: this file runs under ts-node in a CJS
  // package, and the manifest is data, not a module.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const path = manifestPath(manifestNetwork);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as DeploymentManifestFile;
  } catch {
    throw new Error(`No deployment manifest at ${path}. Run the deploy script first.`);
  }
}

/**
 * Compiler settings, read from the Hardhat config rather than retyped.
 *
 * A manifest that recorded settings by hand would drift from the settings that
 * actually produced the bytecode, and explorer verification would then fail for
 * a reason nobody could see.
 */
export function compilerSettings(): DeploymentManifestFile['compiler'] {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const config = require('../../hardhat.config').default as {
    solidity: {
      version: string;
      settings: { evmVersion: string; optimizer: { enabled: boolean; runs: number } };
    };
  };
  return {
    solc: config.solidity.version,
    evmVersion: config.solidity.settings.evmVersion,
    optimizer: {
      enabled: config.solidity.settings.optimizer.enabled,
      runs: config.solidity.settings.optimizer.runs,
    },
  };
}

/** Format a token amount with six decimals, for logs. */
export function formatTusd(amount: bigint): string {
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, '0');
  return `${whole.toString()}.${fraction}`;
}

/**
 * Run a script's main, exiting non-zero on failure.
 *
 * A bare `execution reverted` is nearly useless when the caller is a script
 * driving a live chain — it says something failed and nothing about what. Ethers
 * attaches the decoded custom error, the failing call and the transaction hash
 * to the error object, so those are printed when present. The stack is still
 * suppressed; it is never the interesting part here.
 */
export function runScript(main: () => Promise<void>): void {
  main().catch((error: unknown) => {
    console.error('');
    console.error(error instanceof Error ? error.message : String(error));

    const detail = error as {
      shortMessage?: string;
      reason?: string;
      revert?: { name?: string; args?: unknown[] };
      transaction?: { to?: string; from?: string };
      receipt?: { hash?: string };
      info?: { error?: { message?: string } };
    };

    if (detail.revert?.name !== undefined) {
      const args = (detail.revert.args ?? []).map((a) => String(a)).join(', ');
      console.error(`  custom error: ${detail.revert.name}(${args})`);
    }
    if (detail.reason !== undefined) console.error(`  reason:       ${detail.reason}`);
    if (detail.shortMessage !== undefined) console.error(`  short:        ${detail.shortMessage}`);
    if (detail.transaction?.to !== undefined) console.error(`  to:           ${detail.transaction.to}`);
    if (detail.transaction?.from !== undefined) console.error(`  from:         ${detail.transaction.from}`);
    if (detail.receipt?.hash !== undefined) console.error(`  tx:           ${detail.receipt.hash}`);
    if (detail.info?.error?.message !== undefined) {
      console.error(`  node said:    ${detail.info.error.message}`);
    }

    console.error('');
    process.exitCode = 1;
  });
}
