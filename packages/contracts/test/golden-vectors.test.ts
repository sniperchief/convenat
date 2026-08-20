/**
 * The boundary between the off-chain protocol and the chain.
 *
 * What this proves, precisely:
 *
 *   canonical text (produced by @covenant/shared)
 *      -> keccak256 over its UTF-8 bytes, computed here with ethers
 *      -> equals the rulesHash locked in the shared golden vectors
 *      -> passed to createMarket
 *      -> stored on-chain and read back byte-identical
 *
 * What it does NOT prove, and does not claim to: Solidity does not reproduce the
 * JCS canonicalisation. Doing so on-chain would mean parsing and re-serialising
 * JSON in the EVM, which is why the specification is committed as a hash in the
 * first place. The contract's job is to hold the exact 32 bytes it was given,
 * and that is what is verified.
 *
 * No hash is transcribed into this file. Every expected value is read from
 * `@covenant/shared/vectors/golden.json`; a copied constant is a constant that
 * can drift from the implementation that produced it.
 */

import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  Outcome,
  closeMarket,
  createMarket,
  defaultMarketParams,
  deployProtocol,
  loadGoldenVectors,
  parseFactoryLogs,
  passChallengeWindow,
  reachConditionDeadline,
  stakeAs,
  usd,
  type Protocol,
} from './helpers';

describe('Shared golden vectors', () => {
  const vectors = loadGoldenVectors();
  let protocol: Protocol;

  beforeEach(async () => {
    protocol = await deployProtocol();
  });

  it('loads the vector file produced by the shared package', () => {
    expect(vectors.producer).to.equal('@covenant/shared');
    expect(vectors.conditionSpecVersion).to.equal('1.0');
    expect(vectors.algorithm.encoding).to.equal('UTF-8');
    expect(vectors.algorithm.digest).to.contain('keccak256');
    expect(vectors.conditionSpecs.length).to.be.greaterThan(0);
    expect(vectors.evidencePackages.length).to.be.greaterThan(0);
  });

  describe('the off-chain hash is reproducible with EVM keccak256', () => {
    for (const vector of vectors.conditionSpecs) {
      it(`reproduces the rulesHash for "${vector.name}"`, () => {
        const recomputed = ethers.keccak256(ethers.toUtf8Bytes(vector.canonical));
        expect(recomputed).to.equal(vector.rulesHash);
      });
    }

    for (const vector of vectors.evidencePackages) {
      it(`reproduces the evidenceHash for "${vector.name}"`, () => {
        const recomputed = ethers.keccak256(ethers.toUtf8Bytes(vector.canonical));
        expect(recomputed).to.equal(vector.evidenceHash);
      });
    }

    it('uses keccak256 and not sha256, which would give a different digest', () => {
      const vector = vectors.conditionSpecs[0]!;
      const bytes = ethers.toUtf8Bytes(vector.canonical);
      expect(ethers.sha256(bytes)).to.not.equal(vector.rulesHash);
      expect(ethers.keccak256(bytes)).to.equal(vector.rulesHash);
    });

    it('is sensitive to a single byte of the canonical text', () => {
      const vector = vectors.conditionSpecs[0]!;
      const tampered = `${vector.canonical} `;
      expect(ethers.keccak256(ethers.toUtf8Bytes(tampered))).to.not.equal(vector.rulesHash);
    });
  });

  describe('the chain stores exactly the committed bytes', () => {
    for (const vector of vectors.conditionSpecs) {
      it(`commits and returns the rulesHash for "${vector.name}"`, async () => {
        const { market } = await createMarket(protocol, { rulesHash: vector.rulesHash });

        expect(await market.rulesHash()).to.equal(vector.rulesHash);
        expect(await market.rulesHash()).to.equal(
          ethers.keccak256(ethers.toUtf8Bytes(vector.canonical)),
        );
        expect(await protocol.factory.marketByRulesHash(vector.rulesHash)).to.equal(
          await market.getAddress(),
        );
      });
    }

    it('emits the rulesHash in MarketCreated so the indexer can join on it', async () => {
      const vector = vectors.conditionSpecs[0]!;
      const params = await defaultMarketParams(await protocol.token.getAddress(), {
        rulesHash: vector.rulesHash,
      });
      const tx = await protocol.factory.connect(protocol.alice).createMarket(params);
      const receipt = await tx.wait();
      if (receipt === null) throw new Error('createMarket produced no receipt');

      const parsed = parseFactoryLogs(protocol, receipt.logs).find(
        (log) => log.name === 'MarketCreated',
      );

      expect(parsed).to.not.equal(undefined);
      expect(parsed!.args['rulesHash']).to.equal(vector.rulesHash);
    });
  });

  describe('the evidence commitment survives a full resolution', () => {
    it('stores the shared evidenceHash and returns it unchanged after finalization', async () => {
      const specVector = vectors.conditionSpecs[0]!;
      const evidenceVector = vectors.evidencePackages[0]!;

      const { market } = await createMarket(protocol, { rulesHash: specVector.rulesHash });
      await stakeAs(protocol, market, protocol.alice, Outcome.YES, usd(10));
      await closeMarket(market);
      await reachConditionDeadline(market);

      await market
        .connect(protocol.resolver)
        .proposeResolution(Outcome.YES, evidenceVector.evidenceHash);
      expect(await market.evidenceHash()).to.equal(evidenceVector.evidenceHash);

      await passChallengeWindow(market);
      await market.finalize();

      expect(await market.evidenceHash()).to.equal(evidenceVector.evidenceHash);
      expect(await market.evidenceHash()).to.equal(
        ethers.keccak256(ethers.toUtf8Bytes(evidenceVector.canonical)),
      );
      // And the rules it was resolved against are still the ones committed.
      expect(await market.rulesHash()).to.equal(specVector.rulesHash);
    });

    /**
     * The Milestone 5.1 core principle, checked against the chain rather than
     * only in TypeScript: the package's own `rulesHash` field is the value the
     * market holds. `v2ShipmentYes` resolves the `shipment` specification, so
     * the binding inside the document and the commitment inside the contract
     * have to be the same 32 bytes — otherwise the evidence argues about some
     * other agreement.
     */
    it('binds a v2.0 evidence package to the rulesHash the market actually holds', async () => {
      const specVector = vectors.conditionSpecs.find((vector) => vector.name === 'shipment');
      const evidenceVector = vectors.evidencePackages.find(
        (vector) => vector.name === 'v2ShipmentYes',
      );
      expect(specVector, 'shipment spec vector').to.not.equal(undefined);
      expect(evidenceVector, 'v2ShipmentYes evidence vector').to.not.equal(undefined);

      const { market } = await createMarket(protocol, { rulesHash: specVector!.rulesHash });
      await stakeAs(protocol, market, protocol.alice, Outcome.YES, usd(10));
      await closeMarket(market);
      await reachConditionDeadline(market);

      await market
        .connect(protocol.resolver)
        .proposeResolution(Outcome.YES, evidenceVector!.evidenceHash);
      await passChallengeWindow(market);
      await market.finalize();

      expect(evidenceVector!.input['version']).to.equal('2.0');
      expect(evidenceVector!.input['rulesHash']).to.equal(await market.rulesHash());
      expect(await market.evidenceHash()).to.equal(
        ethers.keccak256(ethers.toUtf8Bytes(evidenceVector!.canonical)),
      );
    });

    /**
     * The counterexample. `v2OtherRules` is byte-identical to `v2ShipmentYes`
     * apart from its `rulesHash`, and the chain will happily store its evidence
     * hash — the contract has no idea what the document says. That is exactly
     * why the binding is refused off-chain, in `@covenant/shared`, before a
     * proposal is ever built.
     */
    it('shows the chain cannot detect a mis-bound package, which is why the backend must', async () => {
      const specVector = vectors.conditionSpecs.find((vector) => vector.name === 'shipment');
      const misBound = vectors.evidencePackages.find((vector) => vector.name === 'v2OtherRules');
      expect(misBound, 'v2OtherRules evidence vector').to.not.equal(undefined);

      const { market } = await createMarket(protocol, { rulesHash: specVector!.rulesHash });
      await closeMarket(market);
      await reachConditionDeadline(market);
      await market
        .connect(protocol.resolver)
        .proposeResolution(Outcome.YES, misBound!.evidenceHash);

      // Stored without complaint, and pointing at rules this market does not have.
      expect(await market.evidenceHash()).to.equal(misBound!.evidenceHash);
      expect(misBound!.input['rulesHash']).to.not.equal(await market.rulesHash());
    });
  });

  describe('cross-checking the vector inputs against on-chain parameters', () => {
    it('accepts the settlement terms carried by the shipment specification', async () => {
      const vector = vectors.conditionSpecs.find((entry) => entry.name === 'shipment')!;
      const settlement = vector.input['settlement'] as {
        challengeWindowSeconds: number;
        resolutionDeadlineSeconds: number;
        challengeBondBaseUnits: string;
      };

      // The window and bond the user approved are the ones the market enforces,
      // which is what makes committing them inside rulesHash meaningful.
      const { market } = await createMarket(protocol, {
        rulesHash: vector.rulesHash,
        challengeWindow: settlement.challengeWindowSeconds,
        resolutionWindow: settlement.resolutionDeadlineSeconds,
        challengeBond: BigInt(settlement.challengeBondBaseUnits),
      });

      expect(await market.challengeWindow()).to.equal(BigInt(settlement.challengeWindowSeconds));
      expect(await market.resolutionWindow()).to.equal(
        BigInt(settlement.resolutionDeadlineSeconds),
      );
      expect(await market.challengeBond()).to.equal(BigInt(settlement.challengeBondBaseUnits));
    });

    it('matches the six-decimal precision the specification assumes', async () => {
      const vector = vectors.conditionSpecs[0]!;
      const settlement = vector.input['settlement'] as { token: { decimals: number } };
      expect(await protocol.token.decimals()).to.equal(BigInt(settlement.token.decimals));
    });
  });
});
