import { expect } from 'chai';
import { ethers } from 'hardhat';
import { time } from '@nomicfoundation/hardhat-network-helpers';

import {
  CHALLENGE_WINDOW,
  DAY,
  HOUR,
  Outcome,
  RESOLUTION_WINDOW,
  State,
  asHandle,
  createMarket,
  defaultMarketParams,
  deployProtocol,
  nextRulesHash,
  stakeAs,
  usd,
  type Protocol,
} from './helpers';

describe('MarketFactory', () => {
  let protocol: Protocol;

  beforeEach(async () => {
    protocol = await deployProtocol();
  });

  describe('deployment', () => {
    it('records the implementation and grants the two roles', async () => {
      expect(await protocol.factory.implementation()).to.equal(protocol.implementation);
      const adminRole = await protocol.factory.DEFAULT_ADMIN_ROLE();
      const proposerRole = await protocol.factory.PROPOSER_ROLE();
      expect(await protocol.factory.hasRole(adminRole, protocol.admin.address)).to.equal(true);
      expect(await protocol.factory.hasRole(proposerRole, protocol.resolver.address)).to.equal(true);
      expect(await protocol.factory.isProposer(protocol.resolver.address)).to.equal(true);
      expect(await protocol.factory.isProposer(protocol.outsider.address)).to.equal(false);
    });

    it('does not make the admin a proposer, nor the proposer an admin', async () => {
      const adminRole = await protocol.factory.DEFAULT_ADMIN_ROLE();
      const proposerRole = await protocol.factory.PROPOSER_ROLE();
      expect(await protocol.factory.hasRole(proposerRole, protocol.admin.address)).to.equal(false);
      expect(await protocol.factory.hasRole(adminRole, protocol.resolver.address)).to.equal(false);
    });

    it('rejects a zero admin or implementation', async () => {
      const zero = ethers.ZeroAddress;
      await expect(
        ethers.deployContract('MarketFactory', [zero, protocol.resolver.address, protocol.implementation]),
      ).to.be.revertedWithCustomError(protocol.factory, 'ZeroAddress');
      await expect(
        ethers.deployContract('MarketFactory', [protocol.admin.address, protocol.resolver.address, zero]),
      ).to.be.revertedWithCustomError(protocol.factory, 'ZeroAddress');
    });
  });

  describe('createMarket', () => {
    it('assigns sequential ids starting at one and emits the full parameter set', async () => {
      const params = await defaultMarketParams(await protocol.token.getAddress());
      await expect(protocol.factory.connect(protocol.alice).createMarket(params))
        .to.emit(protocol.factory, 'MarketCreated')
        .withArgs(
          1n,
          (value: string) => ethers.isAddress(value) && value !== ethers.ZeroAddress,
          protocol.alice.address,
          params.rulesHash,
          params.token,
          params.tradingEndsAt,
          params.conditionDeadline,
          params.challengeWindow,
          params.resolutionWindow,
          params.challengeBond,
          (value: bigint) => value > 0n,
        );

      const second = await defaultMarketParams(await protocol.token.getAddress());
      await protocol.factory.connect(protocol.bob).createMarket(second);
      expect(await protocol.factory.marketCount()).to.equal(2n);
      expect(await protocol.factory.marketById(1n)).to.not.equal(ethers.ZeroAddress);
      expect(await protocol.factory.marketById(2n)).to.not.equal(await protocol.factory.marketById(1n));
    });

    it('records the creator as the caller, not the backend', async () => {
      const { market } = await createMarket(protocol, {}, protocol.bob);
      expect(await market.creator()).to.equal(protocol.bob.address);
    });

    it('deploys a genuine EIP-1167 clone', async () => {
      const { market } = await createMarket(protocol);
      const code = await ethers.provider.getCode(await market.getAddress());
      // Minimal proxy runtime is 45 bytes and embeds the implementation address.
      expect(ethers.dataLength(code)).to.equal(45);
      expect(code.toLowerCase()).to.contain(protocol.implementation.slice(2).toLowerCase());
    });

    it('indexes the market by id and by rules hash', async () => {
      const { market, marketId, params } = await createMarket(protocol);
      const address = await market.getAddress();
      expect(await protocol.factory.marketById(marketId)).to.equal(address);
      expect(await protocol.factory.marketByRulesHash(params.rulesHash)).to.equal(address);
      expect(await protocol.factory.requireMarket(marketId)).to.equal(address);
    });

    it('refuses to create a second market with the same rules hash', async () => {
      const { market, params } = await createMarket(protocol);
      const duplicate = await defaultMarketParams(await protocol.token.getAddress(), {
        rulesHash: params.rulesHash,
      });
      await expect(protocol.factory.connect(protocol.bob).createMarket(duplicate))
        .to.be.revertedWithCustomError(protocol.factory, 'RulesHashAlreadyUsed')
        .withArgs(params.rulesHash, await market.getAddress());
    });

    it('reverts on an unknown market id', async () => {
      await expect(protocol.factory.requireMarket(99n))
        .to.be.revertedWithCustomError(protocol.factory, 'UnknownMarket')
        .withArgs(99n);
    });

    it('pages through markets oldest first', async () => {
      const created: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const { market } = await createMarket(protocol);
        created.push(await market.getAddress());
      }
      expect(await protocol.factory.listMarkets(1n, 10n)).to.deep.equal(created);
      expect(await protocol.factory.listMarkets(2n, 1n)).to.deep.equal([created[1]]);
      expect(await protocol.factory.listMarkets(0n, 2n)).to.deep.equal(created.slice(0, 2));
      expect(await protocol.factory.listMarkets(4n, 5n)).to.deep.equal([]);
      expect(await protocol.factory.listMarkets(1n, 0n)).to.deep.equal([]);
    });
  });

  describe('parameter validation', () => {
    it('rejects a zero token or creator-facing zero address', async () => {
      const params = await defaultMarketParams(ethers.ZeroAddress);
      await expect(
        protocol.factory.connect(protocol.alice).createMarket(params),
      ).to.be.revertedWithCustomError(
        asHandle(await ethers.getContractAt('ConditionalMarket', protocol.implementation)),
        'ZeroAddress',
      );
    });

    it('rejects an empty rules hash', async () => {
      const params = await defaultMarketParams(await protocol.token.getAddress(), {
        rulesHash: ethers.ZeroHash,
      });
      await expect(
        protocol.factory.connect(protocol.alice).createMarket(params),
      ).to.be.revertedWithCustomError(
        asHandle(await ethers.getContractAt('ConditionalMarket', protocol.implementation)),
        'MissingRulesHash',
      );
    });

    it('rejects a trading end already in the past', async () => {
      const now = await time.latest();
      const params = await defaultMarketParams(await protocol.token.getAddress(), {
        tradingEndsAt: BigInt(now - 1),
        conditionDeadline: BigInt(now + DAY),
      });
      await expect(
        protocol.factory.connect(protocol.alice).createMarket(params),
      ).to.be.revertedWithCustomError(
        asHandle(await ethers.getContractAt('ConditionalMarket', protocol.implementation)),
        'TradingEndsInThePast',
      );
    });

    it('rejects a condition deadline before trading ends', async () => {
      const now = await time.latest();
      const params = await defaultMarketParams(await protocol.token.getAddress(), {
        tradingEndsAt: BigInt(now + 2 * DAY),
        conditionDeadline: BigInt(now + DAY),
      });
      await expect(
        protocol.factory.connect(protocol.alice).createMarket(params),
      ).to.be.revertedWithCustomError(
        asHandle(await ethers.getContractAt('ConditionalMarket', protocol.implementation)),
        'DeadlineBeforeTradingEnd',
      );
    });

    it('enforces the challenge window bounds mirrored from the shared spec limits', async () => {
      const implementation = asHandle(await ethers.getContractAt('ConditionalMarket', protocol.implementation));
      for (const challengeWindow of [0, 59, 31 * DAY]) {
        const params = await defaultMarketParams(await protocol.token.getAddress(), {
          challengeWindow,
        });
        await expect(
          protocol.factory.connect(protocol.alice).createMarket(params),
        ).to.be.revertedWithCustomError(implementation, 'InvalidChallengeWindow');
      }
      const ok = await defaultMarketParams(await protocol.token.getAddress(), {
        challengeWindow: 60,
      });
      await expect(protocol.factory.connect(protocol.alice).createMarket(ok)).to.not.be.reverted;
    });

    it('enforces the resolution window bounds', async () => {
      const implementation = asHandle(await ethers.getContractAt('ConditionalMarket', protocol.implementation));
      for (const resolutionWindow of [0, HOUR - 1, 91 * DAY]) {
        const params = await defaultMarketParams(await protocol.token.getAddress(), {
          resolutionWindow,
        });
        await expect(
          protocol.factory.connect(protocol.alice).createMarket(params),
        ).to.be.revertedWithCustomError(implementation, 'InvalidResolutionWindow');
      }
    });
  });

  describe('clone isolation', () => {
    it('gives each market independent configuration and state', async () => {
      const { market: a, params: pa } = await createMarket(protocol);
      const { market: b, params: pb } = await createMarket(protocol, {
        challengeWindow: 3 * HOUR,
        challengeBond: usd(1),
      });

      expect(await a.rulesHash()).to.equal(pa.rulesHash);
      expect(await b.rulesHash()).to.equal(pb.rulesHash);
      expect(await a.challengeWindow()).to.equal(BigInt(CHALLENGE_WINDOW));
      expect(await b.challengeWindow()).to.equal(BigInt(3 * HOUR));
      expect(await a.resolutionWindow()).to.equal(BigInt(RESOLUTION_WINDOW));
      expect(await a.marketId()).to.not.equal(await b.marketId());
      expect(await a.state()).to.equal(State.OPEN);
    });

    it('keeps each market custodying only its own funds', async () => {
      const { market: a } = await createMarket(protocol);
      const { market: b } = await createMarket(protocol);

      await stakeAs(protocol, a, protocol.alice, Outcome.YES, usd(100));
      await stakeAs(protocol, b, protocol.bob, Outcome.NO, usd(70));

      expect(await protocol.token.balanceOf(await a.getAddress())).to.equal(usd(100));
      expect(await protocol.token.balanceOf(await b.getAddress())).to.equal(usd(70));
      expect(await a.totalYes()).to.equal(usd(100));
      expect(await a.totalNo()).to.equal(0n);
      expect(await b.totalNo()).to.equal(usd(70));
      expect(await b.totalYes()).to.equal(0n);

      // A stake in one market confers nothing in the other.
      expect(await b.yesStake(protocol.alice.address)).to.equal(0n);
      expect(await a.noStake(protocol.bob.address)).to.equal(0n);
    });

    it('proves market A cannot be drained through market B', async () => {
      const { market: a } = await createMarket(protocol);
      const { market: b } = await createMarket(protocol);

      await stakeAs(protocol, a, protocol.alice, Outcome.YES, usd(100));
      await stakeAs(protocol, b, protocol.alice, Outcome.YES, usd(1));
      await stakeAs(protocol, b, protocol.bob, Outcome.NO, usd(1));

      // Settle B entirely. It can only ever pay out its own 2 USD.
      await time.increaseTo(await b.conditionDeadline());
      await b.close();
      await b.connect(protocol.resolver).proposeResolution(Outcome.YES, nextRulesHash());
      await time.increaseTo((await b.challengeEndsAt()) + 1n);
      await b.finalize();

      const before = await protocol.token.balanceOf(protocol.alice.address);
      await b.connect(protocol.alice).claim();
      const gained = (await protocol.token.balanceOf(protocol.alice.address)) - before;

      expect(gained).to.equal(usd(2));
      expect(await protocol.token.balanceOf(await a.getAddress())).to.equal(usd(100));
      expect(await protocol.token.balanceOf(await b.getAddress())).to.equal(0n);
    });
  });

  describe('initialization', () => {
    it('cannot initialize a market twice', async () => {
      const { market, params } = await createMarket(protocol);
      await expect(
        market.initialize({
          marketId: 999n,
          creator: protocol.outsider.address,
          token: params.token,
          rulesHash: nextRulesHash(),
          tradingEndsAt: params.tradingEndsAt,
          conditionDeadline: params.conditionDeadline,
          challengeWindow: params.challengeWindow,
          resolutionWindow: params.resolutionWindow,
          challengeBond: params.challengeBond,
        }),
      ).to.be.revertedWithCustomError(market, 'InvalidInitialization');
    });

    it('cannot initialize the implementation contract itself', async () => {
      const implementation = asHandle(await ethers.getContractAt('ConditionalMarket', protocol.implementation));
      const params = await defaultMarketParams(await protocol.token.getAddress());
      await expect(
        implementation.initialize({
          marketId: 1n,
          creator: protocol.outsider.address,
          token: params.token,
          rulesHash: params.rulesHash,
          tradingEndsAt: params.tradingEndsAt,
          conditionDeadline: params.conditionDeadline,
          challengeWindow: params.challengeWindow,
          resolutionWindow: params.resolutionWindow,
          challengeBond: params.challengeBond,
        }),
      ).to.be.revertedWithCustomError(implementation, 'InvalidInitialization');
    });

    it('starts the market OPEN with the factory recorded as its role source', async () => {
      const { market } = await createMarket(protocol);
      expect(await market.state()).to.equal(State.OPEN);
      expect(await market.factory()).to.equal(await protocol.factory.getAddress());
      expect(await market.proposalRound()).to.equal(0n);
      expect(await market.finalOutcome()).to.equal(Outcome.UNSET);
      expect(await market.refundMode()).to.equal(false);
    });
  });

  describe('pause', () => {
    it('lets the admin stop and resume market creation', async () => {
      await protocol.factory.connect(protocol.admin).pause();
      const params = await defaultMarketParams(await protocol.token.getAddress());
      await expect(
        protocol.factory.connect(protocol.alice).createMarket(params),
      ).to.be.revertedWithCustomError(protocol.factory, 'EnforcedPause');

      await protocol.factory.connect(protocol.admin).unpause();
      await expect(protocol.factory.connect(protocol.alice).createMarket(params)).to.not.be.reverted;
    });

    it('refuses to let a non-admin pause', async () => {
      await expect(
        protocol.factory.connect(protocol.outsider).pause(),
      ).to.be.revertedWithCustomError(protocol.factory, 'AccessControlUnauthorizedAccount');
      await expect(
        protocol.factory.connect(protocol.resolver).pause(),
      ).to.be.revertedWithCustomError(protocol.factory, 'AccessControlUnauthorizedAccount');
    });
  });

  describe('role administration', () => {
    it('lets the admin rotate the resolver across every market at once', async () => {
      const { market } = await createMarket(protocol);
      const proposerRole = await protocol.factory.PROPOSER_ROLE();

      await protocol.factory.connect(protocol.admin).revokeRole(proposerRole, protocol.resolver.address);
      await protocol.factory.connect(protocol.admin).grantRole(proposerRole, protocol.carol.address);

      expect(await protocol.factory.isProposer(protocol.resolver.address)).to.equal(false);
      expect(await protocol.factory.isProposer(protocol.carol.address)).to.equal(true);

      await time.increaseTo(await market.conditionDeadline());
      await market.close();
      await expect(
        market.connect(protocol.resolver).proposeResolution(Outcome.YES, nextRulesHash()),
      ).to.be.revertedWithCustomError(market, 'NotProposer');
      await expect(market.connect(protocol.carol).proposeResolution(Outcome.YES, nextRulesHash())).to
        .not.be.reverted;
    });

    it('refuses to let a non-admin grant the proposer role', async () => {
      const proposerRole = await protocol.factory.PROPOSER_ROLE();
      await expect(
        protocol.factory.connect(protocol.outsider).grantRole(proposerRole, protocol.outsider.address),
      ).to.be.revertedWithCustomError(protocol.factory, 'AccessControlUnauthorizedAccount');
    });
  });
});
