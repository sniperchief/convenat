import { time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  Outcome,
  State,
  asHandle,
  createMarket,
  defaultMarketParams,
  deployProtocol,
  stakeAs,
  usd,
  type ConditionalMarket,
  type Protocol,
} from './helpers';

describe('Staking and closure', () => {
  let protocol: Protocol;
  let market: ConditionalMarket;

  beforeEach(async () => {
    protocol = await deployProtocol();
    ({ market } = await createMarket(protocol));
  });

  describe('stake', () => {
    it('records a YES stake and moves the funds into the market', async () => {
      const marketAddress = await market.getAddress();
      await protocol.token.connect(protocol.alice).approve(marketAddress, usd(100));

      await expect(market.connect(protocol.alice).stake(Outcome.YES, usd(100)))
        .to.emit(market, 'StakePlaced')
        .withArgs(await market.marketId(), protocol.alice.address, Outcome.YES, usd(100), usd(100), 0n);

      expect(await market.yesStake(protocol.alice.address)).to.equal(usd(100));
      expect(await market.totalYes()).to.equal(usd(100));
      expect(await protocol.token.balanceOf(marketAddress)).to.equal(usd(100));
    });

    it('records a NO stake', async () => {
      await stakeAs(protocol, market, protocol.bob, Outcome.NO, usd(40));
      expect(await market.noStake(protocol.bob.address)).to.equal(usd(40));
      expect(await market.totalNo()).to.equal(usd(40));
      expect(await market.totalYes()).to.equal(0n);
    });

    it('accumulates repeated stakes from the same account', async () => {
      await stakeAs(protocol, market, protocol.alice, Outcome.YES, usd(30));
      await stakeAs(protocol, market, protocol.alice, Outcome.YES, usd(70));
      expect(await market.yesStake(protocol.alice.address)).to.equal(usd(100));
      expect(await market.totalYes()).to.equal(usd(100));
    });

    it('tracks several accounts on both sides independently', async () => {
      await stakeAs(protocol, market, protocol.alice, Outcome.YES, usd(100));
      await stakeAs(protocol, market, protocol.bob, Outcome.YES, usd(50));
      await stakeAs(protocol, market, protocol.carol, Outcome.NO, usd(30));

      expect(await market.totalYes()).to.equal(usd(150));
      expect(await market.totalNo()).to.equal(usd(30));
      expect(await market.pool()).to.equal(usd(180));

      const [aliceYes, aliceNo] = await market.stakeOf(protocol.alice.address);
      expect(aliceYes).to.equal(usd(100));
      expect(aliceNo).to.equal(0n);
    });

    it('lets one account back both sides', async () => {
      await stakeAs(protocol, market, protocol.alice, Outcome.YES, usd(10));
      await stakeAs(protocol, market, protocol.alice, Outcome.NO, usd(5));
      expect(await market.yesStake(protocol.alice.address)).to.equal(usd(10));
      expect(await market.noStake(protocol.alice.address)).to.equal(usd(5));
    });

    it('rejects a zero amount', async () => {
      await expect(
        market.connect(protocol.alice).stake(Outcome.YES, 0n),
      ).to.be.revertedWithCustomError(market, 'ZeroAmount');
    });

    it('rejects a side that is not YES or NO', async () => {
      await protocol.token.connect(protocol.alice).approve(await market.getAddress(), usd(10));
      for (const side of [Outcome.UNSET, Outcome.INVALID]) {
        await expect(
          market.connect(protocol.alice).stake(side, usd(10)),
        ).to.be.revertedWithCustomError(market, 'InvalidSide');
      }
    });

    it('rejects a stake with no allowance', async () => {
      await expect(market.connect(protocol.alice).stake(Outcome.YES, usd(10))).to.be.reverted;
    });

    it('rejects a stake larger than the balance', async () => {
      const balance = await protocol.token.balanceOf(protocol.carol.address);
      await protocol.token.connect(protocol.carol).approve(await market.getAddress(), balance + 1n);
      await expect(market.connect(protocol.carol).stake(Outcome.YES, balance + 1n)).to.be.reverted;
    });

    it('rejects a stake once trading has ended, even before anyone calls close', async () => {
      await time.increaseTo(await market.tradingEndsAt());
      expect(await market.state()).to.equal(State.OPEN);
      await protocol.token.connect(protocol.alice).approve(await market.getAddress(), usd(10));
      await expect(
        market.connect(protocol.alice).stake(Outcome.YES, usd(10)),
      ).to.be.revertedWithCustomError(market, 'TradingClosed');
    });

    it('rejects a stake after the market is closed', async () => {
      await time.increaseTo(await market.tradingEndsAt());
      await market.close();
      await protocol.token.connect(protocol.alice).approve(await market.getAddress(), usd(10));
      await expect(
        market.connect(protocol.alice).stake(Outcome.YES, usd(10)),
      ).to.be.revertedWithCustomError(market, 'InvalidState');
    });

    it('rejects a stake while the factory is paused, and resumes after unpause', async () => {
      await protocol.factory.connect(protocol.admin).pause();
      await protocol.token.connect(protocol.alice).approve(await market.getAddress(), usd(10));
      await expect(
        market.connect(protocol.alice).stake(Outcome.YES, usd(10)),
      ).to.be.revertedWithCustomError(market, 'StakingPaused');

      await protocol.factory.connect(protocol.admin).unpause();
      await expect(market.connect(protocol.alice).stake(Outcome.YES, usd(10))).to.not.be.reverted;
    });

    it('rejects a fee-on-transfer token rather than crediting funds it never received', async () => {
      const feeToken = asHandle(await ethers.deployContract('FeeOnTransferToken'));
      await feeToken.waitForDeployment();
      await feeToken.mint(protocol.alice.address, usd(1000));

      const params = await defaultMarketParams(await feeToken.getAddress());
      await protocol.factory.connect(protocol.alice).createMarket(params);
      const feeMarketAddress = await protocol.factory.marketByRulesHash(params.rulesHash);
      const feeMarket = asHandle(
        await ethers.getContractAt('ConditionalMarket', feeMarketAddress),
      );

      await feeToken.connect(protocol.alice).approve(feeMarketAddress, usd(100));
      await expect(
        feeMarket.connect(protocol.alice).stake(Outcome.YES, usd(100)),
      ).to.be.revertedWithCustomError(feeMarket, 'UnsupportedToken');

      expect(await feeMarket.totalYes()).to.equal(0n);
    });
  });

  describe('close', () => {
    it('is permissionless once trading ends', async () => {
      await stakeAs(protocol, market, protocol.alice, Outcome.YES, usd(10));
      await time.increaseTo(await market.tradingEndsAt());

      await expect(market.connect(protocol.outsider).close())
        .to.emit(market, 'MarketClosed')
        .withArgs(await market.marketId(), (value: bigint) => value > 0n, usd(10), 0n);
      expect(await market.state()).to.equal(State.CLOSED);
    });

    it('refuses to close before trading ends', async () => {
      await expect(market.close()).to.be.revertedWithCustomError(market, 'TradingStillOpen');
      await time.increaseTo((await market.tradingEndsAt()) - 2n);
      await expect(market.close()).to.be.revertedWithCustomError(market, 'TradingStillOpen');
    });

    it('is not idempotent: a second close reverts rather than re-emitting', async () => {
      await time.increaseTo(await market.tradingEndsAt());
      await market.close();
      await expect(market.close())
        .to.be.revertedWithCustomError(market, 'InvalidState')
        .withArgs(State.CLOSED);
    });

    it('closes implicitly when a proposal arrives on an unclosed market', async () => {
      await time.increaseTo(await market.conditionDeadline());
      expect(await market.state()).to.equal(State.OPEN);

      await expect(
        market
          .connect(protocol.resolver)
          .proposeResolution(Outcome.YES, ethers.id('evidence')),
      ).to.emit(market, 'MarketClosed');

      expect(await market.state()).to.equal(State.RESOLUTION_PROPOSED);
    });
  });
});
