import { time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  CHALLENGE_BOND,
  Outcome,
  RESOLUTION_WINDOW,
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

const EVIDENCE_1 = ethers.id('evidence-round-1');
const EVIDENCE_2 = ethers.id('evidence-round-2');
const REASON = ethers.id('the carrier feed was stale');

describe('Challenge', () => {
  let protocol: Protocol;
  let market: ConditionalMarket;

  async function propose(outcome: bigint, evidence: string): Promise<void> {
    await market.connect(protocol.resolver).proposeResolution(outcome, evidence);
  }

  async function postBond(who = protocol.bob): Promise<void> {
    await protocol.token.connect(who).approve(await market.getAddress(), CHALLENGE_BOND);
  }

  beforeEach(async () => {
    protocol = await deployProtocol();
    ({ market } = await createMarket(protocol));
    await stakeAs(protocol, market, protocol.alice, Outcome.YES, usd(100));
    await stakeAs(protocol, market, protocol.bob, Outcome.NO, usd(100));
    await closeMarket(market);
    await reachConditionDeadline(market);
    await propose(Outcome.YES, EVIDENCE_1);
  });

  describe('filing', () => {
    it('accepts a challenge from a participant and takes the bond', async () => {
      await postBond();
      const marketAddress = await market.getAddress();
      const before = await protocol.token.balanceOf(marketAddress);

      await expect(market.connect(protocol.bob).challenge(REASON))
        .to.emit(market, 'ResolutionChallenged')
        .withArgs(
          await market.marketId(),
          protocol.bob.address,
          Outcome.YES,
          REASON,
          CHALLENGE_BOND,
          (value: bigint) => value > 0n,
          (value: bigint) => value > 0n,
        );

      expect(await market.state()).to.equal(State.CHALLENGED);
      expect(await market.challenger()).to.equal(protocol.bob.address);
      expect(await market.challengedOutcome()).to.equal(Outcome.YES);
      expect(await market.challengeReasonHash()).to.equal(REASON);
      expect(await market.bondOutstanding()).to.equal(true);
      expect((await protocol.token.balanceOf(marketAddress)) - before).to.equal(CHALLENGE_BOND);
    });

    it('sets a review deadline one resolution window out', async () => {
      await postBond();
      await market.connect(protocol.bob).challenge(REASON);
      expect(await market.reviewDeadline()).to.equal(
        (await market.challengedAt()) + BigInt(RESOLUTION_WINDOW),
      );
    });

    it('refuses a challenger with no stake in this market', async () => {
      await protocol.token
        .connect(protocol.outsider)
        .approve(await market.getAddress(), CHALLENGE_BOND);
      await expect(
        market.connect(protocol.outsider).challenge(REASON),
      ).to.be.revertedWithCustomError(market, 'NotAParticipant');
    });

    it('refuses a challenge with no bond approved', async () => {
      await expect(market.connect(protocol.bob).challenge(REASON)).to.be.reverted;
    });

    it('refuses a challenge with no reason commitment', async () => {
      await postBond();
      await expect(
        market.connect(protocol.bob).challenge(ethers.ZeroHash),
      ).to.be.revertedWithCustomError(market, 'MissingReason');
    });

    it('refuses a challenge once the window has closed', async () => {
      await postBond();
      await passChallengeWindow(market);
      await expect(market.connect(protocol.bob).challenge(REASON)).to.be.revertedWithCustomError(
        market,
        'ChallengeWindowClosed',
      );
    });

    it('refuses a second challenge of the same proposal', async () => {
      await postBond();
      await market.connect(protocol.bob).challenge(REASON);
      await postBond(protocol.alice);
      await expect(market.connect(protocol.alice).challenge(REASON)).to.be.revertedWithCustomError(
        market,
        'InvalidState',
      );
    });
  });

  describe('the one-round cap', () => {
    beforeEach(async () => {
      await postBond();
      await market.connect(protocol.bob).challenge(REASON);
    });

    it('allows exactly one replacement proposal', async () => {
      await propose(Outcome.NO, EVIDENCE_2);
      expect(await market.proposalRound()).to.equal(2n);
      expect(await market.proposedOutcome()).to.equal(Outcome.NO);
      expect(await market.evidenceHash()).to.equal(EVIDENCE_2);
      expect(await market.state()).to.equal(State.RESOLUTION_PROPOSED);
    });

    it('makes the replacement proposal uncontestable', async () => {
      await propose(Outcome.NO, EVIDENCE_2);
      await protocol.token.connect(protocol.alice).approve(await market.getAddress(), CHALLENGE_BOND);
      await expect(market.connect(protocol.alice).challenge(REASON)).to.be.revertedWithCustomError(
        market,
        'ChallengeRoundExhausted',
      );
    });

    it('admits no third proposal after the replacement is finalized', async () => {
      await propose(Outcome.NO, EVIDENCE_2);
      await passChallengeWindow(market);
      await market.finalize();
      await expect(propose(Outcome.YES, ethers.id('third'))).to.be.revertedWithCustomError(
        market,
        'InvalidState',
      );
      expect(await market.proposalRound()).to.equal(2n);
    });

    it('terminates: the second window ends in finalization', async () => {
      await propose(Outcome.NO, EVIDENCE_2);
      await passChallengeWindow(market);
      await market.finalize();
      expect(await market.state()).to.equal(State.FINALIZED);
      expect(await market.finalOutcome()).to.equal(Outcome.NO);
    });
  });

  describe('bond disposition', () => {
    beforeEach(async () => {
      await postBond();
      await market.connect(protocol.bob).challenge(REASON);
    });

    it('returns the bond when the challenge changed the outcome', async () => {
      await propose(Outcome.NO, EVIDENCE_2);
      await passChallengeWindow(market);
      await market.finalize();

      expect(await market.bondRefundable()).to.equal(true);
      expect(await market.forfeitedBond()).to.equal(0n);
      expect(await market.pool()).to.equal(usd(200));

      const before = await protocol.token.balanceOf(protocol.bob.address);
      await expect(market.connect(protocol.bob).claimChallengeBond())
        .to.emit(market, 'ChallengeBondReturned')
        .withArgs(await market.marketId(), protocol.bob.address, CHALLENGE_BOND);
      expect((await protocol.token.balanceOf(protocol.bob.address)) - before).to.equal(CHALLENGE_BOND);
    });

    it('forfeits the bond into the pool when the outcome was confirmed', async () => {
      await propose(Outcome.YES, EVIDENCE_2);
      await passChallengeWindow(market);
      await market.finalize();

      expect(await market.bondRefundable()).to.equal(false);
      expect(await market.forfeitedBond()).to.equal(CHALLENGE_BOND);
      expect(await market.pool()).to.equal(usd(200) + CHALLENGE_BOND);

      await expect(market.connect(protocol.bob).claimChallengeBond()).to.be.revertedWithCustomError(
        market,
        'AlreadyClaimed',
      );

      // The forfeited bond goes to the winner, not to an operator.
      const before = await protocol.token.balanceOf(protocol.alice.address);
      await market.connect(protocol.alice).claim();
      expect((await protocol.token.balanceOf(protocol.alice.address)) - before).to.equal(
        usd(200) + CHALLENGE_BOND,
      );
    });

    it('returns the bond in full when the market is cancelled', async () => {
      await time.increaseTo(await market.reviewDeadline());
      await market.cancel();

      expect(await market.bondRefundable()).to.equal(true);
      const before = await protocol.token.balanceOf(protocol.bob.address);
      await market.connect(protocol.bob).claimChallengeBond();
      expect((await protocol.token.balanceOf(protocol.bob.address)) - before).to.equal(CHALLENGE_BOND);
    });

    it('refuses the bond to anyone but the challenger', async () => {
      await propose(Outcome.NO, EVIDENCE_2);
      await passChallengeWindow(market);
      await market.finalize();
      await expect(
        market.connect(protocol.alice).claimChallengeBond(),
      ).to.be.revertedWithCustomError(market, 'NotChallenger');
    });

    it('refuses to return the bond twice', async () => {
      await propose(Outcome.NO, EVIDENCE_2);
      await passChallengeWindow(market);
      await market.finalize();
      await market.connect(protocol.bob).claimChallengeBond();
      await expect(market.connect(protocol.bob).claimChallengeBond()).to.be.revertedWithCustomError(
        market,
        'AlreadyClaimed',
      );
    });

    it('refuses to return the bond before the market resolves', async () => {
      await expect(market.connect(protocol.bob).claimChallengeBond()).to.be.revertedWithCustomError(
        market,
        'InvalidState',
      );
    });

    it('never strands the bond when the winning side is empty', async () => {
      // NO wins, but the challenge confirmed it and nobody is left to pay.
      const { market: solo } = await createMarket(protocol);
      await stakeAs(protocol, solo, protocol.alice, Outcome.YES, usd(10));
      await time.increaseTo(await solo.conditionDeadline());
      await solo.close();
      await solo.connect(protocol.resolver).proposeResolution(Outcome.NO, EVIDENCE_1);
      await protocol.token.connect(protocol.alice).approve(await solo.getAddress(), CHALLENGE_BOND);
      await solo.connect(protocol.alice).challenge(REASON);
      await solo.connect(protocol.resolver).proposeResolution(Outcome.NO, EVIDENCE_2);
      await time.increaseTo((await solo.challengeEndsAt()) + 1n);
      await solo.finalize();

      // Confirmed outcome would normally forfeit the bond, but there is no pool
      // for it to join, so it is returned instead of being locked in forever.
      expect(await solo.refundMode()).to.equal(true);
      expect(await solo.bondRefundable()).to.equal(true);
      expect(await solo.forfeitedBond()).to.equal(0n);

      await solo.connect(protocol.alice).withdrawRefund();
      await solo.connect(protocol.alice).claimChallengeBond();
      expect(await protocol.token.balanceOf(await solo.getAddress())).to.equal(0n);
    });
  });

  describe('zero-bond markets', () => {
    it('allows a free challenge when the creator set no bond', async () => {
      const { market: free } = await createMarket(protocol, { challengeBond: 0n });
      await stakeAs(protocol, free, protocol.alice, Outcome.YES, usd(10));
      await time.increaseTo(await free.conditionDeadline());
      await free.close();
      await free.connect(protocol.resolver).proposeResolution(Outcome.YES, EVIDENCE_1);

      await free.connect(protocol.alice).challenge(REASON);
      expect(await free.state()).to.equal(State.CHALLENGED);
      expect(await free.bondOutstanding()).to.equal(false);

      await free.connect(protocol.resolver).proposeResolution(Outcome.YES, EVIDENCE_2);
      await time.increaseTo((await free.challengeEndsAt()) + 1n);
      await free.finalize();
      expect(await free.state()).to.equal(State.FINALIZED);
      expect(await free.forfeitedBond()).to.equal(0n, 'nothing was posted, so nothing can be forfeited');

      // With no bond outstanding, the last claim is enough to reach SETTLED.
      await free.connect(protocol.alice).claim();
      expect(await free.state()).to.equal(State.SETTLED);
      expect(await protocol.token.balanceOf(await free.getAddress())).to.equal(0n);
    });
  });
});
