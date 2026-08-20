# ADR-0002: Factory deploys an EIP-1167 clone per market

**Status:** Accepted — 2026-08-16

## Context

Two viable shapes for the MVP contracts:

1. **Singleton registry** — one contract holds every market as a struct in a mapping and
   custodies all stablecoin for all markets in one balance.
2. **Factory + clone** — a factory deploys a minimal proxy per market; each market holds
   only its own funds.

The specification requires `MarketFactory` plus a market contract, and the database schema
carries both `chainMarketId` and `contractAddress`, which fits either shape but reads more
naturally as the second.

## Decision

`MarketFactory` deploys an EIP-1167 minimal proxy (OpenZeppelin `Clones`) over one
immutable `ConditionalMarket` implementation, assigns a sequential `marketId`, and records
the address. Markets are initialized, not constructed; the implementation calls
`_disableInitializers()` so it can never be initialized directly.

## Consequences

- **Blast radius.** An accounting bug or a malicious ERC-20 in one market cannot touch
  another market's balance. Given that §8 of the spec makes fund safety the dominant
  requirement, isolation outweighs the alternative's simplicity.
- **Cost.** ~45k extra gas per market creation versus a struct insert. On X Layer with OKB
  gas this is immaterial for the MVP.
- **Indexing.** Logs are emitted from many addresses. The indexer must watch the factory
  for `MarketCreated` and then subscribe to each clone, or filter by topic across all
  addresses. The indexer keeps the known-market address set in the DB and filters by it.
- **Upgrades.** Clones are not upgradeable and deliberately so: rules committed to a
  market cannot be changed by redeploying an implementation. A new implementation affects
  only markets created after it.
- **Verification.** Only the implementation and factory need explorer verification; clones
  verify by proxy pattern.
