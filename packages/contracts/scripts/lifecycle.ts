/**
 * The complete live lifecycle on X Layer Testnet (§23, §24, §25).
 *
 *   npm run lifecycle:testnet --workspace @covenant/contracts
 *
 * Drives **two markets at once**, because the milestone asks for two different
 * endings and running them sequentially would double a wall-clock wait that is
 * already measured in minutes:
 *
 *   `plain`      — proposed, left unchallenged, finalized, winner claims (§24).
 *   `challenged` — proposed, challenged by Wallet B with a real bond,
 *                  re-proposed to the opposite outcome, finalized, winner claims
 *                  and the challenger recovers the bond (§25).
 *
 * Every wait is a real wait. There is no `evm_increaseTime` on a public chain,
 * so the script polls `block.timestamp` until the contract will actually accept
 * the next call. That is slow and it is the point: these are the same
 * transitions a user would experience.
 *
 * Balances are recorded before and after every movement and asserted at the end.
 * A lifecycle that "completed" without the money having moved correctly would
 * tell us nothing.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ethers } from 'hardhat';

import { ensureMarkets, readMarketsDocument } from './lib/markets';
import {
  formatTusd,
  handle,
  readManifest,
  requireNetwork,
  requireSigners,
  runScript,
  type ContractHandle,
} from './lib/support';

const RESULT_PATH = resolve(__dirname, '..', 'deployments', 'xlayer-testnet-lifecycle.json');

/** Stakes, six decimals: A backs YES with 100, B backs NO with 300. */
const STAKE_A = 100_000_000n;
const STAKE_B = 300_000_000n;

const Outcome = { UNSET: 0, YES: 1, NO: 2, INVALID: 3 } as const;
const StateName = [
  'OPEN',
  'CLOSED',
  'RESOLUTION_PROPOSED',
  'CHALLENGED',
  'FINALIZED',
  'SETTLED',
  'CANCELLED',
] as const;

type Handle = ContractHandle;

const steps: {
  step: string;
  variant: string;
  txHash: string | null;
  detail: Record<string, string>;
}[] = [];

function record(
  step: string,
  variant: string,
  txHash: string | null,
  detail: Record<string, string> = {},
): void {
  steps.push({ step, variant, txHash, detail });
  const tx = txHash === null ? '' : `  tx ${txHash}`;
  const extra = Object.entries(detail)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  console.log(`  [${variant}] ${step}${tx}${extra === '' ? '' : `  ${extra}`}`);
}

/** Poll until the chain's own clock has passed `timestamp`. */
async function waitUntil(timestamp: number, label: string): Promise<void> {
  for (;;) {
    const block = await ethers.provider.getBlock('latest');
    const nowOnChain = block?.timestamp ?? 0;
    if (nowOnChain > timestamp) return;

    const remaining = timestamp - nowOnChain + 1;
    console.log(`  waiting ${remaining}s for ${label} (chain clock ${nowOnChain})…`);
    await new Promise((r) => setTimeout(r, Math.min(remaining, 20) * 1000));
  }
}

async function main(): Promise<void> {
  const target = await requireNetwork('xlayerTestnet');
  const manifest = readManifest(target.manifestNetwork);
  const { deployer, resolver, walletA, walletB } = await requireSigners();

  if (walletA.address.toLowerCase() === walletB.address.toLowerCase()) {
    throw new Error('Wallet A and Wallet B must be independent accounts (§23).');
  }

  // Create the markets in this same process. A separate `hardhat run` costs
  // minutes of boot on a cold machine, and that time comes straight out of the
  // trading window the specifications committed to.
  const document = readMarketsDocument();
  await ensureMarkets({
    document,
    factoryAddress: manifest.contracts.MarketFactory.address,
    creator: walletA,
    chainId: target.chainId,
  });
  console.log('');

  const markets = document.markets.filter((m) => m.onchain !== undefined);
  if (markets.length !== 2) {
    throw new Error('Expected two created markets.');
  }

  const token = handle(
    await ethers.getContractAt('TestUSD', manifest.contracts.TestUSD.address),
  );

  const handles = new Map<string, Handle>();
  for (const market of markets) {
    handles.set(
      market.variant,
      handle(await ethers.getContractAt('ConditionalMarket', market.onchain!.address)),
    );
  }

  const balance = async (who: string): Promise<bigint> => token.balanceOf(who);

  console.log(`network   ${target.hardhatName} (chain ${target.chainId})`);
  console.log(`walletA   ${walletA.address}`);
  console.log(`walletB   ${walletB.address}`);
  console.log(`resolver  ${resolver.address}`);
  console.log('');

  const openingA = await balance(walletA.address);
  const openingB = await balance(walletB.address);
  console.log(`opening   A ${formatTusd(openingA)} TUSD   B ${formatTusd(openingB)} TUSD`);
  console.log('');

  // Fail fast, and say why. Staking after `tradingEndsAt` reverts inside the
  // contract with nothing a script can usefully report, so the window is
  // checked here where the remaining time can be printed.
  const head = await ethers.provider.getBlock('latest');
  const chainNow = head?.timestamp ?? 0;
  for (const market of markets) {
    const closesIn = market.createMarketParams.tradingEndsAt - chainNow;
    if (closesIn <= 0) {
      throw new Error(
        `The ${market.variant} market stopped accepting stakes ${-closesIn}s ago ` +
          `(tradingEndsAt ${market.createMarketParams.tradingEndsAt}, chain clock ${chainNow}). ` +
          'Re-run prepare-market and create-market to get fresh timings.',
      );
    }
    console.log(`  ${market.variant.padEnd(11)} accepts stakes for another ${closesIn}s`);
  }
  console.log('');

  // --- 1. two independent wallets stake ------------------------------------
  console.log('— staking —');
  for (const market of markets) {
    const handle = handles.get(market.variant)!;
    const address = market.onchain!.address;

    const beforeA = await balance(walletA.address);
    await (await token.connect(walletA).approve(address, STAKE_A)).wait();
    const stakeATx = await (await handle.connect(walletA).stake(Outcome.YES, STAKE_A)).wait();
    const afterA = await balance(walletA.address);
    if (beforeA - afterA !== STAKE_A) {
      throw new Error(
        `Wallet A's balance moved by ${beforeA - afterA}, expected ${STAKE_A}.`,
      );
    }
    record('stake YES (wallet A)', market.variant, stakeATx.hash, {
      amount: formatTusd(STAKE_A),
      balanceDelta: `-${formatTusd(beforeA - afterA)}`,
    });

    const beforeB = await balance(walletB.address);
    await (await token.connect(walletB).approve(address, STAKE_B)).wait();
    const stakeBTx = await (await handle.connect(walletB).stake(Outcome.NO, STAKE_B)).wait();
    const afterB = await balance(walletB.address);
    if (beforeB - afterB !== STAKE_B) {
      throw new Error(
        `Wallet B's balance moved by ${beforeB - afterB}, expected ${STAKE_B}.`,
      );
    }
    record('stake NO (wallet B)', market.variant, stakeBTx.hash, {
      amount: formatTusd(STAKE_B),
      balanceDelta: `-${formatTusd(beforeB - afterB)}`,
    });

    // The market must custody exactly what was deposited.
    const held: bigint = await balance(address);
    if (held !== STAKE_A + STAKE_B) {
      throw new Error(
        `The market holds ${held} but ${STAKE_A + STAKE_B} was deposited.`,
      );
    }
    record('market custody verified', market.variant, null, {
      held: formatTusd(held),
    });
  }

  // --- 2. close -------------------------------------------------------------
  console.log('');
  console.log('— closing —');
  const tradingEnd = Math.max(...markets.map((m) => m.createMarketParams.tradingEndsAt));
  await waitUntil(tradingEnd, 'trading to end');

  for (const market of markets) {
    const handle = handles.get(market.variant)!;
    // Permissionless: the deployer calls it, holding no privilege to do so.
    const receipt = await (await handle.connect(deployer).close()).wait();
    record('close', market.variant, receipt.hash, {
      state: StateName[Number(await handle.state())] ?? '?',
    });
  }

  // --- 3. propose -----------------------------------------------------------
  console.log('');
  console.log('— proposing —');
  const deadline = Math.max(...markets.map((m) => m.createMarketParams.conditionDeadline));
  await waitUntil(deadline, 'the condition deadline');

  // Placeholder evidence commitment. The real one is the keccak of a canonical
  // EvidencePackage produced by the resolution engine, which is Milestone 5 —
  // this is a stand-in and is labelled as such rather than dressed up.
  const evidenceHash = ethers.keccak256(
    ethers.toUtf8Bytes('covenant:m4:placeholder-evidence:round-1'),
  );

  for (const market of markets) {
    const handle = handles.get(market.variant)!;
    const receipt = await (
      await handle.connect(resolver).proposeResolution(Outcome.YES, evidenceHash)
    ).wait();
    record('proposeResolution YES (round 1)', market.variant, receipt.hash, {
      state: StateName[Number(await handle.state())] ?? '?',
      round: String(await handle.proposalRound()),
    });
  }

  // --- 4. challenge (challenged market only) --------------------------------
  console.log('');
  console.log('— challenge —');
  const challenged = markets.find((m) => m.variant === 'challenged')!;
  const challengedHandle = handles.get('challenged')!;
  const bond = BigInt(challenged.createMarketParams.challengeBond);

  const bondBefore = await balance(walletB.address);
  await (await token.connect(walletB).approve(challenged.onchain!.address, bond)).wait();
  const reasonHash = ethers.keccak256(
    ethers.toUtf8Bytes('covenant:m4:challenge-reason:probe-b-reported-not-ok'),
  );
  const challengeReceipt = await (
    await challengedHandle.connect(walletB).challenge(reasonHash)
  ).wait();
  const bondAfter = await balance(walletB.address);

  if (bondBefore - bondAfter !== bond) {
    throw new Error(`The challenge bond moved ${bondBefore - bondAfter}, expected ${bond}.`);
  }
  record('challenge (wallet B)', 'challenged', challengeReceipt.hash, {
    bond: formatTusd(bond),
    bondDelta: `-${formatTusd(bondBefore - bondAfter)}`,
    state: StateName[Number(await challengedHandle.state())] ?? '?',
  });

  // --- 5. second proposal, overturning the outcome --------------------------
  // Round 2 changes the outcome to NO, so the challenge was informative and the
  // bond is returned rather than forfeited. That is the path worth exercising:
  // it proves the contract can be moved off a wrong answer.
  const evidenceHash2 = ethers.keccak256(
    ethers.toUtf8Bytes('covenant:m4:placeholder-evidence:round-2'),
  );
  const round2 = await (
    await challengedHandle.connect(resolver).proposeResolution(Outcome.NO, evidenceHash2)
  ).wait();
  record('proposeResolution NO (round 2)', 'challenged', round2.hash, {
    state: StateName[Number(await challengedHandle.state())] ?? '?',
    round: String(await challengedHandle.proposalRound()),
  });

  // --- 6. finalize ----------------------------------------------------------
  console.log('');
  console.log('— finalizing —');
  for (const market of markets) {
    const handle = handles.get(market.variant)!;
    const challengeEnds = Number(await handle.challengeEndsAt());
    await waitUntil(challengeEnds, `${market.variant} challenge window to close`);

    const receipt = await (await handle.connect(deployer).finalize()).wait();
    record('finalize', market.variant, receipt.hash, {
      state: StateName[Number(await handle.state())] ?? '?',
      finalOutcome: String(await handle.finalOutcome()),
      refundMode: String(await handle.refundMode()),
    });
  }

  // --- 7. claims ------------------------------------------------------------
  console.log('');
  console.log('— claiming —');

  // plain: YES stood, so Wallet A takes the pool.
  const plainHandle = handles.get('plain')!;
  const plainBefore = await balance(walletA.address);
  const plainClaim = await (await plainHandle.connect(walletA).claim()).wait();
  const plainAfter = await balance(walletA.address);
  const plainPayout = plainAfter - plainBefore;
  if (plainPayout !== STAKE_A + STAKE_B) {
    throw new Error(
      `Wallet A received ${plainPayout} from the unchallenged market, expected the whole pool ` +
        `${STAKE_A + STAKE_B}.`,
    );
  }
  record('claim (wallet A, sole winner)', 'plain', plainClaim.hash, {
    payout: formatTusd(plainPayout),
  });

  // challenged: NO won, so Wallet B takes the pool and recovers the bond.
  const challengedBefore = await balance(walletB.address);
  const challengedClaim = await (await challengedHandle.connect(walletB).claim()).wait();
  const afterClaim = await balance(walletB.address);
  record('claim (wallet B, sole winner)', 'challenged', challengedClaim.hash, {
    payout: formatTusd(afterClaim - challengedBefore),
  });

  const bondClaim = await (await challengedHandle.connect(walletB).claimChallengeBond()).wait();
  const afterBond = await balance(walletB.address);
  const returned = afterBond - afterClaim;
  if (returned !== bond) {
    throw new Error(
      `The bond returned ${returned}, expected ${bond}. The challenge changed the outcome, so ` +
        'the bond should have come back in full.',
    );
  }
  record('claimChallengeBond (wallet B)', 'challenged', bondClaim.hash, {
    returned: formatTusd(returned),
  });

  // --- 8. final accounting --------------------------------------------------
  console.log('');
  console.log('— accounting —');
  const closingA = await balance(walletA.address);
  const closingB = await balance(walletB.address);

  // A staked twice, won one pool outright, lost the other stake.
  const expectedA = openingA - STAKE_A * 2n + (STAKE_A + STAKE_B);
  // B staked twice, lost one, won the other outright, bond returned in full.
  const expectedB = openingB - STAKE_B * 2n + (STAKE_A + STAKE_B);

  console.log(`  wallet A  ${formatTusd(closingA)}  expected ${formatTusd(expectedA)}`);
  console.log(`  wallet B  ${formatTusd(closingB)}  expected ${formatTusd(expectedB)}`);

  if (closingA !== expectedA) throw new Error("Wallet A's final balance is not what settlement implies.");
  if (closingB !== expectedB) throw new Error("Wallet B's final balance is not what settlement implies.");

  for (const market of markets) {
    const held: bigint = await balance(market.onchain!.address);
    const handle = handles.get(market.variant)!;
    console.log(
      `  ${market.variant.padEnd(11)} residual ${formatTusd(held)} TUSD  state ` +
        `${StateName[Number(await handle.state())] ?? '?'}`,
    );
  }

  writeFileSync(
    RESULT_PATH,
    `${JSON.stringify(
      {
        completedAt: new Date().toISOString(),
        chainId: Number(target.chainId),
        walletA: walletA.address.toLowerCase(),
        walletB: walletB.address.toLowerCase(),
        resolver: resolver.address.toLowerCase(),
        openingBalances: { A: openingA.toString(), B: openingB.toString() },
        closingBalances: { A: closingA.toString(), B: closingB.toString() },
        markets: markets.map((m) => ({
          variant: m.variant,
          rulesHash: m.rulesHash,
          address: m.onchain!.address,
          marketId: m.onchain!.marketId,
        })),
        steps,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  console.log('');
  console.log(`lifecycle complete. transcript written to ${RESULT_PATH}`);
}

runScript(main);
