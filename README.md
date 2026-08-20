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

**Milestones 1–3 of 7 complete.** The shared protocol core (specification schema,
canonicalisation, both protocol hashes), the on-chain financial layer (factory, market,
full state machine, settlement, challenge, cancellation), and the backend with its AI
condition compiler are implemented and tested — **480 tests, all passing locally**. Nothing
is deployed to a public network yet.

Current state, known issues and the milestone plan: [BUILD_STATE.md](BUILD_STATE.md).

## Repository

```
packages/shared     specification schema, canonicalisation, rulesHash / evidenceHash,
                    network config, typed API contracts        [Milestone 1 - done]
packages/contracts  MarketFactory, ConditionalMarket, TestUSD   [Milestone 2 - done]
apps/backend        Fastify API + AI condition compiler         [Milestone 3 - done]
                    resolution engine, indexer                  [Milestone 4-5]
apps/web            React + Vite frontend                       [Milestone 6]
docs/               architecture, protocol, security, ADRs
```

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

Milestone 1 needs no API keys, no database and no network access. Copy
[`.env.example`](.env.example) to `.env` when you reach the milestone that needs it; every
variable is grouped by the milestone that first requires it.

## Documentation

| | |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Trust model, layer map, contract shape, state machine, settlement |
| [docs/ai-compiler.md](docs/ai-compiler.md) | How a sentence becomes an enforceable condition — and how it correctly fails to |
| [docs/security.md](docs/security.md) | What each party can and provably cannot do, and the risks this MVP accepts |
| [docs/market-lifecycle.md](docs/market-lifecycle.md) | Every state, transition, guard and event |
| [docs/canonical-specification.md](docs/canonical-specification.md) | The hashing protocol: ConditionSpec, EvidencePackage, canonicalisation rules, cross-environment reproducibility |
| [docs/adr/](docs/adr/) | Architecture decision records |
| [BUILD_STATE.md](BUILD_STATE.md) | Milestone status, open dependencies, accepted risks |

## Networks

| | Chain ID | RPC | Gas |
| --- | --- | --- | --- |
| X Layer Testnet | 1952 | `https://testrpc.xlayer.tech/terigon` | OKB |
| X Layer Mainnet | 196 | `https://rpc.xlayer.tech` | OKB |

Both are transcribed from the project specification and **have not yet been confirmed
against a live node**. `packages/shared/src/chains/xlayer.ts` marks them `unverified`;
Milestone 4 confirms them with a real `eth_chainId` call before anything is deployed.

No contract or token address appears anywhere in source. Addresses are deployment outputs
and live in `packages/contracts/deployments/<network>.json`.
