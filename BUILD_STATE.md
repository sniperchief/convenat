# BUILD_STATE

**Last updated:** 2026-08-21
**Current milestone:** M5.5–M5.7 — evidence pipeline, resolution engine, on-chain
resolution + API + demo surface (**complete**)
**Next milestone:** M6 — hardening; `ConditionSpec` v1.1 to carry acceptance criteria
inside `rulesHash` (ADR-0017)

---

## Repository state

npm-workspace monorepo. `packages/shared`, `packages/contracts` and `apps/backend` are
implemented, typechecked, built and tested. `apps/web` is still a workspace placeholder
with a `package.json` and a README only.

**The protocol is live on X Layer Testnet (chain 1952).** Three contracts are deployed,
two markets have been driven through a complete lifecycle by two independent wallets, and
every token movement reconciles to the base unit. The backend connects to a real
PostgreSQL (Neon), a real RPC endpoint, and a real Anthropic model.

Deployed addresses live in `packages/contracts/deployments/xlayer-testnet.json` and
nowhere else. Nothing is deployed to mainnet, and three independent guards refuse it.

---

## Completed work

### M0 — Planning

Trust model, layer map, contract shape, state machine, settlement rules with explicit edge
cases, backend service decomposition and configuration strategy specified in
[docs/architecture.md](docs/architecture.md). Seven ADRs recorded.

### M1 — Shared core + workspace foundation

**Workspace.** npm workspaces over `packages/*` and `apps/*`; shared
`tsconfig.base.json` with `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes` and `verbatimModuleSyntax`; `.gitignore` (secrets first);
`.env.example` with every variable grouped by the milestone that first needs it and no
values. `npm install`, `npm run typecheck`, `npm test` and `npm run build` all work from
the root.

**`packages/shared`** — the protocol core, the only implementation of both hashes:

| Area | Modules |
| --- | --- |
| Schema | `schema/primitives.ts`, `enums.ts`, `condition-spec.ts`, `evidence-package.ts`, `validate.ts` |
| Canonicalisation | `canonical/jcs.ts`, `unordered.ts`, `canonicalize.ts` |
| Hashing | `hashing/keccak.ts`, `rules-hash.ts`, `evidence-hash.ts` |
| Networks | `chains/xlayer.ts` |
| Shared types | `types/domain.ts`, `types/api.ts` |
| Errors | `errors.ts` |
| Fixtures | `testing/fixtures.ts` (shipped, so M2 Solidity tests reuse them) |

The protocol is documented in
[docs/canonical-specification.md](docs/canonical-specification.md).

**Golden vectors.** [`packages/shared/vectors/golden.json`](packages/shared/vectors/golden.json)
holds, per fixture, the input document, the expected canonical string and the expected
hash. Generated once from the implementation, then committed and asserted against — so a
future change to the schema, the unordered-field set, the normalisation rules or the
encoder breaks the tests loudly instead of silently redefining the protocol. Exported as
`@covenant/shared/vectors/golden.json` for the M2 Solidity tests and any reimplementation.

| Vector | Hash |
| --- | --- |
| `shipment` (ConditionSpec) | `0x739735cae491d20d3242742eda9d9efcdf1ef0e6d34a2cbca7555ed868ff6e97` |
| `productLaunch` (ConditionSpec) | `0x642729c0448c1e2a38ccddd00baae7b04dd5364df9bcdab40e2cdebea3cba1cf` |
| `minimal` (ConditionSpec) | `0x4f731802f203041e62327df24c9c4efdf45ba0585c46cd6b0dc56867789b4aa5` |
| `delivered` (EvidencePackage v1.0) | `0x2c8cb84a1b1367090334c08e748312c3222cb5fbc456264b7bf1a8ff2525c6d8` |
| `unreachableSource` (EvidencePackage v1.0) | `0x4d33645167e3df2f489a9f7bac54bdc630535b30f740e096dbcdaa2ffeb3bb20` |

These are now frozen. A diff to any of them is a breaking protocol change requiring a
specification version bump, **not** a regeneration. M5.1 added ten `EvidencePackage` v2.0
vectors *after* them and left all five byte-identical — see below.

### M2 — Contracts

Three contracts and two test-only mocks in `packages/contracts`, compiled with Solidity
0.8.24 at `evmVersion: paris`.

| Contract | Purpose |
| --- | --- |
| `MarketFactory` | Creates EIP-1167 clones; holds `PROPOSER_ROLE` and the pause switch. No function can move a market's funds |
| `ConditionalMarket` | One conditional agreement, custodying its own tokens. Full state machine, pari-mutuel settlement, challenge, cancellation |
| `TestUSD` | Six-decimal test token, deployable only on an allowlist of development chains |
| `FeeOnTransferToken`, `ReentrantToken` | Adversarial mocks used to prove the token and reentrancy guards actually fire |

The lifecycle is documented in [docs/market-lifecycle.md](docs/market-lifecycle.md) and the
trust model in [docs/security.md](docs/security.md), both written this milestone.

**Golden-vector integration.** Contract tests read
`@covenant/shared/vectors/golden.json` — no hash is transcribed into Solidity or into the
test files. They prove: canonical text → `ethers.keccak256(toUtf8Bytes(...))` → equals the
locked `rulesHash` → passed to `createMarket` → read back from the chain unchanged. Solidity
does **not** reproduce JCS canonicalisation and the tests do not claim it does; that is the
whole reason the specification is committed as a hash.

### M3 — AI condition compiler + backend foundation

`apps/backend`: Fastify API, the condition compiler, and the persistence layer. Documented
in [docs/ai-compiler.md](docs/ai-compiler.md).

| Area | Modules |
| --- | --- |
| Config | `config.ts` — constructed by `loadConfig(env)`, never read at module scope |
| Errors | `errors.ts` — extends the shared `CovenantError` hierarchy; one HTTP mapping |
| LLM boundary | `llm/provider.ts`, `anthropic-provider.ts`, `fake-provider.ts` |
| Compiler | `compiler/prompt.ts`, `output-schema.ts`, `assemble.ts`, `compiler.ts`, `version.ts` |
| Storage | `repositories/types.ts`, `memory.ts`, `drizzle.ts`; `db/schema.ts` + generated SQL |
| API | `api/server.ts`, `api/schemas.ts` |

**Two boundaries carry the milestone.** The Anthropic SDK is imported in exactly one file,
so `FakeLLMProvider` is a complete substitute rather than an approximation. Route handlers
depend on repository interfaces, never on Drizzle. Everything is injected through
`buildServer({ config, repositories, compiler })`. Consequently **no test requires a
network, a database, or an API key** — including the tests that exercise malformed model
output, a refusing provider, and a dead datastore.

**The compiler's structural decision** is the split between what the model produces and
what the system supplies. The model produces the *condition*; the system supplies
`version`, `nonce`, `creator`, and the entire `settlement` block (token, trading end,
challenge window, bond, resolution window). A model that could choose the bond size could
put invented economics inside a hash a user is asked to approve.

**`rulesHash` comes only from `@covenant/shared`.** The backend implements no
canonicalisation and no hashing; a sweep confirms neither appears in `apps/backend/src`.

**Honest 501s.** `/resolve`, `/challenge` and `/positions` validate their input and then
return 501 with an explanation. An empty positions list would claim the user holds nothing
when the truth is that the indexer cannot see it yet.

### M4 — X Layer testnet integration + live infrastructure

The milestone that replaced assumptions with measurements. Everything below was observed
against the live chain, a live PostgreSQL, and a live model — not planned, and not
inferred from documentation.

**The chain gate came first (§2).** Before any code changed, `eth_chainId` against
`https://testrpc.xlayer.tech/terigon` returned `0x7a0` — 1952, matching the brief.
`net_version` agreed. The node identified itself as `reth/v2.3.0-…/xlayer/v0.0.7`, i.e.
op-reth: X Layer is an OP Stack rollup since its migration off Polygon CDK.
`packages/shared/src/chains/xlayer.ts` now records that confirmation with its date, and
its `verification` flags are the gate the deploy script checks.

**EVM configuration was settled by measurement, and then left alone** (ADR-0012). Block
headers carry `parentBeaconBlockRoot`, `blobGasUsed` and `excessBlobGas` (Cancun) plus
`requestsHash` (Prague), so Cancun and Prague opcodes *are* available — the M2 assumption
was wrong in the safe direction. `evmVersion: paris` is kept anyway: nothing here uses a
Cancun feature, `paris` output is a strict subset of what the chain executes, and the M2
review was done against this bytecode. The pin is now a decision rather than a hedge.

**Drizzle security (§6).** `drizzle-orm` was the only advisory affecting a runtime
dependency (`npm audit --omit=dev` reported exactly one). Upgraded 0.38.4 → **0.45.2**,
confirmed as the current stable `latest` rather than assumed from the old report — 1.0.0
exists only at `rc.5`. `drizzle-kit` 0.30.6 → 0.31.10 to match. The repository layer needed
no API changes; typecheck and the full suite pass.

**Deployed to X Layer Testnet, and verified from the chain rather than from the script's
own output.**

| Contract | Address | `eth_getCode` |
| --- | --- | --- |
| TestUSD | `0x6d7227b319972af3006337fc5cda17737571c2e2` | 2,063 bytes |
| ConditionalMarket (impl) | `0xc9619d94a57f0480271142d6e22182a3264ac7d1` | 10,215 bytes |
| MarketFactory | `0x0b039cfbd96c13c34a2fe9445d4e155a403cfb3e` | 3,649 bytes |

Deployment block 38,533,494. `factory.implementation()` returns the implementation
address; `TestUSD.symbol()` decodes to `TUSD`. The manifest records compiler settings and
constructor arguments so the deployment can be reproduced.

**A complete lifecycle ran on testnet, twice, with different endings.** Two markets, two
independent wallets, real balance deltas at every step:

| | plain (market 5) | challenged (market 6) |
| --- | --- | --- |
| A stakes YES 100 TUSD | `0xd15a3eb4…` | `0x915e0da4…` |
| B stakes NO 300 TUSD | `0x8c181917…` | `0x32f11984…` |
| Custody check | 400.000000 held | 400.000000 held |
| Propose round 1 | YES `0x98b5fc45…` | YES `0x98b5fc45…` |
| Challenge (B, 25 TUSD bond) | — | `0x201da862…` |
| Propose round 2 | — | NO `0xee494972…` |
| Finalize | `0xeec3743a…` → YES | `0xcf46162b…` → NO |
| Winner claim | A takes 400.000000 | B takes 400.000000 |
| Bond | — | returned in full `0xa39d457a…` |

Wallet A 10000 → 10200; Wallet B 10000 → 9800. Sum unchanged at 20000. Both markets ended
`SETTLED` holding **0.000000** residual. The challenge overturned the outcome, so the bond
came back rather than being forfeited — the path that proves a wrong answer can be
corrected.

**`rulesHash` survived the round trip (§22).** `apps/backend`'s `prepare-market` tool
builds the ConditionSpec, validates it through `@covenant/shared`, and computes the hash;
the contracts script creates the market and reads `rulesHash()` back off the chain and
compares. Both markets matched:
`0x0e1002058488bb63df1d89aa3e22f20f16917ff9fc049f299453190a55df1f4c` and
`0xdcf1c8f45d334664f673f8a2ee431e7bcb6463ccafa1bc6f40f7674ce5919e81`. A mismatch stops the
script.

**New backend subsystems.**

| Area | Modules |
| --- | --- |
| Chain | `chain/types.ts` (the port), `chain/client.ts` (the only viem import), `chain/abi.ts`, `chain/enums.ts`, `chain/manifest.ts` |
| Indexer | `indexer/indexer.ts`, `indexer/main.ts` |
| Reconciliation | `reconcile/reconcile.ts`, `reconcile/main.ts` |
| Authentication | `auth/siwe.ts`, `auth/service.ts` |
| Composition | `composition.ts` — config → manifest → chain-id check, in that order |
| Tools | `tools/prepare-market.ts`, `tools/live-compiler-test.ts` |

**Authentication replaced an asserted identity with a proved one (§30, §31).** `creator`
is gone from the compile request; identity comes from a SIWE (EIP-4361) session. The
server builds the message and rebuilds it at verification from its own stored fields, so
there is no ABNF parser and nothing a client can vary — a signature over any other message
recovers a different address. The nonce is consumed by a single conditional `UPDATE ...
WHERE consumed_at IS NULL` *before* the signature is checked, so two concurrent replays
cannot both win. Only a SHA-256 of the session token is stored.

**Defects found in earlier milestones by running things for real:**

1. **`output_config.format.name` was never a valid field.** The M3 Anthropic provider sent
   it on every structured-output request; the API rejects it with
   `output_config.format.name: Extra inputs are not permitted`. **Every M3 compiler test
   used `FakeLLMProvider`, so no test ever built a real request** — this is precisely the
   gap §29 exists to expose, and the live test found it on the first call.
2. **The SIWE message was rendered with the caller's address casing but rebuilt from the
   lowercased stored value**, so a checksummed address produced two different messages and
   failed verification. Only reachable when bypassing the route schema, but the schema is
   the wrong place for that invariant. `renderSiweMessage` now normalises to EIP-55 at the
   single point where the string is built.
3. **`readMarket` used viem `multicall` with no multicall address.** The client is built
   without a `chain` preset — deliberately, since the chain comes from the manifest — so
   viem raised `client chain not configured`. Multicall3 is deployed at its canonical
   address on X Layer testnet (confirmed, 3,808 bytes) and is now passed explicitly.
4. **The indexer committed its checkpoint only at the end of a pass.** On a bootstrap
   spanning ~123,000 blocks at 100 blocks per request, a dropped connection near the end
   discarded the whole run. Passes are now bounded by `maxBlocksPerPass` and commit
   incrementally.

   **Validated by a real failure, not just by reasoning.** A later catch-up died at block
   38,628,800 with `Connection terminated unexpectedly` from Neon. The checkpoint stood at
   38,623,800, so the run resumed there and lost one 5,000-block window instead of 140,000
   blocks of work.
5. **The first lifecycle script assumed it ran start-to-finish in one process.** It died
   after eleven minutes of polling with real money staked in two live markets and no way
   to resume. Replaced by `resume-lifecycle.ts`, which derives the next action from
   on-chain state and is safe to re-run.
6. **The indexer stopped watching markets it had discovered itself.** The most serious of
   the six, and only visible against real data. `getMarketLogs` built its address filter
   from `markets.contract_address` — the table populated when a creator *registers a
   specification off-chain*. Anyone may call the factory, so a market can exist with no
   such row. The consequence: once the pass containing a market's `MarketCreated` was
   behind the cursor, every later event that market emitted was invisible. The first live
   bootstrap discovered six markets and recorded their stakes, then silently missed every
   close, proposal, challenge, finalization and claim. The watch set is now the union of
   registered markets, markets already in `market_chain_state` (which the indexer populates
   itself), and markets created within the current range. Covered by a regression test that
   fails against the old behaviour.

   Worth stating plainly: **every unit test passed throughout.** The scripted chain only
   ever exercised single-pass scenarios where creation and activity fell in the same range.
   It took a real chain — where a market is created and then acted on 95,000 blocks later —
   to expose it.
7. **The reconciler reported every correctly-settled market as underfunded.** It compared
   the market's token balance against `pool()` — which is the *original* distributable
   amount and does not shrink as winners claim. A market that had paid everyone correctly
   and therefore held nothing produced a `mismatch`, the loudest severity, on the healthiest
   possible state. A false positive in a monitoring tool is not a cosmetic bug: it is what
   teaches people to ignore the tool.

   Now compares against what is *still* owed — an outstanding bond exactly, refund-mode
   stake exactly — plus a weaker check that a market with claims outstanding holds
   something. The exact remaining payout outside refund mode is proportional and cannot be
   read from one getter, and duplicating the contract's arithmetic in the reconciler would
   make it wrong in a second place. Four tests now cover it, including the settled-market
   regression.

**Chain facts that are not in any documentation this project could find**, each discovered
by something breaking:

- `eth_getLogs` is capped at **100 blocks**; a wider request returns `block range greater
  than 100 max`. The default was 2000 and failed on the first real call.
- `proposeResolution` has **no upper deadline** — the resolution deadline only enables
  permissionless `cancel()`. This is what allowed markets 26 hours past their resolution
  deadline to be driven through a full lifecycle instead of only cancelled.
- Multicall3 is deployed at the canonical address.

### M5.1 — Evidence package model + deterministic evidence hashing

The first slice of the resolution subsystem, and deliberately only this much:

```
ConditionSpec  →  EvidencePackage  →  evidenceHash
```

No source retrieval, no web access, no AI resolver, no on-chain submission, no settlement
change, no frontend. Everything added is pure domain logic in `packages/shared` — it
touches no PostgreSQL, no Drizzle, no Fastify, no Anthropic SDK and no RPC. Documented in
[docs/ai-resolution.md](docs/ai-resolution.md); reasoning in
[ADR-0015](docs/adr/0015-evidence-package-v2.md).

**The existing schema was inspected before anything was written, and it was not
sufficient.** M1's `EvidencePackage` v1.0 was designed before a resolution engine existed
and got the frame right. Four things did not survive contact with the actual pipeline:

1. **A deterministic check could be read but never re-run.** v1.0 recorded
   `{ validator, passed, detail }` — a name, a boolean and prose. An auditor learns that
   something called `deadline-comparison` returned true and nothing else: not what was
   compared, not against what, not what was found. The entire argument for running
   deterministic validators before the model is that their conclusions are checkable by
   someone who does not trust us.
2. **A claim could not record an absence.** `value` was required, so "the resolver looked
   for the consignee name and no approved source published it" was either omitted —
   indistinguishable from never having checked — or written as a placeholder.
3. **Transport metadata was inside the digest.** `httpStatus` and `contentType` are facts
   about one request over one protocol, meaningless for `manual_attestation`. A hash that
   moves because a CDN changed a header is a tamper alarm that cries wolf.
4. **`contentHash` was mandatory even when nothing was retrieved** — and the shipped
   `unreachableSource` fixture shows the consequence: a source that returned HTTP 503 on
   every attempt carries a hash of bytes that do not exist. The schema required a value, so
   the fixture invented one. That is the failure this product exists to prevent, committed
   in our own golden vectors.

**So: EvidencePackage v2.0, with v1.0 frozen rather than edited.** A hashed document's
schema *is* the agreement; it cannot be amended in place at any price. v1.0 still
validates, canonicalises and hashes exactly as it did, and a test asserts its two digests
are the ones M1 committed. `validateEvidencePackage` dispatches on the declared `version`,
and a package whose label does not match its shape is rejected by the schema that label
selects. Nothing on-chain constrained this: **no real evidence package has ever been
committed** — M4's testnet lifecycle proposed a hash of the literal string
`covenant:m4:placeholder-evidence:round-1`, labelled as a placeholder in the script.

| Area | Modules |
| --- | --- |
| Schema | `schema/evidence-package-v1.ts` (frozen), `evidence-package-v2.ts`, `evidence-common.ts`, `evidence-package.ts` (versions + union) |
| Vocabularies | `schema/enums.ts` — `retrievalStatus`, `claimSupport`, `extractionMethod`, `deterministicCheckType`, `deterministicCheckResult` |
| Primitives | `schema/primitives.ts` — `publicUrlSchema`, `identifierSchema` |
| Binding | `evidence/binding.ts` — `assertEvidenceBinding`, `buildBoundEvidenceCommitment`, `buildEvidenceCommitmentForSpec` |
| Ordering | `canonical/unordered.ts` — version-keyed, `unorderedFieldsForEvidenceVersion` |

**What v2.0 changed, and the reason in one line each:**

- **Deterministic checks record the comparison, not its verdict.**
  `{ checkId, checkType, sourceIds[], expected, observed, result, explanation }`. A closed
  eight-member `checkType` vocabulary over a generic record shape — the vocabulary is fixed,
  the shape stays open to future validators. `result` is `PASS | FAIL | INDETERMINATE`
  rather than a boolean, because "the check could not run" is neither, and a boolean forces
  it to be recorded as one of the two.
- **Claims carry a support state and name how they were extracted.** `support` is
  `SUPPORTED | UNSUPPORTED | DISPUTED`, and `value` is null *exactly when* support is
  `UNSUPPORTED`. `extraction` is `{ method, locator }`: `JSON_POINTER` / `CSS_SELECTOR` /
  `REGEX` must name their locator so a third party can re-extract and check;
  `MODEL_EXTRACTION` must not, and cannot. **The point of that field is to make the
  non-reproducible case visible** — an auditor can see at a glance which claims rest on a
  locator anyone can run and which rest on a model's reading.
- **Sources describe evidence, not requests.** `httpStatus` and `contentType` are gone,
  replaced by `status: RETRIEVED | UNAVAILABLE | MALFORMED | NOT_ATTEMPTED`.
  `contentHash` is nullable and required exactly when `RETRIEVED`. Where a status code
  genuinely mattered it belongs in a `SOURCE_AVAILABLE` check's `observed` field, which is a
  place for observations.
- **`approvedSourceIndex` is mandatory with no null escape hatch.** Evidence may only come
  from a source the user approved when they approved the rules. A resolver that needs an
  unapproved source cannot resolve, and saying so — `INVALID`, refunds — is correct
  behaviour rather than a limitation.
- **References are by id, not position.** `sourceId` / `claimId` / `checkId`, lowercase
  slugs, unique per package. This removed the coupling that had made v1.0's ordering
  decision for it, and lets one claim cite several sources — which is what `DISPUTED` is.

**Three collections, three ordering answers** (§12 of the brief asked for a decision on
each, not a blanket rule):

| Collection | Order | Why |
| --- | --- | --- |
| `sources` | **ordered** | Position carries precedence and retrieval sequence. A resolver that read the fallback before the primary did something different |
| `claims` | **unordered** | With positional references gone, it is a set of independent assertions. Weigh the failure modes: an ordered `claims` breaks the hash on a benign re-serialisation — a tamper alarm for a change that means nothing — while an unordered one cannot hide a real change, because permuting independent claims *is* no change |
| `deterministicChecks` | **ordered** | A validator that short-circuits after an earlier failure is a different run |

`UNORDERED_FIELDS` is now version-keyed, and canonicalisation **refuses** for a version it
does not know rather than defaulting to "nothing is unordered" and hashing under the wrong
rules.

**The rules binding is a construction-time refusal, in shared code.**
`buildEvidenceCommitmentForSpec` *derives* the expected `rulesHash` from the specification
rather than accepting one alongside it, so a caller cannot pass a hash that does not belong
to the document it holds. It also reconciles every source against the approved source it
cites: the index must be in range, and the URL must be the one approved at that position.

That last check answers the obvious objection to carrying both an index and a URL — two
representations of one fact, which ADR-0008 decision 1 warns against. They are not
deduplicated; they are made **unable to disagree**. The URL stays because a package should
be readable without fetching the specification to find out what was consulted.

A mismatch raises `EvidenceBindingError` / `EVIDENCE_RULES_MISMATCH` (HTTP 409), distinct
from `HASH_MISMATCH`: the document reproduces its own digest perfectly and is simply
evidence for another agreement. The check lives in `packages/shared` and not in a route
handler because the frontend verifier and any third-party auditor must reach the same
verdict — a boundary enforced in one place is a boundary with a way around it.

**Source URLs are checked for embedded credentials**, because an evidence package is
published. `publicUrlSchema` refuses `https://user:pass@host` userinfo and eleven query
parameter names that can only mean a secret. `key`, `token` and `signature` are
deliberately **not** on that list: they have legitimate non-secret meanings (`?key=BTC`),
and a false positive here does not mean a warning — it means the evidence cannot be
published and the market cannot be resolved.

**Ten new golden vectors, and the five old ones proven untouched.** The regenerated
`golden.json` was diffed field-by-field against a copy taken before the run: all three
`ConditionSpec` entries and both v1.0 `EvidencePackage` entries are byte-identical,
including their canonical strings. All twelve evidence hashes are distinct.

| Vector | Covers |
| --- | --- |
| `v2ShipmentYes` | Basic YES; two JSON-pointer claims, two passing checks |
| `v2ShipmentNo` | Basic NO; a failing check and an `UNSUPPORTED` claim |
| `v2MultiSource` | Primary `UNAVAILABLE`, approved fallback decides — precedence in action |
| `v2MultiClaim` | Five claims across all three support states; model, regex and selector extraction |
| `v2CheckVocabulary` | All eight check types, including an `INDETERMINATE` result |
| `v2Invalid` | INVALID; `NOT_ATTEMPTED` fallback, null `contentHash` |
| `v2LowConfidence` | Confidence differs and nothing else |
| `v2OtherRules` | Identical but for `rulesHash` — the binding is inside the digest |
| `v2SourceOrderSwapped` | `v2MultiSource` with sources permuted; must differ |
| `v2ClaimEdited` | One claim value changed; the smallest meaningful edit |

Now frozen on the same terms as the M1 five:

| Vector | Hash |
| --- | --- |
| `v2ShipmentYes` | `0x6c29bf29e3bff637be1783ed7b4baf4cc805316506185c7fe6c8bfe15d6d8d0e` |
| `v2ShipmentNo` | `0x6aa9037108f3d1e73ddf1d651a6481d0ac3be557457b8a67baf4517fc1d76bd6` |
| `v2MultiSource` | `0x0fbf709dc21b5131b54d473e2ffa1ced41fec3375581f91181dacdbe08b65c46` |
| `v2MultiClaim` | `0xfcac19df40680ee1790c9dd3e2917c1a3004424b91aa0e39d0d302b002d2932d` |
| `v2CheckVocabulary` | `0x5cd374be4d9404b0472d0ddf2b707279d0b9efdc381a72dc2195a0951bc5dd1b` |
| `v2Invalid` | `0x58d6eb89b4b452f7207f51b730de8a14e3884b08ad839ce41263d15052bf27c0` |
| `v2LowConfidence` | `0xcc898fad08015b5fd35f9628d8eae790fea10b831e4b10d3c3f178c4cea1a3e4` |
| `v2OtherRules` | `0xb1cee2e638142fef414ab25748094bb8a1c9531d8679088faf2b32e0d8b27eff` |
| `v2SourceOrderSwapped` | `0xa861756ae89d88ed5a7efd097ae45dd119c2d6115ca26b9cf1e30446a67e5707` |
| `v2ClaimEdited` | `0xa514a44b32dc59f169dc37854740381c9f55c97cba695c1d1f832a296144e65d` |

The v2.0 fixtures bind to the **real** frozen `rulesHash` of `shipmentConditionSpec` rather
than an all-zero placeholder, written as a literal and cross-checked by a test against
`hashConditionSpec(shipmentConditionSpec)`. A fixture that computed its own binding would
agree with the hashing code by construction and could never catch it changing.

### M5.2 — Approved source retrieval + evidence snapshots

The evidence acquisition layer:

```
ConditionSpec.approvedSources → EvidenceSourceAdapter → snapshots → EvidenceSource[]
```

No claim extraction, no validators, no AI resolver, no outcome, no confidence, no on-chain
submission, no contract change, no frontend. Documented in
[docs/ai-resolution.md](docs/ai-resolution.md) Part II (§11–§20).

| Area | Modules (`apps/backend/src/evidence/`) |
| --- | --- |
| Port | `types.ts` — `EvidenceSourceAdapter`, `SourceRetrievalError`, the six failure kinds |
| Transport | `https-adapter.ts` — **the only file that opens a socket to a source** |
| Test double | `fake-adapter.ts` — scripted, shipped in `src` like `FakeLLMProvider` |
| Policy | `url-policy.ts` — normalisation and the SSRF address table |
| Content | `normalize.ts` — JSON canonicalisation, `dataPath`, HTML text, bounds |
| Orchestration | `retriever.ts` — the precedence walk, retries, snapshots, projection |
| Live check | `tools/evidence-smoke-test.ts` — opt-in, not part of the suite |

**Precedence is honoured exactly, and made auditable.** Sources are attempted in array
order; the first usable answer ends the walk; everything after it is recorded as
`NOT_ATTEMPTED` and everything before it with the status its failure maps to. That last part
is the point — reading position 1 is only legitimate when position 0 is *on record* as
having failed, so a resolution that skipped a healthy primary is visible without taking the
resolver's word for it.

**Three prohibitions, each with a test.** The retriever never adds a source outside
`approvedSources`; never turns a retrieval failure into a `NO` (the failure vocabulary
contains nothing that could be mistaken for an outcome); and never mutates the
`ConditionSpec` — a test asserts the document is byte-identical afterwards, because a
retriever that edited it would change `rulesHash` and unbind the market.

**Two hashes over two different things.** `contentHash` is keccak256 of the *complete raw
body* and is what enters the hashed package; `normalizedHash` covers the retained
normalised text and is operational only. JSON is re-serialised through the protocol's own
JCS encoder, so response key order cannot change a snapshot, and a payload carrying a float
is `SOURCE_MALFORMED` rather than something that fails later with less context.

**The retention tradeoff, stated rather than hidden.** `contentHash` commits to the whole
body so nothing can be silently swapped, while only the first 20,000 characters of
normalised content are retained, with `normalizedTruncated` recording that it happened. An
oversized *raw* response (>2 MiB) is a failure, not a truncation: hashing a prefix and
calling it the content would be a lie about what was read.

**SSRF defence, with an honest threat model.** A URL here is not attacker-controlled at
retrieval time — it came from an approved specification whose bytes are inside `rulesHash`.
So this is defence-in-depth, and it is still necessary, because a redirect can take an
innocent URL anywhere. Name-level policy (https only, no userinfo, port allowlist, fragment
stripped) re-runs on **every** redirect hop. Address-level policy blocks loopback, private,
link-local (**including `169.254.169.254`**), CGNAT, documentation, multicast and reserved
ranges, with IPv4-mapped and NAT64 addresses unwrapped and re-checked so the table cannot be
walked around by writing `::ffff:127.0.0.1`.

The address check is wired through `https.request`'s **`lookup` hook** rather than done
before the call. That is what closes DNS rebinding: resolving, checking, then handing the
*hostname* to a client is a time-of-check/time-of-use hole, because the client resolves
again and a hostile authoritative server can answer differently. Supplying the function
`net.connect` itself calls means the socket lands on an address this process vetted. It is
also why the adapter is built on `node:https` rather than `fetch`, which exposes no
equivalent hook without a dependency to replace its dispatcher. The policy fails closed: if
any resolved address is disallowed, the whole host is refused.

**Defect found by running it for real — the milestone's most valuable result.** The first
version bounded the connect but not the DNS lookup, on the assumption that a connect timeout
covered the attempt. It does not: the connect has not started yet. The live smoke test in an
environment with no reachable resolver **stalled indefinitely** rather than classifying as a
timeout — exactly the failure the retrieval bounds exist to prevent, in the one step that
had none. `dns.lookup` is now inside the attempt deadline, and the retriever additionally
refuses to wait on any transport past its own deadline, because a contract is not an
enforcement mechanism. Both have regression tests.

**Every unit test passed throughout.** A fake adapter cannot have a DNS problem. That is the
whole argument for keeping an opt-in live check that the suite does not depend on.

**Live smoke test, after the fix** (`node dist/tools/evidence-smoke-test.js`, 3/5 probes as
expected):

| Probe | Result |
| --- | --- |
| Cloud metadata endpoint `169.254.169.254` | ✅ `SOURCE_FORBIDDEN` — link-local, refused in 2ms, before a socket |
| Loopback `127.0.0.1` | ✅ `SOURCE_FORBIDDEN` — refused in 2ms |
| Non-standard port `:8080` | ✅ `SOURCE_FORBIDDEN` — not in the allowed set, 1ms |
| HTML over TLS | ❌ `SOURCE_UNAVAILABLE: connection failed` (1928ms) |
| JSON over TLS | ❌ `SOURCE_UNAVAILABLE: connection failed` (205ms) |

The two outbound probes fail because **this development machine has no outbound network**,
not because of a code defect — the classification and the timings say so. Before the fix
these hung indefinitely; they now terminate in under two seconds with a typed, classified
failure, which is precisely the behaviour §3 of the brief demands and is the fix working.

What this does **not** prove is stated plainly rather than implied: a successful retrieval
over real TLS from a real host, a real redirect being followed and re-checked, and a real
`content-type` being honoured are all still **unverified against a live source**. They are
recorded in Known issues.

### M5.4 — AI resolution intelligence

The model finally enters the resolution path, bounded on every side:

```
ConditionSpec (immutable) + snapshots + DeterministicCheck[]
  → gates → one model call → Zod → semantic gate → outcome mapping → confidence floor
  → EvidencePackage v2.0 + evidenceHash
```

**Nothing is submitted on-chain.** No signer, no chain client, no transaction anywhere in
`apps/backend/src/resolution/`. Documented in
[docs/ai-resolution.md](docs/ai-resolution.md) Part IV (§30–§39); reasoning in
[ADR-0016](docs/adr/0016-ai-proposes-code-decides.md).

| Area | Modules (`apps/backend/src/resolution/`) |
| --- | --- |
| Output contract | `output-schema.ts` — Zod gate + provider JSON Schema, `.strict()` |
| Prompt | `prompt.ts` — system prompt, spec/checks/evidence rendering, evidence fencing |
| Claim extraction | `claims.ts` — `JSON_POINTER` first, `UNSUPPORTED` reachable, model for the residue |
| Semantic gate | `grounding.ts` — six checks Zod cannot express |
| Outcome mapping | `outcome.ts` — verdict + `encodes` + edge cases, never `SATISFIED → YES` |
| Orchestration | `engine.ts` — the pipeline and the three terminal statuses |
| Assembly | `assemble.ts` — through `buildEvidenceCommitmentForSpec`, nothing else |

**The central decision is that the model concurs in an outcome rather than choosing one.**
The deterministic verdict, mapped through `plan.encodes`, is the authority. The model's own
reading of `successCondition` and `failureCondition` must agree with it; a disagreement
produces `NEEDS_REVIEW`, never a flip. A matched `edgeCases[]` entry may only make the
proposal more conservative — confirm the checks, or settle to `INVALID`, or force a review.
The model's vocabulary is `RESOLVED_YES | RESOLVED_NO | NEEDS_REVIEW` and contains no
`INVALID`, so a refund determination can only come from something the user pre-approved.
A compromised or mistaken model costs liveness; it cannot cost correctness.

**One new gap, stated as plainly as M5.3 stated its own.** Mapping a verdict onto an outcome
needs to know which condition the checks encode, and `ConditionSpec` v1.0 cannot say. It is
carried as `ValidationPlan.encodes`, which is **unhashed operator input** — a user approving
a `rulesHash` is not approving it. The concurrence rule above means a mis-set `encodes`
produces a review rather than an inverted payout, which is a real mitigation and not a
substitute for `ConditionSpec` v1.1.

### M5.5–M5.7 — The complete resolution pipeline

The milestone that connects everything M5.1–M5.4 built to the chain, the API and a user:

```
ConditionSpec → load spec → verify rulesHash against the CHAIN → collect evidence
  → deterministic validation → AI analysis → EvidencePackage → evidenceHash
  → resolver proposal on-chain → challenge window → second proposal → finalization
  → the contract settles
```

**The AI still cannot move funds, and now that claim has a transaction path to be false
about.** Nothing in `resolution/engine.ts` imports a chain client, a signer or a key; the
signer lives in one file (`chain/writer.ts`) that the engine cannot reach; and the two
non-view functions the backend declares an ABI for are `proposeResolution` and
`finalize`. `abi-parity.test.ts` asserts that list is exactly those two, so a `claim` or a
`transferFrom` appearing there is a deliberate edit to a test rather than an accident.

| Area | Modules |
| --- | --- |
| Write port | `chain/types.ts` — `ResolverChainWriter`; `chain/writer.ts` — the only file holding a key |
| Orchestration | `resolution/service.ts` — gates, persistence, submission, finalization, challenge recording |
| Projection | `api/resolution-view.ts` — the stored record → the panel's shape |
| API | `api/server.ts` — resolve, resolution, challenge, challenge/prepare, finalize, validation-plan; CORS |
| Storage | `db/schema.ts` — `challenges` table, `markets.validation_plan`, four columns on `resolutions` |
| Demo surface | `apps/web/` — list, create, detail, and the resolution chain |
| Tools | `tools/prepare-demo.ts`, `tools/demo.ts` |

**M5.5's evidence pipeline was already built and was checked rather than rebuilt.** The
brief asks for an injectable provider interface, a production HTTP provider, a fake for
tests, and deterministic checks before any LLM judgment. M5.2 and M5.3 produced exactly
that under different names — `EvidenceSourceAdapter`, `HttpsSourceAdapter`,
`FakeSourceAdapter`, and `DeterministicCheck[]` with `{ checkId, checkType, expected,
observed, result, explanation }`. Renaming them to match the brief's vocabulary would have
churned a tested layer for nothing. What was added is the piece that was genuinely
missing: the criteria have somewhere to *live* between market creation and resolution.

**The one new architectural decision is ADR-0017: the validation plan is stored per
market, outside `rulesHash`.** M5.3 found that `ConditionSpec` v1.0 promises
`deterministic_numeric_threshold` and has nowhere to put the threshold, and passed the
plan as a function argument because it had no persistence. Now it is a nullable
`markets.validation_plan`, set by the **proved creator**, validated at write *and* on
every read, and refused if it references a source the specification did not approve. A
market with no plan resolves to `NEEDS_REVIEW` with reason `NO_VALIDATION_PLAN` — it never
falls back to asking a model for a number that settles money.

That is a real weakening and it is recorded as one: the numeric criteria a market settles
on are creator-supplied rather than hash-committed. Four things bound it, and the second
is the load-bearing one — **a deadline comparison may only use `spec_deadline`**, because
the plan schema has no literal-instant variant at all. An unhashed plan therefore cannot
substitute a deadline for the one inside `rulesHash`.

**The resolution service is a sequence of refusals, and the hash comparison is a stop.**
Before a model is called, the service reads the market from the contract and compares the
hash derived from the stored specification against the hash the market committed. A
mismatch returns `INVALID` and never reaches the submission path. The engine performs the
same check independently — a boundary this important is worth having twice, and neither
can be bypassed by calling the other directly.

Then: state must be `CLOSED` or `CHALLENGED`; the condition deadline must have passed; and
`proposalRound` must be below the contract's limit of two. **A third proposal is not
attempted**, rather than attempted and reverted.

**Four terminal statuses, kept apart deliberately** (`RESOLVED`, `NEEDS_REVIEW`,
`INSUFFICIENT_EVIDENCE`, `INVALID`, plus `RESOLUTION_FAILED`). `INSUFFICIENT_EVIDENCE` is
pulled out of `NEEDS_REVIEW` because they call for different actions: one means nothing was
read and the sources need looking at, the other means something was read and a person has
to judge it. All of them are **HTTP 200** — a market the engine will not resolve is the
system working, and a 4xx would tell a UI to show a failure banner where it should show
reasoning.

**A hash is still not an outcome.** `proposeResolution` returns a transaction hash, which
is persisted *before* the wait so a process that dies mid-wait leaves a record pointing at
something findable. `waitForTransaction` reports a mined revert as `FAILED`, and that is
recorded as `PROPOSAL_REVERTED` with `submissionState: FAILED` — never as a proposal.

**Challenges: the contract decides, the backend records.** Filing a challenge moves the
challenger's own bond, so their wallet sends `challenge(reasonHash)`. The backend then
attaches the argument behind that commitment, and refuses unless three things hold: the
market is `CHALLENGED`, the on-chain `challenger` is the authenticated wallet, and
`keccak256(reason)` equals the `challengeReasonHash` the contract stored. Without the third
check this table would be a place for anyone to put words in a challenger's mouth.
`challengeReasonHash` was added to `readMarket` for exactly this.

`POST /challenge/prepare` exists because a browser cannot keccak256 without a library, and
shipping one so the client could compute a protocol hash is what ADR-0001 forbids. The
server hashes the bytes through `@covenant/shared`; the check that matters still happens
later, against what the contract actually holds.

**Finalization is left permissionless, because the contract left it permissionless.** The
route requires no authentication and takes no arguments — requiring a login would invent a
gate the protocol does not have, and liveness that depends on this backend is what ADR-0004
refuses. The service checks the window before relaying so a caller gets "the window closes
at T" instead of a reverted transaction; the contract's `ChallengePeriodActive` is the
enforcement.

**Settlement arithmetic is absent, and a test asserts its absence.**
`resolution-service.test.ts` greps its own source for `payout =`, `previewClaim(`,
`totalYes *` and `/ pool`. The contract owns winning stake, payout, refund mode, bonds and
settlement state; the backend reads them.

**The reconciler now checks the evidence behind the commitment.** For every market carrying
a non-zero on-chain `evidenceHash` it asks three separate questions — do we hold the
package at all, does it re-derive to the committed digest, and is it bound to *this*
market's rules — because they call for different responses. A published digest nobody can
resolve to a document is a commitment that cannot be checked, which is the failure this
product exists to prevent.

**The indexer needed no repair.** The M4 defect the brief describes — discovery depending
on `markets.contract_address` — was found and fixed during M4 itself, by the first live
bootstrap: six markets were discovered and their stakes recorded, then every later close,
proposal, challenge, finalization and claim was silently missed. The watch set has since
been the union of registered markets, markets already in `market_chain_state` (which the
indexer populates itself), and markets created within the current range, with a regression
test that fails against the old behaviour. Incremental checkpointing was fixed in the same
milestone and validated by a real Neon disconnection that cost one 5,000-block window
instead of 140,000 blocks. Both were re-read and confirmed rather than taken on trust.

**The frontend is four files of plain HTML, CSS and ES modules, with no bundler.** There is
no React and no Vite in this repository, so adding one would have meant a dependency tree
and a build step for a page that exists to make an argument legible. The `build` script is
an honest check rather than a no-op: it verifies every referenced asset exists and that
every module parses under `node --check`, because a missing `<script src>` and a syntax
error are both a blank page.

**Three of the five hand-written function selectors were wrong.** With no bundler there is
no viem in the page, so the four contract calls it sends are encoded by hand against
selector constants. Three of the five were wrong when first written. `web-selectors.test.ts`
now recomputes every one from the **compiled ABI** and fails on drift — the same argument
`abi-parity.test.ts` makes for the backend's fragments, applied to the one place a hash
could not be derived at run time.

**The demo market is a numeric threshold against a public JSON API**, deliberately: it is
the shape the deterministic layer can actually decide. `stargazers_count` from
`api.github.com/repos/ethereum/go-ethereum`, compared `GREATER_THAN 40000` by
`BigInt`-backed decimals. The answer is not in doubt — the repository has had far more than
that for years — because a demo whose outcome is genuinely uncertain can fail live for
reasons that have nothing to do with the software. The claim behind the outcome is a
`JSON_POINTER`, so it is reproducible by anyone rather than resting on a model's reading.

### M5.3 — Deterministic evidence validation engine

Everything code can decide, decided without a model:

```
ConditionSpec + EvidenceSnapshot[] + ValidationPlan → DeterministicCheck[] + verdict
```

No outcome, no reasoning, no confidence, no AI, nothing on-chain, no contract change.
Documented in [docs/ai-resolution.md](docs/ai-resolution.md) Part III (§21–§29).

| Area | Modules (`apps/backend/src/validation/`) |
| --- | --- |
| Exact arithmetic | `decimal.ts` — `BigInt`-backed decimals, six operators |
| Instants | `temporal.ts` — UTC seconds, delegating acceptance to the shared primitive |
| Criteria | `plan.ts` — the `ValidationPlan` schema, strict |
| Validators | `validators.ts` — five kinds, `CHECK` / `NOT_APPLICABLE` / `VALIDATION_ERROR` |
| Orchestration | `engine.ts` — precedence, conflicts, verdict |

**The headline finding is a defect in the frozen schema.** `resolutionMethod` has a member
`deterministic_numeric_threshold`, documented as *"a number from an approved source compared
against a fixed threshold"* — and **`ConditionSpec` v1.0 has nowhere to put that
threshold.** The only machine-readable criteria in the entire document are `deadline` and
`edgeCases[].outcome`; the number, the operator and the expected status all live in
`successCondition`, which is prose. The enum promises a capability the schema cannot carry.

Three ways to get the threshold, and the first two were refused:

1. **Regex it out of `successCondition`** — inventing acceptance criteria from prose. Works
   on the fixtures, fails on the first real market phrased differently, and its failure mode
   is a confidently wrong number inside settlement arithmetic.
2. **Ask a model** — forbidden here, and wrong regardless: it puts a model-chosen number
   inside the comparison that settles a market, the exact inversion of this milestone.
3. **An explicit, validated, separately-supplied `ValidationPlan`** — what was built.

**And the plan is not hashed, which is a real weakening, stated rather than dressed up.**
The numeric criteria a market settles on are currently *operator-supplied* rather than
*user-approved*: a user approving a `rulesHash` is not approving the threshold their money
turns on. Two constraints bound the damage until `ConditionSpec` v1.1 can carry criteria
inside the hash — a plan may only reference approved sources, and **a deadline comparison
may only use `spec_deadline`**, because the schema has no literal-instant variant at all. An
unhashed plan therefore *cannot* substitute a deadline for the one inside `rulesHash`, which
is the single most valuable thing an attacker could change. A test asserts the attempt is
rejected.

**No floating point on any comparison path.** Decimals are `sign × digits / 10^scale` with
`digits` a `BigInt`. Exponent notation, leading `+`, leading zeros, bare `.5`, thousands
separators and currency symbols are all refused rather than interpreted; digits are capped
at 64, because `BigInt` is unbounded and a megabyte of digits would be a denial of service
wearing the costume of a very precise number. A quoted decimal string and a bare JSON number
read identically — a source that quotes its numbers must not be unreadable while an
identical one that does not works.

**All time is UTC, and nothing reads a clock.** Acceptance is delegated to
`utcInstantSchema` from `@covenant/shared`, so an instant that validates here is the one that
would validate inside a hashed document; a second parser would eventually disagree with the
first. A timestamp with no offset is **refused, not assumed to be UTC** — guessing would be
correct for every source reporting UTC and wrong for every source reporting local time,
which is the shape of bug that survives testing.

**An unreadable value is never a `FAIL`.** "The number could not be parsed" and "the number
was below the threshold" are different facts and settle differently. Every parse refusal
produces `INDETERMINATE`, and any indeterminate check makes the whole verdict
`NEEDS_REVIEW` — a resolution built on "most of the checks worked" is the kind that looks
fine until the one that did not run was the one that mattered.

**`observation.sourceId` names the highest-precedence position to consult, not the only
one.** Every approved source at or after it is read, because corroboration is what makes a
disagreement visible — consulting exactly one source would make conflict handling
unreachable and falling back when the primary is silent impossible. Naming a later position
is how a plan deliberately skips a source that does not carry the field. (The first
implementation had a filter whose second clause was true for every snapshot, so the field
was validated and then ignored; caught by re-reading, not by a test, and now load-bearing
with a test of its own.)

**Conflicts are settled by precedence, never by majority.** The highest-precedence source
that produced a usable value wins, because the user approved an ordering, not an electorate.
The disagreement is recorded in `conflicts` and on the check's own `explanation` so a
challenger can see it. A test asserts that with the primary saying `in_transit` and the
fallback saying `delivered`, the verdict follows the primary — two-to-one on a majority
count, and precedence says otherwise.

**Second defect found, this one in the frozen shared layer: `utcInstantSchema` silently
rolled impossible calendar dates forward.** `Date.parse` does not reject them — it rolls
them over:

| Written | Was normalised to |
| --- | --- |
| `2026-02-31T00:00:00Z` | `2026-03-03T00:00:00Z` |
| `2026-04-31T00:00:00Z` | `2026-05-01T00:00:00Z` |
| `2025-02-29T00:00:00Z` | `2025-03-01T00:00:00Z` |

Each returns a finite timestamp, so the `Number.isFinite` guard — whose comment claimed it
caught "not a real calendar date" — saw nothing wrong. Out-of-range *months* and days above
31 were rejected; the in-range-but-impossible day, which is exactly what a human is most
likely to write, was not.

**In a hashed document this is a silent alteration of the agreement.** A user approving a
`deadline` of 29 February 2025 would have `2025-03-01` normalised into `rulesHash` — a whole
extra day — with no error shown to anyone. `24:00:00`, `23:60:00` and `23:59:60` rolled the
same way.

Found while writing the M5.3 temporal boundary tests, and worth noting *how*: an M5.1 test
already asserted that `2026-02-31T00:00:00Z` was refused inside an evidence package, and it
**passed for the wrong reason** — the rolled-over date tripped a different cross-field rule
(`retrievedAt` then fell after `resolvedAt`), so the assertion was green while the defect sat
underneath it. A test can be passing and still be telling you nothing.

Fixed in `primitives.ts` by validating the written date and time-of-day components before
`Date.parse`, using the full Gregorian leap rule. **The fix can only reject inputs that were
previously being corrupted**, so no valid document changes and no golden vector moves — the
shared suite is the proof, and it runs from source.

**The verdict is deliberately not an outcome.** `SATISFIED | REFUTED | NEEDS_REVIEW`, kept
verbally distinct from `Outcome` so that anyone mapping `SATISFIED → YES` in M5.4 has to do
it deliberately, in code that also reads `failureCondition`, rather than by assignment. A
test asserts the engine's entire output contains no `YES`, `NO` or `INVALID`.

## Current work

M5.4 is complete and stops where the brief said to stop. A validated resolution proposal
exists — outcome, confidence, reasoning, claims, deterministic checks, sources — assembled
into an `EvidencePackage` v2.0 with its `evidenceHash`. **Not built, deliberately:** on-chain
submission, the resolver signing path, challenge processing, any settlement change, any
frontend. `/resolve` and `/challenge` remain honest 501s.

**The live smoke test found a real defect and then a real open question.** The defect: the
provider returns `400 output_config.format.schema: For 'integer' type, properties maximum,
minimum are not supported`, which failed every scenario that reached it on the first run.
Same class as M4's `output_config.format.name` finding, found the same way, and the argument
for the live test existing — no `FakeLLMProvider` test builds a real request. Fixed; the
bounds live in Zod, where they are enforced anyway. The open question is recorded below: on
the second run the provider was reached on four scenarios and **every one was refused by
`UNGROUNDED_VALUE`**, which is not yet diagnosed.

M5.3 is complete. The deterministic layer decides what code can decide; the interpretation
built on top of it in M5.4 cannot overrule it.

M5.2 is complete and stops where the brief said to stop: evidence is acquired, nothing is
interpreted. There is still no claim extraction, no validator, no outcome and no confidence,
and `/resolve` remains an honest 501.

M5.1 is complete and stops exactly where the brief said to stop. **Not built, deliberately:**
source retrieval, any web access, the deterministic validator implementations, the AI
resolver, on-chain resolution submission, any settlement change, any frontend. The
`/resolve` and `/challenge` routes are still honest 501s.

`docs/ai-resolution.md` marks every place where it states a contract M5.2 inherits rather
than describing code that exists, because a document that reads as though the engine were
built would be exactly the M3-era fiction the previous milestone refused to write.

M4 remains complete except for explorer verification, which is recorded in "Known issues"
rather than papered over: OKLink documents the endpoint for chain 195 while this
deployment is on 1952, and no explorer API key was available.

The full path now runs end to end on live infrastructure: compile → register → create
on-chain → index → reconcile. Both testnet markets are linked to their specifications by
`rulesHash`, and reconciliation reports no mismatches.

One task remains open and is not a defect: a **local integration suite against a
throwaway PostgreSQL** (§34 category B) was never built, because the machine has no Docker
and no local `psql`. The Drizzle layer is exercised by the live indexer and reconciler
instead.

---

## Architectural decisions

Full records in [docs/adr/](docs/adr/).

| # | Decision | Why |
| --- | --- | --- |
| 0001 | npm-workspace monorepo; `packages/shared` owns schema + hashing | Backend hashing and frontend verification must be the same code, or verification is theatre |
| 0002 | Factory deploys an EIP-1167 clone per market | Per-market fund isolation; a bug in one market cannot reach another's balance |
| 0003 | RFC 8785 JCS canonicalisation, floats banned | `JSON.stringify` is not deterministic enough to anchor money |
| 0004 | One challenge round, bonded; permissionless cancellation timeouts | The spec's challenge loop is unbounded as written, and an absent resolver would otherwise strand funds forever |
| 0005 | Ship our own `TestUSD` for testnet | No X Layer testnet stablecoin address is confirmed, and §32 forbids inventing one |
| 0006 | The user's wallet creates the market; indexer joins on `rulesHash` | The person who approved the rules is the person who commits them |
| 0007 | Pause guards creation and staking only, never claims | A pausable `claim()` is a fund freeze |
| 0008 | The canonical hashing protocol as implemented (refines 0003) | Four decisions the sketch left open or got wrong — see below |
| 0009 | An INVALID outcome runs through the challenge window (refines 0004) | ADR-0004's "immediate" cancellation would hand the resolver an unchallengeable unilateral unwind of any market |
| 0010 | `packages/contracts` is a CommonJS island | Hardhat 2 is CJS; the seam is a package boundary, and only JSON crosses it |
| 0011 | The compile endpoint is conversational | `INCOMPLETE` is the common outcome, and a user needs a question they can answer — with somewhere to send the answer |
| 0012 | `evmVersion: paris` stays, now as a choice | Cancun and Prague are confirmed available on X Layer; nothing here uses them, and `paris` is what M2's review was performed against |
| 0013 | The deployment manifest is the only channel for contract addresses | A constant in source is an address nobody re-derived from a deployment |
| 0014 | The server renders the SIWE message; the client only signs it | No ABNF parser, and nothing a client can vary |
| 0015 | EvidencePackage v2.0, with v1.0 frozen (refines 0008) | v1.0's deterministic checks could be read but not re-run, and its claims could not record a fact that was looked for and not found |
| 0016 | The model concurs in an outcome, it does not choose one (refines 0015) | A model asked to resolve a financial condition fails *plausibly*, and the evidence it reads is attacker-controlled. Code decides; the model can withhold a resolution but never flip one |

### Decisions taken during M1 (ADR-0008)

1. **`approvedSources` is ordered; its `role: primary|secondary` field is removed.**
   ADR-0003 had listed it as unordered *and* the architecture gave each source a role —
   two conflictable representations of precedence. Sorting it would also have meant
   permuting the fallback chain does not change the hash, even though it changes which
   source decides the outcome. Position is now the only precedence: index 0 is primary.
2. **Unknown keys are rejected, not stripped.** ADR-0003 said stripped. Stripping prevents
   smuggling but silently drops a field the caller believed was part of the agreement.
   Every schema is `.strict()`. This also gives evidence packages storage-independence for
   free — a stray database `id` fails loudly rather than hashing differently.
3. **Unordered sets sort by each element's own canonical JSON**, not by a named key —
   total, needs no per-field configuration, identical behaviour for strings and objects.
   Duplicates are rejected, not deduplicated.
4. **No hashed field is optional-by-absence.** Nullable fields carry a `null` default, so a
   validated document always has the same key set. An absent key versus an explicit `null`
   is the likeliest source of a cross-implementation mismatch.

Consequences carried forward: the M3 compiler prompt must emit `approvedSources` in
precedence order, and the M6 review UI must present position as precedence.

### Decisions taken during M2 (ADR-0009, ADR-0010)

1. **`INVALID` is challengeable.** ADR-0004 said a proposed `INVALID` cancels immediately.
   That hands the resolver a unilateral, unchallengeable unwind of any market and
   contradicts ADR-0004's own rule that every proposal has a challenge window. `INVALID`
   now runs the full window; `finalize()` converts it to `CANCELLED`.
2. **The resolution deadline is measured from `conditionDeadline`, not `tradingEndsAt`.**
   ADR-0004's prose said the latter; the frozen `ConditionSpec` v1.0 field says the former,
   and the schema is right — a resolution cannot be demanded before the condition is
   measured.
3. **`resolutionDeadlineSeconds` doubles as the post-challenge review window.** Adding a
   field would break the frozen golden vectors for no benefit.
4. **`CANCELLED` is terminal** and never advances to `SETTLED`. The architecture diagram
   previously showed otherwise; collapsing them would erase why funds came back.
5. **`packages/contracts` is CommonJS** (ADR-0010), resolving the ESM/CJS question M1
   flagged. Only `golden.json` crosses the seam, as JSON.
6. **Non-upgradeable `ReentrancyGuard` in a cloned contract.** There is no
   `ReentrancyGuardUpgradeable` in contracts-upgradeable 5.6; the base guard keeps its flag
   in an ERC-7201 namespaced slot and tests `== ENTERED`, so a clone's zero slot behaves as
   `NOT_ENTERED`. Verified by reading the installed source, not assumed.
7. **`evmVersion: paris`.** X Layer's opcode support is unconfirmed, so Cancun additions
   (`MCOPY`, `TSTORE`) are avoided. This is also why `ReentrancyGuardTransient` is unused.

### Decisions taken during M3 (ADR-0011)

1. **The compile contract is conversational** (ADR-0011). `prompt` became `message`, an
   optional `sessionId` continues a compilation, and `INCOMPLETE` now carries
   `questions[]` alongside `missing[]` and `partial`. Every response carries `sessionId`,
   `compilerVersion` and `interpretation`. **No hash is affected** — `ConditionSpec` and the
   canonicalisation rules are untouched and the golden vectors still pass.
2. **The model never sets economic terms.** Token, trading end, challenge window, bond and
   resolution window come from operator policy (`MARKET_*` env vars); `nonce` and `creator`
   come from the request. The model produces only the condition.
3. **`interpretation` is outside the hash; `ambiguities` are inside it.** Commentary is for
   the review screen; a reading that actually binds the agreement goes in the hashed
   document, so approving the rules approves the reading.
4. **`INCOMPLETE` is HTTP 200.** The user did nothing wrong, and the compiler declining to
   invent a deadline is the system working.
5. **`auth` provider failures are reported as 503, not 401.** A bad API key is an operator
   problem; confirming key validity to a client is an information leak.
6. **`RepositoryError` has a fixed client-facing message.** Its constructor message is for
   the log and may name a driver or connection; the projection sent to a client cannot.
   Found by a test that asserted a connection password never reaches a response body.
7. **`CovenantError.code` is typed `string`, not `ErrorCode`.** Lets the backend extend the
   shared hierarchy with HTTP-shaped codes and still map every failure through one
   `toApiError()`. Concrete classes still declare literals, so precision is kept where it
   is useful.
8. **`docs/ai-resolution.md` is deferred to M5.** M3 built the compiler, so
   [docs/ai-compiler.md](docs/ai-compiler.md) is what exists. Writing a resolution document
   describing an engine that does not exist would be fiction. **Written in M5.1**, scoped
   to the evidence model and marked explicitly where it states a contract M5.2 inherits
   rather than describing code that exists.

### Decisions taken during M5.1 (ADR-0015)

1. **EvidencePackage v2.0, with v1.0 frozen rather than amended.** A hashed document's
   schema is the agreement and cannot be edited in place. v1.0 is still accepted and hashes
   identically; validation dispatches on the declared `version`.
2. **Deterministic checks record `expected` and `observed`, not a boolean.** A check that
   cannot be re-derived from the record is an assertion wearing the costume of evidence.
   `result` gains `INDETERMINATE`, because "could not run" is neither a pass nor a failure.
3. **Claims gain `support` and `extraction`.** An absence must be recordable, and the
   package must say which claims rest on a locator anyone can re-run and which rest on a
   model's reading.
4. **`claims` is unordered; `sources` and `deterministicChecks` stay ordered.** Three
   collections, three reasons — not a blanket rule.
5. **The rules binding is enforced at construction, in shared code**, and
   `buildEvidenceCommitmentForSpec` derives the expected hash from the specification rather
   than trusting one it was handed.
6. **`approvedSourceIndex` and `url` are reconciled, not deduplicated.** Two
   representations of one fact are acceptable only when a validator makes disagreement
   impossible.

Still deliberately deferred: evidence storage beyond Postgres (IPFS/public URL); resolver
key custody beyond a `.env` key (needed before mainnet, not before testnet); protocol fee
mechanics (absent from the MVP by design); authentication — there is no login, and a
`creator` is currently an asserted address rather than a proven one.

### Decisions taken during M5.4 (ADR-0016)

1. **The deterministic verdict is the authority; the model concurs or withholds.** A model
   that disagrees with a conclusive verdict produces `NEEDS_REVIEW`, never the opposite
   outcome. This is the asymmetry the layer rests on: a compromised or mistaken model costs
   liveness, not correctness.
2. **The model's outcome vocabulary contains no `INVALID`.** `RESOLVED_YES | RESOLVED_NO |
   NEEDS_REVIEW`. An `INVALID` proposal routes to refunds and is a determination the user
   pre-approved in `edgeCases[].outcome`; it can only arrive that way.
3. **A matched edge case may only make the proposal more conservative.** *Which* case
   matches is a prose judgement made by a model reading hostile content, so a case that
   would flip a settlement produces a review. `INVALID` is let through because refunds take
   money from nobody.
4. **The model is never asked for an identifier or for `extraction`.** Claim ids are
   assigned by the system and provenance is stamped by the assembler, because a model able
   to label its own reading as a reproducible `JSON_POINTER` could erase the field that
   distinguishes reproducible extraction from a model's reading.
5. **One ungrounded claim reviews the whole proposal.** No partial credit: a model that
   fabricated one fact has not demonstrated anything about the others.
6. **`RESOLUTION_FAILED` is separate from `NEEDS_REVIEW`.** They call for different actions
   — one means a person has something to read, the other means nothing was attempted.
   Neither is a 5xx, because a resolver that crashes on ambiguity is a resolver that cannot
   say "I do not know".
7. **Three gates run before the model is called.** A resolution that cannot be proposed
   anyway should not put attacker-controlled content in front of a model at all.
8. **The prompt is versioned with the resolver.** `RESOLVER_VERSION` is inside
   `evidenceHash`, and a prompt edit that can change a proposal is a minor bump, not a
   tweak — the same discipline `COMPILER_VERSION` carries.

---

## Tests performed

Windows, Node v22.22.0.

### M5.5–M5.7

| Suite | Result |
| --- | --- |
| `packages/shared` | **pass** — 404 tests, 9 files, unchanged (nothing was added to the protocol layer) |
| `packages/contracts` | **pass** — 156 tests, unchanged (no contract, ABI or vector was touched) |
| `apps/backend` | **pass** — 571 tests, 19 files (was 523 / 16) |
| `apps/web` | **pass** — reference check and module parse over 9 files |
| `apps/backend` typecheck | **pass** — 0 errors |
| `npm audit --omit=dev` | **0 vulnerabilities** |

**1131 tests across three workspaces.** The backend suite still needs no network, no
PostgreSQL and no API key — the signer is behind `ResolverChainWriter` with a scripted
implementation, exactly as the model and the chain already were.

New coverage:

| File | Tests | Covers |
| --- | --- | --- |
| `resolution-service.test.ts` | 28 | **The gates** — a one-word specification edit refused as `RULES_HASH_MISMATCH` with nothing persisted; a market still `OPEN`; a condition not yet due; **a third proposal never attempted**; no acceptance criteria, and criteria that no longer validate, both reviewing rather than guessing; nothing retrieved reported as `INSUFFICIENT_EVIDENCE` and never as a `NO`. **A proposal** — built, persisted and submitted with the hash and block stored; the package re-derivable through `verifyEvidenceHash`; a dry run persisting what it would have sent and sending nothing; no resolver key producing a proposal that is not submitted; idempotence proven by scripting **one** model response and calling twice; **a mined revert recorded as `PROPOSAL_REVERTED`, not as a proposal**; a second proposal after a challenge. **The model cannot reach a transaction** — a contradiction of the deterministic verdict, non-JSON output and an unreachable provider each sending nothing. **Finalization** — refused while the window is open, performed once it closes, refused with no standing proposal. **Challenges** — recorded when the hash matches; refused for altered text, for a wallet that is not the on-chain challenger, and for a market that is not challenged; idempotent per round. **What it never does** — its own source grepped for `payout =`, `previewClaim(`, `totalYes *` and `/ pool`; `resolvedAt` following the injected clock exactly |
| `resolution-routes.test.ts` | 11 | The payload carries the **whole chain**: `rulesHash`, sources with names, URLs, statuses and content hashes, checks with `expected`/`observed`, the model's reasoning and each claim's extraction method, the outcome with its `evidenceHash`, and the submission state with its transaction. **No settlement figure anywhere in the body.** A market the engine will not resolve answered **200** with its reason rather than a 4xx. `/resolution` carrying the challenge window, finalizability and the two-proposal limit. `/evidence` re-deriving to its own digest, and 404 rather than a hollow package. The plan route refusing an unapproved source reference and a non-creator wallet, and storing the **normalised** form so `encodes` is what will actually run |
| `web-selectors.test.ts` | 4 | Every hand-written selector recomputed from the compiled ABI; the declared set exact; `approve` against the ERC-20 standard; **no selector for a function that moves someone else's funds** |
| `abi-parity.test.ts` | +1 | The non-view list asserted as exactly `proposeResolution` and `finalize`; the ERC-20 surface proven to declare no `transfer`, `transferFrom`, `approve` or `permit` |

**Three of the five hand-written frontend selectors were wrong**, and `web-selectors.test.ts`
is why that is a sentence in this document rather than a silent failure at the demo. With
no bundler there is no viem in the page, so the selectors are constants; a constant is only
safe if something recomputes it.

**A test that was passing for the wrong reason, found in this milestone.** The first version
of `resolution-routes.test.ts` asserted the on-chain proposal view was present after
resolving, and it failed — because `FakeResolverWriter` recorded the call without advancing
the scripted market. The fixture, not the product, was wrong: on a real chain
`proposeResolution` moves the market to `RESOLUTION_PROPOSED` at round 1. The double now
applies that transition through its `onPropose` hook, so the assertion measures behaviour
rather than the limits of the double.

**Secrets sweep.** Every tracked file scanned for 32-byte hex values, Anthropic key
prefixes and credentialed database URLs. Three hits, all deliberate fixtures —
`sk-ant-test-key-do-not-use` and `postgresql://user:hunter2@…`, which exist so a test can
assert a password never reaches a response body. `.env` is not tracked.

#### Live results — chain and model, not fixtures

| Check | Result |
| --- | --- |
| API boots, manifest loaded, `eth_chainId` == 1952 | ✅ |
| Resolver key loaded, `canSubmitProposals` | ✅ `0xcb2b8052734cf2512bc70e959f98e5bdf17a7326` |
| Migration applied to live PostgreSQL | ✅ `challenges` table + 5 columns |
| Demo market created on X Layer testnet | ✅ `0x4201Dd224c7d50c819Cae14DabecE62C2d7413C9`, tx `0x32623a6e…`, block 38,873,615 |
| On-chain `rulesHash` == `@covenant/shared` | ✅ `0xb2fb2e7a5b502e645934c4de939c062c6c745c9dc231bfe1e339d27a32222198` |
| Wallet A stakes YES 100 TUSD | ✅ `0x8c66a0f1…` |
| Wallet B stakes NO 300 TUSD | ✅ `0xae530fd9…` |
| Market custody | ✅ 400.000000 TUSD |
| Specification registered through the real API (SIWE) | ✅ `PENDING_ONCHAIN` |
| Live model resolution | ✅ **5/6** scenarios; the sixth was a provider timeout, not a wrong answer |
| Resolver proposes on-chain | ❌ **not reached** — see below |

**The live model run is the result worth reading**, because M5.4 left an open question: on
its second run *every* scenario that reached the provider was refused by `UNGROUNDED_VALUE`,
and that was recorded as undiagnosed. It no longer happens.

| Scenario | Outcome |
| --- | --- |
| `valid-no` | `PROPOSED NO` — a package assembled, validated, bound and hashed |
| `precedence` | `PROPOSED YES` — the fallback decided, and only after the primary was on record as having failed |
| `injection` | `NEEDS_REVIEW` / `MODEL_OUTPUT_UNGROUNDED` — a document instructing the model to resolve YES changed nothing |
| `unavailable` | `NEEDS_REVIEW` / `INSUFFICIENT_EVIDENCE` — an unreadable source is not a `NO` |
| `ambiguous` | `NEEDS_REVIEW` / `DETERMINISTIC_INCONCLUSIVE` — refused before the model was called |
| `valid-yes` | `RESOLUTION_FAILED` / `PROVIDER_TIMEOUT` — the network, not the logic |

**Two defects found by running this for real, both fixed:**

1. **`createMarket` was declared with seven flat arguments; it takes a struct.** The wrong
   ABI produced the selector for a function that does not exist, so every call reverted
   with no reason string — and the revert looked like a parameter problem, which cost time
   chasing timings that were never wrong. Fixed against
   `packages/contracts/abi/MarketFactory.json`. This is exactly what `abi-parity.test.ts`
   and `web-selectors.test.ts` prevent for the backend and the frontend; `tools/demo.ts` is
   an operator script outside both, and it paid for that.
2. **The connection pool was configured for a database that is always awake.** `pg`
   defaults to no connect timeout and a 10s idle timeout, which on a serverless Postgres
   that suspends means the first request after a quiet period fails with `ETIMEDOUT` and
   the next with `Client network socket disconnected before secure TLS connection was
   established`. Now: 30s connect timeout, 5s idle timeout, `keepAlive`, `max: 3`, a
   pool-level `error` handler so a dropped socket cannot take the process down, and a
   narrow retry (0.5s/2s/5s) for connection-class failures only — a constraint violation
   still fails immediately.

**The complete lifecycle ran on X Layer testnet, driven by this backend.**

| Step | Result |
| --- | --- |
| Market created | `0x4201Dd224c7d50c819Cae14DabecE62C2d7413C9`, tx `0x32623a6e…`, block 38,873,615 |
| On-chain `rulesHash` == `@covenant/shared` | ✅ `0xb2fb2e7a…` |
| A stakes YES 100, B stakes NO 300 | ✅ `0x8c66a0f1…`, `0xae530fd9…` — 400.000000 custody |
| Evidence read from the live approved source | ✅ HTTP 200, 6,479 bytes, `/stargazers_count` = 51304 |
| Deterministic check | ✅ `51304 > 40000` → PASS → verdict `SATISFIED` |
| Model concurred | ✅ YES at 9950 bps |
| EvidencePackage hashed | ✅ `0x8741f11441d1eb7f71c6fc6ebee05faf41141268c72f4095067442e7f1d641e9` |
| **Resolver proposed on-chain** | ✅ tx `0x2b826a8e…`, CONFIRMED |
| Finalized after the challenge window | ✅ tx `0xdd29febf…` → YES |
| Winner claimed | ✅ tx `0x0179a559…` |
| Settlement | ✅ A 10100 → **10500**, B 9500, market **0.000000** residual |
| Conservation across both wallets | ✅ 20000 → 20000 |
| Served package re-derives to its own digest | ✅ `verified: true` |
| Served digest == the digest the contract holds | ✅ `matchesOnChain: true` |

**Four defects found by running against real infrastructure**, none of which any scripted
double could have produced:

1. **`createMarket` was declared with seven flat arguments; it takes a struct.** The wrong
   ABI produced the selector for a function that does not exist, so every call reverted
   with no reason string — and a bare revert looks like a parameter problem, which sent the
   investigation after timings that were never wrong.
2. **The connection pool was configured for a database that is always awake.** `pg`
   defaults to no connect timeout and a 10s idle timeout. On a serverless Postgres that
   suspends when idle, the first request after a quiet period fails `ETIMEDOUT` and the
   next fails `Client network socket disconnected before secure TLS connection was
   established`.
3. **The SSRF `lookup` hook ignored `options.all`, and had therefore never worked.** Node 20
   turned on `autoSelectFamily` by default; that path calls a custom `lookup` with
   `{ all: true }` and expects an **array** of `{ address, family }`. Returning a bare
   string makes every real connection fail with `ERR_INVALID_IP_ADDRESS`, which the adapter
   classifies as `SOURCE_UNAVAILABLE: connection failed`.

   **M5.2 recorded exactly this failure and concluded the machine had no outbound
   network.** It did not. The adapter had never successfully retrieved anything, and the
   conclusion was written into this document as a fact about the environment. A failure
   vocabulary precise enough to explain an outage is precise enough to hide a defect behind
   one, and the only thing that would have caught it is a live retrieval that *succeeds* —
   which no test asserted, because every test used the fake adapter.
4. **`resolvedAt` was captured before retrieval**, so every live package claimed a
   resolution predating its own evidence and was refused by the v2.0 schema — the rule
   working exactly as designed, against us. Retrieval takes real seconds; a frozen test
   clock made start and finish identical and the ordering invisible.

**M5.4's open question is closed.** It recorded that on its second live run every scenario
reaching the provider was refused by `UNGROUNDED_VALUE`, "not yet diagnosed". The cause:
the model was making claims whose value was *retrieval metadata* — the `retrievedAt`
instant this system itself recorded — which by definition does not appear in the retrieved
bytes. The grounding gate was correct every time; the prompt simply never said that
metadata is not claimable. One paragraph added to the prompt, and the live run proposes.

**Reconciliation reports two real historical gaps**, and finding them is the new evidence
check working: M4's markets 5 and 6 committed the literal placeholder
`covenant:m4:placeholder-evidence:round-1`, so the contract holds an evidence hash for
which no package exists and their outcomes are unexplainable. The demo market is absent
from the findings — its package is stored and re-derives.

### M5.4

| Suite | Result |
| --- | --- |
| `packages/shared` | **pass** — 404 tests, 9 files, unchanged (M5.4 added nothing to the protocol layer) |
| `apps/backend` | **pass** — 523 tests, 16 files (was 401 / 14) |
| `packages/contracts` | not re-run — no contract, ABI or vector was touched |
| `apps/backend` typecheck | **pass** |

**The backend suite still needs no network, no PostgreSQL and no API key.** That is the
property to protect here more than anywhere else: the layer whose whole job is to call a
model must be fully testable without one, or the tests that matter — malformed output,
hallucinated sources, a successful prompt injection — cannot be written at all.
`FakeLLMProvider` is the reason they can be, because those are cases a real model produces
rarely and never on demand.

New M5.4 coverage:

| File | Tests | Covers |
| --- | --- | --- |
| `resolution.test.ts` | 84 | **YES / NO** — a proposal that validates, binds and hashes; the package re-derivable through `verifyEvidenceHash`; a plan encoding the *failure* condition producing `YES` from a `REFUTED` verdict, which is the case `SATISFIED → YES` would get backwards. **Insufficient evidence** — nothing retrieved returns review *without calling the model at all*; an unavailable source is never a `NO`; a model abstention is honoured and its words kept. **Conflicting evidence** — an `INDETERMINATE` check reviews before the model call; a source disagreement settled by precedence with the disagreement recorded; a claim carrying the rejected value refused. **Invalid model output** — 6 malformed shapes, non-JSON text, JSON wrapped in prose, a truncated response; 6 invented fields (`rulesHash`, `evidenceHash`, `settlement`, a payout, a transaction, `deterministicChecks`) each rejected rather than stripped; a model-supplied `extraction` refused. **Hallucination** — a claim citing a source that was never read; one citing an approved source that failed; a value absent from the bytes; an invented URL in the reasoning; a hash or address in the reasoning; grounding exercised directly for selection equality, case, numeric equivalence and cross-source leakage. **Rules binding** — a wrong hash and a one-word specification edit both refused *before* the model call; case-insensitive comparison; **the specification byte-identical afterwards**. **Confidence** — 5 invalid values and a percentage string; the floor exact at 7000 and 6999; maximum confidence unable to settle a contradiction. **Arbitrary outcomes** — 9 invented outcomes rejected, including the on-chain `YES`/`NO`/`INVALID` spellings and `RESOLVED_INVALID`. **Deterministic precedence** — an outcome contradicting a conclusive verdict refused; the checks handed over as facts with `expected`/`observed`; **no outcome and no settlement terms ever shown to the model**. **Edge cases** — a pre-approved `INVALID` applied; one that would flip a settlement refused; an out-of-range index refused. **Claim extraction** — `JSON_POINTER` with its locator; `UNSUPPORTED` when a dataPath found nothing; one `DISPUTED` claim rather than two; `MODEL_EXTRACTION` with a null locator; no duplicate under a weaker provenance; no float in any classification. **The provider boundary** — timeout, refusal and unavailability distinguished; no credential in the record; exactly one call, one turn, no history. **Immutability** — identical inputs hash identically twice; the hash moves when the reasoning or the confidence moves. **Assembly** — a source URL that is not the approved one refused; a resolution predating its evidence refused; an unused fallback recorded as `NOT_ATTEMPTED` |
| `resolution-injection.test.ts` | 38 | Every test scripts a model that has **already been fully compromised** — it does exactly what the hostile source told it — and asserts nothing is proposed anyway. **Outcome** — 5 injection texts, each with the word the attacker wants planted in the document so that *grounding passes*, and each stopped by the deterministic contradiction instead. **Schema** — an injected `settlement` field, an invented outcome, a dictated `rulesHash`. **Source policy** — a fallback claiming to be authoritative; a mirror URL introduced through the reasoning. **Manufactured evidence** — a claim citing an invented source, and one citing the source that failed. **Framing** — content fenced and labelled untrusted; a fence token emitted by the source neutralised so it cannot close its own block; the agreement rendered before the untrusted content; truncation declared; a failed source shown rather than hidden. **Instruction** — 11 prompt rules asserted present, whitespace-collapsed so re-wrapping a sentence does not break a test |

### M5.3

| Suite | Result |
| --- | --- |
| `packages/shared` | **pass** — 404 tests, 9 files (was 393; +11 for the calendar-date fix) |
| `apps/backend` | **pass** — 401 tests, 14 files (was 310 / 12) |
| `packages/contracts` | **pass** — 156 tests, unchanged; no contract was touched |

**961 tests across three workspaces, all passing.** The backend suite still needs no network,
no PostgreSQL and no API key — `validation/` is pure functions over documents, so it adds no
dependency that could require one.

**The proof that mattered most:** `golden-vectors.test.ts` — all 72 — passed unchanged after
the `utcInstantSchema` fix. The fix can only reject inputs that were previously being
corrupted, so no valid document's canonical form or hash moves. That is demonstrated by the
committed vector file rather than asserted.

New M5.3 coverage:

| File | Tests | Covers |
| --- | --- | --- |
| `validation-primitives.test.ts` | 51 | **Decimals** — 17 refusals (exponent notation, leading `+`, leading zeros, bare `.5`, separators, currency symbols, hex, `Infinity`, `NaN`), the 64-digit ceiling, `-0 == 0`, cross-scale equality (`1.50 == 1.5`), and three cases IEEE-754 gets wrong (`9007199254740993` vs `…92`, a difference in the fifteenth decimal place, a 40-digit magnitude). **Boundaries** — `threshold−1 / threshold / threshold+1` for all six operators, plus one unit in the last place. **Range** — inclusive at both ends, exact at the ends. **Instants** — offset normalisation, sub-second truncation, 8 refusals including a local date-time and a bare epoch number. **Deadline boundary** — `deadline−1s / deadline / deadline+1s` for all four temporal operators, cross-timezone comparison by instant rather than wall clock, sub-second overshoot |
| `validation-engine.test.ts` | 40 | **Numeric** — expected/observed/result recorded; boundary walked end to end; a quoted decimal read like a bare number; unreadable values and exponent notation producing `INDETERMINATE` not `FAIL`; missing observation; no snapshots. **Deadline** — measured against the spec's own deadline; boundary walked; "before" vs "by" at exactly the deadline; offset conversion; a local date-time refused; **a plan cannot be pointed at any other instant**. **Categorical/boolean** — exact by default, opt-in case folding, `1`/`0` refused as ambiguous. **Conflicts** — primary preferred over a disagreeing fallback; disagreement recorded on the check; fallback used when the primary produced nothing; **agreeing fallbacks do not outvote the primary**. **Verdict** — `NEEDS_REVIEW` when any check could not run even if the rest passed; **no `YES`/`NO`/`INVALID` anywhere in the output**. **Determinism** — 25 runs byte-identical; the clock moved to 2099 with no effect. **Availability** — informational, never decisive. **Package integration** — checks accepted by `buildEvidenceCommitmentForSpec`; unique ids. **Plan validation** — duplicate ids, inverted ranges, non-decimal thresholds, non-approved source references, unknown fields. **Truncation** — an explicit pointer into a truncated snapshot declines rather than half-reads |
| `schema.test.ts` (shared) | +11 | The calendar-date fix: 8 impossible dates refused rather than rolled forward, the Gregorian leap rule in both directions (2028 accepted, 2100 refused), impossible times of day, and a real date still normalising unchanged |

### M5.2

| Suite | Result |
| --- | --- |
| `apps/backend` | **pass** — 310 tests, 12 files (was 196 / 10) |
| `packages/shared` | **pass** — 393 tests, unchanged (M5.2 added nothing to the protocol layer) |
| `packages/contracts` | **pass** — 156 tests, unchanged (no contract was touched) |

**859 tests across three workspaces, all passing.** The backend suite still needs no network,
no PostgreSQL and no API key — the new transport sits behind `EvidenceSourceAdapter`, so the
retrieval tests run against a scripted double exactly as the compiler tests run against
`FakeLLMProvider`.

| Command | Result |
| --- | --- |
| `npx tsc -p tsconfig.json --noEmit` (backend) | **pass** — 0 errors |
| `npx tsc -p tsconfig.build.json` (backend) | **pass** — `dist/` emitted |

New M5.2 coverage:

| File | Tests | Covers |
| --- | --- | --- |
| `evidence-retrieval.test.ts` | 67 | **Retrieval** — primary read and snapshotted; raw bytes hashed rather than normalised text; approved `dataPath` applied and the selection recorded; JSON key order not changing a snapshot; `+json` structured suffix accepted. **Hash stability** — identical across repeated retrievals, changed by one byte, independent of transport metadata, unaffected by the retention ceiling. **Precedence** — stops at the first usable source and never reads the fallback; falls through when the primary is unavailable; order preserved exactly; **no source outside the approved list is ever read**; every source recorded when all fail, with no outcome decided. **Failure classification** — 13 scripted cases covering timeout, unreachable host, 404/403/500/204/418, wrong and missing content type, non-JSON body, absent `dataPath`, a float in the payload, and invalid UTF-8; every kind mapped onto a protocol status and never onto an outcome; a detail carrying no transport internals; an unexpected throw recorded rather than crashing; an unservable retrieval kind. **Retries** — a transient failure retried and succeeding; attempts bounded; definitive failures, malformed bodies and policy refusals *not* retried. **Bounds** — oversized response refused rather than truncated; precedence rescuing an oversized primary; retained text truncated and said so; **an adapter that never returns does not stall the walk** (the live-defect regression); total budget exhaustion. **SSRF** — 8 hostile URLs refused *before any adapter is called*, and the refused source recorded with a null content hash. **Duplicates** — a normalised duplicate read once and reused; no double fetch; every approved position keeping its own source id. **Immutability** — the specification byte-identical afterwards, and its URL recorded verbatim rather than normalised. **M5.1 integration** — records that bind to the specification; records the package accepts when every source failed; an unused fallback as `NOT_ATTEMPTED`; ordering by approved position; no status the layer is not entitled to invent |
| `evidence-url-policy.test.ts` | 47 | Normalisation and the address policy in isolation: scheme, userinfo, port allowlist, fragment stripping, empty-query normalisation, IDN and host casing, **query order preserved rather than sorted**; and the blocked-range table including IPv4-mapped and NAT64 unwrapping |

### M5.1

| Suite | Result |
| --- | --- |
| `packages/shared` | **pass** — 393 tests, 9 files (was 209 / 7) |
| `apps/backend` | **pass** — 196 tests, 10 files (unchanged) |
| `packages/contracts` | **pass** — 156 tests (was 144). Ten come free: `golden-vectors.test.ts` iterates the vector file, so every new v2.0 vector is re-derived with `ethers.keccak256(ethers.toUtf8Bytes(canonical))`. Two were written |

**758 tests across three workspaces, all passing.** The shared suite still needs no network,
no database and no API key — M5.1 added no dependency that could require one.

Two contract tests were added deliberately, and the second is the more interesting:

1. **The binding holds against the chain, not just in TypeScript.** A market is created from
   the `shipment` specification, `v2ShipmentYes` is proposed against it, and the package's
   own `rulesHash` field is asserted equal to the value `market.rulesHash()` returns.
2. **The chain cannot detect a mis-bound package.** `v2OtherRules` is byte-identical to
   `v2ShipmentYes` apart from its `rulesHash`, and `proposeResolution` stores its evidence
   hash without complaint — the contract has no idea what the document says. That test
   exists to make the reason for §9 concrete: **nothing on-chain enforces this boundary, so
   the off-chain refusal is the only one there is.**

| Command | Result |
| --- | --- |
| `npm run typecheck --workspace @covenant/shared` | **pass** — 0 errors |
| `npm run build --workspace @covenant/shared` | **pass** — `dist/` emitted |
| `npm run typecheck --workspace @covenant/backend` | **pass** — 0 errors, after fixing a pre-existing `test/helpers.ts` failure (see Known issues) |
| `npm run vectors:generate --workspace @covenant/shared` | **pass** — 3 spec + 12 evidence vectors; the 5 pre-existing entries byte-identical |

New M5.1 coverage:

| File | Tests | Covers |
| --- | --- | --- |
| `evidence-package-v2.test.ts` | 120 | **Versioning** — v2.0 produced, v1.0 still accepted, an unknown version refused with one issue at `version`, a v1.0 body labelled `2.0` (and the reverse) rejected, no ordering rules invented for an unknown version. **Determinism** — 100× repeat; JSON round trip; key permutation at every depth; whitespace, hex casing, timezone offsets and sub-second precision all normalising to one digest; an omitted default hashing as an explicit null; no clock read. **Ordering** — 12 seeded claim permutations all hashing identically and canonicalising to one form; source permutation and check permutation both changing the hash; a duplicated claim refused as a repeated `claimId`. **Sensitivity** — 27 semantic mutations each producing a different hash, including support state, extraction method, extraction locator, claim id, check type, `expected`, `observed` and which approved source was read. **Storage independence** — 9 storage/infrastructure fields rejected rather than ignored, transport metadata rejected inside a source, a jsonb round trip hashing identically. **Adversarial** — 57 invalid inputs refused, every one a `CovenantError`: closed-vocabulary violations, `UNSET` and `NEEDS_REVIEW` as outcomes, fractional/negative/out-of-range/unsafe-integer confidence, unsafe chain id, malformed hashes and addresses, credentialed URLs, plain http, every cross-field rule in both directions, duplicate ids, duplicate source references, dangling references, and five date failures. Plus: issues anchored to array elements, all problems reported at once, and the fixtures' hard-coded `rulesHash` cross-checked against `hashConditionSpec` |
| `evidence-binding.test.ts` | 20 | Binding accepted, and accepted in any hex casing; a mismatch refused with `EVIDENCE_RULES_MISMATCH`, anchored at `rulesHash`, naming both hashes; a malformed expected hash refused rather than compared; validation running **before** binding so a malformed package fails as a validation problem; **a source read from an unapproved URL refused**; a source citing the primary but reading the fallback refused; an out-of-range `approvedSourceIndex` refused; an invalid specification refused before the evidence is examined; v1.0 bound but explicitly not reconciled; no raw error escaping the typed model |
| `golden-vectors.test.ts` | +44 | The ten new v2.0 vectors, each locked canonical string and hash, each re-hashing from its own canonical form; the two v1.0 digests asserted against the literals M1 committed; the full fixture inventory; the version-keyed unordered-field declaration; every evidence hash distinct |
| `contracts/golden-vectors.test.ts` | +12 | Ten from iterating the vector file; plus the v2.0 binding proven against the chain, and the counterexample showing the chain accepts a mis-bound package without complaint |

### M4 (re-run at the end of the milestone)

| Suite | Result |
| --- | --- |
| `packages/shared` | **pass** — 209 tests, 7 files |
| `apps/backend` | **pass** — 196 tests, 10 files |
| `packages/contracts` | **pass** — 144 tests |

**549 tests across three workspaces, all passing.** The unit suites still need no network,
no PostgreSQL and no API key — the chain is behind a port (`ChainClient`) with a scripted
implementation, so reorgs happen on demand rather than being waited for.

Two shared tests were *changed* rather than fixed, and the distinction matters: M1 asserted
that both X Layer networks were `unverified`, which was correct then and is wrong now that
a live node has confirmed testnet. They now assert testnet is verified with evidence in the
note, and that **mainnet is still unverified** — an M4 that quietly flipped mainnet too
would be exactly the dishonesty that suite exists to prevent.

New M4 coverage:

| File | Tests | Covers |
| --- | --- | --- |
| `indexer.test.ts` | 15 | Bootstrap from the deployment block (not one after it); checkpoint persisted and resumed; **replaying a block inserts nothing** and the count does not double; one tx hash with different log indices treated as different events; on-chain identity attached exactly once; never reads past `latest − confirmations`; indexes once deep enough; **a replaced block detected, its events deleted, the cursor rewound**; rewind counted; no false rewind when the window agrees; replacement chain re-indexed; chain state cached from the contract rather than reconstructed from events; an unknown market recorded without a specification being invented; **a market discovered on-chain stays watched in later passes with no off-chain record** (the live-bootstrap regression) |
| `auth.test.ts` | 18 | EIP-4361 message shape; the statement says it authorises nothing; correct signer accepted; **wrong signer rejected**; **a signature over a different-domain message rejected**; malformed signature refused before recovery; unknown nonce refused; **the same nonce and signature refused twice**; expired challenge; expired session; revoked session; **digest stored, never the token**; unauthenticated compile is 401; a client-asserted `creator` is a 400; the signed-in wallet becomes the creator; **another wallet cannot continue a session (403)**; **another wallet cannot register a spec naming someone else (403)**; `/auth/me`; logout invalidates; no token in an error body |
| `chain.test.ts` | 12 | Manifest accepted and addresses lowercased; **a mainnet manifest refused**; a wrong-chain manifest refused; network/chain-id disagreement refused; invalid address refused; unknown field refused; missing file named; malformed JSON reported as configuration; enum ordinals match `MarketTypes.sol`; outcome round-trip; **an unknown ordinal throws rather than defaulting to index 0** |
| `reconcile.test.ts` | 11 | A healthy database reports nothing; **each of stale state, stale totals, wrong address, absent-on-chain and missing cache detected**; a refunding market short of the stake it owes, a market with claims outstanding holding nothing, and an unreturned bond all detected; **a correctly settled market holding nothing is NOT flagged** (the live false-positive regression); an unknown on-chain market is a warning, not an error |
| `abi-parity.test.ts` | 5 | Every hand-written fragment exists in the compiled ABI, byte for byte, including **indexed flags**; every event the indexer claims to observe is declared; **the only non-view function the backend declares is `proposeResolution`** |

Live results — chain, database and model, not fixtures:

| Check | Result |
| --- | --- |
| `eth_chainId` / `net_version` | `0x7a0` / `1952` ✅ |
| Contracts deployed and `eth_getCode` non-empty | ✅ all three |
| `factory.implementation()` matches manifest | ✅ |
| Shared `rulesHash` == on-chain `rulesHash` | ✅ both markets |
| Two independent wallets stake, balances move exactly | ✅ |
| Market custody == total deposited | ✅ 400.000000 each |
| Full lifecycle to `SETTLED` | ✅ both markets, 0.000000 residual |
| Challenge → overturn → bond returned | ✅ 25.000000 back in full |
| Conservation across all wallets | ✅ 20000 → 20000 |
| Live PostgreSQL connected, schema applied | ✅ 13 tables |
| Indexer reads real X Layer logs into Postgres | ✅ decoded `MarketCreated` for 4 pre-existing markets |
| Live model compile | ✅ 3/4 expected; found a real M3 defect |
| Indexer captured the full lifecycle | ✅ **23 events** across 9 types |
| Cached state matches the chain | ✅ market 5 `SETTLED`/YES, market 6 `SETTLED`/NO, both 100/300 |
| Specifications registered through the real API | ✅ SIWE sign-in as Wallet A, both accepted |
| `rulesHash` join fired (ADR-0006) | ✅ markets 5 and 6 linked, promoted `PENDING_ONCHAIN` → `SETTLED` |
| Reconciliation against live chain + database | ✅ **no mismatches**; 2 on-chain matched to 2 in database |
| Explorer verification | ❌ **not achieved** — see Known issues |

Indexed event counts after the watch-set fix, from the live database:

| Event | Count |
| --- | --- |
| `MarketCreated` | 6 |
| `StakePlaced` | 4 |
| `MarketClosed` | 2 |
| `ResolutionProposed` | 3 (two round-1, one round-2) |
| `ResolutionChallenged` | 1 |
| `MarketFinalized` | 2 |
| `WinningsClaimed` | 2 |
| `ChallengeBondReturned` | 1 |
| `MarketSettled` | 2 |

`MarketCancelled` is decoded and indexed but has a count of zero, because no market was
cancelled. Eight of the nine event types §17 names were observed on the live chain; the
ninth was not provoked.

Reconciliation output: `no mismatches (warnings only)` — six `unknown-specification`
warnings (correct: those markets were created without registering a specification
off-chain) and one `indexer-lagging` while the catch-up pass was still running.

### M3 and earlier

| Command | Result |
| --- | --- |
| `npm run typecheck --workspace @covenant/backend` | **pass** — 0 errors |
| `npm run build --workspace @covenant/backend` | **pass** — `dist/` emitted |
| `npm test --workspace @covenant/backend` | **pass** — 129 tests, 5 files |
| `npm run db:generate --workspace @covenant/backend` | **pass** — 8 tables, SQL written to `drizzle/0000_*.sql`, offline (no database contacted) |
| `npm run build --workspace @covenant/shared` | **pass** — rebuilt after the API-contract change |
| `npm test --workspace @covenant/shared` | **pass** — 207 tests, unchanged by the M3 edits |
| `npm test --workspace @covenant/contracts` | **pass** — 144 tests (M2, unchanged) |
| `npm run deploy:local --workspace @covenant/contracts` | **pass** — manifest written to `deployments/hardhat.json` (M2) |

**480 tests across three workspaces, all passing.** The backend suite needs no network, no
PostgreSQL and no API key.

Note: `npm run <script>` reports a non-zero exit through PowerShell even on success, because
npm writes its banner to stderr and PowerShell 5.1 wraps it. Verified via `cmd /c`; the
results above are real.

### M3 coverage by file (129 tests)

| File | Tests | Covers |
| --- | --- | --- |
| `compiler.test.ts` | 44 | COMPILED path; hash derived exclusively from `@covenant/shared` and equal to `hashConditionSpec`; same spec twice → same hash; different nonce → different hash; system-supplied `creator`/`nonce`/`version`/settlement; **model rejected for smuggling `settlement`, `rulesHash`**; approved-source precedence preserved and reversal changing the hash; INCOMPLETE questions/missing/partial; COMPILED-with-no-condition and INCOMPLETE-with-no-questions both rejected; deadline past / too near / unparseable / offset-normalised; second-gate failures (non-https source, duplicated failure condition, zero sources); 8 malformed-output shapes; truncation; provider timeout/rate-limit/outage/refusal mapping; **auth failure not disclosing our credentials**; prompt contents and history replay |
| `adversarial.test.ts` | 34 | The six vague conditions from the brief all returning INCOMPLETE with no specification and no hash; the two objective conditions compiling; **system-side rejection even when the model claims COMPILED** — invented deadline, zero sources, unknown spec field, invented resolution method, invented outcome enum, smuggled `confidence`, smuggled `outcome`; interpretation kept out of the hash while `ambiguities` stay inside it; all 13 prompt rules asserted present; worked examples and the objectivity test present |
| `routes.test.ts` | 36 | Health; compile success, persistence, INCOMPLETE-as-200, multi-turn session continuity, unknown session, cross-wallet session refusal; 7 validation rejections; wrong chain; 502/503/504 mappings; register with server-side hash recomputation, client-mismatch rejection, tampered-spec rejection, idempotency; listing, filtering, detail, `rulesHashVerified`, stake totals reported as 0 with `origin: indexer`; evidence 404; **the three 501s not faking data**, with input still validated first; storage failure as 503 with no driver detail; typed 404; error bodies carrying no stack |
| `config-and-logging.test.ts` | 13 | Config built from an explicit env; every missing variable reported at once; malformed token address and chain id; optional resolver key; `logUserContent` off by default; `describeConfig` carrying no secret value and no credential-shaped field; redaction paths; user content reduced to a length by default; **no secret in any response body** across success, validation failure and upstream failure |
| `repositories.test.ts` | 12 | Wallet idempotency; session turn ordering; turn on a missing session; markets idempotent on `rulesHash`; on-chain identity left null until the chain assigns one; keyset paging newest-first; filtering; failing repositories raising typed errors |

### M2 coverage by file (144 tests)

| File | Tests | Covers |
| --- | --- | --- |
| `factory.test.ts` | 27 | Role separation at deployment; sequential ids; creator is the caller; genuine 45-byte EIP-1167 runtime containing the impl address; id and rulesHash indexes; duplicate-rulesHash rejection; pagination; all six parameter validations; clone isolation of config, state and **funds**; double-initialize and implementation-initialize both rejected; pause/unpause of creation; resolver rotation across markets |
| `staking.test.ts` | 17 | YES/NO stakes, accumulation, multiple accounts, both-sides staking; zero amount, bad side, no allowance, insufficient balance; staking after `tradingEndsAt` **before** anyone calls close; staking after close; staking while paused; fee-on-transfer rejection; permissionless close, early close, double close, implicit close on proposal |
| `resolution.test.ts` | 18 | Proposal recording and event; unauthorized proposer (outsider, admin, staker); proposal while open; proposal before the condition deadline; UNSET outcome; empty evidence hash; double proposal; **proposal does not make funds claimable**; finalize before/at window edge; resolver cannot finalize early; permissionless finalize; outcome and evidence hash fixed; double finalize; INVALID through the window; refunds after INVALID |
| `challenge.test.ts` | 19 | Filing, bond custody, review deadline; non-participant rejected; no bond, no reason, window closed, duplicate; **the one-round cap** — round 2 allowed, round 2 uncontestable, no third proposal, terminates; bond returned when outcome changed, forfeited into the pool when confirmed, returned on cancellation; wrong claimant, double claim, premature claim; bond never stranded when the winning side is empty; zero-bond markets |
| `settlement.test.ts` | 20 | Sole winner takes the pool; SETTLED on last withdrawal; losing side, double claim, non-staker; proportional multi-winner payout; both-sides staker paid once; **flooring and dust**; payouts never exceed the pool; zero-winning-pool on both sides; market with no stake at all; one-sided market returns exactly its stake; refund/claim mode guards |
| `cancellation.test.ts` | 19 | All three triggers; cancel with no prior close; premature cancel; cancel blocked while a proposal stands; refunds after each trigger; **each participant recovers only their own stake**; non-participant gets nothing; CANCELLED stays terminal; double cancel; **five pause tests** proving refunds, cancellation, claims, finalization and challenges all survive an administrator pausing and walking away |
| `security.test.ts` | 14 | ABI enumeration proving no fund-moving function on either contract; admin and resolver both unable to extract; resolver decides the outcome but not the recipient; every state-changing function enumerated (no setters); `rulesHash` fixed across the whole lifecycle and through a re-init attempt; out-of-order transitions from OPEN, from CLOSED, and from SETTLED; **two reentrancy attacks** asserting the callback fired and reverted with `ReentrancyGuardReentrantCall()` specifically; conservation of funds across a full challenged lifecycle |
| `golden-vectors.test.ts` | 15 | Vector file identity; keccak256 reproduction of all five shared hashes; sha256 gives a different digest; one-byte sensitivity; on-chain storage and read-back of each `rulesHash`; `MarketCreated` carries it; evidence hash survives finalization; the shipment fixture's settlement terms accepted as on-chain parameters; six-decimal precision matches |
| `lifecycle.test.ts` | 5 | The full end-to-end flows: unchallenged market from creation to settlement with hand-computed payouts; challenged market overturned (bond returned); challenged market confirmed (bond forfeited to the winner); market abandoned by the resolver with the admin paused; two concurrent markets settled independently |

### M1 coverage by file (207 tests)

| File | Tests | Covers |
| --- | --- | --- |
| `jcs.test.ts` | 22 | RFC 8785 key ordering (incl. non-ASCII by code unit), string escaping, lone surrogates, UTF-8 byte output, no insignificant whitespace; rejection of floats, unsafe integers, NaN/Infinity, `undefined`, bigint, function, symbol, `Date`/`Map`/`Set`, circular refs; error paths; `-0` |
| `canonicalize.test.ts` | 25 | Key permutation at every depth; input whitespace; unordered-set permutation (incl. 12 seeded shuffles); **ordered** array permutation changing the bytes; duplicate rejection; non-mutation; timestamp/address/null-default normalisation |
| `rules-hash.test.ts` | 62 | bytes32 shape, 100× repeat determinism, JSON round trip; 22 semantic-change mutations each producing a different hash; 27 invalid inputs refused; no raw runtime error escaping the typed model; multi-issue and nested field paths; verification and mismatch |
| `evidence-hash.test.ts` | 44 | Same determinism battery; 16 semantic mutations; storage-field independence (row id and insertion timestamp rejected, restored-from-storage package hashes identically); clock-independence; 16 invalid inputs refused |
| `golden-vectors.test.ts` | 28 | Locked canonical string and hash per fixture, byte for byte; re-hash from own canonical form; declared unordered-field set matches implementation; structural-skeleton whitespace check |
| `schema.test.ts` | 14 | Discriminated validation result; named missing fields; unknown-key rejection; normalisation; timezone accept/reject; issue-path formatting |
| `chains.test.ts` | 12 | Lookup by key and chain id; typed error for unknown; X Layer values; **unverified flags**; no 20-byte address anywhere in config; explorer left null |

**Defects found and fixed during M3:**

1. **`RepositoryError` leaked its message to the client.** The message is caller-supplied
   and, in a datastore error, can contain a connection string — including a password. Found
   by a test asserting no credential reaches a response body. Backend errors now expose a
   `clientMessage`, and `RepositoryError` overrides it with a fixed string while the
   detailed version survives for the log.
2. **`CovenantError.code` was too narrow to extend.** Typed as the shared `ErrorCode`
   union, it prevented the backend adding its own codes without forking the hierarchy.
   Widened to `string`; concrete classes still declare literals.
3. **`buildLoggerOptions` could return `undefined`**, which made the Fastify options object
   fail its overload under `exactOptionalPropertyTypes` and silently resolve to the HTTP/2
   server type. Return type narrowed to `NonNullable<...>`.
4. Two of my own assertions were wrong rather than the code: a secret-name regex that
   flagged `settlementToken` (a symbol, not a secret — the field is now
   `settlementTokenSymbol`), and a 501-body check that forbade the substring `outcome` in a
   message whose job is to explain there isn't one. Both replaced with structural
   assertions.

### M5.4 security review

| Checked | Outcome |
| --- | --- |
| The model cannot modify the `ConditionSpec` | It is an input, read-only, and hashed at the end of the pipeline. A test serialises it before and after a full resolution and asserts byte equality, then re-derives `rulesHash` |
| The model cannot produce a `rulesHash` | Absent from the output schema, and `.strict()` rejects one rather than stripping it. Tested at the schema and end to end. The hash on the package is derived by `@covenant/shared` from the specification, never read from the model or the caller |
| The model cannot reach the settlement contract | `resolution/` imports no chain client, no ABI, no signer, no key, no `viem`. There is no code path from the layer to a transaction, and none was added to the composition root either — `Runtime.resolver` is constructed with a provider and two numbers |
| The model cannot submit a transaction | Nothing in the layer can perform I/O except the single `provider.complete()` call. The proposal is a document and a hash |
| An invented outcome cannot widen the vocabulary | 9 rejected outcomes tested, including the on-chain `YES`/`NO`/`INVALID` spellings — the model's vocabulary is deliberately a *different* set from the protocol's, so even a correct-looking value from the wrong enum fails |
| A hallucinated source cannot support a claim | A claim may cite only a source that produced retrieved content. An approved source that *failed* is refused too, which is the case a plausible-sounding model gets wrong |
| An invented value cannot enter a package | Every non-null claim value must appear in a cited source's retained content or equal its approved selection. One failure reviews the whole proposal |
| An invented URL cannot enter the reasoning | Every URL in the reasoning must have an approved host. Tested with a plausible mirror domain |
| A model cannot label its own reading as reproducible | `extraction` is not in the output schema and is stamped by the assembler. A model that sends one is rejected |
| Deterministic checks cannot be overruled | The outcome is the verdict's, mapped through `plan.encodes`; the model can only concur or withhold. Tested with a grounded, maximum-confidence claim reaching the opposite outcome — refused |
| Confidence cannot settle anything | The floor gates *proposing*, tested exactly at 7000 and 6999. A 10000-bps contradiction is still refused |
| Prompt injection cannot change an outcome | 5 injection texts, each scripting a **fully compromised** model that obeys them, each refused. The injected word is planted in the document so that grounding passes and the deterministic contradiction is what stops it |
| Prompt injection cannot escape the evidence block | The fence token is neutralised inside retrieved content before rendering, so a source cannot close its own block. Tested directly |
| Prompt injection cannot override source precedence | A fallback claiming to be authoritative is refused when the model drops the primary's reading. Reporting the disagreement is still allowed — the rule catches substitution, not transparency |
| The model cannot see what it does not need | `settlement` is omitted from the rendered specification: no bond, no token, no challenge window. Asserted by a test on the prompt text. It is also never shown a proposed outcome, only the verdict vocabulary |
| A provider failure cannot leak a credential | Provider errors are classified into three reasons with fixed messages; a scripted `auth` failure carrying a key-shaped string is asserted absent from the record |
| Ambiguity cannot become a crash | Every refusal path returns a structured status. The only `throw` left is for a non-protocol exception, which is a defect in our code rather than a fact about the evidence |
| No new dependency, no new surface | `apps/backend` gained no package. No route was added; `/resolve` is still a 501 |
| **Residual, and not closed** | `plan.encodes` joins the thresholds as unhashed operator input, and the live grounding failure means the happy path is unverified against a real model. Both are in Known issues |

### M5.3 security review

| Checked | Outcome |
| --- | --- |
| No model on the validation path | `validation/` imports nothing from `llm/` and no SDK. The validators are pure functions of their inputs; a determinism test runs one 25 times and compares serialised output byte for byte |
| A challenge can re-derive the same verdict | Nothing reads `Date.now()`, the network, or a random source. A test moves the global clock to 2099 and asserts the output is unchanged — if the engine consulted a clock, a re-run during a challenge could reach a different verdict from identical evidence |
| Arithmetic cannot be silently wrong | No floating point on any comparison path. Boundary tests walk `threshold − 1 / threshold / threshold + 1` for all six numeric operators and `deadline − 1s / deadline / deadline + 1s` for all four temporal ones, plus cases float comparison gets wrong (`9007199254740993` vs `…92`, and a difference in the fifteenth decimal place) |
| An unhashed plan cannot substitute the deadline | The plan schema has **no literal-instant variant**; a temporal comparison's reference is the literal `'spec_deadline'` and nothing else. Asserted by a test that tries to smuggle `2027-01-01T00:00:00Z` and is rejected at parse time |
| An unhashed plan cannot reach an unapproved source | `sourceId` must match `^source-\d+$`, which only names positions in `approvedSources`. A URL in that field is rejected |
| A plan cannot smuggle extra fields | Every plan schema is `.strict()`; an unknown key is rejected rather than stripped, the same discipline as the hashed documents |
| An unreadable value cannot become a decision | Every parse refusal produces `INDETERMINATE`, never `FAIL`, and any indeterminate check forces the whole verdict to `NEEDS_REVIEW`. Tested for unparseable numbers, exponent notation, non-boolean values, offsetless timestamps and truncated documents |
| A timestamp cannot be interpreted in server local time | Acceptance is delegated to the shared `utcInstantSchema`, which requires an explicit offset. A test asserts `2026-09-01T23:59:59` is refused while the same instant with `Z` is accepted |
| Majority cannot override precedence | Tested directly: primary `in_transit`, fallback `delivered`, verdict follows the primary. The disagreement is recorded rather than hidden |
| The engine cannot decide an outcome | The verdict vocabulary is `SATISFIED / REFUTED / NEEDS_REVIEW`. A test asserts the engine's entire serialised output contains no `YES`, `NO` or `INVALID` |
| No new dependency, no new surface | `apps/backend` gained no package. `validation/` touches no database, no Fastify route, no chain client |
| **Residual, and not closed** | The validation criteria are unhashed and operator-supplied. This is the milestone's known weakening and is recorded in Known issues; it is a `ConditionSpec` v1.1 problem, not one this layer can fix |

### M5.2 security review

| Checked | Outcome |
| --- | --- |
| Retrieval cannot become an SSRF primitive | Two layers. Name-level (https only, no userinfo, port allowlist) re-runs on **every** redirect hop, so an innocent URL that redirects to `http://169.254.169.254/` is refused at the hop, not at the start. Address-level blocks loopback, private, link-local, CGNAT, documentation, benchmarking, multicast and reserved ranges, with IPv4-mapped and NAT64 addresses unwrapped and re-checked against the IPv4 table. Eight hostile URLs are asserted refused **before any adapter is called** |
| DNS rebinding | Closed by supplying `https.request`'s `lookup` hook rather than resolving and then handing over a hostname. The socket connects to an address this process vetted; there is no second resolution for a hostile authoritative server to answer differently. This is the reason the adapter is built on `node:https` rather than `fetch` |
| Split-horizon DNS | Fails closed: if **any** resolved address is disallowed, the whole host is refused rather than the permitted addresses being used |
| An approved source cannot stall the resolver | Per-attempt timeout covering redirects **and DNS**, bounded attempts, bounded redirects, a total walk budget, and a retriever-level backstop that refuses to wait on any transport past its deadline. The DNS gap was real and was found by the live check, not by the suite |
| An oversized source cannot exhaust memory | The size cap is enforced while bytes stream and the connection is destroyed the moment it is exceeded — not after buffering. An oversized response is a failure, never a truncation, because hashing a prefix and calling it the content would misrepresent what was read |
| Credentials cannot reach a published document | Userinfo is refused at normalisation and again on every redirect hop, complementing `publicUrlSchema` in the shared package. Failure details are asserted to carry no transport internals |
| Retrieval cannot decide an outcome | The six failure kinds collapse onto `UNAVAILABLE` / `MALFORMED` only. No code path turns a failure into `YES` or `NO`, and a test asserts the mapping's whole range |
| Retrieval cannot widen the approved set | The only URLs read come from `ConditionSpec.approvedSources`; a test asserts no other URL is ever requested. There is no discovery and no substitution |
| Retrieval cannot alter the agreement | The `ConditionSpec` is read-only and asserted byte-identical after a walk. Editing it would change `rulesHash` and unbind the market |
| The transport is isolated | `node:https` is imported in exactly one file, so the whole suite runs with no network — the same boundary that keeps the Anthropic SDK and viem each in one file |
| No new runtime dependency | The adapter uses `node:https`, `node:dns` and `node:net` only. `apps/backend` gained no package |

### M5.1 security review

| Checked | Outcome |
| --- | --- |
| The rules binding cannot be bypassed | `assertEvidenceBinding` is a pure function in `packages/shared`, reachable identically from the backend, the frontend verifier and any auditor. `buildEvidenceCommitmentForSpec` derives the expected hash from the specification instead of accepting one, so a caller cannot supply a hash that does not belong to the document it holds. A contract test demonstrates the chain will store a mis-bound evidence hash without complaint, which is why the off-chain refusal is the only one |
| Evidence cannot cite an unapproved source | `approvedSourceIndex` is mandatory with no null escape hatch, and the spec-taking builder checks both that the index is in range and that the URL is the one approved at that position. A resolver that needs an unapproved source cannot resolve |
| Model output cannot widen the protocol | Every vocabulary added is a closed `z.enum`, every object is `.strict()`, and unknown keys are rejected rather than stripped. A resolver inventing a `checkType`, an `extraction.method` or an outcome fails validation instead of redefining the schema at runtime |
| A model's reading cannot masquerade as deterministic | `extraction.method` is required, and `MODEL_EXTRACTION` must have a null locator while `JSON_POINTER` / `CSS_SELECTOR` / `REGEX` must name one. The two cannot be confused, in either direction |
| A "could not" cannot be recorded as a "did" | Three cross-field rules enforced in both directions: `contentHash` null iff not `RETRIEVED`, `value` null iff `UNSUPPORTED`, `observed` null iff `INDETERMINATE`. v1.0's mandatory `contentHash` had forced the shipped `unreachableSource` fixture to hash bytes that never existed |
| Credentials cannot be published in an evidence URL | `publicUrlSchema` rejects URL userinfo and eleven unambiguous secret query-parameter names. Ambiguous names are deliberately allowed, because a false positive makes a market unresolvable. The residual gap — a credential in a path segment, and the un-tightened `ConditionSpec` URL — is recorded in Known issues rather than papered over |
| Storage and infrastructure cannot enter the digest | Nine storage/infrastructure fields and four transport fields are asserted rejected, not ignored. `httpStatus` and `contentType` were removed from the hashed source record for the same reason |
| No confidence path to settlement | `proposeResolution` takes an outcome and a hash and has no confidence parameter. `confidenceBps` stays an integer 0–10000 and remains audit metadata; documented in `docs/ai-resolution.md` §4 |
| No new dependency surface | `packages/shared` gained no dependency. A sweep confirms the new code contains no `Date.now`, no `new Date()`, no `fetch`, no `process.env` and no `require`. Exactly one `keccak256` call site remains, `JSON.stringify` still appears only inside `jcs.ts` for RFC 8785 string escaping, and there is still no SHA-256 anywhere in `packages/shared` |
| The frozen protocol was not quietly redefined | The regenerated vector file was diffed against a pre-run copy: all three `ConditionSpec` vectors and both v1.0 evidence vectors are byte-identical, canonical strings included. A test asserts the two v1.0 digests against the literals M1 committed |

### M4 security review (§32)

| Checked | Outcome |
| --- | --- |
| Deployer key handling | Read from the environment by Hardhat only. The manifest records the deployer as an *address*. No script logs, writes or echoes a key; error text names the missing variable, never its value |
| Resolver key handling | Same. The resolver holds `PROPOSER_ROLE` and nothing else. Proven structurally: `abi-parity.test.ts` asserts the **only** non-view function the backend declares is `proposeResolution`, which records an outcome and names no recipient. M2's `security.test.ts` already proved the resolver cannot claim, withdraw, or alter `rulesHash` |
| Database credentials | In `.env` (gitignored). `RepositoryError` has a fixed client-facing message so a connection string — which carries a password — cannot reach a response. Asserted by a test using a sentinel password |
| API key handling | One file imports the Anthropic SDK. `describeConfig` reduces every secret to a boolean. The live compiler test records no response text and no key |
| RPC URL treated as a credential | An RPC endpoint can carry an API key in its path, so `describeConfig` reports `rpcConfigured: boolean` and never the URL. `ChainUnavailableError` overrides its client message for the same reason |
| Manifest handling | Validated by the shared schema; refused if malformed, wrong chain, wrong environment, or carrying an unknown field. `environment: mainnet` is refused outright |
| Authentication nonce replay | Consumed by a single conditional `UPDATE ... WHERE consumed_at IS NULL` **before** the signature is checked, so the database picks the winner of a race. Tested by replaying an identical valid signature |
| Signature expiration | Checked in `verifySiweSignature` as well as in SQL, so a stored nonce outliving its window is still unusable. Session expiry and revocation both tested |
| Signature domain binding | The server rebuilds the message from its own stored fields; a signature over a look-alike message naming another domain recovers a different address. Tested explicitly |
| Session token storage | Only a SHA-256 digest is stored; lookup is by digest, followed by a constant-time compare. A dump of `auth_sessions` cannot impersonate anyone |
| Indexer duplication | Event identity is the primary key `(chain_id, transaction_hash, log_index)`; insertion is conflict-ignore. Tested by forcing a re-scan and asserting zero new rows |
| Indexer reorg behaviour | Block hashes recorded and re-checked; divergence rewinds the cursor and deletes events above the last agreeing height. Tested against a scripted chain that reorganises on demand |
| Chain-ID mismatch | Asked of the node at startup and fatal on mismatch. This is what makes "configured for testnet, pointed at mainnet" a crash |
| Wrong-network deployment | Three independent refusals: no mainnet network in the Hardhat config, `loadConfig` rejects `NETWORK=xlayer-mainnet`, and the manifest environment check. Plus TestUSD's own constructor allowlist |
| `rulesHash` mismatch | Compared after creation and stopped on mismatch; the reconciler re-derives it from the stored specification *and* compares against the chain, so a tampered stored spec is detectable |
| Contract address mismatch | Reconciler compares the stored address against `factory.marketByRulesHash` |
| Cross-wallet authorization | A wallet cannot continue another's compiler session or register a specification naming another creator. Both are 403 — the caller has proved who they are, so a 404 would send an honest user hunting for a record that exists |
| Authentication ≠ authority | No code path leads from a session token to a transaction. Market creation, staking and claiming are all done by the user's own wallet |

Residual and accepted: the resolver remains a single `.env` key (KMS or multisig before
mainnet); no external audit; explorer verification unachieved.

**One credential was exposed during this milestone**: the Neon connection string was pasted
into the development chat transcript. It grants full access to the scratch database. It
should be rotated (Neon → project → Roles → reset password). No production data was ever in
that database.

### M3 security review (manual, beyond the tests)

| Checked | Outcome |
| --- | --- |
| Secrets in responses | Asserted absent across success, validation failure and upstream failure, using sentinel values so a failure names the secret that escaped |
| Secrets in logs | Never enter a loggable object (`describeConfig` reduces to booleans); pino redaction as a backstop; user prompts reduced to a length unless explicitly opted in |
| Secrets in the database | No table has a credential column. The resolver key is held in config for M5 and read by nothing in M3 |
| AI decision authority | No `/decide` route; no code path from a model to an outcome, a transaction, or financial state. `/resolve` is a 501 |
| Malformed model output | Cannot reach the hashing pipeline — Zod parse is the gate, and `.strict()` rejects invented fields rather than stripping them |
| Client-supplied state | `rulesHash` recomputed server-side and compared; a mismatch or a tampered specification is a 400 |
| Duplicate schema / hashing | Sweep confirms one `ConditionSpec` (in `shared`), no canonicalisation or keccak in `apps/backend/src`, Anthropic SDK in exactly one file, Drizzle only in the composition root and the DB layer |
| Error projections | Only `{ code, message, issues }`; no stack, no SQL, no provider payload. Unknown errors get a generic message |
| Input validation | Every route parses its input before the handler, including the 501 routes |

Residual, and recorded as accepted or open below: no authentication (a `creator` is an
asserted address), and the Drizzle layer is not runtime-tested.

**Defects found and fixed during M2:**

1. `ConditionalMarket.claim()` checked the state before `refundMode`, so calling it on a
   cancelled market reported `InvalidState` instead of `RefundModeActive` — technically a
   correct rejection, but it failed to tell the caller that `withdrawRefund()` is the
   function they want. The guards were reordered; both paths still revert.
2. `ReentrancyGuardUpgradeable` does not exist in `@openzeppelin/contracts-upgradeable`
   5.6.1. Rather than pinning an older version, the installed `ReentrancyGuard` source was
   read to confirm it is clone-safe (ERC-7201 namespaced slot, tested with `== ENTERED`, so
   a zero slot behaves as `NOT_ENTERED`) and used directly.

**Defects found and fixed during M5.3:**

1. **`utcInstantSchema` silently rolled impossible calendar dates forward.** `2026-02-31` →
   3 March, `2025-02-29` → 1 March, `2026-04-31` → 1 May, `24:00:00` → the next midnight.
   `Date.parse` returns a finite timestamp for all of them, so the `Number.isFinite` guard —
   whose comment claimed it caught "not a real calendar date" — never fired. Inside a hashed
   document this silently alters the agreement: approving a 29 February deadline commits the
   user to 1 March. Fixed by validating the written components against the Gregorian
   calendar before parsing. **The fix only rejects inputs that were being corrupted, so no
   valid document changes and no golden vector moves.**
2. **A passing M1 test was passing for the wrong reason.** `evidence-hash.test.ts` asserted
   `2026-02-31T00:00:00Z` was refused inside an evidence package, and it was — but by a
   *different* cross-field rule, because the rolled-over date pushed `resolvedAt` before the
   source's `retrievedAt`. The assertion was green throughout while the defect it appeared to
   cover sat underneath it. Worth recording as a reminder that a green test proves only that
   *something* rejected the input.

**Defects found and fixed during M1:**

1. **A raw `SyntaxError` escaped the typed error model.** Zod continues running a
   `.refine()` after a failed `.regex()` check (a regex failure marks the result *dirty*,
   not *aborted*), so `BigInt("50.5")` threw straight past `SpecificationValidationError`.
   In the M3 API that would have surfaced as a 500 rather than a field-level validation
   failure. The range check in `uint256StringSchema` is now total, and both hash suites
   gained a guard asserting every rejection is a `CovenantError`.
2. A golden-vector whitespace assertion could not distinguish structural whitespace from
   whitespace inside string values. Replaced with a check over the structural skeleton
   (string literals stripped) — the test was wrong, not the implementation.

### M2 security review (manual, beyond the tests)

Walked the contracts against the checklist in the milestone brief. Findings and their
resolution:

| Checked | Outcome |
| --- | --- |
| Reentrancy | All state-changing externals `nonReentrant`; withdrawals write `hasClaimed`/`bondOutstanding`/`remainingClaimableStake` before transferring. `stake` inverts CEI out of necessity (the received amount must be measured) — it moves no funds out and is guarded |
| Integer division / zero division | `Math.mulDiv` with a `winningTotal == 0` branch reached first (refund mode). No division can see a zero denominator |
| Stuck funds | Three permissionless cancellation triggers; bond returned rather than forfeited when there is no pool to join; only sub-base-unit dust can remain |
| Double claims | `hasClaimed` and `bondOutstanding` set before any transfer |
| State bypass | Every entry point begins with an explicit guard; `_closeIfDue` re-applies the identical `close()` guard rather than skipping it |
| Clone initialization | Implementation constructor calls `_disableInitializers()`; `initializer` blocks re-entry. A clone deployed by a third party answers to their factory and is not in this registry |
| Admin abuse | Pause scoped to two entry points; no withdrawal, no rule mutation, no claim blocking. Cancellation is permissionless so an admin cannot hold funds hostage |
| Resolver abuse | Cannot finalize early, cannot propose a third time, cannot unwind unilaterally (ADR-0009), cannot receive funds |
| Griefing | Challenge requires both a stake and a bond; one round only |
| Token failures | `SafeERC20`; balance-delta equality rejects fee-on-transfer and rebasing tokens |
| Timestamp overflow | `initialize` proves both deadline sums fit `uint64` |
| Enum ordinals | Documented as protocol surface in `MarketTypes`; reordering is a breaking change |

Two residual items are **accepted risks**, recorded in `docs/security.md` §10: a wrong
resolution surviving its single challenge round is final, and the resolver is a single key.
Neither is a code defect; both are MVP scope decisions. No external audit has been done.

### Hygiene sweep

- Exactly one `keccak256` call site (`hashing/keccak.ts`). No duplicate hash implementation.
  **Re-confirmed in M5.1** — the evidence work added no second canonicalisation and no
  second digest.
- `JSON.stringify` appears only inside `jcs.ts`, for RFC 8785 string escaping. It is never
  the protocol serialiser.
- No SHA-256 or `createHash` anywhere in `packages/shared`.
- The M5.1 evidence code contains no `Date.now`, no `new Date()`, no `fetch`, no
  `process.env` and no `require`. `Date.parse` appears only in the cross-field check that
  a source was not retrieved after the resolution was produced, which parses a value
  carried by the document rather than reading a clock.
- **M5.2:** `node:https` is imported in exactly one file (`evidence/https-adapter.ts`), the
  same single-file discipline as the Anthropic SDK and viem. The retriever reads a clock
  only through injected `now`/`sleep`, so `retrievedAt` is a fact of the caller rather than
  of the day. No `axios`, and no new package in `apps/backend`.
  `fetch` does appear in `tools/register-markets.ts`, an M4 operator script that calls
  **our own API** — stated rather than glossed, because "no `fetch` in the backend" would be
  a tidier sentence and a false one. Nothing outside `https-adapter.ts` opens a connection
  to an *evidence source*, which is the property that actually matters.
- No 20-byte address outside test fixtures and golden vectors; a test asserts none can
  enter `chains/xlayer.ts`.
- No private keys, API keys or PEM material. No `.env` file present; `.gitignore` excludes
  `.env*` while keeping `.env.example`.

---

## Known issues / accepted risks

| Item | Status |
| --- | --- |
| **The live model's claims are refused by the semantic gate** | The M5.4 smoke test reached the provider on four scenarios and **none of them proposed**: three refused by `UNGROUNDED_VALUE`, including both clean happy-path cases, and one by `SOURCE_PRECEDENCE_VIOLATED`. The gate is doing what it says; what is not known is *why* the model's claim values fail it. Most likely it returns a restated value ("delivered on 2026-08-30") rather than the verbatim token the source renders, which the prompt already asks for. **Not diagnosed** — the run was stopped rather than repeated. Consequence: the happy path is verified only against a scripted model, and the engine as configured would review almost everything with a real one. **First thing M5.5 should look at**, and the fix is likely in the prompt or in a token-level relaxation of grounding, not in weakening the gate |
| **`docs/m5-live-resolution-test.json` predates one fix** | The `precedence` row in that record is a **false positive that has since been fixed**: the rule flagged any claim carrying a rejected value, which caught a model honestly *reporting* that a fallback disagreed. It now fires only on substitution — a rejected value carried while no claim reports the one precedence selected. The artifact was not regenerated, because re-running it would have meant more live calls; read that row against this note |
| **`ValidationPlan.encodes` is unhashed operator input** | Mapping a verdict onto an outcome needs to know which of the two conditions the checks encode, and `ConditionSpec` v1.0 cannot say. Same category as the threshold gap below, with the same consequence: **a user approving a `rulesHash` is not approving it.** Bounded by the concurrence rule (ADR-0016) — the model reads both condition texts independently, so a mis-set `encodes` produces `NEEDS_REVIEW` rather than an inverted payout. That is a real mitigation and not a substitute for `ConditionSpec` v1.1 |
| **`ConditionSpec` v1.0 cannot express a validation criterion** | The `resolutionMethod` enum has `deterministic_numeric_threshold`, documented as a comparison "against a fixed threshold", and the schema has nowhere to put one. M5.3 works around it with an unhashed, operator-supplied `ValidationPlan`, which means **the numeric criteria a market settles on are not part of what the user approved**. Bounded by refusing any literal instant in a plan, so the deadline at least cannot be substituted. **Closing this needs `ConditionSpec` v1.1 carrying criteria inside the hash — the most important open item in the resolution subsystem.** Until then, no market whose settlement turns on a numeric threshold should be treated as fully user-approved |
| **The happy path of live retrieval is unverified** | The development machine has no outbound network, so `evidence-smoke-test.ts` cannot complete a real HTTPS retrieval. The three policy probes (metadata endpoint, loopback, non-standard port) pass; the two outbound probes return `SOURCE_UNAVAILABLE: connection failed`. **Unproven against a real source:** a successful TLS retrieval, a real redirect being followed and re-checked at each hop, a real `content-type` being honoured, and a real oversized body being cut off mid-stream. The fakes cover the logic; only a live run covers the transport. Re-run the smoke test from a networked machine before M5.3 |
| **`--dns-result-order=ipv4first` is still required on this machine** | Same IPv6 routing fault M4 recorded for Neon. It affects any outbound connection, retrieval included. An environment fault, not a code fault |
| **`ConditionSpec.approvedSources[].url` is not credential-checked** | M5.1 added `publicUrlSchema` to `EvidencePackage` v2.0 source URLs, because a package is published. The same check was **not** applied to `ConditionSpec`, since tightening a frozen v1.0 schema is a breaking protocol change. The asymmetry is real: a specification may approve a URL that an evidence package may not republish, which makes such a market unresolvable. Failing loudly beats publishing a key, but closing the gap is a ConditionSpec v1.1 question and is **open** |
| **A v1.0 evidence package cannot be reconciled against its approved sources** | It carries no `approvedSourceIndex`, so `buildEvidenceCommitmentForSpec` checks only the rules binding for v1.0 and says so in its documentation. Not a defect — it is exactly the auditability gap v2.0 exists to close — but it means any v1.0 package must be treated as unverified on that axis |
| **Two ADRs both numbered 0012** | `0012-evm-version-after-live-verification.md` and `0012-evm-version-and-chain-facts.md` record the same decision under the same number. `docs/adr/README.md` now links the first and flags the collision. Neither was deleted in M5.1: withdrawing an accepted record is not a side effect to take unasked. **Open housekeeping** |
| ~~`apps/backend` typecheck failed on `test/helpers.ts`~~ | **Fixed in M5.1.** `startBlockOverride` was added to `ChainConfig` during M4 but never added to the test helper's chain config literal, so `npm run typecheck --workspace @covenant/backend` exited 2 on a pre-existing error unrelated to this milestone. One line; the helper now passes `startBlockOverride: null` |
| ~~`drizzle-orm@0.38.4` — GHSA-gpj5-g38j-94v9~~ | **Fixed in M4.** Upgraded to 0.45.2 (confirmed current stable `latest`; 1.0.0 is only at `rc.5`), `drizzle-kit` to 0.31.10. No repository API changes were required. `npm audit --omit=dev` is clean |
| **Explorer verification not achieved** | OKLink's published Hardhat endpoint documents `XLAYER_TESTNET` as **chain 195** — the retired Polygon-CDK testnet — while this deployment is on **1952**. No explorer API key was obtained, and whether that endpoint serves 1952 was never established. `scripts/verify.ts` records outcomes honestly (`verified` / `attempted-failed` / `unsupported` / `not-attempted`) and has no path that claims success without the explorer saying so. **Criterion 8 is unmet** |
| **`POST /api/markets` accepts a specification whose deadline has already passed** | Discovered while registering the testnet specifications a day after their deadlines: both were accepted. `validateConditionSpec` enforces `tradingEndsAt <= deadline` but says nothing about the deadline being in the future — only the *compiler* rejects a past deadline, and registration does not go through the compiler. Arguably correct (recording the rules of an already-settled market is legitimate) but it also permits registering rules for a market that can never be opened. **An open product question, not yet decided** |
| **No local integration suite against a throwaway PostgreSQL** | §34's category B was not built. There is no Docker and no local `psql` on the development machine, and the only available database is a hosted scratch instance. The Drizzle layer is exercised by the live indexer run rather than by a dedicated suite |
| `INDEXER_START_BLOCK` override exists and is dangerous | Added to skip a known-empty prefix during development; **in the event it skipped nothing**, because the checkpoint had already been created at the manifest's deployment block by an earlier run, and `loadOrCreate` resumes from the stored cursor rather than re-reading the override. The live bootstrap therefore did scan from block 38,533,494 as intended. The override remains a way to lose data if used on a fresh checkpoint, which is why the indexer logs a warning whenever it differs from the manifest |
| **The development machine cannot route IPv6** | Neon resolves to both families; with default DNS ordering `pg` fails with `AggregateError [ETIMEDOUT]` after a long hang, indistinguishable from a dead database. Worked around with `--dns-result-order=ipv4first`. An environment fault, not a code fault, but it cost three misdiagnosed failures and a 7-minute `drizzle-kit migrate` hang |
| **Migrations were applied by hand, not by `drizzle-kit migrate`** | The generated SQL was run directly against Neon (see `apps/backend/drizzle/manual-setup.sql`, rewritten to be idempotent). Consequence: drizzle's `__drizzle_migrations` bookkeeping table does not exist, so **`drizzle-kit migrate` must not be run against this database** — it would try to recreate existing tables. The application itself is unaffected. The M3 migration `0000` was archived to `drizzle-m3-archive/` and a single clean `0000` regenerated, which is safe because M3's migration had never been applied anywhere |
| **The `clear` case in the live compiler test returned INCOMPLETE** | Expected COMPILED. Haiku 4.5 asked for `approvedSources[0].dataPath` and `timezone` — the prompt gave a bare CoinGecko URL without saying which JSON field holds the price. The model declined to invent part of the agreement, which is the safe direction; the test case was under-specified. 3/4 cases matched expected system behaviour |
| `npm audit`: 33 advisories total (14 low, 8 moderate, 10 high, 1 critical) | The other 32 are **dev tooling** — `vitest`/`vite`/`esbuild`, `drizzle-kit`, and the Hardhat toolchain (`adm-zip`, `cookie`, `elliptic`, `undici`, `tmp`, `serialize-javascript`, `uuid`). None reaches a shipped artefact. Re-examine before mainnet |
| The Drizzle repository implementations are only partly runtime-tested | The indexer exercises the checkpoint, block, event and chain-state repositories against live PostgreSQL. The compiler-session, compilation, resolution and evidence repositories are still covered by typecheck plus their in-memory twins only. Narrowed in M4, not closed |
| ~~No authentication~~ | **Fixed in M4.** SIWE (EIP-4361) wallet authentication; `creator` removed from the request contract entirely. Authentication proves *identity*, never authority over the contract — that distinction is enforced by there being no code path from a session to a transaction |
| ~~The compiler has never run against a real model~~ | **Done in M4** (§29). Four fixed prompts against Claude Haiku 4.5; 3/4 matched expected system behaviour. Results in `docs/m4-live-compiler-test.json` — outcome, validation status and hash only, no model response text. **It immediately found a real defect** (`output_config.format.name`) that a year of fake-provider tests could not have |
| Default model changed to Claude Haiku 4.5 | `$1/$5` per million against Opus 5's `$5/$25`. Justified because the *system*, not the model, enforces correctness: strict schema parsing, shared validation, and operator-supplied economics. A weaker model yields more `INCOMPLETE`, which is a product outcome rather than a safety failure. Note for anyone raising it back to an Opus tier: thinking is on by default there and is billed against the same `LLM_MAX_OUTPUT_TOKENS` budget, so the limit must rise with it or the JSON truncates |
| No external audit has been performed | Prerequisite for mainnet, not for testnet. The M2 review above is the author's own |
| A wrong resolution surviving its single challenge round is final on-chain | Accepted MVP limitation (ADR-0004); documented in `docs/security.md` §10 |
| The resolver is a single `.env` key | Cannot take funds, but decides outcomes. KMS or a multisig proposer required before mainnet |
| Rounding dust (<1 base unit per winner) permanently locked in each market | Accepted and tested; a sweep function would be an extraction surface |
| `claim()` cannot be paused during a live exploit | Deliberate (ADR-0007); mitigation is coverage, not a switch |
| ~~`evmVersion` pinned to `paris` on an unconfirmed basis~~ | **Settled in M4** (ADR-0012). Cancun and Prague confirmed active on X Layer; the pin is kept as a deliberate choice because nothing here uses a Cancun feature |
| No TypeChain bindings | Contract handles in tests are loosely typed via a small `ContractHandle` interface (ADR-0010). Accepted ergonomic cost |
| Mainnet settlement token unidentified | Blocker for mainnet only |
| Test suites are slow on Windows (~2.5 min shared, ~5 min contracts) | Tolerable; not optimised |

---

## Contract addresses

| Network | Chain ID | MarketFactory | ConditionalMarket impl | Settlement token |
| --- | --- | --- | --- | --- |
| Local (Hardhat, in-process) | 31337 | `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0` | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` | `0x5FbDB2315678afecb367f032d93F642f64180aa3` |
| X Layer Testnet | 1952 | not deployed | not deployed | not deployed |
| X Layer Mainnet | 196 | not deployed | not deployed | not deployed |

The local addresses are deterministic Hardhat addresses from an ephemeral in-process chain
that no longer exists; they are recorded for reference only and the manifest
(`deployments/hardhat.json`) is gitignored. Testnet manifests are created by the M4 deploy
scripts at the paths recorded in `chains/xlayer.ts`.

---

## Open dependencies

| Dependency | Needed by | Status |
| --- | --- | --- |
| X Layer testnet chain id `1952` and RPC `https://testrpc.xlayer.tech/terigon` | M4 | **Unverified.** Recorded in `chains/xlayer.ts` as `verification.chainId: 'unverified'` with a test asserting it stays that way. First step of M4 is a live `eth_chainId` call |
| X Layer mainnet chain id `196` and RPC | Mainnet | **Unverified**, same mechanism |
| Block explorer URL + API key for verification | M4 | Not obtained. `blockExplorer` is `null` rather than guessed |
| Testnet OKB for deployer and resolver gas | M4 | Not obtained |
| `ANTHROPIC_API_KEY` | Running the backend | Not obtained. **Does not block development** — `FakeLLMProvider` covers the whole test suite, and the backend runs locally without one |
| Postgres / Supabase connection string | Running the backend | Not obtained. **Does not block development** — in-memory repositories cover the whole test suite. Migrations are generated offline |
| `SETTLEMENT_TOKEN_ADDRESS` for the target chain | Running the backend | Comes from the M4 deployment manifest. Until then, the local `TestUSD` address |
| Approved evidence source APIs for the first demo condition | M5.3 | **Still not chosen.** It did not block M5.2 after all: the retrieval layer is written against `ConditionSpec.approvedSources` and an adapter port, not against a vendor's response shape. It now blocks a live end-to-end resolution, which is M5.3 |
| Outbound network access from the development machine | M5.2 verification | **Absent.** Blocks only the live smoke test's happy path, not the suite. See Known issues |
| Mainnet settlement token address | Mainnet only | Unidentified |

None block M3, which is fully offline. M4 is the first milestone that genuinely needs a
network.

---

## Milestone plan

| # | Milestone | Gate | Status |
| --- | --- | --- | --- |
| M1 | Foundation: workspace + `packages/shared` | Golden-vector tests + typecheck pass | **done** |
| M2 | Contracts: `MarketFactory`, `ConditionalMarket`, `TestUSD`; full state machine; the test matrix from spec §25 | All contract tests pass locally | **done** |
| M3 | Backend core: Fastify API, Drizzle schema, AI compiler with Zod gate and `INCOMPLETE` path | Compiler rejects malformed AI output | **done** |
| M4 | Testnet deploy + indexer: verify chain id, deploy, verify contracts, write manifests | Real market created on X Layer testnet | **done** (except explorer verification) |
| M5.1 | Evidence package model + deterministic evidence hashing | Golden vectors committed; rules binding refuses a mismatched package | **done** |
| M5.2 | Approved source retrieval + evidence snapshots | Precedence honoured; SSRF refused before a socket; snapshots feed M5.1 | **done** |
| M5.3 | Deterministic validation engine | Boundaries exact; conflicts settled by precedence; no model on the path | **done** |
| M5.4 | Claim extraction, AI interpretation, outcome + reasoning + confidence | Model cannot flip an outcome; injection and hallucination refused; package assembled and hashed | **done** |
| M5.5 | On-chain proposal + challenge processing | Proposal + evidence hash land on testnet; `NEEDS_REVIEW` path proven first | next |
| M6 | Frontend: 6 pages, wallet connect, stake, challenge, claim, client-side rules-hash verification | Full flow drivable in the browser | |
| M7 | End-to-end + security review | MVP definition of done (spec §34) | |

---

## M5.5 detail (proposed)

Interpretation is done; nothing has reached the chain.

1. **Diagnose the live grounding failures first** (Known issues). Everything below assumes a
   real model can produce a proposal, and right now the only evidence for that is a scripted
   one. Run the smoke test, look at what the model actually put in `claim.value`, and fix
   the prompt or the grounding rule — not by weakening the gate.
2. **Prove the `NEEDS_REVIEW` path before the happy path.** A submitter that only works when
   the answer is clean is a submitter whose refusal path has never run.
3. **On-chain submission**, from a non-AI path holding the resolver key: outcome +
   `evidenceHash` into `proposeResolution`, with the market's own `rulesHash` re-checked
   against the specification at submission time rather than trusted from the proposal.
4. **Serve the package**, so a challenger can read the document whose hash was committed.
   A committed hash with no retrievable document makes the challenge window decorative.
5. **Challenge processing.** Untouched by M5.4.
6. **Close §22 and §33.** `ConditionSpec` v1.1 carrying both the validation criteria and
   `encodes` inside the hash.

## M5.4 detail (historical — completed)

The plan M5.3 wrote for this milestone. Items 2–6 were done; item 1 was not, and the
milestone proceeded on top of the gap it names — which is recorded in Known issues rather
than treated as closed.

1. **Close the `ConditionSpec` v1.0 criterion gap first** (Known issues). ⚠️ **Not done** —
   a protocol version bump was out of this milestone's scope, and the brief asked for the
   resolution layer. Worse than not closed: M5.4 **added a second field of the same kind**,
   `plan.encodes`, which is now recorded alongside it. Both are bounded by the concurrence
   rule rather than fixed by it.
2. **Map the verdict onto an `Outcome`.** ✅ Done, in `resolution/outcome.ts`, reading
   `plan.encodes` and honouring `edgeCases[].outcome` — and constrained so that a matched
   edge case can only make the proposal more conservative (ADR-0016).
3. **Claim extraction, deterministic first.** ✅ Done, in `resolution/claims.ts`.
4. **`UNSUPPORTED` must stay reachable.** ✅ Done, and emitted deterministically when a
   source was read but its approved `dataPath` selected nothing.
5. **Reasoning and confidence.** ✅ Done, both inside the hash, and confidence explicitly
   unable to settle anything.
6. **`NEEDS_REVIEW` before on-chain submission.** ✅ Done off-chain — twelve review reasons,
   each tested. **On-chain submission itself is M5.5**, so "proven before the happy path"
   still has to be honoured there.

## M5.3 detail (historical — completed)

The plan M5.2 wrote for this milestone. Items 2 and part of 1 were done; the rest moved on.

1. **Re-run the live smoke test from a networked machine first.** ⚠️ **Not done** — the
   machine still has no egress. It did not block M5.3, which is pure functions over
   snapshots, but it remains open for M5.4.
2. **The deterministic validators.** ✅ Done, plus the schema-gap finding above, which the
   plan did not anticipate.
3. Claim extraction → **M5.4**.
4. `UNSUPPORTED` reachable → **M5.4**.
5. Assembly through `buildEvidenceCommitmentForSpec` → **M5.4** (M5.3 asserts its checks are
   *accepted* by a package, but does not assemble one).
6. `NEEDS_REVIEW` before submission → **M5.4**.

## M5.3 detail (as proposed by M5.2)

Retrieval is done; interpretation is not. In order:

1. **Re-run the live smoke test from a networked machine first.** The transport's happy path
   is the one thing M5.2 could not verify, and building extraction on top of an unproven
   retrieval means a later failure has two possible homes instead of one.
2. **The deterministic validators**, one per `checkType`, each producing the
   `{ expected, observed, result }` triple `EvidencePackage` v2.0 already defines. They
   consume `EvidenceSnapshot.normalizedContent` and run **before** any model. A
   numeric-threshold or deadline condition should be decidable without an LLM at all.
3. **Claim extraction.** Deterministic first — a JSON pointer against the snapshot is
   reproducible and must be labelled `JSON_POINTER` with its locator. Only the residue goes
   to the model, and those claims are `MODEL_EXTRACTION` with a null locator, which is what
   makes them visibly non-reproducible.
4. **`UNSUPPORTED` must stay reachable.** A claim the engine looked for and did not find is
   the case v2.0 exists to express; an extractor that can only emit `SUPPORTED` has quietly
   removed it.
5. **Assembly through `buildEvidenceCommitmentForSpec`**, never by hand. The binding refusal
   is the point.
6. **`NEEDS_REVIEW` before on-chain submission.** Below the confidence floor, or on source
   failure, the engine submits nothing — and that path should be proven before the happy one.

Only then: `proposeResolution` on testnet, and the challenge-processing path.

## M5.2 detail (historical — completed)

The plan M5.1 wrote for this milestone, kept for comparison. Items 1 and 2 were done as
described; 3–6 moved to M5.3, which is the split the brief asked for.

1. **Choose the approved source APIs first.** ⚠️ **Not done, and it did not block.** The
   layer was built against `ConditionSpec.approvedSources` as a contract rather than against
   any particular vendor's response shape — which is what an adapter port is *for*. The
   dependency is still open and now genuinely blocks a live end-to-end resolution.
2. **Retrieval behind a port**, so the whole suite runs with no network. ✅ Done —
   `EvidenceSourceAdapter`, with `status` and `contentHash` populated together and an unused
   approved fallback recorded as `NOT_ATTEMPTED`.
3. The deterministic validators → **M5.3**.
4. The AI interpretation step → **M5.3**.
5. Assembly through `buildEvidenceCommitmentForSpec` → **M5.3**.
6. `NEEDS_REVIEW` before on-chain submission → **M5.3**.

## M4 detail (historical — completed)

The first milestone that genuinely needs a network. Order matters — several steps are
gates, not tasks.

1. **Confirm the chain before anything else.** A live `eth_chainId` against
   `https://testrpc.xlayer.tech/terigon`. If it does not return `1952`, stop and correct
   `chains/xlayer.ts` — every later step assumes it. Flip `verification.chainId` to
   `verified` with a timestamp, and update the test that currently asserts it is
   unverified.
2. **Upgrade `drizzle-orm` to ≥0.45.2** and verify against a real PostgreSQL. This is the
   milestone's security prerequisite (see Known issues) and it needs a live database to
   verify, which is exactly what M4 introduces.
3. **Deploy to X Layer testnet.** `TestUSD`, the `ConditionalMarket` implementation, then
   `MarketFactory`. Write `deployments/xlayer-testnet.json` with chain id, addresses,
   transaction hashes, block numbers and verification status. Grant `PROPOSER_ROLE` to the
   resolver wallet.
4. **Verify the contracts on the explorer**, and record the explorer URL in
   `chains/xlayer.ts` — it is currently `null` rather than guessed.
5. **Point the backend at the deployment.** `SETTLEMENT_TOKEN_ADDRESS` from the manifest,
   not a constant. Run the migrations against a real PostgreSQL for the first time.
6. **Indexer.** Poll `getLogs` with a confirmation lag, persist the cursor in
   `indexer_state`, and make it idempotent per `(txHash, logIndex)`. On `MarketCreated`,
   join to the stored compilation by `rulesHash` and promote `PENDING_ONCHAIN` → `OPEN`;
   record a market whose hash we have never seen as `UNKNOWN_SPEC` rather than hiding it.
   Then `StakePlaced` → positions, which is what turns `/api/positions` from a 501 into an
   answer.
7. **End-to-end on testnet:** compile a condition, approve it, create the market from a
   wallet, stake from two wallets, and see all of it appear through the API.
8. **Also worth doing here:** a live evaluation of the compiler prompt against the
   adversarial cases, now that a real model is reachable. Everything currently proven is
   that the *system* refuses bad model output; how often a real model produces it is
   unmeasured.

Deliberately **not** in M4: the resolution engine and evidence retrieval (M5), and the
frontend (M6).

Open question to settle at the start of M4: whether the indexer runs in-process with the
API or as a separate worker. Separate is probably right — indexing must not stall on API
load and wants its own restart semantics — but it costs a second deployable.
