/**
 * Local deployment.
 *
 * Deploys the protocol to whatever network Hardhat is pointed at and writes a
 * manifest. Guarded to development chains only: Milestone 2 does not deploy to
 * X Layer, and the chain id and RPC recorded in `@covenant/shared` are still
 * marked `unverified`. Milestone 4 adds the testnet path after confirming them
 * against a live node.
 *
 *   npx hardhat run scripts/deploy-local.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { ethers, network } from 'hardhat';

const DEVELOPMENT_CHAIN_IDS = new Set<bigint>([31337n]);

async function main(): Promise<void> {
  const { chainId } = await ethers.provider.getNetwork();
  if (!DEVELOPMENT_CHAIN_IDS.has(chainId)) {
    throw new Error(
      `Refusing to deploy to chain ${chainId}. This script targets local development only; ` +
        'X Layer deployment arrives in Milestone 4, after the chain id is confirmed live.',
    );
  }

  const [deployer, resolver] = await ethers.getSigners();
  if (deployer === undefined || resolver === undefined) {
    throw new Error('Expected at least two signers');
  }

  console.log(`network      ${network.name} (chain ${chainId})`);
  console.log(`deployer     ${deployer.address}`);
  console.log(`resolver     ${resolver.address}`);

  const token = await ethers.deployContract('TestUSD');
  await token.waitForDeployment();

  const implementation = await ethers.deployContract('ConditionalMarket');
  await implementation.waitForDeployment();

  const factory = await ethers.deployContract('MarketFactory', [
    deployer.address,
    resolver.address,
    await implementation.getAddress(),
  ]);
  await factory.waitForDeployment();

  const deployments = {
    chainId: Number(chainId),
    network: network.name,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    resolver: resolver.address,
    contracts: {
      TestUSD: {
        address: await token.getAddress(),
        transactionHash: token.deploymentTransaction()?.hash ?? null,
        blockNumber: (await token.deploymentTransaction()?.wait())?.blockNumber ?? null,
        verification: 'not-applicable-locally',
      },
      ConditionalMarketImplementation: {
        address: await implementation.getAddress(),
        transactionHash: implementation.deploymentTransaction()?.hash ?? null,
        blockNumber: (await implementation.deploymentTransaction()?.wait())?.blockNumber ?? null,
        verification: 'not-applicable-locally',
      },
      MarketFactory: {
        address: await factory.getAddress(),
        transactionHash: factory.deploymentTransaction()?.hash ?? null,
        blockNumber: (await factory.deploymentTransaction()?.wait())?.blockNumber ?? null,
        verification: 'not-applicable-locally',
      },
    },
  };

  const manifestPath = resolve(__dirname, '..', 'deployments', `${network.name}.json`);
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(deployments, null, 2)}\n`, 'utf8');

  console.log('');
  console.log(`TestUSD                        ${deployments.contracts.TestUSD.address}`);
  console.log(
    `ConditionalMarket (impl)       ${deployments.contracts.ConditionalMarketImplementation.address}`,
  );
  console.log(`MarketFactory                  ${deployments.contracts.MarketFactory.address}`);
  console.log('');
  console.log(`manifest written to ${manifestPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
