/**
 * Distribute testnet gas and TestUSD to the participant wallets (§23).
 *
 *   npm run fund:testnet --workspace @covenant/contracts
 *
 * The X Layer faucet is rate-limited per address per day, so claiming for four
 * wallets would take four days. Instead the deployer is funded once from the
 * faucet and this script forwards a small amount of OKB on-chain, then mints
 * TestUSD — which is unpermissioned free money by design, on an allowlisted
 * development chain only.
 *
 * Wallet A and Wallet B are funded as **independent accounts** because §23
 * requires two genuinely separate stakers. Nothing here merges them, and the
 * lifecycle script asserts their addresses differ.
 */

import { ethers } from 'hardhat';

import {
  formatTusd,
  handle,
  readManifest,
  requireNetwork,
  requireSigners,
  runScript,
} from './lib/support';

/** Enough for many transactions at ~0.02 gwei; the faucet gives 0.2 OKB. */
const GAS_TOPUP = ethers.parseEther('0.02');
/** 10,000 TUSD each, six decimals. */
const TUSD_GRANT = 10_000_000_000n;

async function main(): Promise<void> {
  const target = await requireNetwork('xlayerTestnet');
  const manifest = readManifest(target.manifestNetwork);
  const { deployer, resolver, walletA, walletB } = await requireSigners();

  if (walletA.address.toLowerCase() === walletB.address.toLowerCase()) {
    throw new Error(
      'WALLET_A and WALLET_B are the same account. The two-wallet test requires two ' +
        'independent wallets.',
    );
  }

  const token = handle(await ethers.getContractAt('TestUSD', manifest.contracts.TestUSD.address));

  console.log(`network   ${target.hardhatName} (chain ${target.chainId})`);
  console.log(`TestUSD   ${manifest.contracts.TestUSD.address}`);
  console.log('');

  // --- native gas -----------------------------------------------------------
  // The resolver needs gas to propose; A and B need gas to approve, stake,
  // challenge and claim. None of them needs much.
  for (const [label, account] of [
    ['resolver', resolver],
    ['walletA', walletA],
    ['walletB', walletB],
  ] as const) {
    const balance = await ethers.provider.getBalance(account.address);
    if (balance >= GAS_TOPUP) {
      console.log(`${label.padEnd(9)} ${account.address}  already holds ${ethers.formatEther(balance)} OKB`);
      continue;
    }

    const amount = GAS_TOPUP - balance;
    const tx = await deployer.sendTransaction({ to: account.address, value: amount });
    const receipt = await tx.wait();
    console.log(
      `${label.padEnd(9)} ${account.address}  +${ethers.formatEther(amount)} OKB  ` +
        `tx ${receipt?.hash ?? tx.hash}`,
    );
  }

  console.log('');

  // --- TestUSD --------------------------------------------------------------
  for (const [label, account] of [
    ['walletA', walletA],
    ['walletB', walletB],
  ] as const) {
    const before: bigint = await token.balanceOf(account.address);
    if (before >= TUSD_GRANT) {
      console.log(`${label.padEnd(9)} ${account.address}  already holds ${formatTusd(before)} TUSD`);
      continue;
    }

    // Anyone may mint; the wallet mints for itself so no allowance is involved.
    const tx = await token.connect(account).mint(account.address, TUSD_GRANT);
    const receipt = await tx.wait();
    const after: bigint = await token.balanceOf(account.address);
    console.log(
      `${label.padEnd(9)} ${account.address}  ${formatTusd(after)} TUSD  tx ${receipt?.hash ?? tx.hash}`,
    );
  }

  console.log('');
  console.log('funded.');
}

runScript(main);
