/**
 * Drive the testnet markets forward, from wherever they actually are (§24, §25).
 *
 *   npx hardhat run scripts/resume-lifecycle.ts --network xlayerTestnet
 *
 * Why this exists rather than `lifecycle.ts`
 * ------------------------------------------
 * `lifecycle.ts` assumes it starts from nothing and runs to completion in one
 * process. Against a public RPC that assumption is wrong: the first attempt died
 * with `Connect Timeout Error` after eleven minutes of polling, with real money
 * staked in two live markets and no way to resume.
 *
 * This script derives the next action from **on-chain state**, per market, every
 * time it runs. Re-running it after a failure repeats at most one transaction
 * and skips everything already done. That is the only design that survives a
 * network you do not control.
 *
 * The transitions, in the order the contract allows them:
 *
 *   OPEN                 → stake (only while trading is open), then close()
 *   CLOSED               → proposeResolution(...)          [resolver only]
 *   RESOLUTION_PROPOSED  → challenge()  [challenged market, round 1, in window]
 *                        → finalize()   [once the challenge window has run]
 *   CHALLENGED           → proposeResolution(...)  round 2  [resolver only]
 *   FINALIZED            → claim() / withdrawRefund() / claimChallengeBond()
 *   CANCELLED            → withdrawRefund()
 *
 * Nothing here forces a transition the contract would refuse. If a market is
 * somewhere unexpected, the script says so and moves on rather than reverting.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ethers } from 'hardhat';

import { readMarketsDocument } from './lib/markets';
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

const steps: {
  at: string;
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
  steps.push({ at: new Date().toISOString(), step, variant, txHash, detail });
  const tx = txHash === null ? '' : `  tx ${txHash}`;
  const extra = Object.entries(detail)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  console.log(`  [${variant}] ${step}${tx}${extra === '' ? '' : `  ${extra}`}`);
}

/**
 * Retry a call that can fail for reasons that are nothing to do with us.
 *
 * A public RPC drops connections. Retrying a *read* is always safe; a write is
 * only retried when it never reached the mempool, which is what a connect-level
 * failure means. Anything the chain actually rejected is rethrown immediately —
 * a revert is an answer, not an outage.
 */
async function withRetry<T>(label: string, run: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A revert, or any rejection the node reasoned about, is final.
      if (/revert|invalid|exceeds|insufficient|nonce too low|already known/i.test(message)) throw error;
      lastError = error;
      console.log(`    ${label}: attempt ${attempt} failed (${message.slice(0, 80)}), retrying…`);
      await new Promise((r) => setTimeout(r, 3_000 * attempt));
    }
  }
  throw lastError;
}

async function chainNow(): Promise<number> {
  const block = await withRetry('getBlock', () => ethers.provider.getBlock('latest'));
  return block?.timestamp ?? 0;
}

async function main(): Promise<void> {
  const target = await requireNetwork('xlayerTestnet');
  const manifest = readManifest(target.manifestNetwork);
  const { deployer, resolver, walletA, walletB } = await requireSigners();

  const document = readMarketsDocument();
  const markets = document.markets.filter((m) => m.onchain !== undefined);
  if (markets.length === 0) throw new Error('No created markets. Run create-market first.');

  const token = handle(await ethers.getContractAt('TestUSD', manifest.contracts.TestUSD.address));
  const balance = (who: string): Promise<bigint> => withRetry('balanceOf', () => token.balanceOf(who));

  console.log(`network   ${target.hardhatName} (chain ${target.chainId})`);
  console.log(`walletA   ${walletA.address}`);
  console.log(`walletB   ${walletB.address}`);
  console.log(`resolver  ${resolver.address}`);
  console.log('');

  const openingA = await balance(walletA.address);
  const openingB = await balance(walletB.address);
  console.log(`balances  A ${formatTusd(openingA)} TUSD   B ${formatTusd(openingB)} TUSD`);
  console.log('');

  // Placeholder evidence commitments. The real ones are keccak of a canonical
  // EvidencePackage from the resolution engine (M5); these are stand-ins and are
  // labelled as such rather than dressed up as real evidence.
  const evidence1 = ethers.keccak256(ethers.toUtf8Bytes('covenant:m4:placeholder-evidence:round-1'));
  const evidence2 = ethers.keccak256(ethers.toUtf8Bytes('covenant:m4:placeholder-evidence:round-2'));
  const reasonHash = ethers.keccak256(
    ethers.toUtf8Bytes('covenant:m4:challenge-reason:probe-reported-not-ok'),
  );

  /** Advance one market by at most one transition. Returns true if it moved. */
  async function advance(market: (typeof markets)[number]): Promise<boolean> {
    const address = market.onchain!.address;
    const m: ContractHandle = handle(await ethers.getContractAt('ConditionalMarket', address));
    const variant = market.variant;

    const state = Number(await withRetry('state', () => m.state()));
    const now = await chainNow();
    const name = StateName[state] ?? `?${state}`;

    switch (name) {
      case 'OPEN': {
        const tradingEndsAt = Number(await withRetry('tradingEndsAt', () => m.tradingEndsAt()));

        if (now < tradingEndsAt) {
          // Still open for stakes. Stake only what is missing, so a re-run after
          // a partial failure tops up rather than doubling.
          const [yesA] = (await withRetry('stakeOf A', () => m.stakeOf(walletA.address))) as [bigint, bigint];
          if (yesA === 0n) {
            await (await withRetry('approve A', () => token.connect(walletA).approve(address, STAKE_A))).wait();
            const tx = await (await withRetry('stake A', () => m.connect(walletA).stake(Outcome.YES, STAKE_A))).wait();
            record('stake YES (wallet A)', variant, tx.hash, { amount: formatTusd(STAKE_A) });
            return true;
          }
          const [, noB] = (await withRetry('stakeOf B', () => m.stakeOf(walletB.address))) as [bigint, bigint];
          if (noB === 0n) {
            await (await withRetry('approve B', () => token.connect(walletB).approve(address, STAKE_B))).wait();
            const tx = await (await withRetry('stake B', () => m.connect(walletB).stake(Outcome.NO, STAKE_B))).wait();
            record('stake NO (wallet B)', variant, tx.hash, { amount: formatTusd(STAKE_B) });
            return true;
          }
          record('waiting for trading to end', variant, null, {
            secondsLeft: String(tradingEndsAt - now),
          });
          return false;
        }

        // Permissionless: the deployer holds no privilege that makes this work.
        const tx = await (await withRetry('close', () => m.connect(deployer).close())).wait();
        record('close', variant, tx.hash, { totalYes: formatTusd(await m.totalYes()), totalNo: formatTusd(await m.totalNo()) });
        return true;
      }

      case 'CLOSED': {
        const conditionDeadline = Number(await withRetry('conditionDeadline', () => m.conditionDeadline()));
        if (now < conditionDeadline) {
          record('waiting for the condition deadline', variant, null, {
            secondsLeft: String(conditionDeadline - now),
          });
          return false;
        }
        const tx = await (
          await withRetry('propose', () => m.connect(resolver).proposeResolution(Outcome.YES, evidence1))
        ).wait();
        record('proposeResolution YES (round 1)', variant, tx.hash, {
          round: String(await m.proposalRound()),
        });
        return true;
      }

      case 'RESOLUTION_PROPOSED': {
        const round = Number(await withRetry('proposalRound', () => m.proposalRound()));
        const challengeEnds = Number(await withRetry('challengeEndsAt', () => m.challengeEndsAt()));

        // The challenged market gets exactly one contest, in round 1, inside the
        // window. Wallet B is a staker, so it is eligible.
        if (variant === 'challenged' && round === 1 && now < challengeEnds) {
          const bond: bigint = await withRetry('challengeBond', () => m.challengeBond());
          const before = await balance(walletB.address);
          if (bond > 0n) {
            await (await withRetry('approve bond', () => token.connect(walletB).approve(address, bond))).wait();
          }
          const tx = await (await withRetry('challenge', () => m.connect(walletB).challenge(reasonHash))).wait();
          const after = await balance(walletB.address);
          record('challenge (wallet B)', variant, tx.hash, {
            bond: formatTusd(bond),
            bondDelta: `-${formatTusd(before - after)}`,
          });
          return true;
        }

        if (now < challengeEnds) {
          record('waiting for the challenge window to close', variant, null, {
            secondsLeft: String(challengeEnds - now),
          });
          return false;
        }

        const tx = await (await withRetry('finalize', () => m.connect(deployer).finalize())).wait();
        record('finalize', variant, tx.hash, {
          finalOutcome: StateName[0] === undefined ? '' : String(await m.finalOutcome()),
          refundMode: String(await m.refundMode()),
        });
        return true;
      }

      case 'CHALLENGED': {
        // Round 2 overturns the outcome to NO, so the challenge was informative
        // and the bond comes back. This is the path worth exercising: it proves
        // the contract can be moved off a wrong answer.
        const tx = await (
          await withRetry('re-propose', () => m.connect(resolver).proposeResolution(Outcome.NO, evidence2))
        ).wait();
        record('proposeResolution NO (round 2)', variant, tx.hash, {
          round: String(await m.proposalRound()),
        });
        return true;
      }

      case 'FINALIZED': {
        const refundMode: boolean = await withRetry('refundMode', () => m.refundMode());
        let moved = false;

        for (const [label, who] of [
          ['wallet A', walletA],
          ['wallet B', walletB],
        ] as const) {
          const claimed: boolean = await withRetry('hasClaimed', () => m.hasClaimed(who.address));
          if (claimed) continue;

          if (refundMode) {
            const [yes, no] = (await withRetry('stakeOf', () => m.stakeOf(who.address))) as [bigint, bigint];
            if (yes + no === 0n) continue;
            const before = await balance(who.address);
            const tx = await (await withRetry('withdrawRefund', () => m.connect(who).withdrawRefund())).wait();
            const after = await balance(who.address);
            record(`withdrawRefund (${label})`, variant, tx.hash, { refund: formatTusd(after - before) });
            moved = true;
          } else {
            const preview: bigint = await withRetry('previewClaim', () => m.previewClaim(who.address));
            if (preview === 0n) continue;
            const before = await balance(who.address);
            const tx = await (await withRetry('claim', () => m.connect(who).claim())).wait();
            const after = await balance(who.address);
            record(`claim (${label})`, variant, tx.hash, { payout: formatTusd(after - before) });
            moved = true;
          }
        }

        // The challenger's bond is a separate claim from their winnings.
        const bondOutstanding: boolean = await withRetry('bondOutstanding', () => m.bondOutstanding());
        if (bondOutstanding) {
          const challenger: string = await withRetry('challenger', () => m.challenger());
          const who = challenger.toLowerCase() === walletB.address.toLowerCase() ? walletB : null;
          if (who !== null) {
            const before = await balance(who.address);
            const tx = await (await withRetry('claimChallengeBond', () => m.connect(who).claimChallengeBond())).wait();
            const after = await balance(who.address);
            record('claimChallengeBond (wallet B)', variant, tx.hash, {
              returned: formatTusd(after - before),
            });
            moved = true;
          }
        }

        if (!moved) record('nothing left to claim', variant, null, {});
        return moved;
      }

      case 'CANCELLED': {
        let moved = false;
        for (const [label, who] of [
          ['wallet A', walletA],
          ['wallet B', walletB],
        ] as const) {
          const claimed: boolean = await withRetry('hasClaimed', () => m.hasClaimed(who.address));
          const [yes, no] = (await withRetry('stakeOf', () => m.stakeOf(who.address))) as [bigint, bigint];
          if (claimed || yes + no === 0n) continue;
          const before = await balance(who.address);
          const tx = await (await withRetry('withdrawRefund', () => m.connect(who).withdrawRefund())).wait();
          const after = await balance(who.address);
          record(`withdrawRefund (${label})`, variant, tx.hash, { refund: formatTusd(after - before) });
          moved = true;
        }
        if (!moved) record('cancelled; nothing left to refund', variant, null, {});
        return moved;
      }

      case 'SETTLED':
        record('settled', variant, null, {});
        return false;

      default:
        record(`unexpected state ${name}`, variant, null, {});
        return false;
    }
  }

  // Keep advancing until neither market can move without waiting on the clock.
  for (let pass = 1; pass <= 12; pass += 1) {
    console.log(`— pass ${pass} —`);
    let moved = false;
    for (const market of markets) {
      const address = market.onchain!.address;
      const m = handle(await ethers.getContractAt('ConditionalMarket', address));
      const before = Number(await withRetry('state', () => m.state()));
      console.log(`  [${market.variant}] state ${StateName[before] ?? before}`);
      if (await advance(market)) moved = true;
    }

    if (!moved) {
      // Everything that can happen now has happened. If a challenge window is
      // still running, sleep just past it and try again rather than exiting.
      let shortestWait = Number.POSITIVE_INFINITY;
      for (const market of markets) {
        const m = handle(await ethers.getContractAt('ConditionalMarket', market.onchain!.address));
        const state = Number(await withRetry('state', () => m.state()));
        if (StateName[state] === 'RESOLUTION_PROPOSED') {
          const ends = Number(await withRetry('challengeEndsAt', () => m.challengeEndsAt()));
          const wait = ends - (await chainNow()) + 3;
          if (wait > 0 && wait < shortestWait) shortestWait = wait;
        }
      }
      if (!Number.isFinite(shortestWait)) break;
      console.log(`  sleeping ${shortestWait}s for a challenge window…`);
      await new Promise((r) => setTimeout(r, shortestWait * 1000));
    }
    console.log('');
  }

  // --- final accounting -----------------------------------------------------
  console.log('— final state —');
  const closingA = await balance(walletA.address);
  const closingB = await balance(walletB.address);

  const summary = [];
  for (const market of markets) {
    const m = handle(await ethers.getContractAt('ConditionalMarket', market.onchain!.address));
    const state = StateName[Number(await withRetry('state', () => m.state()))] ?? '?';
    const held = await balance(market.onchain!.address);
    const finalOutcome = Number(await withRetry('finalOutcome', () => m.finalOutcome()));
    console.log(
      `  ${market.variant.padEnd(11)} ${state.padEnd(20)} outcome=${finalOutcome} residual=${formatTusd(held)} TUSD`,
    );
    summary.push({
      variant: market.variant,
      marketId: market.onchain!.marketId,
      address: market.onchain!.address,
      rulesHash: market.rulesHash,
      state,
      finalOutcome,
      residualBaseUnits: held.toString(),
    });
  }

  console.log('');
  console.log(`  wallet A  ${formatTusd(openingA)} → ${formatTusd(closingA)} TUSD`);
  console.log(`  wallet B  ${formatTusd(openingB)} → ${formatTusd(closingB)} TUSD`);

  writeFileSync(
    RESULT_PATH,
    `${JSON.stringify(
      {
        completedAt: new Date().toISOString(),
        chainId: Number(target.chainId),
        walletA: walletA.address.toLowerCase(),
        walletB: walletB.address.toLowerCase(),
        resolver: resolver.address.toLowerCase(),
        balances: {
          A: { opening: openingA.toString(), closing: closingA.toString() },
          B: { opening: openingB.toString(), closing: closingB.toString() },
        },
        markets: summary,
        steps,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  console.log('');
  console.log(`transcript written to ${RESULT_PATH}`);
}

runScript(main);
