# ADR-0007: Pause covers creation and staking only, never claims

**Status:** Accepted — 2026-08-16

## Context

`Pausable` is a standard safety control and the specification lists it as appropriate. But
a pause applied indiscriminately is indistinguishable, from a user's position, from a
freeze of their funds — and §8 forbids any privileged function that lets an administrator
redirect or withhold active user funds.

## Decision

`whenNotPaused` guards exactly two entry points:

- `MarketFactory.createMarket` — stop new markets
- `ConditionalMarket.stake` — stop new money entering an existing market

It guards **none** of:

- `claim`
- `withdrawRefund`
- `challenge`
- `cancel` (the permissionless timeout triggers)
- `finalize`

Pausing is therefore strictly a "stop taking new risk" control, never an "immobilize
existing funds" control. Combined with ADR-0004's permissionless cancellation, a fully
absent operator still leaves every participant a path to their money.

## Consequences

- A live exploit against `stake` can be contained. A live exploit against `claim` cannot
  be paused — the mitigation there is audit coverage and the pari-mutuel accounting being
  simple enough to reason about exhaustively, not an emergency switch.
- `docs/security.md` states this trade-off explicitly so it is a chosen position rather
  than an oversight.
