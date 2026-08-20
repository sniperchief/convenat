import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  Outcome,
  State,
  closeMarket,
  createMarket,
  deployProtocol,
  passChallengeWindow,
  reachConditionDeadline,
  stakeAs,
  usd,
  type ConditionalMarket,
  type Protocol,
} from './helpers';

const EVIDENCE = ethers.id('evidence');

describe('Settlement', () => {
  let protocol: Protocol;
  let market: ConditionalMarket;

  beforeEach(async () => {
    protocol = await deployProtocol();
    ({ market } = await createMarket(protocol));
  });

  /** Drive a staked market to FINALIZED with the given outcome. */
  async function resolveTo(outcome: bigint, target: ConditionalMarket = market): Promise<void> {
    await closeMarket(target);
    await reachConditionDeadline(target);
    await target.connect(protocol.resolver).proposeResolution(outcome, EVIDENCE);
    await passChallengeWindow(target);
    await target.finalize();
  }

  describe('YES wins', () => {
    beforeEach(async () => {
      await stakeAs(protocol, market, protocol.alice, Outcome.YES, usd(100));
      await stakeAs(protocol, market, protocol.bob, Outcome.NO, usd(300));
      await resolveTo(Outcome.YES);
    });

    it('pays the sole winner the entire pool', async () => {
      expect(await market.previewClaim(protocol.alice.address)).to.equal(usd(400));

      const before = await protocol.token.balanceOf(protocol.alice.address);
      await expect(market.connect(protocol.alice).claim())
        .to.emit(market, 'WinningsClaimed')
        .withArgs(await market.marketId(), protocol.alice.address, Outcome.YES, usd(100), usd(400));

      expect((await protocol.token.balanceOf(protocol.alice.address)) - before).to.equal(usd(400));
      expect(await protocol.token.balanceOf(await market.getAddress())).to.equal(0n);
    });

    it('reaches SETTLED once the last winning stake is withdrawn', async () => {
      expect(await market.state()).to.equal(State.FINALIZED);
      await market.connect(protocol.alice).claim();
      expect(await market.state()).to.equal(State.SETTLED);
      expect(await market.remainingClaimableStake()).to.equal(0n);
    });

    it('refuses the losing side', async () => {
      await expect(market.connect(protocol.bob).claim()).to.be.revertedWithCustomError(
        market,
        'NothingToClaim',
      );
      expect(await market.previewClaim(protocol.bob.address)).to.equal(0n);
    });

    it('refuses a second claim', async () => {
      await market.connect(protocol.alice).claim();
      await expect(market.connect(protocol.alice).claim()).to.be.revertedWithCustomError(
        market,
        'AlreadyClaimed',
      );
    });

    it('refuses someone who never staked', async () => {
      await expect(market.connect(protocol.outsider).claim()).to.be.revertedWithCustomError(
        market,
        'NothingToClaim',
      );
    });
  });

  describe('NO wins', () => {
    it('pays NO stakers proportionally', async () => {
      await stakeAs(protocol, market, protocol.alice, Outcome.YES, usd(600));
      await stakeAs(protocol, market, protocol.bob, Outcome.NO, usd(300));
      await stakeAs(protocol, market, protocol.carol, Outcome.NO, usd(100));
      await resolveTo(Outcome.NO);

      // pool 1000, NO side 400. bob 300/400, carol 100/400.
      expect(await market.previewClaim(protocol.bob.address)).to.equal(usd(750));
      expect(await market.previewClaim(protocol.carol.address)).to.equal(usd(250));

      const bobBefore = await protocol.token.balanceOf(protocol.bob.address);
      const carolBefore = await protocol.token.balanceOf(protocol.carol.address);
      await market.connect(protocol.bob).claim();
      await market.connect(protocol.carol).claim();

      expect((await protocol.token.balanceOf(protocol.bob.address)) - bobBefore).to.equal(usd(750));
      expect((await protocol.token.balanceOf(protocol.carol.address)) - carolBefore).to.equal(usd(250));
      expect(await protocol.token.balanceOf(await market.getAddress())).to.equal(0n);
      expect(await market.state()).to.equal(State.SETTLED);
    });

    it('pays a staker who backed both sides only for the winning side', async () => {
      await stakeAs(protocol, market, protocol.alice, Outcome.YES, usd(100));
      await stakeAs(protocol, market, protocol.alice, Outcome.NO, usd(100));
      await stakeAs(protocol, market, protocol.bob, Outcome.NO, usd(100));
      await resolveTo(Outcome.NO);

      // pool 300, NO side 200. Alice's 100 YES is simply lost into the pool.
      expect(await market.previewClaim(protocol.alice.address)).to.equal(usd(150));
      expect(await market.previewClaim(protocol.bob.address)).to.equal(usd(150));
    });
  });

  describe('rounding', () => {
    it('floors each payout and leaves at most one base unit per winner behind', async () => {
      // pool 10, YES side 3, split 1/1/1. Each gets floor(1 * 10 / 3) = 3.
      await stakeAs(protocol, market, protocol.alice, Outcome.YES, 1n);
      await stakeAs(protocol, market, protocol.bob, Outcome.YES, 1n);
      await stakeAs(protocol, market, protocol.carol, Outcome.YES, 1n);
      await stakeAs(protocol, market, protocol.outsider, Outcome.NO, 7n);
      await resolveTo(Outcome.YES);

      expect(await market.pool()).to.equal(10n);
      for (const account of [protocol.alice, protocol.bob, protocol.carol]) {
        expect(await market.previewClaim(account.address)).to.equal(3n);
      }

      await market.connect(protocol.alice).claim();
      await market.connect(protocol.bob).claim();
      await market.connect(protocol.carol).claim();

      // 10 - 9 = 1 base unit of dust, permanently locked. Documented, and
      // deliberately not swept: a sweep function would be an extraction surface.
      expect(await protocol.token.balanceOf(await market.getAddress())).to.equal(1n);
      expect(await market.state()).to.equal(State.SETTLED);
    });

    it('never lets the payouts exceed the pool', async () => {
      const stakes = [7n, 11n, 13n];
      const accounts = [protocol.alice, protocol.bob, protocol.carol];
      for (let i = 0; i < accounts.length; i += 1) {
        await stakeAs(protocol, market, accounts[i]!, Outcome.YES, stakes[i]!);
      }
      await stakeAs(protocol, market, protocol.outsider, Outcome.NO, 29n);
      await resolveTo(Outcome.YES);

      const pool = await market.pool();
      let distributed = 0n;
      for (const account of accounts) {
        distributed += await market.previewClaim(account.address);
      }
      expect(distributed).to.be.lessThanOrEqual(pool);
      expect(pool - distributed).to.be.lessThan(BigInt(accounts.length));
    });
  });

  describe('zero winning pool', () => {
    it('refunds everyone when YES wins with no YES stake', async () => {
      await stakeAs(protocol, market, protocol.bob, Outcome.NO, usd(50));
      await stakeAs(protocol, market, protocol.carol, Outcome.NO, usd(25));
      await resolveTo(Outcome.YES);

      expect(await market.refundMode()).to.equal(true);
      expect(await market.finalOutcome()).to.equal(Outcome.YES);
      await expect(market.connect(protocol.bob).claim()).to.be.revertedWithCustomError(
        market,
        'RefundModeActive',
      );

      const bobBefore = await protocol.token.balanceOf(protocol.bob.address);
      await expect(market.connect(protocol.bob).withdrawRefund())
        .to.emit(market, 'RefundWithdrawn')
        .withArgs(await market.marketId(), protocol.bob.address, usd(50));
      await market.connect(protocol.carol).withdrawRefund();

      expect((await protocol.token.balanceOf(protocol.bob.address)) - bobBefore).to.equal(usd(50));
      expect(await protocol.token.balanceOf(await market.getAddress())).to.equal(0n);
      expect(await market.state()).to.equal(State.SETTLED);
    });

    it('refunds everyone when NO wins with no NO stake', async () => {
      await stakeAs(protocol, market, protocol.alice, Outcome.YES, usd(80));
      await resolveTo(Outcome.NO);

      expect(await market.refundMode()).to.equal(true);
      const before = await protocol.token.balanceOf(protocol.alice.address);
      await market.connect(protocol.alice).withdrawRefund();
      expect((await protocol.token.balanceOf(protocol.alice.address)) - before).to.equal(usd(80));
    });

    it('handles a market that attracted no stake at all', async () => {
      await resolveTo(Outcome.YES);
      expect(await market.refundMode()).to.equal(true);
      expect(await market.state()).to.equal(State.SETTLED, 'nothing to claim, so already settled');
      await expect(market.connect(protocol.alice).withdrawRefund()).to.be.revertedWithCustomError(
        market,
        'NothingToClaim',
      );
    });

    it('gives a one-sided market its own money back and no more', async () => {
      await stakeAs(protocol, market, protocol.alice, Outcome.YES, usd(40));
      await resolveTo(Outcome.YES);

      // YES wins and is the only side. The formula returns exactly the stake.
      expect(await market.refundMode()).to.equal(false);
      expect(await market.previewClaim(protocol.alice.address)).to.equal(usd(40));
      const before = await protocol.token.balanceOf(protocol.alice.address);
      await market.connect(protocol.alice).claim();
      expect((await protocol.token.balanceOf(protocol.alice.address)) - before).to.equal(usd(40));
    });
  });

  describe('withdrawal guards', () => {
    it('refuses a refund when the market is not in refund mode', async () => {
      await stakeAs(protocol, market, protocol.alice, Outcome.YES, usd(10));
      await stakeAs(protocol, market, protocol.bob, Outcome.NO, usd(10));
      await resolveTo(Outcome.YES);
      await expect(market.connect(protocol.alice).withdrawRefund()).to.be.revertedWithCustomError(
        market,
        'NotInRefundMode',
      );
    });

    it('refuses a claim before finalization at every earlier state', async () => {
      await stakeAs(protocol, market, protocol.alice, Outcome.YES, usd(10));
      await expect(market.connect(protocol.alice).claim()).to.be.revertedWithCustomError(
        market,
        'InvalidState',
      );

      await closeMarket(market);
      await expect(market.connect(protocol.alice).claim()).to.be.revertedWithCustomError(
        market,
        'InvalidState',
      );

      await reachConditionDeadline(market);
      await market.connect(protocol.resolver).proposeResolution(Outcome.YES, EVIDENCE);
      await expect(market.connect(protocol.alice).claim()).to.be.revertedWithCustomError(
        market,
        'InvalidState',
      );
    });

    it('refuses a refund twice', async () => {
      await stakeAs(protocol, market, protocol.bob, Outcome.NO, usd(10));
      await resolveTo(Outcome.YES);
      await market.connect(protocol.bob).withdrawRefund();
      await expect(market.connect(protocol.bob).withdrawRefund()).to.be.revertedWithCustomError(
        market,
        'AlreadyClaimed',
      );
    });
  });
});
