# Covenant

AI-powered conditional contract and event-resolution infrastructure on X Layer.

Smart contracts execute deterministic conditions. Real-world conditions are written in
ambiguous human language and need evidence and interpretation. Covenant bridges that gap:
you write a condition in plain English, an AI compiles it into a precise specification you
review and approve, a hash of those rules is committed on-chain **before** any money is at
risk, and after the event a resolution engine gathers evidence from pre-approved sources
and proposes an outcome — with an evidence hash, a challenge window, and settlement by the
contract rather than by the AI.

```
natural-language condition
   -> AI compilation -> structured rules -> user approval
   -> rulesHash committed on X Layer -> funds locked
   -> real-world event
   -> evidence gathered -> deterministic validation -> AI interpretation
   -> resolution proposed + evidenceHash committed
   -> challenge window -> finalisation -> settlement
```

A binary prediction market is the first settlement adapter built on this primitive. It is
not the point of the product.

## What the AI can and cannot do

The model is a **resolution intelligence layer**. It does not settle markets, and the
asymmetry that makes that true is structural rather than a matter of prompting:

- The **deterministic verdict is the authority.** Code compares what the approved sources
  said against the committed criteria and reaches `SATISFIED | REFUTED | NEEDS_REVIEW`
  before the model is called at all.
- The model is asked to **concur** with the outcome that verdict maps to. A disagreement
  produces `NEEDS_REVIEW`, never the opposite outcome. A compromised or mistaken model
  costs liveness; it cannot cost correctness.
- Its vocabulary contains **no `INVALID`**. A refund determination can only come from an
  edge case the user pre-approved inside the hashed rules.
- It never sees, and cannot name, a stake, a payout, a bond, a token, a deadline, a
  resolver identity or a `rulesHash`. Those are system-controlled, and the output schema
  rejects them rather than stripping them.


| The AI | |
| --- | --- |
| interprets real-world information | never holds or moves funds |
| proposes a resolution | never authorises settlement by confidence |
| compiles rules for a human to approve | never changes rules after funds are committed |
| says "I cannot resolve this" | never invents an answer |

The smart contract is the source of truth for every financial fact. The database is a
cache and a document store. The resolver wallet can propose an outcome and nothing else;
there is no administrative function that can withdraw, freeze, or redirect user funds.

## Status

**The full path runs end to end.** A condition is compiled and hashed, the creator's wallet
commits the hash on X Layer Testnet, participants stake, the resolver reads the approved
sources, code decides what code can decide, the model concurs or withholds, an
`EvidencePackage` is hashed by `@covenant/shared` and proposed on-chain, the challenge
window runs, and the contract settles.

Three contracts are deployed to **X Layer Testnet (chain 1952)** and their addresses live
in `packages/contracts/deployments/xlayer-testnet.json` and nowhere else. Nothing is
deployed to mainnet, and three independent guards refuse it.

Current state, test counts, live results, known issues and accepted risks:
[BUILD_STATE.md](BUILD_STATE.md).

## Repository

```
packages/shared     specification schema, canonicalisation, rulesHash / evidenceHash,
                    evidence package v2.0, network config, typed API contracts
packages/contracts  MarketFactory, ConditionalMarket, TestUSD
apps/backend        Fastify API, AI condition compiler, evidence retrieval,
                    deterministic validation, AI resolution engine, on-chain
                    proposal + finalization, indexer, reconciler
apps/web            the demo surface: market list, create, detail, evidence panel
docs/               architecture, protocol, security, ADRs
```

`apps/web` is deliberately plain HTML, CSS and ES modules with **no bundler and no
framework** — the milestone that built it was explicit that hours were not to go into the
frontend, and the page exists to make the resolution chain legible rather than to be an
application. The trade is stated rather than implied.

`packages/shared` holds the only implementation of `rulesHash` and `evidenceHash`. The
backend that computes a hash, the frontend that verifies it, and the contract tests that
assert it all run the same code — otherwise "verify this hash" would be theatre.

## Getting started

Requires Node.js 20.11 or later.

```bash
npm install
npm run typecheck
npm test
npm run build
```

**The whole test suite needs no network, no PostgreSQL and no API key.** That is a
property worth protecting rather than a convenience: the layer whose job is to call a
model has to be fully testable without one, or the cases that matter — malformed output, a
hallucinated source, a successful prompt injection — cannot be written at all. The model,
the chain and every evidence source sit behind ports with scripted implementations.

To run it against real infrastructure, copy [`.env.example`](.env.example) to `.env` and
fill it in; every variable is documented where it is declared.

```bash
# terminal 1 — the API (loads the manifest, verifies the chain id, then binds)
node --env-file=.env apps/backend/dist/index.js

# terminal 2 — the indexer
node --env-file=.env apps/backend/dist/indexer/main.js

# terminal 3 — the demo surface
npm run start:web            # http://127.0.0.1:5173
```

Reconcile the database against the chain at any time:

```bash
node --env-file=.env apps/backend/dist/reconcile/main.js
```

## Documentation

| | |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Trust model, layer map, contract shape, state machine, settlement |
| [docs/ai-compiler.md](docs/ai-compiler.md) | How a sentence becomes an enforceable condition — and how it correctly fails to |
| [docs/security.md](docs/security.md) | What each party can and provably cannot do, and the risks this MVP accepts |
| [docs/market-lifecycle.md](docs/market-lifecycle.md) | Every state, transition, guard and event |
| [docs/canonical-specification.md](docs/canonical-specification.md) | The hashing protocol: ConditionSpec, EvidencePackage, canonicalisation rules, cross-environment reproducibility |
| [docs/ai-resolution.md](docs/ai-resolution.md) | The evidence model, retrieval, deterministic validation, and where the model sits |
| [docs/adr/](docs/adr/) | Architecture decision records |
| [BUILD_STATE.md](BUILD_STATE.md) | Milestone status, open dependencies, accepted risks |

## The demo

One deterministic market, driven step by step against the live testnet. Each step derives
what to do from **on-chain state**, so any of them is safe to re-run.

```bash
cd apps/backend
node --env-file=../../.env dist/tools/prepare-demo.js   # spec + rulesHash + criteria
node --env-file=../../.env dist/tools/demo.js register  # store the rules (SIWE sign-in)
node --env-file=../../.env dist/tools/demo.js create    # creator's wallet commits the hash
node --env-file=../../.env dist/tools/demo.js stake     # two wallets stake YES and NO
node --env-file=../../.env dist/tools/demo.js status    # where it is, on-chain and off
node --env-file=../../.env dist/tools/demo.js resolve   # evidence → checks → model → propose
node --env-file=../../.env dist/tools/demo.js finalize  # after the challenge window
node --env-file=../../.env dist/tools/demo.js claim     # the contract pays the winner
```

`demo.js dry-run` runs the whole pipeline and submits nothing, and `demo.js challenge`
exercises the contested path. The web page shows the same market with the reasoning
rendered as a chain: rules → evidence → checks → reasoning → outcome → on-chain.

## Networks

| | Chain ID | RPC | Gas |
| --- | --- | --- | --- |
| X Layer Testnet | 1952 | `https://testrpc.xlayer.tech/terigon` | OKB |
| X Layer Mainnet | 196 | `https://rpc.xlayer.tech` | OKB |

**Testnet is confirmed against a live node**: `eth_chainId` returned `0x7a0` (1952) and the
node identified itself as `reth/…/xlayer`, i.e. an OP Stack rollup.
`packages/shared/src/chains/xlayer.ts` records that confirmation with its date, and its
`verification` flags are the gate the deploy script checks.

**Mainnet remains `unverified` and is refused outright** — `loadConfig` rejects it, the
deploy script rejects it, and the manifest loader rejects a mainnet manifest. Testnet end
to end and an external audit come first.

Two chain facts found by things breaking, and in no documentation this project could find:
`eth_getLogs` is capped at **100 blocks** on X Layer testnet, and `proposeResolution` has
**no upper deadline** — the resolution deadline only enables permissionless `cancel()`.

No contract or token address appears anywhere in source. Addresses are deployment outputs
and live in `packages/contracts/deployments/<network>.json`.
