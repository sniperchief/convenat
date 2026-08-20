/**
 * The first complete financial lifecycle, end to end and entirely local.
 *
 * This is the test the whole milestone exists to make pass: two users fund
 * opposite sides of a real condition, the condition closes, a resolver proposes
 * an outcome backed by an evidence commitment, a participant contests it, the
 * resolver reconsiders, the market finalizes, and every token ends up where the
 * rules say it should. Balances are checked against arithmetic done here, not
 * against the contract's own view of itself.
 */

import { time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  CHALLENGE_BOND,
  Outcome,
  State,
  createMarket,
  deployProtocol,
  loadGoldenVectors,
  stakeAs,
  usd,
  type Protocol,
} from './helpers';

describe('End-to-end lifecycle', () => {
  let protocol: Protocol;

  beforeEach(async () => {
    protocol = await deployProtocol();
  });

  it('runs an unchallenged market from creation to settlement', async () => {
    const vectors = loadGoldenVectors();
    const specVector = vectors.conditionSpecs.find((entry) => entry.name === 'shipment')!;
    const evidenceVector = vectors.evidencePackages.find((entry) => entry.name === 'delivered')!;

    // 1. A creator opens a market committing to the approved rules.
    const { market, marketId } = await createMarket(
      protocol,
      { rulesHash: specVector.rulesHash },
      protocol.alice,
    );
    expect(await market.state()).to.equal(State.OPEN);
    expect(await market.rulesHash()).to.equal(
      ethers.keccak256(ethers.toUtf8Bytes(specVector.canonical)),
    );

    // 2. Both sides are funded.
    await stakeAs(protocol, market, protocol.alice, Outcome.YES, usd(300));
    await stakeAs(protocol, market, protocol.bob, Outcome.NO, usd(100));
    await stakeAs(protocol, market, protocol.carol, Outcome.YES, usd(100));

    const marketAddress = await market.getAddress();
    expect(await protocol.token.balanceOf(marketAddress)).to.equal(usd(500));
    expect(await market.pool()).to.equal(usd(500));

    // 3. Trading closes, permissionlessly.
    await time.increaseTo(await market.tradingEndsAt());
    await market.connect(protocol.outsider).close();
    expect(await market.state()).to.equal(State.CLOSED);

    // 4. After the condition deadline, the resolver proposes with evidence.
    await time.increaseTo(await market.conditionDeadline());
    await market
      .connect(protocol.resolver)
      .proposeResolution(Outcome.YES, evidenceVector.evidenceHash);
    expect(await market.state()).to.equal(State.RESOLUTION_PROPOSED);

    // 5. Nothing is claimable while the proposal is contestable.
    await expect(market.connect(protocol.alice).claim()).to.be.revertedWithCustomError(
      market,
      'InvalidState',
    );

    // 6. The window passes unchallenged and anyone may finalize.
    await time.increaseTo((await market.challengeEndsAt()) + 1n);
    await market.connect(protocol.outsider).finalize();
    expect(await market.state()).to.equal(State.FINALIZED);
    expect(await market.finalOutcome()).to.equal(Outcome.YES);

    // 7. Winners claim their proportional share. YES side is 400 of a 500 pool.
    const aliceBefore = await protocol.token.balanceOf(protocol.alice.address);
    const carolBefore = await protocol.token.balanceOf(protocol.carol.address);
    const bobBefore = await protocol.token.balanceOf(protocol.bob.address);

    await market.connect(protocol.alice).claim();
    await market.connect(protocol.carol).claim();

    expect((await protocol.token.balanceOf(protocol.alice.address)) - aliceBefore).to.equal(
      usd(375),
    ); // 300/400 * 500
    expect((await protocol.token.balanceOf(protocol.carol.address)) - carolBefore).to.equal(
      usd(125),
    ); // 100/400 * 500

    // 8. The loser gets nothing and the market is empty and settled.
    await expect(market.connect(protocol.bob).claim()).to.be.revertedWithCustomError(
      market,
      'NothingToClaim',
    );
    expect(await protocol.token.balanceOf(protocol.bob.address)).to.equal(bobBefore);
    expect(await protocol.token.balanceOf(marketAddress)).to.equal(0n);
    expect(await market.state()).to.equal(State.SETTLED);
    expect(await market.marketId()).to.equal(marketId);
  });

  it('runs a challenged market whose outcome is overturned', async () => {
    const { market } = await createMarket(protocol);

    await stakeAs(protocol, market, protocol.alice, Outcome.YES, usd(200));
    await stakeAs(protocol, market, protocol.bob, Outcome.NO, usd(200));
    const marketAddress = await market.getAddress();

    await time.increaseTo(await market.conditionDeadline());
    await market.close();

    // Round 1: the resolver gets it wrong.
    await market.connect(protocol.resolver).proposeResolution(Outcome.YES, ethers.id('e1'));

    // Bob posts a bond and contests it.
    await protocol.token.connect(protocol.bob).approve(marketAddress, CHALLENGE_BOND);
    await market.connect(protocol.bob).challenge(ethers.id('the source was misread'));
    expect(await market.state()).to.equal(State.CHALLENGED);
    expect(await protocol.token.balanceOf(marketAddress)).to.equal(usd(400) + CHALLENGE_BOND);

    // Round 2: the resolver reconsiders. This proposal is final.
    await market.connect(protocol.resolver).proposeResolution(Outcome.NO, ethers.id('e2'));
    expect(await market.proposalRound()).to.equal(2n);

    await time.increaseTo((await market.challengeEndsAt()) + 1n);
    await market.finalize();

    // The challenge changed the outcome, so the bond comes back and the pool is
    // just the two stakes.
    expect(await market.finalOutcome()).to.equal(Outcome.NO);
    expect(await market.bondRefundable()).to.equal(true);
    expect(await market.forfeitedBond()).to.equal(0n);
    expect(await market.pool()).to.equal(usd(400));

    const bobBefore = await protocol.token.balanceOf(protocol.bob.address);
    await market.connect(protocol.bob).claim();
    await market.connect(protocol.bob).claimChallengeBond();

    // Bob wins the whole pool and gets his bond back: 400 + 50.
    expect((await protocol.token.balanceOf(protocol.bob.address)) - bobBefore).to.equal(
      usd(400) + CHALLENGE_BOND,
    );
    expect(await protocol.token.balanceOf(marketAddress)).to.equal(0n);
    expect(await market.state()).to.equal(State.SETTLED);
  });

  it('runs a challenged market whose outcome is confirmed', async () => {
    const { market } = await createMarket(protocol);
    const marketAddress = await market.getAddress();

    await stakeAs(protocol, market, protocol.alice, Outcome.YES, usd(200));
    await stakeAs(protocol, market, protocol.bob, Outcome.NO, usd(200));

    await time.increaseTo(await market.conditionDeadline());
    await market.close();
    await market.connect(protocol.resolver).proposeResolution(Outcome.YES, ethers.id('e1'));

    await protocol.token.connect(protocol.bob).approve(marketAddress, CHALLENGE_BOND);
    await market.connect(protocol.bob).challenge(ethers.id('disagree'));

    // The resolver looks again and stands by the original answer.
    await market.connect(protocol.resolver).proposeResolution(Outcome.YES, ethers.id('e2'));
    await time.increaseTo((await market.challengeEndsAt()) + 1n);
    await market.finalize();

    // The bond is forfeited into the pool, so the winner is paid it.
    expect(await market.forfeitedBond()).to.equal(CHALLENGE_BOND);
    expect(await market.pool()).to.equal(usd(400) + CHALLENGE_BOND);

    const aliceBefore = await protocol.token.balanceOf(protocol.alice.address);
    await market.connect(protocol.alice).claim();
    expect((await protocol.token.balanceOf(protocol.alice.address)) - aliceBefore).to.equal(
      usd(400) + CHALLENGE_BOND,
    );
    await expect(market.connect(protocol.bob).claimChallengeBond()).to.be.revertedWithCustomError(
      market,
      'AlreadyClaimed',
    );
    expect(await protocol.token.balanceOf(marketAddress)).to.equal(0n);
  });

  it('unwinds a market the resolver abandoned, with the admin paused and gone', async () => {
    const { market } = await createMarket(protocol);
    const marketAddress = await market.getAddress();

    await stakeAs(protocol, market, protocol.alice, Outcome.YES, usd(150));
    await stakeAs(protocol, market, protocol.bob, Outcome.NO, usd(90));

    // Worst case: the backend never proposes and the administrator pauses and
    // walks away. Participants must still be able to recover their funds.
    await protocol.factory.connect(protocol.admin).pause();
    await time.increaseTo(await market.resolutionDeadline());

    await market.connect(protocol.outsider).cancel();
    expect(await market.state()).to.equal(State.CANCELLED);

    const aliceBefore = await protocol.token.balanceOf(protocol.alice.address);
    const bobBefore = await protocol.token.balanceOf(protocol.bob.address);
    await market.connect(protocol.alice).withdrawRefund();
    await market.connect(protocol.bob).withdrawRefund();

    expect((await protocol.token.balanceOf(protocol.alice.address)) - aliceBefore).to.equal(usd(150));
    expect((await protocol.token.balanceOf(protocol.bob.address)) - bobBefore).to.equal(usd(90));
    expect(await protocol.token.balanceOf(marketAddress)).to.equal(0n);
  });

  it('keeps two concurrent markets financially independent throughout', async () => {
    const { market: a } = await createMarket(protocol);
    const { market: b } = await createMarket(protocol);

    await stakeAs(protocol, a, protocol.alice, Outcome.YES, usd(100));
    await stakeAs(protocol, a, protocol.bob, Outcome.NO, usd(100));
    await stakeAs(protocol, b, protocol.carol, Outcome.YES, usd(500));
    await stakeAs(protocol, b, protocol.outsider, Outcome.NO, usd(500));

    await time.increaseTo(await a.conditionDeadline());
    await a.close();
    await b.close();
    await a.connect(protocol.resolver).proposeResolution(Outcome.YES, ethers.id('a'));
    await b.connect(protocol.resolver).proposeResolution(Outcome.NO, ethers.id('b'));
    await time.increaseTo((await a.challengeEndsAt()) + 1n);
    await a.finalize();
    await b.finalize();

    await a.connect(protocol.alice).claim();
    expect(await protocol.token.balanceOf(await a.getAddress())).to.equal(0n);
    // Settling A moved nothing in B.
    expect(await protocol.token.balanceOf(await b.getAddress())).to.equal(usd(1000));

    await b.connect(protocol.outsider).claim();
    expect(await protocol.token.balanceOf(await b.getAddress())).to.equal(0n);
    expect(await a.state()).to.equal(State.SETTLED);
    expect(await b.state()).to.equal(State.SETTLED);
  });
});
