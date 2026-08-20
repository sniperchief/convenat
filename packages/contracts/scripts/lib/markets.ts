/**
 * Creating the prepared markets, and proving the hash survived (§22).
 *
 * Extracted so `create-market.ts` and `lifecycle.ts` share one implementation.
 * That is not only DRY: on this machine a `hardhat run` boot costs minutes, and
 * the markets carry a trading window measured in minutes too. Running creation
 * and the lifecycle as two invocations spent most of the window on process
 * startup and the first stake reverted. One boot, one code path.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ethers } from 'hardhat';

import { handle } from './support';

export interface MarketRequest {
  variant: 'plain' | 'challenged';
  rulesHash: string;
  canonical: string;
  specification: Record<string, unknown>;
  createMarketParams: {
    token: string;
    rulesHash: string;
    tradingEndsAt: number;
    conditionDeadline: number;
    challengeWindow: number;
    resolutionWindow: number;
    challengeBond: string;
  };
  onchain?: {
    marketId: string;
    address: string;
    transactionHash: string;
    blockNumber: number;
  };
}

export interface MarketsDocument {
  generatedAt: string;
  chainId: number;
  environment: string;
  factory: string;
  creator: string;
  markets: MarketRequest[];
}

export const REQUEST_PATH = resolve(
  __dirname,
  '..',
  '..',
  'deployments',
  'xlayer-testnet-markets.json',
);

export function readMarketsDocument(): MarketsDocument {
  return JSON.parse(readFileSync(REQUEST_PATH, 'utf8')) as MarketsDocument;
}

export function writeMarketsDocument(document: MarketsDocument): void {
  writeFileSync(REQUEST_PATH, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
}

/**
 * Create any market that does not exist yet, and verify its hash round-trips.
 *
 * Idempotent: a market already registered under its rules hash is adopted
 * rather than recreated, which is also what the factory would enforce.
 */
export async function ensureMarkets(input: {
  document: MarketsDocument;
  factoryAddress: string;
  creator: Awaited<ReturnType<typeof ethers.getSigners>>[number];
  chainId: bigint;
}): Promise<void> {
  const { document, factoryAddress, creator } = input;

  if (document.chainId !== Number(input.chainId)) {
    throw new Error(
      `The prepared markets are for chain ${document.chainId}, not ${input.chainId}.`,
    );
  }
  if (document.creator.toLowerCase() !== creator.address.toLowerCase()) {
    // The creator is inside the hash. Creating from another wallet would produce
    // a market whose on-chain creator contradicts its own approved rules.
    throw new Error(
      `The specifications name ${document.creator} as creator, but the configured Wallet A is ` +
        `${creator.address}. The creator is part of the hashed rules and cannot be substituted.`,
    );
  }

  const factory = handle(await ethers.getContractAt('MarketFactory', factoryAddress));

  for (const market of document.markets) {
    const existing: string = await factory.marketByRulesHash(market.rulesHash);

    if (existing !== ethers.ZeroAddress) {
      if (market.onchain === undefined) {
        const instance = handle(await ethers.getContractAt('ConditionalMarket', existing));
        market.onchain = {
          marketId: (await instance.marketId()).toString(),
          address: existing.toLowerCase(),
          // Unknown: this market was created by an earlier run, and the
          // creating transaction is not something we can recover from state.
          transactionHash: '',
          blockNumber: 0,
        };
      }
      console.log(`${market.variant}: already created at ${existing}`);
      continue;
    }

    const params = market.createMarketParams;

    const head = await ethers.provider.getBlock('latest');
    const chainNow = head?.timestamp ?? 0;
    if (params.conditionDeadline <= chainNow) {
      throw new Error(
        `The ${market.variant} specification's deadline (${params.conditionDeadline}) is already ` +
          `behind the chain clock (${chainNow}). Re-run prepare-market for fresh timings.`,
      );
    }

    console.log(`creating ${market.variant}…`);
    const tx = await factory.connect(creator).createMarket({
      token: params.token,
      rulesHash: params.rulesHash,
      tradingEndsAt: params.tradingEndsAt,
      conditionDeadline: params.conditionDeadline,
      challengeWindow: params.challengeWindow,
      resolutionWindow: params.resolutionWindow,
      challengeBond: params.challengeBond,
    });
    const receipt = await tx.wait();
    if (receipt === null) throw new Error('createMarket produced no receipt');

    const address: string = await factory.marketByRulesHash(params.rulesHash);
    if (address === ethers.ZeroAddress) {
      throw new Error('createMarket succeeded but the factory has no market for the rules hash.');
    }

    const instance = handle(await ethers.getContractAt('ConditionalMarket', address));

    // --- the comparison the milestone is about -----------------------------
    const onChainHash: string = await instance.rulesHash();
    if (onChainHash.toLowerCase() !== market.rulesHash.toLowerCase()) {
      throw new Error(
        'STOP. The rules hash stored on-chain does not match the hash computed by ' +
          `@covenant/shared.\n  shared:   ${market.rulesHash}\n  on-chain: ${onChainHash}`,
      );
    }

    const marketId: bigint = await instance.marketId();
    market.onchain = {
      marketId: marketId.toString(),
      address: address.toLowerCase(),
      transactionHash: receipt.hash.toLowerCase(),
      blockNumber: receipt.blockNumber,
    };

    console.log(`  market id   ${marketId}`);
    console.log(`  address     ${address}`);
    console.log(`  tx          ${receipt.hash}`);
    console.log(`  block       ${receipt.blockNumber}`);
    console.log(`  rulesHash   ${onChainHash}  ✓ matches @covenant/shared`);
  }

  writeMarketsDocument(document);
}
