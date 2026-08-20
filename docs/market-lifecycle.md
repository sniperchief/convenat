# Market lifecycle

Every state, every transition, who can trigger it, and what it does to the money.

Implementation: [`ConditionalMarket.sol`](../packages/contracts/contracts/ConditionalMarket.sol).
Enum ordinals are protocol surface — off-chain indexing decodes them by number, so
reordering `State`, `Outcome` or `CancellationReason` is a breaking change.

---

## States

| # | State | Meaning | Money |
| --- | --- | --- | --- |
| 0 | `OPEN` | Accepting stakes | Flowing in |
| 1 | `CLOSED` | Trading over, awaiting a proposal | Locked |
| 2 | `RESOLUTION_PROPOSED` | A proposal stands; the challenge window is running | Locked |
| 3 | `CHALLENGED` | Contested; awaiting the one permitted second proposal | Locked |
| 4 | `FINALIZED` | Outcome fixed | Claimable |
| 5 | `SETTLED` | Every winning stake withdrawn | Empty (bar dust) |
| 6 | `CANCELLED` | Unwound. Terminal | Refundable |

**No `CHALLENGE_PERIOD` state.** It is exactly `RESOLUTION_PROPOSED` before
`challengeEndsAt()`. A separate state would need a transaction to enter it at a timestamp,
and nothing can transition a contract without one — deriving it from the clock is the
honest encoding.

**`CANCELLED` never becomes `SETTLED`.** A cancelled market was unwound, not settled;
collapsing them would erase why the money came back. Use `remainingClaimableStake` to see
whether refunds are still outstanding.

---

## Time

Four instants, all fixed at creation and all committed inside `rulesHash`:

```
        tradingEndsAt        conditionDeadline              resolutionDeadline
  ──────────┼────────────────────────┼──────────────────────────────┼────────▶
   staking  │   no staking, no       │  resolver may propose        │ anyone may
   allowed  │   proposal yet         │                              │ cancel

                       proposedAt ──── challengeWindow ────▶ challengeEndsAt
                                       (contestable)               (finalizable)

                       challengedAt ── resolutionWindow ───▶ reviewDeadline
                                       (round 2 due)              (anyone may cancel)
```

`resolutionWindow` serves as both the post-deadline proposal window and the post-challenge
review window. One value rather than two, because adding a field to `ConditionSpec` v1.0
would break its frozen golden vectors for no benefit (ADR-0009).

The resolution deadline is measured from `conditionDeadline`, not from `tradingEndsAt`: a
resolution cannot reasonably be demanded before the instant the condition is measured
against.

---

## Transitions

| From | To | Function | Who | Guard |
| --- | --- | --- | --- | --- |
| — | `OPEN` | `initialize` | factory, once | Valid parameters; never runs twice |
| `OPEN` | `OPEN` | `stake` | anyone | `t < tradingEndsAt`, not paused, amount > 0, side ∈ {YES, NO} |
| `OPEN` | `CLOSED` | `close` | **anyone** | `t ≥ tradingEndsAt` |
| `CLOSED` | `RESOLUTION_PROPOSED` | `proposeResolution` | `PROPOSER_ROLE` | `t ≥ conditionDeadline`, outcome ≠ UNSET, evidence hash ≠ 0, round < 2 |
| `RESOLUTION_PROPOSED` | `CHALLENGED` | `challenge` | any staker | `t < challengeEndsAt`, round == 1, bond posted, reason hash ≠ 0 |
| `CHALLENGED` | `RESOLUTION_PROPOSED` | `proposeResolution` | `PROPOSER_ROLE` | Round becomes 2 — final and uncontestable |
| `RESOLUTION_PROPOSED` | `FINALIZED` | `finalize` | **anyone** | `t ≥ challengeEndsAt`, outcome ≠ INVALID |
| `RESOLUTION_PROPOSED` | `CANCELLED` | `finalize` | **anyone** | `t ≥ challengeEndsAt`, outcome == INVALID |
| `CLOSED` | `CANCELLED` | `cancel` | **anyone** | `t ≥ resolutionDeadline` |
| `CHALLENGED` | `CANCELLED` | `cancel` | **anyone** | `t ≥ reviewDeadline` |
| `FINALIZED` | `SETTLED` | `claim` / `withdrawRefund` | winners | Automatic once `remainingClaimableStake == 0` and no bond outstanding |

`close`, `finalize` and `cancel` are permissionless so liveness never depends on the
backend. `proposeResolution` and `cancel` also close an open-but-overdue market implicitly,
applying the identical guard rather than bypassing it, so nobody is deadlocked behind
someone else's transaction.

Everything not in this table reverts with `InvalidState(current)`.

---

## Outcomes

| # | Outcome | Effect |
| --- | --- | --- |
| 0 | `UNSET` | No outcome recorded. Cannot be proposed |
| 1 | `YES` | YES stakers split the pool |
| 2 | `NO` | NO stakers split the pool |
| 3 | `INVALID` | Undecidable on approved evidence → `CANCELLED`, full refunds |

`INVALID` runs through the full challenge window like any other outcome. Cancelling on
sight would hand the resolver an unchallengeable unilateral unwind of any market
(ADR-0009).

There is no `UNRESOLVED` outcome. `NEEDS_REVIEW` and `RESOLUTION_FAILED` are off-chain
resolver *statuses* — the engine expresses "I will not guess" by proposing nothing at all,
which leaves the contract untouched and lets the cancellation timeout do its job.

---

## Money

```
pool   = totalYes + totalNo + forfeitedBond
payout = stake × pool / totalWinningStake        (floor)
```

Three withdrawal paths, each paying `msg.sender` from their own recorded position:

- `claim()` — a winner's proportional share. `FINALIZED`/`SETTLED`, not in refund mode.
- `withdrawRefund()` — your own stake back. Refund mode: `CANCELLED`, or `FINALIZED` where
  the winning side attracted no stake.
- `claimChallengeBond()` — the challenger's bond, when it was not forfeited.

Rounding, zero-winning-pool, one-sided markets, duplicate claims and bond disposition are
specified in [docs/security.md](security.md) §6 and §9.

---

## Events

Enough for an indexer to reconstruct the lifecycle without reading storage.

| Event | Emitted by |
| --- | --- |
| `MarketCreated(marketId, market, creator, rulesHash, token, tradingEndsAt, conditionDeadline, challengeWindow, resolutionWindow, challengeBond, createdAt)` | `MarketFactory` |
| `StakePlaced(marketId, staker, side, amount, totalYes, totalNo)` | market |
| `MarketClosed(marketId, closedAt, totalYes, totalNo)` | market |
| `ResolutionProposed(marketId, proposer, outcome, evidenceHash, round, proposedAt, challengeEndsAt)` | market |
| `ResolutionChallenged(marketId, challenger, challengedOutcome, reasonHash, bond, challengedAt, reviewDeadline)` | market |
| `MarketFinalized(marketId, outcome, evidenceHash, pool, refundMode, finalizedAt)` | market |
| `MarketCancelled(marketId, reason, refundablePool, cancelledAt)` | market |
| `WinningsClaimed(marketId, claimant, outcome, stake, payout)` | market |
| `RefundWithdrawn(marketId, claimant, amount)` | market |
| `ChallengeBondReturned(marketId, challenger, amount)` | market |
| `MarketSettled(marketId, settledAt)` | market |

Running totals ride along on `StakePlaced` and `MarketClosed` so an indexer can track pool
size without an extra call per event. Only hashes and numbers are emitted — never a
specification or evidence document.

`MarketCreated` carries `rulesHash`, which is how the indexer joins an on-chain market to
the off-chain specification approved before it (ADR-0006). The factory enforces uniqueness
on that hash, so the join is total rather than ambiguous.
