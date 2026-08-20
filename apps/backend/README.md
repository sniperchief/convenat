# @covenant/backend

Fastify API, the AI condition compiler, and the resolution engine.

The backend **proposes**. It compiles a natural-language condition into a reviewable
specification and computes its `rulesHash`; it retrieves approved evidence, runs the
deterministic validators over it, and produces a resolution proposal with an
`evidenceHash`. It does not create markets, move funds, or sign transactions.

Neither AI component can act. The compiler produces a draft a user must approve with their
own wallet; the resolver produces a document that a person or a later, non-AI path decides
what to do with. Neither has a chain client, a signer, or a key.

```
POST /api/markets/compile   natural language -> ConditionSpec + rulesHash, or questions
POST /api/markets           register an approved specification (PENDING_ONCHAIN)
GET  /api/markets           list
GET  /api/markets/:id       detail, with rulesHash re-verified server-side
GET  /api/markets/:id/evidence
POST /api/markets/:id/resolve      501 until the resolution engine exists
POST /api/markets/:id/challenge    501 until there is a proposal to contest
GET  /api/positions                501 until the indexer can see them
GET  /health
```

`:id` accepts a `rulesHash` or a decimal on-chain market id. Until markets are on-chain,
only the hash resolves.

`POST /resolve` is still a 501: M5.4 built the engine that produces a proposal, and
submitting one on-chain is a later milestone.

Read [docs/ai-compiler.md](../../docs/ai-compiler.md) before changing anything in
`src/compiler`, and [docs/ai-resolution.md](../../docs/ai-resolution.md) before changing
anything in `src/evidence`, `src/validation` or `src/resolution`. Part IV and
[ADR-0016](../../docs/adr/0016-ai-proposes-code-decides.md) explain why the model in
`src/resolution` can withhold a resolution but never flip one; a change that lets it flip
one is a protocol change, not a refactor.

## Commands

```bash
npm run typecheck --workspace @covenant/backend
npm test          --workspace @covenant/backend    # no network, no database, no API key
npm run build     --workspace @covenant/backend
npm run db:generate --workspace @covenant/backend  # SQL migrations, offline
```

## Two boundaries everything else depends on

**The LLM boundary.** `LLMProvider` is the only way to reach a model. No Anthropic type,
error class, or field name is visible above it — the SDK is imported in exactly one file,
and a sweep asserts it. `FakeLLMProvider` is therefore a complete substitute, which is why
the whole suite runs offline and why the malformed, refusing and hallucinating cases can be
produced on demand rather than waited for.

**The storage boundary.** Route handlers depend on repository interfaces, never on Drizzle.
`createInMemoryRepositories()` backs the tests; `createFailingRepositories()` makes the
"database is down" branch testable without an outage.

Both are injected through `buildServer({ config, repositories, compiler })`. Nothing reads
`process.env` at module scope, and configuration is constructed by `loadConfig(env)` — so a
test builds a config without a `.env` file.

## What the compiler will not do

- Invent a deadline, a source, or acceptance criteria — it asks instead, and `INCOMPLETE`
  is a 200, not an error.
- Choose economic terms. The token, challenge window, bond and resolution window come from
  operator policy; the nonce and creator come from the request. A model that could set the
  bond could put invented economics inside a hash a user is asked to approve.
- Compute a hash. `@covenant/shared` does that, from a validated document.
- Reorder `approvedSources`. Position is precedence (ADR-0008), so sorting it would change
  which source decides the outcome.

## Honest 501s

`/resolve`, `/challenge` and `/positions` return 501 with an explanation. They could return
an empty list or a plausible-looking proposal; both would be lies. An empty portfolio says
"you hold nothing" when the truth is "the indexer cannot see it yet", and a fabricated
resolution is precisely the failure this product exists to prevent.

Input is still validated before the 501, so the contract is enforced from day one.

## Database

Drizzle schema in `src/db/schema.ts`; migrations generated offline into `drizzle/`.

Eight tables: wallets, compiler sessions and turns, compilations, markets, resolutions,
evidence, indexer state. **No table records a balance.** Positions and stakes are on-chain
facts that arrive via the indexer in Milestone 4; a table for them now would be an empty
invitation to treat the database as the authority for money.

Unit tests do not touch PostgreSQL. The Drizzle implementations are consequently not
runtime-tested yet — that is stated in BUILD_STATE rather than papered over with a mock
that would only prove Drizzle's API to itself.
