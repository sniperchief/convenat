/**
 * Deploy the protocol to X Layer Testnet (§10).
 *
 *   npm run deploy:testnet --workspace @covenant/contracts
 *
 * Order matters and is fixed: TestUSD, then the ConditionalMarket
 * implementation, then the MarketFactory — the factory's constructor takes the
 * implementation address, so it cannot be first, and nothing may be deployed
 * before the chain id has been confirmed against the live node.
 *
 * The script is deterministic with respect to source, compiler settings,
 * constructor arguments and network (§12). It records all four in the manifest,
 * so a later verification request can reproduce exactly what was deployed
 * instead of relying on someone remembering.
 *
 * **It writes no key anywhere.** The deployer appears in the manifest as an
 * address. `DEPLOYER_PRIVATE_KEY` is read by Hardhat from the environment, is
 * never logged, and never reaches a file this repo tracks.
 */

import { ethers } from 'hardhat';

import {
  compilerSettings,
  requireNetwork,
  requireSigners,
  runScript,
  writeManifest,
  type DeploymentManifestFile,
  type ManifestContract,
} from './lib/support';

const NOT_ATTEMPTED: ManifestContract['verification'] = {
  status: 'not-attempted',
  url: null,
  note: 'Run scripts/verify.ts. Verification is recorded only when it actually succeeds.',
};

async function main(): Promise<void> {
  // Gate 1: the node must be the chain we think it is. Nothing is sent before
  // this returns.
  const target = await requireNetwork('xlayerTestnet');
  const { deployer, resolver } = await requireSigners();

  const balance = await ethers.provider.getBalance(deployer.address);
  if (balance === 0n) {
    throw new Error(
      `The deployer ${deployer.address} holds no OKB on chain ${target.chainId}. ` +
        'Fund it from the X Layer testnet faucet before deploying.',
    );
  }

  console.log(`network      ${target.hardhatName} (chain ${target.chainId})`);
  console.log(`deployer     ${deployer.address}`);
  console.log(`resolver     ${resolver.address}`);
  console.log(`balance      ${ethers.formatEther(balance)} OKB`);
  console.log('');

  // --- 1. TestUSD -----------------------------------------------------------
  // Its constructor refuses any chain outside its own allowlist, so a deployment
  // that reached the wrong network would revert here regardless of our guards.
  console.log('deploying TestUSD…');
  const token = await ethers.deployContract('TestUSD');
  await token.waitForDeployment();
  const tokenReceipt = await token.deploymentTransaction()?.wait();

  // --- 2. ConditionalMarket implementation ---------------------------------
  console.log('deploying ConditionalMarket implementation…');
  const implementation = await ethers.deployContract('ConditionalMarket');
  await implementation.waitForDeployment();
  const implementationReceipt = await implementation.deploymentTransaction()?.wait();

  // --- 3. MarketFactory ----------------------------------------------------
  const implementationAddress = await implementation.getAddress();
  const factoryArgs = [deployer.address, resolver.address, implementationAddress] as const;

  console.log('deploying MarketFactory…');
  const factory = await ethers.deployContract('MarketFactory', [...factoryArgs]);
  await factory.waitForDeployment();
  const factoryReceipt = await factory.deploymentTransaction()?.wait();

  const contract = (
    address: string,
    receipt: { hash: string; blockNumber: number } | null | undefined,
    constructorArgs: string[],
  ): ManifestContract => ({
    address: address.toLowerCase(),
    transactionHash: receipt?.hash.toLowerCase() ?? null,
    blockNumber: receipt?.blockNumber ?? null,
    constructorArgs,
    verification: { ...NOT_ATTEMPTED },
  });

  const tokenAddress = await token.getAddress();
  const factoryAddress = await factory.getAddress();

  // The indexer starts here. The factory's block, not the earliest of the
  // three: no market can exist before the factory does, and starting earlier
  // would only scan empty blocks.
  const startBlock = factoryReceipt?.blockNumber ?? 0;

  const manifest: DeploymentManifestFile = {
    schemaVersion: 1,
    environment: target.environment === 'testnet' ? 'testnet' : 'local',
    network: target.manifestNetwork,
    chainId: Number(target.chainId),
    deployedAt: new Date().toISOString(),
    deployer: deployer.address.toLowerCase(),
    resolver: resolver.address.toLowerCase(),
    compiler: compilerSettings(),
    startBlock,
    contracts: {
      TestUSD: contract(tokenAddress, tokenReceipt, []),
      ConditionalMarketImplementation: contract(implementationAddress, implementationReceipt, []),
      MarketFactory: contract(factoryAddress, factoryReceipt, [
        deployer.address,
        resolver.address,
        implementationAddress,
      ]),
    },
  };

  const path = writeManifest(manifest);

  console.log('');
  console.log(`TestUSD                   ${manifest.contracts.TestUSD.address}`);
  console.log(`ConditionalMarket (impl)  ${manifest.contracts.ConditionalMarketImplementation.address}`);
  console.log(`MarketFactory             ${manifest.contracts.MarketFactory.address}`);
  console.log(`start block               ${startBlock}`);
  console.log('');
  console.log(`manifest written to ${path}`);
  console.log('');
  console.log('Next: npm run verify:testnet, then fund:testnet.');
}

runScript(main);
