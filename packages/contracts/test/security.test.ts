/**
 * Adversarial tests.
 *
 * Each of these asks a question the security model claims to have an answer for:
 * can a privileged party take money, can a commitment be rewritten, can the
 * state machine be walked around, can a callback be used to claim twice.
 */

import { time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  CHALLENGE_BOND,
  Outcome,
  State,
  asHandle,
  closeMarket,
  createMarket,
  defaultMarketParams,
  deployProtocol,
  passChallengeWindow,
  reachConditionDeadline,
  stakeAs,
  usd,
  type ConditionalMarket,
  type ContractHandle,
  type Protocol,
} from './helpers';

const EVIDENCE = ethers.id('evidence');

/** Every function name in a contract's ABI. */
function functionNames(contract: ContractHandle): string[] {
  const names: string[] = [];
  contract.interface.forEachFunction((fragment) => names.push(fragment.name));
  return names;
}

describe('Security', () => {
  let protocol: Protocol;
  let market: ConditionalMarket;

  beforeEach(async () => {
    protocol = await deployProtocol();
    ({ market } = await createMarket(protocol));
    await stakeAs(protocol, market, protocol.alice, Outcome.YES, usd(100));
    await stakeAs(protocol, market, protocol.bob, Outcome.NO, usd(100));
  });

  describe('no privileged path to user funds', () => {
    it('exposes no fund-moving function on the factory at all', () => {
      for (const name of functionNames(protocol.factory)) {
        expect(name).to.not.match(/withdraw|sweep|rescue|drain|transfer|emergency|seize/i);
      }
    });

    it('exposes no fund-moving function on the market beyond the refund path', () => {
      const names = functionNames(market).filter((name) =>
        /withdraw|sweep|rescue|drain|emergency|seize|transfer/i.test(name),
      );
      expect(names.sort()).to.deep.equal(['withdrawRefund']);
    });

    it('gives the admin no way to take a market s balance', async () => {
      const marketAddress = await market.getAddress();
      expect(await protocol.token.balanceOf(marketAddress)).to.equal(usd(200));

      // The admin holds DEFAULT_ADMIN_ROLE and can pause. That is all.
      await protocol.factory.connect(protocol.admin).pause();
      expect(await protocol.token.balanceOf(marketAddress)).to.equal(usd(200));

      // Nothing the admin can do resembles a withdrawal.
      await expect(market.connect(protocol.admin).claim()).to.be.revertedWithCustomError(
        market,
        'InvalidState',
      );
      await expect(market.connect(protocol.admin).withdrawRefund()).to.be.revertedWithCustomError(
        market,
        'NotInRefundMode',
      );
    });

    it('gives the resolver no way to take a market s balance', async () => {
      await closeMarket(market);
      await reachConditionDeadline(market);
      await market.connect(protocol.resolver).proposeResolution(Outcome.YES, EVIDENCE);
      await passChallengeWindow(market);
      await market.finalize();

      // The resolver decided the outcome and still gets nothing: it never staked.
      await expect(market.connect(protocol.resolver).claim()).to.be.revertedWithCustomError(
        market,
        'NothingToClaim',
      );
      expect(await market.previewClaim(protocol.resolver.address)).to.equal(0n);
    });

    it('lets the resolver decide the outcome but not who is paid', async () => {
      await closeMarket(market);
      await reachConditionDeadline(market);
      await market.connect(protocol.resolver).proposeResolution(Outcome.NO, EVIDENCE);
      await passChallengeWindow(market);
      await market.finalize();

      const before = await protocol.token.balanceOf(protocol.bob.address);
      await market.connect(protocol.bob).claim();
      expect((await protocol.token.balanceOf(protocol.bob.address)) - before).to.equal(usd(200));
      expect(await protocol.token.balanceOf(await market.getAddress())).to.equal(0n);
    });
  });

  describe('immutability of the rules commitment', () => {
    it('offers no function that writes rulesHash after initialization', async () => {
      const original = await market.rulesHash();
      const writers: string[] = [];
      market.interface.forEachFunction((fragment) => {
        if (fragment.stateMutability !== 'view' && fragment.stateMutability !== 'pure') {
          writers.push(fragment.name);
        }
      });

      // Every state-changing entry point, enumerated. None of them is a setter.
      expect(writers.sort()).to.deep.equal([
        'cancel',
        'challenge',
        'claim',
        'claimChallengeBond',
        'close',
        'finalize',
        'initialize',
        'proposeResolution',
        'stake',
        'withdrawRefund',
      ]);
      expect(await market.rulesHash()).to.equal(original);
    });

    it('keeps rulesHash fixed across the entire lifecycle', async () => {
      const original = await market.rulesHash();
      await closeMarket(market);
      expect(await market.rulesHash()).to.equal(original);
      await reachConditionDeadline(market);
      await market.connect(protocol.resolver).proposeResolution(Outcome.YES, EVIDENCE);
      expect(await market.rulesHash()).to.equal(original);
      await passChallengeWindow(market);
      await market.finalize();
      expect(await market.rulesHash()).to.equal(original);
      await market.connect(protocol.alice).claim();
      expect(await market.rulesHash()).to.equal(original);
    });

    it('cannot be rewritten by re-initializing', async () => {
      const original = await market.rulesHash();
      const params = await defaultMarketParams(await protocol.token.getAddress());
      await expect(
        market.connect(protocol.resolver).initialize({
          marketId: 1n,
          creator: protocol.resolver.address,
          token: params.token,
          rulesHash: params.rulesHash,
          tradingEndsAt: params.tradingEndsAt,
          conditionDeadline: params.conditionDeadline,
          challengeWindow: params.challengeWindow,
          resolutionWindow: params.resolutionWindow,
          challengeBond: params.challengeBond,
        }),
      ).to.be.revertedWithCustomError(market, 'InvalidInitialization');
      expect(await market.rulesHash()).to.equal(original);
      expect(await market.token()).to.equal(await protocol.token.getAddress());
      expect(await market.creator()).to.equal(protocol.alice.address);
    });
  });

  describe('state machine cannot be walked around', () => {
    it('rejects every out-of-order transition from OPEN', async () => {
      await expect(market.finalize()).to.be.revertedWithCustomError(market, 'InvalidState');
      await expect(market.cancel()).to.be.revertedWithCustomError(market, 'ResolutionWindowActive');
      await expect(market.connect(protocol.alice).claim()).to.be.revertedWithCustomError(
        market,
        'InvalidState',
      );
      await expect(market.connect(protocol.alice).challenge(EVIDENCE)).to.be.revertedWithCustomError(
        market,
        'InvalidState',
      );
    });

    it('rejects a challenge before any proposal exists', async () => {
      await closeMarket(market);
      await protocol.token.connect(protocol.bob).approve(await market.getAddress(), CHALLENGE_BOND);
      await expect(market.connect(protocol.bob).challenge(EVIDENCE))
        .to.be.revertedWithCustomError(market, 'InvalidState')
        .withArgs(State.CLOSED);
    });

    it('rejects staking, proposing and finalizing once a market is settled', async () => {
      await closeMarket(market);
      await reachConditionDeadline(market);
      await market.connect(protocol.resolver).proposeResolution(Outcome.YES, EVIDENCE);
      await passChallengeWindow(market);
      await market.finalize();
      await market.connect(protocol.alice).claim();
      expect(await market.state()).to.equal(State.SETTLED);

      await protocol.token.connect(protocol.carol).approve(await market.getAddress(), usd(1));
      await expect(
        market.connect(protocol.carol).stake(Outcome.YES, usd(1)),
      ).to.be.revertedWithCustomError(market, 'InvalidState');
      await expect(
        market.connect(protocol.resolver).proposeResolution(Outcome.NO, EVIDENCE),
      ).to.be.revertedWithCustomError(market, 'InvalidState');
      await expect(market.finalize()).to.be.revertedWithCustomError(market, 'InvalidState');
      await expect(market.cancel()).to.be.revertedWithCustomError(market, 'InvalidState');
    });
  });

  describe('reentrancy', () => {
    /** Build a market denominated in a token that calls back on transfer. */
    async function reentrantMarket(): Promise<{
      token: ContractHandle;
      market: ConditionalMarket;
    }> {
      const token = asHandle(await ethers.deployContract('ReentrantToken'));
      await token.waitForDeployment();
      for (const account of [protocol.alice, protocol.bob]) {
        await token.mint(account.address, usd(1000));
      }

      const params = await defaultMarketParams(await token.getAddress());
      await protocol.factory.connect(protocol.alice).createMarket(params);
      const address = await protocol.factory.marketByRulesHash(params.rulesHash);
      const attacked = asHandle(await ethers.getContractAt('ConditionalMarket', address));

      await token.connect(protocol.alice).approve(address, usd(100));
      await attacked.connect(protocol.alice).stake(Outcome.YES, usd(100));
      await token.connect(protocol.bob).approve(address, usd(100));
      await attacked.connect(protocol.bob).stake(Outcome.NO, usd(100));

      return { token, market: attacked };
    }

    it('stops a token that re-enters claim during the payout', async () => {
      const { token, market: attacked } = await reentrantMarket();

      await time.increaseTo(await attacked.conditionDeadline());
      await attacked.close();
      await attacked.connect(protocol.resolver).proposeResolution(Outcome.YES, EVIDENCE);
      await time.increaseTo((await attacked.challengeEndsAt()) + 1n);
      await attacked.finalize();

      await token.arm(await attacked.getAddress(), 1); // Attack.CLAIM

      const before = await token.balanceOf(protocol.alice.address);
      await attacked.connect(protocol.alice).claim();

      expect(await token.attempted()).to.equal(true, 'the callback must actually have fired');
      expect(await token.reentryReverted()).to.equal(true);

      // The guard, not an incidental check further down, is what stopped it.
      const guardSelector = ethers.id('ReentrancyGuardReentrantCall()').slice(0, 10);
      expect(await token.lastRevertData()).to.equal(guardSelector);

      // Exactly one payout of the whole pool.
      expect((await token.balanceOf(protocol.alice.address)) - before).to.equal(usd(200));
      expect(await token.balanceOf(await attacked.getAddress())).to.equal(0n);
    });

    it('stops a token that re-enters withdrawRefund during a refund', async () => {
      const { token, market: attacked } = await reentrantMarket();

      await time.increaseTo(await attacked.resolutionDeadline());
      await attacked.cancel();

      await token.arm(await attacked.getAddress(), 2); // Attack.WITHDRAW_REFUND

      const before = await token.balanceOf(protocol.alice.address);
      await attacked.connect(protocol.alice).withdrawRefund();

      expect(await token.attempted()).to.equal(true);
      expect(await token.reentryReverted()).to.equal(true);
      expect((await token.balanceOf(protocol.alice.address)) - before).to.equal(usd(100));
      // Bob's stake is untouched and still recoverable.
      expect(await token.balanceOf(await attacked.getAddress())).to.equal(usd(100));
      await attacked.connect(protocol.bob).withdrawRefund();
      expect(await token.balanceOf(await attacked.getAddress())).to.equal(0n);
    });
  });

  describe('conservation of funds', () => {
    it('never pays out more than was staked, across a full challenged lifecycle', async () => {
      await stakeAs(protocol, market, protocol.carol, Outcome.YES, usd(37));
      const marketAddress = await market.getAddress();

      await closeMarket(market);
      await reachConditionDeadline(market);
      await market.connect(protocol.resolver).proposeResolution(Outcome.NO, EVIDENCE);

      await protocol.token.connect(protocol.alice).approve(marketAddress, CHALLENGE_BOND);
      await market.connect(protocol.alice).challenge(ethers.id('reason'));
      await market.connect(protocol.resolver).proposeResolution(Outcome.YES, ethers.id('e2'));
      await passChallengeWindow(market);
      await market.finalize();

      const deposited = usd(100) + usd(100) + usd(37) + CHALLENGE_BOND;
      expect(await protocol.token.balanceOf(marketAddress)).to.equal(deposited);

      await market.connect(protocol.alice).claim();
      await market.connect(protocol.carol).claim();
      await market.connect(protocol.alice).claimChallengeBond();

      const remaining = await protocol.token.balanceOf(marketAddress);
      expect(remaining).to.be.lessThan(2n, 'at most rounding dust may remain');
    });
  });
});
