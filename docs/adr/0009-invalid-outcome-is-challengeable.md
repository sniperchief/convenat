# ADR-0009: An INVALID outcome runs through the challenge window

**Status:** Accepted — 2026-08-16
**Refines:** [ADR-0004](0004-challenge-rounds-and-liveness.md)

## Context

ADR-0004's cancellation table has three triggers, and the third reads:

| From state | Timeout | Result |
| --- | --- | --- |
| Resolver proposes `INVALID` | immediate | `CANCELLED` |

Implementing it revealed what "immediate" costs. If proposing `INVALID` cancels on sight,
the resolver can unwind **any** market, at any time after the condition deadline, with no
window in which anyone can object. Refunding everyone is not theft, so this is not a way
to steal — but it is a unilateral, unchallengeable power over every market in the
protocol, held by a backend key. A resolver that is compromised, buggy, or simply
unwilling to make a hard call can void every outcome it dislikes, and the challenge
mechanism — the entire point of which is that AI resolution is contestable rather than
blindly trusted — never gets to run.

It also contradicts ADR-0004's own framing one paragraph earlier: *every* proposed
resolution has a challenge window.

## Decision

`INVALID` is proposed like any other outcome and is contestable for the full challenge
window. `finalize()` is what converts a standing `INVALID` into `CANCELLED`, with
`cancellationReason = RESOLVED_INVALID`.

The other two cancellation triggers are unchanged and remain permissionless timeouts.

Two further points settled at the same time, both following from the frozen
`ConditionSpec` v1.0 schema rather than from ADR-0004's prose:

- **The resolution deadline is measured from the condition deadline**, not from the
  trading end. ADR-0004 said "tradingEnd + 7 days"; the schema field is documented as
  "seconds after `deadline`". The schema is right: a resolution cannot reasonably be
  demanded before the instant the condition is measured against.
- **The same `resolutionDeadlineSeconds` value serves as the review window** after a
  challenge. Adding a separate field would mean changing a schema whose golden vectors are
  frozen, which is a breaking protocol change for no benefit.

## Consequences

- The resolver cannot unwind a market without giving participants a window to object.
  A challenge against an unjustified `INVALID` forces a second look, and if the second
  proposal is a real outcome, the challenger's bond comes back.
- Cancellation is slower by exactly one challenge window. Nothing is at risk during it:
  the funds are already sitting in the market and no claim is possible either way.
- A market can now reach `CANCELLED` from `RESOLUTION_PROPOSED` as well as from the two
  timeouts. `cancellationReason` distinguishes all three, and `finalOutcome` is `INVALID`
  for this path and `UNSET` for the timeouts.
- `CANCELLED` is terminal and never advances to `SETTLED`, even after every refund is
  taken. A cancelled market was unwound, not settled, and collapsing the two states would
  erase why the money came back. `remainingClaimableStake` already exposes whether refunds
  are outstanding.
