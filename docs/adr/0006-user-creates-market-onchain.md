# ADR-0006: The user's wallet creates the market; the backend joins on rulesHash

**Status:** Accepted — 2026-08-16

## Context

After a user approves an AI-compiled specification, something must call
`MarketFactory.createMarket`. Either the backend submits it (and must then be trusted, and
must be paid for gas, and becomes a single point of failure), or the user's own wallet
submits it. If the user submits it, the backend needs a reliable way to link the
off-chain specification document to the on-chain market.

## Decision

The user's wallet calls `createMarket(rulesHash, token, tradingEnd, challengeWindow,
challengeBond, resolutionDeadline)` directly.

The backend persists the approved specification at approval time, keyed by its
`rulesHash`, in state `PENDING_ONCHAIN`. The indexer observes `MarketCreated`, reads the
`rulesHash` from the event, and joins it to the stored specification, promoting it to
`OPEN` with the on-chain `marketId` and clone address recorded.

If a `MarketCreated` event carries a `rulesHash` the backend has never seen, the market is
recorded as `UNKNOWN_SPEC` and surfaced without a specification body rather than being
hidden. The chain remains authoritative even about the existence of markets.

## Consequences

- The backend cannot create a market on a user's behalf, and the user does not depend on
  backend liveness or a backend gas budget to open one.
- The rules hash is committed by the same person who approved the rules — the commitment
  means something.
- The join key is content-derived, so a mismatch is detectable rather than silent.
- Collision handling: two users approving a byte-identical specification produce the same
  `rulesHash`. The spec schema therefore includes a `nonce` (creator address + a random
  32-byte value fixed at approval time), making each approved spec — and its hash —
  unique.
