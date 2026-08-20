# ADR-0004: One challenge round, bond-based, with a cancellation safety valve

**Status:** Accepted — 2026-08-16

## Context

The specified state machine allows `RESOLUTION_PROPOSED → CHALLENGED → REVIEW →
RESOLUTION_PROPOSED`, which as written is an unbounded loop. Two hazards follow:

1. **Non-termination / griefing.** A free challenge can be repeated forever, and each
   round delays every honest participant's claim.
2. **Resolver liveness.** If the backend resolver stops working — crashed, key lost,
   operator gone — a market sitting in `CLOSED` or `CHALLENGED` would hold user funds
   permanently with no path out. That is the single worst failure mode in the system, and
   it is caused by *absence* of action, so no amount of access control prevents it.

The specification also forbids building a complex decentralized dispute protocol.

## Decision

**Bond.** Challenging requires an ERC-20 bond in the settlement token, sized at market
creation and included in the rules hash. Eligibility: any address with a non-zero stake in
that market.

**Bond outcome, decided without an arbiter.** If the round-2 proposal states a *different*
outcome from the challenged one, the challenge was informative → bond refunded to the
challenger. If round 2 confirms the original outcome, the bond is forfeited into the
market pool, benefiting the eventual winners.

**Exactly one round.** The round-2 proposal is final and cannot be challenged. The state
machine therefore provably terminates. This is a deliberate MVP limitation: the goal is to
demonstrate that AI resolution is *contestable*, not to build a court.

**Cancellation safety valve.** Three timeouts, each callable by *anyone* once elapsed:

| From state | Timeout | Result |
| --- | --- | --- |
| `CLOSED`, no proposal | `resolutionDeadline` (tradingEnd + 7 days) | `CANCELLED` |
| `CHALLENGED`, no round-2 proposal | `reviewDeadline` (challengedAt + 7 days) | `CANCELLED` |
| Resolver proposes `INVALID` | immediate | `CANCELLED` |

In `CANCELLED`, `withdrawRefund()` returns each participant `stakeYes + stakeNo`, and the
challenger's bond is returned in full. No outcome, no winners, no losers.

## Consequences

- Funds cannot be stranded by resolver failure; the worst case is a 7-day delay followed
  by a full refund.
- Griefing costs the bond, and an honest challenger who is right pays nothing.
- A wrong resolution that survives its single challenge round is final on-chain. This is
  an accepted MVP risk, stated plainly in `docs/security.md`, and is the main thing a
  post-MVP dispute layer would address.
- The cancellation triggers must be permissionless. If only the admin could cancel, the
  admin would hold users' funds hostage — a privilege §8 forbids.
