import { time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  CHALLENGE_WINDOW,
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

const EVIDENCE = ethers.id('evidence-package-v1');

describe('Resolution proposal and finalization', () => {
  let protocol: Protocol;
  let market: ConditionalMarket;

  beforeEach(async () => {
    protocol = await deployProtocol();
    ({ market } = await createMarket(protocol));
    await stakeAs(protocol, market, protocol.alice, Outcome.YES, usd(100));
    await stakeAs(protocol, market, protocol.bob, Outcome.NO, usd(100));
  });

  describe('proposeResolution', () => {
    it('records the outcome, evidence hash and challenge deadline', async () => {
      await closeMarket(market);
      await reachConditionDeadline(market);

      const tx = await market.connect(protocol.resolver).proposeResolution(Outcome.YES, EVIDENCE);
      const block = await ethers.provider.getBlock((await tx.wait())!.blockNumber);
      const proposedAt = BigInt(block!.timestamp);

      await expect(tx)
        .to.emit(market, 'ResolutionProposed')
        .withArgs(
          await market.marketId(),
          protocol.resolver.address,
          Outcome.YES,
          EVIDENCE,
          1n,
          proposedAt,
          proposedAt + BigInt(CHALLENGE_WINDOW),
        );

      expect(await market.state()).to.equal(State.RESOLUTION_PROPOSED);
      expect(await market.proposedOutcome()).to.equal(Outcome.YES);
      expect(await market.evidenceHash()).to.equal(EVIDENCE);
      expect(await market.proposalRound()).to.equal(1n);
      expect(await market.challengeEndsAt()).to.equal(proposedAt + BigInt(CHALLENGE_WINDOW));
    });

    it('refuses an unauthorized proposer', async () => {
      await closeMarket(market);
      await reachConditionDeadline(market);
      for (const signer of [protocol.outsider, protocol.admin, protocol.alice]) {
        await expect(
          market.connect(signer).proposeResolution(Outcome.YES, EVIDENCE),
        ).to.be.revertedWithCustomError(market, 'NotProposer');
      }
    });

    it('refuses a proposal while the market is still open for trading', async () => {
      await expect(
        market.connect(protocol.resolver).proposeResolution(Outcome.YES, EVIDENCE),
      ).to.be.revertedWithCustomError(market, 'InvalidState');
    });

    it('refuses a proposal before the condition deadline, even once closed', async () => {
      await closeMarket(market);
      await expect(
        market.connect(protocol.resolver).proposeResolution(Outcome.YES, EVIDENCE),
      ).to.be.revertedWithCustomError(market, 'ConditionNotDue');
    });

    it('refuses an UNSET outcome', async () => {
      await closeMarket(market);
      await reachConditionDeadline(market);
      await expect(
        market.connect(protocol.resolver).proposeResolution(Outcome.UNSET, EVIDENCE),
      ).to.be.revertedWithCustomError(market, 'InvalidOutcome');
    });

    it('refuses a proposal with no evidence commitment', async () => {
      await closeMarket(market);
      await reachConditionDeadline(market);
      await expect(
        market.connect(protocol.resolver).proposeResolution(Outcome.YES, ethers.ZeroHash),
      ).to.be.revertedWithCustomError(market, 'MissingEvidenceHash');
    });

    it('refuses a second proposal while one is already standing', async () => {
      await closeMarket(market);
      await reachConditionDeadline(market);
      await market.connect(protocol.resolver).proposeResolution(Outcome.YES, EVIDENCE);
      await expect(
        market.connect(protocol.resolver).proposeResolution(Outcome.NO, ethers.id('other')),
      ).to.be.revertedWithCustomError(market, 'InvalidState');
    });

    it('does not make funds claimable', async () => {
      await closeMarket(market);
      await reachConditionDeadline(market);
      await market.connect(protocol.resolver).proposeResolution(Outcome.YES, EVIDENCE);
      await expect(market.connect(protocol.alice).claim()).to.be.revertedWithCustomError(
        market,
        'InvalidState',
      );
      expect(await market.previewClaim(protocol.alice.address)).to.equal(0n);
    });
  });

  describe('finalize', () => {
    beforeEach(async () => {
      await closeMarket(market);
      await reachConditionDeadline(market);
      await market.connect(protocol.resolver).proposeResolution(Outcome.YES, EVIDENCE);
    });

    it('refuses to finalize while the challenge window is running', async () => {
      await expect(market.finalize()).to.be.revertedWithCustomError(market, 'ChallengePeriodActive');
      await time.increaseTo((await market.challengeEndsAt()) - 2n);
      await expect(market.finalize()).to.be.revertedWithCustomError(market, 'ChallengePeriodActive');
    });

    it('refuses to let even the resolver finalize early', async () => {
      await expect(market.connect(protocol.resolver).finalize()).to.be.revertedWithCustomError(
        market,
        'ChallengePeriodActive',
      );
    });

    it('is permissionless once the window has passed', async () => {
      await passChallengeWindow(market);
      await expect(market.connect(protocol.outsider).finalize())
        .to.emit(market, 'MarketFinalized')
        .withArgs(
          await market.marketId(),
          Outcome.YES,
          EVIDENCE,
          usd(200),
          false,
          (value: bigint) => value > 0n,
        );
      expect(await market.state()).to.equal(State.FINALIZED);
      expect(await market.finalOutcome()).to.equal(Outcome.YES);
    });

    it('fixes the outcome and the evidence hash permanently', async () => {
      await passChallengeWindow(market);
      await market.finalize();

      expect(await market.finalOutcome()).to.equal(Outcome.YES);
      expect(await market.evidenceHash()).to.equal(EVIDENCE);

      await expect(
        market.connect(protocol.resolver).proposeResolution(Outcome.NO, ethers.id('rewrite')),
      ).to.be.revertedWithCustomError(market, 'InvalidState');
      expect(await market.evidenceHash()).to.equal(EVIDENCE);
    });

    it('cannot be finalized twice', async () => {
      await passChallengeWindow(market);
      await market.finalize();
      await expect(market.finalize())
        .to.be.revertedWithCustomError(market, 'InvalidState')
        .withArgs(State.FINALIZED);
    });
  });

  describe('INVALID outcome', () => {
    it('runs through the challenge window rather than cancelling on sight', async () => {
      await closeMarket(market);
      await reachConditionDeadline(market);
      await market.connect(protocol.resolver).proposeResolution(Outcome.INVALID, EVIDENCE);

      // Still contestable: the resolver does not get a unilateral unwind.
      expect(await market.state()).to.equal(State.RESOLUTION_PROPOSED);

      await passChallengeWindow(market);
      await expect(market.finalize())
        .to.emit(market, 'MarketCancelled')
        .withArgs(await market.marketId(), 3n, usd(200), (value: bigint) => value > 0n);

      expect(await market.state()).to.equal(State.CANCELLED);
      expect(await market.finalOutcome()).to.equal(Outcome.INVALID);
      expect(await market.refundMode()).to.equal(true);
    });

    it('lets both sides recover exactly their own stake', async () => {
      await closeMarket(market);
      await reachConditionDeadline(market);
      await market.connect(protocol.resolver).proposeResolution(Outcome.INVALID, EVIDENCE);
      await passChallengeWindow(market);
      await market.finalize();

      const aliceBefore = await protocol.token.balanceOf(protocol.alice.address);
      const bobBefore = await protocol.token.balanceOf(protocol.bob.address);
      await market.connect(protocol.alice).withdrawRefund();
      await market.connect(protocol.bob).withdrawRefund();

      expect((await protocol.token.balanceOf(protocol.alice.address)) - aliceBefore).to.equal(usd(100));
      expect((await protocol.token.balanceOf(protocol.bob.address)) - bobBefore).to.equal(usd(100));
      expect(await protocol.token.balanceOf(await market.getAddress())).to.equal(0n);
    });
  });
});
