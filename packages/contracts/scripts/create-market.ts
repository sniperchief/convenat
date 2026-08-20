/**
 * Create the testnet markets, and prove the hash survived the trip (§22).
 *
 *   npm run market:testnet --workspace @covenant/contracts
 *
 * Reads the specifications prepared by `apps/backend`'s `prepare-market` tool —
 * where `@covenant/shared` computed the rules hash — creates a market for each,
 * then reads `rulesHash` back off the chain and compares.
 *
 * The work lives in `lib/markets.ts` because `lifecycle.ts` does the same thing
 * in the same process: on a slow machine a second `hardhat run` boot can consume
 * most of a market's trading window before the first stake is sent. This script
 * remains useful for creating markets without running a lifecycle.
 */

import { ethers } from 'hardhat';

import { ensureMarkets, readMarketsDocument } from './lib/markets';
import { readManifest, requireNetwork, requireSigners, runScript } from './lib/support';

async function main(): Promise<void> {
  const target = await requireNetwork('xlayerTestnet');
  const manifest = readManifest(target.manifestNetwork);
  const { walletA } = await requireSigners();

  console.log(`network   ${target.hardhatName} (chain ${target.chainId})`);
  console.log(`factory   ${manifest.contracts.MarketFactory.address}`);
  console.log(`creator   ${walletA.address}`);
  console.log('');

  await ensureMarkets({
    document: readMarketsDocument(),
    factoryAddress: manifest.contracts.MarketFactory.address,
    creator: walletA,
    chainId: target.chainId,
  });

  void ethers;
}

runScript(main);
