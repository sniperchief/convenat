import { time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  CHALLENGE_BOND,
  CancellationReason,
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
const REASON = ethers.id('reason');

describe('Cancellation and liveness', () => {
  let protocol: Protocol;
  let market: ConditionalMarket;

  beforeEach(async () => {
    protocol = await deployProtocol();
    ({ market } = await createMarket(protocol));
    await stakeAs(protocol, market, protocol.alice, Outcome.YES, usd(100));
    await stakeAs(protocol, market, protocol.bob, Outcome.NO, usd(60));
  });

  describe('trigger 1: no resolution was ever proposed', () => {
    it('lets anyone unwind the market once the resolution deadline passes', async () => {
      await closeMarket(market);
      await time.increaseTo(await market.resolutionDeadline());

      await expect(market.connect(protocol.outsider).cancel())
        .to.emit(market, 'MarketCancelled')
        .withArgs(
          await market.marketId(),
          CancellationReason.NO_RESOLUTION,
          usd(160),
          (value: bigint) => value > 0n,
        );

      expect(await market.state()).to.equal(State.CANCELLED);
      expect(await market.refundMode()).to.equal(true);
      expect(await market.cancellationReason()).to.equal(CancellationReason.NO_RESOLUTION);
    });

    it('works even if nobody ever called close', async () => {
      await time.increaseTo(await market.resolutionDeadline());
      expect(await market.state()).to.equal(State.OPEN);
      await expect(market.connect(protocol.outsider).cancel()).to.emit(market, 'MarketClosed');
      expect(await market.state()).to.equal(State.CANCELLED);
    });

    it('refuses to cancel before the deadline', async () => {
      await closeMarket(market);
      await expect(market.cancel()).to.be.revertedWithCustomError(market, 'ResolutionWindowActive');
      await time.increaseTo((await market.resolutionDeadline()) - 2n);
      await expect(market.cancel()).to.be.revertedWithCustomError(market, 'ResolutionWindowActive');
    });

    it('refuses to cancel while a proposal is standing', async () => {
      await closeMarket(market);
      await reachConditionDeadline(market);
      await market.connect(protocol.resolver).proposeResolution(Outcome.YES, EVIDENCE);
      await time.increaseTo(await market.resolutionDeadline());
      await expect(market.cancel())
        .to.be.revertedWithCustomError(market, 'InvalidState')
        .withArgs(State.RESOLUTION_PROPOSED);
    });
  });

  describe('trigger 2: a challenge was never reviewed', () => {
    beforeEach(async () => {
      await closeMarket(market);
      await reachConditionDeadline(market);
      await market.connect(protocol.resolver).proposeResolution(Outcome.YES, EVIDENCE);
      await protocol.token.connect(protocol.bob).approve(await market.getAddress(), CHALLENGE_BOND);
      await market.connect(protocol.bob).challenge(REASON);
    });

    it('lets anyone unwind once the review deadline passes', async () => {
      await time.increaseTo(await market.reviewDeadline());
      await expect(market.connect(protocol.outsider).cancel())
        .to.emit(market, 'MarketCancelled')
        .withArgs(
          await market.marketId(),
          CancellationReason.NO_REVIEW,
          usd(160),
          (value: bigint) => value > 0n,
        );
      expect(await market.cancellationReason()).to.equal(CancellationReason.NO_REVIEW);
    });

    it('refuses to cancel while the review window is still running', async () => {
      await expect(market.cancel()).to.be.revertedWithCustomError(market, 'ReviewWindowActive');
      await time.increaseTo((await market.reviewDeadline()) - 2n);
      await expect(market.cancel()).to.be.revertedWithCustomError(market, 'ReviewWindowActive');
    });

    it('returns every stake and the bond', async () => {
      await time.increaseTo(await market.reviewDeadline());
      await market.cancel();

      const aliceBefore = await protocol.token.balanceOf(protocol.alice.address);
      const bobBefore = await protocol.token.balanceOf(protocol.bob.address);
      await market.connect(protocol.alice).withdrawRefund();
      await market.connect(protocol.bob).withdrawRefund();
      await market.connect(protocol.bob).claimChallengeBond();

      expect((await protocol.token.balanceOf(protocol.alice.address)) - aliceBefore).to.equal(usd(100));
      expect((await protocol.token.balanceOf(protocol.bob.address)) - bobBefore).to.equal(
        usd(60) + CHALLENGE_BOND,
      );
      expect(await protocol.token.balanceOf(await market.getAddress())).to.equal(0n);
    });
  });

  describe('trigger 3: a finalized INVALID', () => {
    it('unwinds with the reason recorded', async () => {
      await closeMarket(market);
      await reachConditionDeadline(market);
      await market.connect(protocol.resolver).proposeResolution(Outcome.INVALID, EVIDENCE);
      await passChallengeWindow(market);
      await market.finalize();

      expect(await market.state()).to.equal(State.CANCELLED);
      expect(await market.cancellationReason()).to.equal(CancellationReason.RESOLVED_INVALID);
      expect(await market.finalOutcome()).to.equal(Outcome.INVALID);
    });
  });

  describe('refund correctness', () => {
    beforeEach(async () => {
      await closeMarket(market);
      await time.increaseTo(await market.resolutionDeadline());
      await market.cancel();
    });

    it('gives each participant exactly their own stake, never anyone else s', async () => {
      const aliceBefore = await protocol.token.balanceOf(protocol.alice.address);
      await market.connect(protocol.alice).withdrawRefund();
      expect((await protocol.token.balanceOf(protocol.alice.address)) - aliceBefore).to.equal(usd(100));

      // Alice cannot come back for Bob's money.
      await expect(market.connect(protocol.alice).withdrawRefund()).to.be.revertedWithCustomError(
        market,
        'AlreadyClaimed',
      );
      expect(await protocol.token.balanceOf(await market.getAddress())).to.equal(usd(60));

      const bobBefore = await protocol.token.balanceOf(protocol.bob.address);
      await market.connect(protocol.bob).withdrawRefund();
      expect((await protocol.token.balanceOf(protocol.bob.address)) - bobBefore).to.equal(usd(60));
      expect(await protocol.token.balanceOf(await market.getAddress())).to.equal(0n);
    });

    it('gives a non-participant nothing', async () => {
      await expect(market.connect(protocol.outsider).withdrawRefund()).to.be.revertedWithCustomError(
        market,
        'NothingToClaim',
      );
    });

    it('refuses a winnings claim: a cancelled market has no winners', async () => {
      await expect(market.connect(protocol.alice).claim()).to.be.revertedWithCustomError(
        market,
        'RefundModeActive',
      );
    });

    it('stays CANCELLED rather than becoming SETTLED, so the reason survives', async () => {
      await market.connect(protocol.alice).withdrawRefund();
      await market.connect(protocol.bob).withdrawRefund();
      expect(await market.state()).to.equal(State.CANCELLED);
      expect(await market.remainingClaimableStake()).to.equal(0n);
    });

    it('cannot be cancelled twice', async () => {
      await expect(market.cancel())
        .to.be.revertedWithCustomError(market, 'InvalidState')
        .withArgs(State.CANCELLED);
    });
  });

  describe('pause cannot become a fund freeze', () => {
    it('leaves refunds available on a cancelled market while paused', async () => {
      await closeMarket(market);
      await time.increaseTo(await market.resolutionDeadline());
      await market.cancel();
      await protocol.factory.connect(protocol.admin).pause();

      const before = await protocol.token.balanceOf(protocol.alice.address);
      await market.connect(protocol.alice).withdrawRefund();
      expect((await protocol.token.balanceOf(protocol.alice.address)) - before).to.equal(usd(100));
    });

    it('leaves the cancellation itself available while paused', async () => {
      // The worst case: an administrator pauses and walks away. Participants
      // must still be able to unwind the market themselves.
      await closeMarket(market);
      await protocol.factory.connect(protocol.admin).pause();
      await time.increaseTo(await market.resolutionDeadline());

      await expect(market.connect(protocol.outsider).cancel()).to.emit(market, 'MarketCancelled');
      await market.connect(protocol.alice).withdrawRefund();
      await market.connect(protocol.bob).withdrawRefund();
      expect(await protocol.token.balanceOf(await market.getAddress())).to.equal(0n);
    });

    it('leaves claims, closure and finalization available while paused', async () => {
      await protocol.factory.connect(protocol.admin).pause();

      await time.increaseTo(await market.tradingEndsAt());
      await expect(market.close()).to.not.be.reverted;

      await reachConditionDeadline(market);
      await expect(market.connect(protocol.resolver).proposeResolution(Outcome.YES, EVIDENCE)).to.not
        .be.reverted;

      await passChallengeWindow(market);
      await expect(market.finalize()).to.not.be.reverted;

      const before = await protocol.token.balanceOf(protocol.alice.address);
      await market.connect(protocol.alice).claim();
      expect((await protocol.token.balanceOf(protocol.alice.address)) - before).to.equal(usd(160));
    });

    it('leaves the challenge route open while paused', async () => {
      await closeMarket(market);
      await reachConditionDeadline(market);
      await market.connect(protocol.resolver).proposeResolution(Outcome.YES, EVIDENCE);
      await protocol.token.connect(protocol.bob).approve(await market.getAddress(), CHALLENGE_BOND);
      await protocol.factory.connect(protocol.admin).pause();

      await expect(market.connect(protocol.bob).challenge(REASON)).to.emit(
        market,
        'ResolutionChallenged',
      );
    });
  });
});
