# Security model

What each party can do, what they provably cannot, and what this protocol accepts as risk.

Implementation: [`packages/contracts`](../packages/contracts/). Every claim below is
asserted by a test in [`test/security.test.ts`](../packages/contracts/test/security.test.ts)
or [`test/cancellation.test.ts`](../packages/contracts/test/cancellation.test.ts) unless
noted otherwise.

---

## 1. The central property

**No party — administrator, resolver, creator or deployer — has any path to a market's
funds.** This is not an omission to be corrected later; it is the property everything else
rests on.

| Party | Can | Cannot |
| --- | --- | --- |
| Admin (`DEFAULT_ADMIN_ROLE`) | Grant/revoke `PROPOSER_ROLE`; pause new market creation and new staking | Withdraw, freeze, redirect or claw back funds; alter rules; alter a resolution; block a claim, refund or cancellation |
| Resolver (`PROPOSER_ROLE`) | Propose an outcome and an evidence hash | Move funds; finalize its own proposal early; change `rulesHash`, the token, the creator or any economic parameter; propose a third time |
| Creator | Stake, challenge, claim like anyone else | Anything privileged. Creating a market confers **no** authority over it |
| Participant | Stake, challenge, claim, withdraw refunds | Touch another participant's stake |
| Anyone | `close`, `finalize`, `cancel` once their timing conditions hold | Bypass a timing condition |

`MarketFactory` has no function whose name or behaviour resembles a withdrawal. A test
enumerates its ABI and asserts this. `ConditionalMarket`'s only outbound-transfer
functions are `claim`, `withdrawRefund` and `claimChallengeBond`, each of which pays
`msg.sender` an amount derived solely from that account's own recorded stake.

---

## 2. Custody

Each market is an EIP-1167 clone with its own balance (ADR-0002). There is no shared pool.
A defect in one market's accounting cannot reach another market's money — proven by a test
that settles one market to zero while a sibling market's balance is untouched.

The backend never holds user funds at any point. Users approve and transfer directly to the
market contract; the resolver wallet's only on-chain capability is `proposeResolution`.

---

## 3. Liveness: the failure mode that matters most

The worst realistic failure is not theft, it is **abandonment** — the backend stops, the
resolver key is lost, the operator disappears. Nothing about access control helps here,
because the problem is the *absence* of an action.

Three permissionless escapes, each callable by anyone once its deadline passes:

| Situation | Trigger | Result |
| --- | --- | --- |
| No proposal ever arrived | `t ≥ conditionDeadline + resolutionWindow` | `CANCELLED`, full refunds |
| Challenged, no second proposal | `t ≥ challengedAt + resolutionWindow` | `CANCELLED`, full refunds |
| A standing `INVALID` proposal | `finalize()` after its challenge window | `CANCELLED`, full refunds |

Plus `close()` and `finalize()`, which are also permissionless, so no market can be stuck
waiting for a specific party to act.

Worst case for a participant is a delay, then a full refund of their own stake. A test
drives exactly this: the resolver never proposes, the administrator pauses the factory and
walks away, and both participants still recover their funds in full.

---

## 4. Pause is not a freeze

`Pausable` guards exactly two entry points (ADR-0007):

- `MarketFactory.createMarket` — no new markets
- `ConditionalMarket.stake` — no new money into existing markets

It guards **none** of `claim`, `withdrawRefund`, `claimChallengeBond`, `challenge`,
`close`, `finalize` or `cancel`. A pause that could stop a withdrawal would be a fund
freeze wearing a safety label.

Tested explicitly: with the factory paused, a market can still be closed, resolved,
challenged, finalized, claimed, cancelled and refunded.

The trade-off this accepts: a live exploit against `claim` **cannot be paused**. The
mitigation is that the pari-mutuel accounting is small enough to reason about
exhaustively, not an emergency switch. That is a deliberate position, not an oversight.

---

## 5. The rules commitment

`rulesHash` is written once in `initialize` and no function writes it afterwards. The test
suite enumerates every state-changing function in the ABI and asserts the list is exactly:

```
cancel, challenge, claim, claimChallengeBond, close,
finalize, initialize, proposeResolution, stake, withdrawRefund
```

None is a setter. `initialize` is guarded by OpenZeppelin's `initializer`, so it cannot run
twice; the implementation contract calls `_disableInitializers()` in its constructor, so it
cannot be initialized at all.

`evidenceHash` is replaceable exactly once, by the single permitted second proposal, and is
fixed from finalization onward.

A clone deployed by someone other than this factory answers to whatever address it recorded
as its factory, and is simply not in this protocol's registry. The factory's
`marketById` / `marketByRulesHash` mappings are authoritative for what counts as a market
here.

---

## 6. Settlement arithmetic

```
pool     = totalYes + totalNo + forfeitedBond
payout   = stake × pool / totalWinningStake        (floor, via Math.mulDiv)
```

Flooring guarantees the payouts sum to at most the pool; a test asserts it directly across
awkward stake ratios. The remainder — strictly less than one base unit per winner — stays
in the contract permanently.

**That dust is deliberately not swept.** Any sweep function is a privileged path to user
funds, which is precisely what §1 forbids. Losing at most `n−1` base units (a millionth of
a dollar each, at six decimals) is cheaper than introducing that surface.

Defined edge cases, each tested:

| Case | Behaviour |
| --- | --- |
| Winning side total is 0 | `refundMode`; everyone withdraws their own stake |
| Only one side funded and it wins | Formula returns exactly that stake — no gain, no loss |
| Staker backed both sides | Paid on the winning side only; the other stake joins the pool |
| Loser claims | `NothingToClaim` |
| Duplicate claim | `hasClaimed` is set before any transfer; second call reverts |
| Cancelled or `INVALID` | `withdrawRefund()` returns `yesStake + noStake` |
| No stake at all | Finalizes straight to `SETTLED` with nothing to pay |

---

## 7. Reentrancy

Every state-changing external function is `nonReentrant`, and every withdrawal follows
checks-effects-interactions: `hasClaimed` / `bondOutstanding` and
`remainingClaimableStake` are written **before** `safeTransfer`.

`stake` is the one place the ordering is inverted — the amount actually received must be
measured before it can be credited. It is `nonReentrant` and moves no funds out, so a
callback can only reach a reverting entry point.

Tested with a token that calls back into the market from inside its own `_update`, at the
exact moment a naive implementation would still have stale accounting. The re-entrant call
is asserted to have actually fired, and to have reverted with
`ReentrancyGuardReentrantCall()` specifically — not with some incidental check further
down. Exactly one payout occurs.

`ReentrancyGuard` is the non-upgradeable version despite cloning. OpenZeppelin 5.x keeps
the flag in an ERC-7201 namespaced slot and tests `== ENTERED`, so a clone's
zero-initialised slot behaves identically to `NOT_ENTERED` without running the
implementation's constructor.

---

## 8. Token assumptions

`SafeERC20` throughout, so tokens with non-standard return values are handled.

**Fee-on-transfer and rebasing tokens are rejected, not tolerated.** `stake` and
`challenge` compare the balance delta against the requested amount and revert with
`UnsupportedToken` on any mismatch. Crediting a stake the market never received would
silently dilute every other participant and leave the last claimant facing an empty
balance. Tested against a 1%-fee token.

---

## 9. Challenge economics and griefing

A challenge requires a bond and a stake in the market, so an uninvolved party cannot grief
for free. Bond disposition needs no arbiter:

| Round-2 outcome | Bond |
| --- | --- |
| Differs from the challenged outcome | Returned — the challenge was informative |
| Confirms the challenged outcome | Forfeited into the pool, paid to the winners |
| Market cancelled | Returned in full |
| Winning side is empty (`refundMode`) | Returned — there is no pool for it to join, and forfeiting would strand it |

That last row exists because forfeiting into a pool nobody can claim would lock the bond in
the contract forever. It is tested.

The process terminates by construction: `MAX_PROPOSAL_ROUNDS = 2`, the second proposal is
uncontestable, and `challenge()` rejects `proposalRound != 1`.

---

## 10. Accepted risks

Stated plainly, because an undocumented risk is worse than a known one.

1. **A wrong resolution that survives its single challenge round is final on-chain.** The
   MVP demonstrates that AI resolution is *contestable*, not that it is *adjudicated*. A
   post-MVP dispute layer is the answer; a second challenge round without an arbiter is
   not, because it never terminates.
2. **The resolver is a single key.** It cannot take funds, but it decides outcomes subject
   only to the challenge window. Custody beyond a `.env` private key (KMS, or a multisig
   proposer) is required before mainnet and is tracked in BUILD_STATE.
3. **Rounding dust is permanently locked**, by choice (§6).
4. **`claim` cannot be paused** during a live exploit, by choice (§4).
5. **No external audit has been performed.** The review behind this document is the
   author's own, plus the adversarial tests it references. An independent audit is a
   prerequisite for mainnet, not for testnet.
6. **The `evmVersion` is pinned to `paris`** because X Layer's supported opcode set has not
   been confirmed by this project. This is conservative rather than correct-by-knowledge,
   and is revisited in Milestone 4 when the chain is actually probed.

---

## 11. Operational

- `RESOLVER_PRIVATE_KEY` and `DEPLOYER_PRIVATE_KEY` are environment-only. They are never
  returned by an API, logged, or committed; `.gitignore` excludes `.env*` while keeping
  `.env.example`.
- The resolver wallet holds `PROPOSER_ROLE` and nothing else. Rotating it is a single
  transaction on the factory and takes effect across every market at once — tested.
- `TestUSD` mints freely to anyone and is deployable **only** on an allowlist of
  development chain ids. An allowlist rather than a mainnet denylist: a denylist fails open
  on every chain nobody thought of, which is the wrong direction for a contract that mints
  free money.
- No contract or token address appears in source. Addresses are deployment outputs and live
  in `packages/contracts/deployments/<network>.json`.
