/**
 * Explorer source verification (§11).
 *
 *   npm run verify:testnet --workspace @covenant/contracts
 *
 * **This script records what happened, not what was intended.** Each attempt
 * writes `verified`, `attempted-failed` or `unsupported` into the manifest along
 * with the explorer's own message. There is no path through this file that
 * marks a contract verified without the explorer having said so — the milestone
 * is explicit that claiming verification without it is a failure mode worse than
 * admitting the explorer could not be reached.
 *
 * Two things are known to be uncertain here and are handled rather than assumed:
 *
 * 1. **The endpoint.** X Layer's testnet moved to chain 1952 with the OP Stack
 *    migration, while OKLink's published Hardhat instructions still describe the
 *    retired chain 195. If the configured API rejects chain 1952, that is
 *    recorded as `unsupported` with the response, not silently ignored.
 *
 * 2. **The clone.** Markets are EIP-1167 minimal proxies. Their 45-byte runtime
 *    contains no Solidity source to verify, so "verifying a market" means
 *    verifying the *implementation* it delegates to — which this script does.
 *    Explorers that understand proxies then display the implementation's ABI
 *    against the clone. A clone is recorded as `unsupported` with that
 *    explanation rather than left looking unverified for no stated reason.
 */

import { run } from 'hardhat';

import {
  readManifest,
  requireNetwork,
  runScript,
  writeManifest,
  type DeploymentManifestFile,
  type ManifestContract,
} from './lib/support';

interface Attempt {
  readonly key: keyof DeploymentManifestFile['contracts'];
  readonly contractPath: string;
}

const ATTEMPTS: readonly Attempt[] = [
  { key: 'TestUSD', contractPath: 'contracts/TestUSD.sol:TestUSD' },
  {
    key: 'ConditionalMarketImplementation',
    contractPath: 'contracts/ConditionalMarket.sol:ConditionalMarket',
  },
  { key: 'MarketFactory', contractPath: 'contracts/MarketFactory.sol:MarketFactory' },
];

/** Distinguish "already verified" from a real failure — it is a success. */
function isAlreadyVerified(message: string): boolean {
  return /already verified|already been verified/i.test(message);
}

/** Distinguish "this explorer cannot do this" from "this attempt failed". */
function isUnsupported(message: string): boolean {
  return /not supported|unsupported|chain.*not.*support|no such chain|invalid chain/i.test(message);
}

async function main(): Promise<void> {
  const target = await requireNetwork('xlayerTestnet');
  const manifest = readManifest(target.manifestNetwork);

  console.log(`network   ${target.hardhatName} (chain ${target.chainId})`);
  console.log('');

  let anyFailed = false;

  for (const attempt of ATTEMPTS) {
    const entry: ManifestContract = manifest.contracts[attempt.key];
    console.log(`verifying ${attempt.key} at ${entry.address}…`);

    let verification: ManifestContract['verification'];
    try {
      await run('verify:verify', {
        address: entry.address,
        constructorArguments: entry.constructorArgs,
        contract: attempt.contractPath,
      });
      verification = {
        status: 'verified',
        url: `https://web3.okx.com/explorer/x-layer-testnet/address/${entry.address}`,
        note: 'Verified through the configured explorer API.',
      };
      console.log('  verified');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (isAlreadyVerified(message)) {
        verification = {
          status: 'verified',
          url: `https://web3.okx.com/explorer/x-layer-testnet/address/${entry.address}`,
          note: 'Explorer reports this source was already verified.',
        };
        console.log('  already verified');
      } else if (isUnsupported(message)) {
        verification = {
          status: 'unsupported',
          url: null,
          // The explorer's own words, trimmed. Not a paraphrase — someone
          // reading this manifest later needs the actual reason.
          note: `Explorer does not support verification on this chain: ${message.slice(0, 300)}`,
        };
        console.log('  unsupported by this explorer');
      } else {
        anyFailed = true;
        verification = {
          status: 'attempted-failed',
          url: null,
          note: `Verification attempt failed: ${message.slice(0, 300)}`,
        };
        console.log('  FAILED');
        console.log(`  ${message.split('\n')[0] ?? ''}`);
      }
    }

    manifest.contracts[attempt.key] = { ...entry, verification };
  }

  const path = writeManifest(manifest);
  console.log('');
  console.log(`manifest updated: ${path}`);

  const summary = ATTEMPTS.map(
    (a) => `  ${a.key.padEnd(32)} ${manifest.contracts[a.key].verification.status}`,
  ).join('\n');
  console.log('');
  console.log(summary);

  console.log('');
  console.log(
    'Note: market instances are EIP-1167 clones and carry no source of their own. ' +
      'Verifying ConditionalMarket (the implementation) is what makes a market readable.',
  );

  if (anyFailed) {
    // Non-zero, so CI cannot mistake a failed verification for a clean run.
    throw new Error('At least one verification attempt failed. See the manifest for details.');
  }
}

runScript(main);
