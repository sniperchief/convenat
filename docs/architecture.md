# Architecture

**Product:** AI-powered conditional contract and event-resolution infrastructure on X Layer.
**Status:** Planning (Milestone 0). No implementation code exists yet.

---

## 1. What this system is

A conditional agreement engine. A user writes a real-world condition in natural
language; an AI compiler turns it into a strict, machine-checkable specification; the
user approves it; a hash of that specification is committed on X Layer before any money
moves; funds are locked in a smart contract; after the event, a resolution engine gathers
evidence from pre-approved sources and proposes an outcome with a cryptographic evidence
hash; a challenge window makes that proposal contestable; the contract then settles.

A binary YES/NO pari-mutuel market is the **first settlement adapter** built on this
primitive, not the product itself.

## 2. Trust model (drives every other decision)

| Actor | Can do | Cannot do |
| --- | --- | --- |
| User wallet | Create markets, stake, challenge, claim | Nothing on behalf of others |
| Resolver wallet (backend) | Propose an outcome + evidence hash | Move, hold, or redirect funds |
| Admin / owner | Pause *new* market creation and *new* staking | Withdraw funds, claw back, alter rules, block claims |
| Backend / DB | Store specs, evidence, indexed display data | Be authoritative for balances or settlement |
| Frontend | Build transactions the user signs | Hold keys, make authorization decisions |

The chain is the only source of truth for financial state. The database is a cache and a
document store. If the two disagree, the chain wins and the indexer is wrong.

## 3. Layer map

```
┌───────────────────────────────────────────────────────────────────────┐
│ apps/web  — React + Vite + TS, wagmi/viem                             │
│  compile UI → spec review/approval → create tx → stake tx →           │
│  resolution + evidence view → challenge tx → claim tx                 │
└───────────────┬───────────────────────────────┬───────────────────────┘
                │ REST (read + AI)              │ signed txs (user's key)
┌───────────────▼───────────────────────────┐   │
│ apps/backend — Node + TS + Fastify        │   │
│  ┌─────────────────────────────────────┐  │   │
│  │ AI compiler   (NL → strict spec)    │  │   │
│  │ Resolution engine (evidence → prop.)│  │   │
│  │ Evidence store + hashing            │  │   │
│  │ Indexer worker (logs → DB)          │  │   │
│  │ Resolver signer (propose only)      │──┼───┤ resolver txs
│  └─────────────────────────────────────┘  │   │
└───────────────┬───────────────────────────┘   │
                │ SQL                            │
┌───────────────▼───────────────┐   ┌────────────▼──────────────────────┐
│ PostgreSQL / Supabase         │   │ X Layer                           │
│ markets, resolutions,         │   │ MarketFactory                     │
│ evidence, positions,          │   │ ConditionalMarket (clone per mkt) │
│ challenges, indexer_state     │   │ settlement ERC-20                 │
└───────────────────────────────┘   └───────────────────────────────────┘
                ▲
                │ imported by all three
┌───────────────┴───────────────────────────────────────────────────────┐
│ packages/shared — spec schema (Zod), canonicalization, rulesHash,     │
│ evidenceHash, chain config, typed API contracts, ABIs                 │
└───────────────────────────────────────────────────────────────────────┘
```

`packages/shared` is deliberately the centre of gravity: hashing must be **identical** in
the backend that computes it, the frontend that verifies it, and the contract tests that
assert it. One implementation, one test suite, three consumers.

## 4. Repository layout (planned)

```
/
├─ package.json                  npm workspaces root
├─ .env.example
├─ BUILD_STATE.md
├─ docs/
│  ├─ architecture.md            this file
│  ├─ security.md
│  ├─ deployment.md
│  ├─ ai-resolution.md
│  ├─ market-lifecycle.md
│  └─ adr/                       0001…0007
├─ packages/
│  ├─ shared/                    schema, canonicalization, hashing, chains, API types
│  └─ contracts/                 Hardhat, Solidity, tests, deploy scripts
│     └─ deployments/            xlayer-testnet.json, xlayer-mainnet.json
└─ apps/
   ├─ backend/                   Fastify API, AI services, resolution engine, indexer
   └─ web/                       React + Vite frontend
```

## 5. Specification and the rules hash

The AI compiler emits a `ConditionSpec` v1.0 validated by a Zod schema. Validation is a
gate, not a formality: a spec that lacks a resolvable deadline, a success condition, a
failure condition, or at least one approved source is returned to the user as
`INCOMPLETE` with the missing fields named. The compiler never fills gaps by guessing.

```
ConditionSpec (v1.0)
  version, nonce, creator, question, conditionType,
  successCondition, failureCondition,
  deadline (RFC 3339 UTC instant), timezone, resolutionMethod,
  approvedSources[{ name, url, retrievalKind, dataPath }],   // ordered: index is precedence
  evidenceRequirements[], ambiguities[], edgeCases[], risk,
  settlement{ kind, token, tradingEndsAt, challengeWindowSeconds,
              challengeBondBaseUnits, resolutionDeadlineSeconds }
```

`approvedSources` is **ordered** — element 0 is the primary source and later entries are
fallbacks in priority order. Precedence is carried by position alone; an additional
`role` field would be a second, conflictable representation of the same fact (ADR-0008).

`settlement` is inside the hash because the token, challenge window and bond a user agreed
to must not be alterable when the market is created.

Canonicalization uses **RFC 8785 JSON Canonicalization Scheme**: keys sorted by UTF-16
code unit, no insignificant whitespace, defined number and string escaping. Then:

```
rulesHash = keccak256( utf8Bytes( JCS(spec) ) )
```

The full spec stays off-chain; only the 32-byte hash goes on-chain. Anyone can re-derive
the hash from the published spec and compare it with `market.rulesHash()`. Determinism is
enforced by a golden-vector test suite (fixed spec fixtures → fixed hex digests) that must
never change once a spec version ships. Changing canonical output requires a new
`version` field value, never an edit to v1.0 behaviour.

The identical construction produces `evidenceHash` over the canonical evidence package.

## 6. Contracts

Two contracts, no more.

**MarketFactory** — creates markets, holds the role registry, is the pause switch for
creation. Deploys each market as an EIP-1167 minimal proxy over a single
`ConditionalMarket` implementation. Assigns a sequential `marketId`, emits
`MarketCreated(marketId, market, creator, rulesHash, token, tradingEnd, resolutionEarliest)`.

**ConditionalMarket** — one clone per condition. Custodies that market's stablecoin and
nothing else. Holds: `rulesHash` (immutable after init), timing parameters, per-side
totals, per-address stakes, resolution record, challenge record, claim bitmap.

Fund isolation is the point of cloning: a defect in one market cannot reach another
market's balance. See ADR-0002.

### State machine

```
        stake()                     t ≥ tradingEndsAt
 OPEN ─────────────▶ OPEN ──────────────────────────▶ CLOSED
                                       close()          │
                                                        │ proposeResolution()  [PROPOSER]
                                                        │ (round 1, t ≥ deadline)
                                                        ▼
                                              RESOLUTION_PROPOSED
                                       ┌────────────────┴────────────────┐
                       challenge()     │                                 │ finalize()
                      [staker + bond]  ▼                                 ▼ t ≥ challengeEnd
                                  CHALLENGED                         FINALIZED
                                       │  proposeResolution()            │ claim() /
                                       │  (round 2 — final, and          │ withdrawRefund()
                                       │   itself uncontestable)         ▼
                                       └──────────▶ RESOLUTION_PROPOSED  SETTLED
                                                              (all winning stake withdrawn)

 CANCELLED  ◀─ cancel()  from CLOSED, t ≥ resolutionDeadline   (no proposal ever arrived)
            ◀─ cancel()  from CHALLENGED, t ≥ reviewDeadline   (no second proposal)
            ◀─ finalize() of a standing INVALID proposal
                  │  withdrawRefund(), claimChallengeBond()
                  ▼  terminal — never becomes SETTLED
```

Every transition has an explicit guard and reverts otherwise. There is no function that
sets state arbitrarily.

`CANCELLED` is the universal safety valve: it exists so funds can never be stranded by an
absent or broken resolver (ADR-0004). It is **terminal** — a cancelled market is unwound,
not settled, and collapsing the two would erase why the money came back.
`remainingClaimableStake` already reports whether refunds are outstanding.

There is no separate `CHALLENGE_PERIOD` state. The challenge period is exactly
`RESOLUTION_PROPOSED` before `challengeEndsAt()`; giving it its own state would require a
transaction to enter it at a timestamp, and nothing can transition a contract without one.

`close`, `finalize` and `cancel` are all **permissionless**. Liveness never depends on the
backend: an absent resolver can delay settlement but cannot strand funds.

### Outcomes

`YES`, `NO`, `INVALID`. `INVALID` routes to the refund path. `NEEDS_REVIEW` /
`RESOLUTION_FAILED` are **off-chain** resolver states — they are never proposed on-chain,
because an unresolved condition must leave the contract untouched, not settle it.

### Settlement (binary pari-mutuel)

```
pool        = totalYes + totalNo + forfeitedBonds
payout(u)   = stake(u, winningSide) * pool / total(winningSide)     // floor
```

Explicitly defined edges:

| Case | Behaviour |
| --- | --- |
| Winning side total = 0 | Market falls to refund mode; every staker withdraws their own stake |
| Only one side funded, it wins | Formula returns exactly that staker's stake — no gain, no loss |
| Only one side funded, it loses | Losers get nothing; winners' side is empty → refund mode applies first |
| Loser claims | Reverts with `NothingToClaim` |
| Duplicate claim | `claimed[user]` set before transfer; second call reverts |
| Cancelled / INVALID | `withdrawRefund()` returns `stakeYes + stakeNo` |
| Rounding dust | Floor division; ≤ 1 wei per winner remains in the contract, permanently. Accepted and documented rather than swept, because any sweep function is an extraction surface |

No protocol fee in the MVP — a fee implies a treasury address and a privileged withdrawal
path, which is exactly what §8 of the spec forbids. Fees can be added later as a value
fixed at market creation and included in the rules hash.

### Access control

`PROPOSER_ROLE` lives on the factory; markets read it. Rotating the resolver wallet is one
transaction and applies to every market. `DEFAULT_ADMIN_ROLE` can grant/revoke
`PROPOSER_ROLE` and pause creation and staking. It **cannot** pause `claim()`,
`withdrawRefund()`, or `challenge()` — pausing a claim is functionally a freeze of user
funds, so those paths are never guarded by `whenNotPaused` (ADR-0007).

### Challenge

Eligibility: any address with a non-zero stake in that market. A challenge posts a bond
in the settlement token and stores a `reasonHash` (keccak256 of the off-chain challenge
document). If round 2 proposes a **different** outcome, the bond is refunded to the
challenger; if it confirms the original outcome, the bond is forfeited into the pool.
This is deterministic and needs no arbiter. Exactly one challenge round is permitted, so
the state machine provably terminates. Default window: 2 hours.

## 7. Backend

Fastify + TypeScript (strict). Chosen over bare Express for first-class schema validation
and typed routes; no other framework is introduced.

Services, each a module with a single responsibility:

- `ai/compiler` — NL → `ConditionSpec`, structured-output call, Zod gate, no repair-by-guessing.
- `ai/resolver` — evidence interpretation only; never asked "did this happen?" in the abstract.
- `evidence/` — retrieval from approved sources, normalization, per-source content hashing.
- `resolution/` — the pipeline: load immutable spec → fetch approved sources →
  normalize → extract claims → **deterministic validators first** → AI only for the
  residue that genuinely needs interpretation → structured proposal → evidence package →
  `evidenceHash` → on-chain `proposeResolution`.
- `chain/` — viem clients, resolver signer, contract reads/writes. The **only** place a
  private key is loaded.
- `indexer/` — polls `getLogs` on a fixed block range with a confirmation lag, advances a
  persisted cursor, is idempotent per `(txHash, logIndex)`. Polling rather than websockets
  because X Layer websocket availability is unconfirmed.
- `api/` — the seven required routes, all input-validated.

Deterministic validation always runs first and can, on its own, decide numeric-threshold
and deadline conditions. AI confidence is recorded but never authorizes anything: it is a
*floor* for proposing at all, never a *reason* to settle. Below threshold, or on source
failure, the engine returns `NEEDS_REVIEW` and submits nothing on-chain.

Market creation is **not** brokered by the backend. The user's own wallet calls
`MarketFactory.createMarket(rulesHash, …)`. The backend stored the approved spec keyed by
its `rulesHash` at approval time; the indexer sees `MarketCreated` and joins on that hash.
Consequence: no backend signature is required to open a market, and the backend cannot
open one on a user's behalf (ADR-0006).

## 8. Database

PostgreSQL (Supabase-compatible). Drizzle for typed schema + generated SQL migrations.

`markets`, `resolutions`, `evidence`, `positions`, `challenges`, `indexer_state`.
`positions` is a projection of `StakePlaced` / `WinningsClaimed` logs and is display-only;
every balance shown next to money the user can act on is read from the chain, not from
this table.

## 9. Frontend

React + Vite + TypeScript, wagmi + viem, TanStack Query, React Router. Injected connector
only (OKX Wallet, MetaMask) for the MVP — WalletConnect would add an external project-id
dependency for no MVP benefit.

Pages: `/`, `/create`, `/create/review`, `/markets`, `/markets/:id`, `/portfolio`.

The market detail page recomputes `rulesHash` from the displayed spec in the browser using
`packages/shared` and shows a verified/mismatch badge against the on-chain value. That
check is the user's guarantee that the rules were not edited after commitment.

## 10. Configuration

All chain configuration lives in `packages/shared/src/chains.ts`, keyed by chain id, with
no network values inlined anywhere else. Token addresses come from the deployment manifest
per network, never from source constants.

| | Testnet | Mainnet |
| --- | --- | --- |
| Chain ID | 1952 | 196 |
| RPC | `https://testrpc.xlayer.tech/terigon` | `https://rpc.xlayer.tech` |
| Gas token | OKB | OKB |

Both values are taken from the project specification and **must be confirmed by a live
`eth_chainId` call before any deploy** — see BUILD_STATE.md, Open Dependencies.

## 11. Non-goals

No DAO, token, NFTs, bridging, leverage, order books, AMMs, liquidity mining, social
features, mobile app, reputation system, or decentralized oracle network. No autonomous
AI wallet. The AI proposes; it never holds or moves funds.
