import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { time } from '@nomicfoundation/hardhat-network-helpers';
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import type {
  ContractRunner,
  ContractTransactionResponse,
  Interface,
  LogDescription,
} from 'ethers';
import { ethers } from 'hardhat';

/**
 * A loosely typed contract handle.
 *
 * TypeChain would give sharper types but pulls in a code-generation step and
 * several packages for a benefit these tests do not need: the ABI surface is
 * small and every call is asserted against real on-chain state anyway.
 *
 * This cannot simply be ethers' `Contract`, because `Contract.connect()` is
 * declared as returning `BaseContract` — which drops the dynamic-method index
 * signature, so `market.connect(alice).stake(...)` would not typecheck. Making
 * `connect` return this same interface restores the chaining that every test
 * uses.
 */
export interface ContractHandle {
  readonly interface: Interface;
  getAddress(): Promise<string>;
  connect(runner: ContractRunner | null): ContractHandle;
  waitForDeployment(): Promise<unknown>;
  deploymentTransaction(): ContractTransactionResponse | null;
  [member: string]: any;
}

export type ConditionalMarket = ContractHandle;
export type MarketFactory = ContractHandle;
export type TestUSD = ContractHandle;

/** Narrow an ethers contract object to the handle shape used across the tests. */
export function asHandle(contract: unknown): ContractHandle {
  return contract as ContractHandle;
}

/** Ordinals must match `MarketTypes.State`. */
export const State = {
  OPEN: 0n,
  CLOSED: 1n,
  RESOLUTION_PROPOSED: 2n,
  CHALLENGED: 3n,
  FINALIZED: 4n,
  SETTLED: 5n,
  CANCELLED: 6n,
} as const;

/** Ordinals must match `MarketTypes.Outcome`. */
export const Outcome = {
  UNSET: 0n,
  YES: 1n,
  NO: 2n,
  INVALID: 3n,
} as const;

/** Ordinals must match `MarketTypes.CancellationReason`. */
export const CancellationReason = {
  NONE: 0n,
  NO_RESOLUTION: 1n,
  NO_REVIEW: 2n,
  RESOLVED_INVALID: 3n,
} as const;

export const DAY = 24 * 60 * 60;
export const HOUR = 60 * 60;

/** Six decimals, matching TestUSD and the stablecoins a real deployment uses. */
export function usd(amount: number): bigint {
  return BigInt(Math.round(amount * 1e6));
}

export const CHALLENGE_WINDOW = 2 * HOUR;
export const RESOLUTION_WINDOW = 7 * DAY;
export const CHALLENGE_BOND = usd(50);

export interface MarketParams {
  token: string;
  rulesHash: string;
  tradingEndsAt: bigint;
  conditionDeadline: bigint;
  challengeWindow: number;
  resolutionWindow: number;
  challengeBond: bigint;
}

export interface Protocol {
  admin: HardhatEthersSigner;
  resolver: HardhatEthersSigner;
  alice: HardhatEthersSigner;
  bob: HardhatEthersSigner;
  carol: HardhatEthersSigner;
  outsider: HardhatEthersSigner;
  token: TestUSD;
  factory: MarketFactory;
  implementation: string;
}

/**
 * Deploy the protocol and fund the participant accounts.
 *
 * Deliberately mirrors the real deployment order: token, implementation
 * (whose constructor disables its own initializers), then factory.
 */
export async function deployProtocol(): Promise<Protocol> {
  const [admin, resolver, alice, bob, carol, outsider] = await ethers.getSigners();

  const token = asHandle(await ethers.deployContract('TestUSD'));
  await token.waitForDeployment();

  const implementationContract = asHandle(await ethers.deployContract('ConditionalMarket'));
  await implementationContract.waitForDeployment();
  const implementation = await implementationContract.getAddress();

  const factory = asHandle(
    await ethers.deployContract('MarketFactory', [
      admin!.address,
      resolver!.address,
      implementation,
    ]),
  );
  await factory.waitForDeployment();

  for (const account of [alice!, bob!, carol!, outsider!]) {
    await token.mint(account.address, usd(1_000_000));
  }

  return {
    admin: admin!,
    resolver: resolver!,
    alice: alice!,
    bob: bob!,
    carol: carol!,
    outsider: outsider!,
    token,
    factory,
    implementation,
  };
}

let rulesHashCounter = 0;

/** A unique, syntactically valid rules hash. Stands in for a real commitment. */
export function nextRulesHash(): string {
  rulesHashCounter += 1;
  return ethers.zeroPadValue(ethers.toBeHex(rulesHashCounter), 32);
}

export async function defaultMarketParams(
  tokenAddress: string,
  overrides: Partial<MarketParams> = {},
): Promise<MarketParams> {
  const now = await time.latest();
  return {
    token: tokenAddress,
    rulesHash: nextRulesHash(),
    tradingEndsAt: BigInt(now + DAY),
    conditionDeadline: BigInt(now + 2 * DAY),
    challengeWindow: CHALLENGE_WINDOW,
    resolutionWindow: RESOLUTION_WINDOW,
    challengeBond: CHALLENGE_BOND,
    ...overrides,
  };
}

/** Create a market through the factory and return the clone, typed. */
export async function createMarket(
  protocol: Protocol,
  overrides: Partial<MarketParams> = {},
  creator?: HardhatEthersSigner,
): Promise<{ market: ConditionalMarket; marketId: bigint; params: MarketParams }> {
  const params = await defaultMarketParams(await protocol.token.getAddress(), overrides);
  const signer = creator ?? protocol.alice;

  const tx = await protocol.factory.connect(signer).createMarket(params);
  const receipt = await tx.wait();
  if (receipt === null) throw new Error('createMarket produced no receipt');

  const log = parseFactoryLogs(protocol, receipt.logs).find(
    (parsed) => parsed.name === 'MarketCreated',
  );
  if (!log) throw new Error('MarketCreated was not emitted');

  const marketId = log.args['marketId'] as bigint;
  const market = asHandle(
    await ethers.getContractAt('ConditionalMarket', log.args['market'] as string),
  );

  return { market, marketId, params };
}

/**
 * Decode the factory's events out of a receipt, discarding logs from other
 * contracts (the token's Transfer, for instance).
 */
export function parseFactoryLogs(
  protocol: Protocol,
  logs: readonly { topics: readonly string[]; data: string }[],
): LogDescription[] {
  const parsed: LogDescription[] = [];
  for (const entry of logs) {
    try {
      const description = protocol.factory.interface.parseLog({
        topics: [...entry.topics],
        data: entry.data,
      });
      if (description !== null) parsed.push(description);
    } catch {
      // Not one of ours.
    }
  }
  return parsed;
}

/** Approve and stake in one step, the way a frontend would. */
export async function stakeAs(
  protocol: Protocol,
  market: ConditionalMarket,
  staker: HardhatEthersSigner,
  side: bigint,
  amount: bigint,
): Promise<void> {
  await protocol.token.connect(staker).approve(await market.getAddress(), amount);
  await market.connect(staker).stake(side, amount);
}

/** Move past the market's trading end and close it. */
export async function closeMarket(market: ConditionalMarket): Promise<void> {
  await time.increaseTo(await market.tradingEndsAt());
  await market.close();
}

/** Move past the condition deadline so a proposal becomes possible. */
export async function reachConditionDeadline(market: ConditionalMarket): Promise<void> {
  await time.increaseTo(await market.conditionDeadline());
}

/** Move past the standing proposal's challenge window. */
export async function passChallengeWindow(market: ConditionalMarket): Promise<void> {
  await time.increaseTo((await market.challengeEndsAt()) + 1n);
}

// ---------------------------------------------------------------------------
// Shared golden vectors
// ---------------------------------------------------------------------------

export interface ConditionSpecVector {
  name: string;
  input: Record<string, unknown>;
  canonical: string;
  rulesHash: string;
}

export interface EvidencePackageVector {
  name: string;
  input: Record<string, unknown>;
  canonical: string;
  evidenceHash: string;
}

export interface GoldenVectors {
  producer: string;
  conditionSpecVersion: string;
  algorithm: { digest: string; encoding: string };
  conditionSpecs: ConditionSpecVector[];
  evidencePackages: EvidencePackageVector[];
}

/**
 * Load the vectors produced by `@covenant/shared`.
 *
 * Read from the package rather than copied into this repository: a duplicated
 * hash is a hash that can drift, and the whole point of the file is that both
 * sides of the boundary agree on the same bytes.
 */
export function loadGoldenVectors(): GoldenVectors {
  let path: string;
  try {
    path = require.resolve('@covenant/shared/vectors/golden.json');
  } catch {
    // Workspace fallback for when the package export map is not resolvable
    // (for example before a fresh install has linked the workspace).
    path = resolve(__dirname, '../../shared/vectors/golden.json');
  }
  return JSON.parse(readFileSync(path, 'utf8')) as GoldenVectors;
}
