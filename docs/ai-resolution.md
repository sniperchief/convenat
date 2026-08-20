# The evidence and resolution model

How a proposed outcome becomes an auditable artefact, and exactly which parts of it are
inside the hash.

Implementation: [`packages/shared/src/schema/evidence-package-v2.ts`](../packages/shared/src/schema/evidence-package-v2.ts)
and [`packages/shared/src/evidence/binding.ts`](../packages/shared/src/evidence/binding.ts).
The hashing it reuses: [docs/canonical-specification.md](canonical-specification.md).
Reasoning behind the shape: [ADR-0015](adr/0015-evidence-package-v2.md).

> **Scope.** Part I covers **Milestone 5.1**: the evidence package model, the rules binding,
> and `evidenceHash`. Retrieval is Part II (M5.2), deterministic validation Part III (M5.3),
> and AI interpretation Part IV (M5.4) — all three are built. **On-chain submission is
> not**, and neither is challenge processing. Where Part I describes something the engine
> "must" do, it is stating a contract the later parts inherit; each of them says where it
> honours one.

---

## 1. The one-sentence model

```
ConditionSpec  →  EvidencePackage  →  evidenceHash
   (what must      (why the proposed     (the 32-byte commitment
    be true)        outcome follows)      submitted on-chain)
```

The specification and the package are bound together by `rulesHash`, which appears in both.
That binding is the whole basis on which the second document says anything about the first.

---

## 2. What an evidence package is for

A resolver proposes an outcome. Anyone with a stake may challenge it within the challenge
window. For that right to be worth anything, the challenger has to be able to see **what
the resolver actually did** — which sources it read, when, what it extracted, which checks
it ran, and what those checks compared against what.

`evidenceHash` is committed on-chain with the proposal, so the copy served later is
tamper-evident: a resolver cannot quietly rewrite its reasoning once a challenge is filed.

Two things the package is deliberately **not**:

- **Not a database record.** No row ids, no insertion timestamps, no request ids, no retry
  counters. A package restored from Postgres, served over the API, or read from a JSON file
  must hash identically. The schema is `.strict()`, so a stray `id` column fails loudly
  rather than hashing differently.
- **Not an authority.** Nothing in it settles anything. The contract receives an outcome
  and a hash. Everything else in the package exists so a human can disagree.

---

## 3. Versions

| Version | Status | Notes |
| --- | --- | --- |
| `1.0` | **Frozen.** Accepted, never produced | The Milestone 1 schema. Its two golden vectors are unchanged |
| `2.0` | **Current.** What this build produces | Milestone 5.1, [ADR-0015](adr/0015-evidence-package-v2.md) |

A hashed document's schema cannot be amended in place — the digest *is* the agreement — so
a change is always a new version, and the old one keeps validating and hashing exactly as
it did. `validateEvidencePackage` dispatches on the declared `version`, and a package whose
label does not match its shape is rejected by the schema that label selects.

Read `CURRENT_EVIDENCE_PACKAGE_VERSION` rather than hard-coding `"2.0"`.

---

## 4. The v2.0 document

```
EvidencePackage (v2.0)
  version, chainId, marketId, marketAddress, rulesHash,
  outcome, confidenceBps, reasoning,
  sources[]             ordered
  claims[]              unordered
  deterministicChecks[] ordered
  resolver{ version, model }, resolvedAt
```

### Sources

```
{ sourceId, approvedSourceIndex, name, url, retrievalKind, status, retrievedAt, contentHash }
```

| Field | Notes |
| --- | --- |
| `sourceId` | Lowercase slug, unique in the package. Claims and checks cite it |
| `approvedSourceIndex` | Position in `ConditionSpec.approvedSources`. **Mandatory** — evidence may only come from a source the user approved |
| `url` | The exact URL read. Must equal the approved source's URL; published, so no credentials |
| `status` | `RETRIEVED` \| `UNAVAILABLE` \| `MALFORMED` \| `NOT_ATTEMPTED` |
| `retrievedAt` | When the read happened. Never after `resolvedAt` |
| `contentHash` | keccak256 of the retrieved bytes. Null **exactly when** `status` is not `RETRIEVED` |

The same approved source may appear more than once — a retry, or a before-and-after
reading. `sourceId` distinguishes them.

`NOT_ATTEMPTED` is the honest record of an approved fallback that was never needed. Omitting
it would make "we did not need it" and "we forgot it" the same document.

### Claims

```
{ claimId, sourceIds[], statement, valueType, value, support, extraction }
```

`support` is `SUPPORTED | UNSUPPORTED | DISPUTED`. `value` is null **exactly when** support
is `UNSUPPORTED`: there is no value to record for a fact that was not found, and a
placeholder string would be a fabrication inside a financial commitment.

`extraction` is `{ method, locator }`:

| Method | Locator | Reproducible by a third party? |
| --- | --- | --- |
| `JSON_POINTER`, `CSS_SELECTOR`, `REGEX` | required | **Yes** — same bytes, same locator, same value |
| `MODEL_EXTRACTION` | must be null | **No.** Declared as such, deliberately |
| `MANUAL_ATTESTATION` | must be null | No |
| `NONE` | must be null | Nothing was extracted; the claim records an absence |

The purpose of this field is to make the non-reproducible case visible. An auditor should be
able to see at a glance which claims rest on a locator anyone can re-run and which rest on a
model's reading.

`value` is always text, whatever `valueType` says. A price, a count and a date all travel
as strings so no float can enter a hashed document.

### Deterministic checks

```
{ checkId, checkType, sourceIds[], expected, observed, result, explanation }
```

`checkType` is a closed vocabulary:

```
NUMERIC_COMPARISON      PRICE_ABOVE_THRESHOLD   PRICE_BELOW_THRESHOLD
DATE_BEFORE_DEADLINE    DATE_AFTER_DEADLINE     BOOLEAN_MATCH
STRING_MATCH            SOURCE_AVAILABLE
```

The vocabulary is closed; the *record shape* is generic, which is what keeps it open to
future validators. Adding a member is a schema version bump.

`expected` and `observed` are the point of the whole structure. v1.0 recorded a validator
name and a boolean, which told an auditor that a check had happened but never what it
compared against what. Here the comparison is in the document, so a third party holding the
same source content can re-run it and disagree.

`result` is `PASS | FAIL | INDETERMINATE`, and `observed` is null **exactly when** the
result is `INDETERMINATE`. A boolean would force "the check could not run" to be recorded
as a pass or a failure; a system that cannot say *I do not know* will say something false
instead.

### Outcome

`YES | NO | INVALID`, and nothing else. This is the on-chain `Outcome` enum minus `UNSET`,
which the contract uses for "no proposal yet" and which must never be proposed.

`NEEDS_REVIEW` and `RESOLUTION_FAILED` are resolver **statuses**, carried on
`ResolutionProposal`, and never appear in a hashed package or on-chain. An unresolved
condition must leave the contract untouched, not settle it. `INVALID` is a different thing:
a definite determination that the condition cannot be decided on approved evidence, which
routes to refunds ([ADR-0009](adr/0009-invalid-outcome-is-challengeable.md) — an `INVALID`
proposal still runs the full challenge window).

### Confidence

`confidenceBps` is an integer, 0–10000. Never a float: floating point is banned from every
hashed document in this protocol, and basis points are how confidence is expressed instead.

**Confidence does not control settlement.** The contract's `proposeResolution` takes an
outcome and an evidence hash. There is no confidence parameter, no threshold in Solidity,
and no code path from this number to a payout. It is a *floor for proposing at all* — below
the operator's threshold the engine returns `NEEDS_REVIEW` and submits nothing — never a
*reason to settle*.

It is inside the hash anyway, because a resolver that later claimed to have been more
certain than it was would be rewriting the record.

---

## 5. Hashed and non-hashed

```
evidenceHash = keccak256( UTF8( JCS( normalise( validate( EvidencePackage ) ) ) ) )
```

Identical pipeline to `rulesHash`, same modules, same restricted JCS profile. There is one
canonicalisation implementation and one keccak call site in this repository, and no
consumer may add a second.

**Inside the hash** — everything in §4. The test is simple: *if a field can change how the
resolution is interpreted, it is hashed.* That includes `reasoning` and `confidenceBps`,
neither of which authorises anything, because both are claims the resolver makes about its
own work and both would otherwise be rewritable after the fact.

**Outside the hash**, and rejected by the schema if present:

| Excluded | Why |
| --- | --- |
| Database row ids, primary keys, `createdAt` / `updatedAt` | Storage bookkeeping. A package must hash the same however it is stored |
| Request ids, trace ids, correlation ids | Infrastructure, not evidence |
| HTTP status codes, response headers, content types | Facts about one request over one protocol. Where a status genuinely mattered, it belongs in a `SOURCE_AVAILABLE` check's `observed` field |
| Latency, retry counts, attempt timestamps | Same |
| API keys, credentials, private endpoints | Never published, and see §8 |
| The raw retrieved bytes | Hashed into `contentHash`; storing them is a storage decision, not a protocol one |
| The resolver's wallet address | Recorded by the chain as `msg.sender`. Hashing it too would mean a key rotation invalidates a document that is still true |
| The proposal transaction hash, block number | Produced *after* the package exists. A document cannot commit to its own future |
| `ResolutionProposal.status` (`NEEDS_REVIEW` etc.) | An off-chain workflow state. The package describes a determination; the status describes what the engine chose to do about it |

---

## 6. Ordering: three collections, three answers

Array order is significant by default in this protocol, and there is no "sort every array"
helper anywhere in the codebase. Each collection was decided on its own merits.

| Collection | Decision | Reason |
| --- | --- | --- |
| `sources` | **ORDERED** | Position carries precedence and retrieval sequence. A resolver that read the fallback before the primary did something different from one that did not, and the hash should say so |
| `claims` | **UNORDERED** | v2.0 replaced positional `sourceIndex` with `sourceId`, so a claim's identity no longer depends on where it sits. What remains is a set of independent assertions, and the sequence in which two unrelated facts were extracted is not part of why an outcome is justified |
| `deterministicChecks` | **ORDERED** | Execution order can matter — a validator that short-circuits after an earlier failure is a different run from one that does not |

The asymmetry between `sources` and `claims` is the interesting one. Consider the failure
modes rather than the aesthetics: if `claims` were ordered, a benign re-serialisation that
reordered them would break the hash and raise a tamper alarm for a change that means
nothing. Because permuting independent claims changes no meaning, making it unordered
cannot hide a real change. `sources` is the opposite — a permutation there *is* a real
change.

Unordered sets are normalised by sorting on each element's own canonical JSON, and
duplicates are **rejected**, not deduplicated. In practice a duplicate claim is caught
earlier, as a repeated `claimId`, so the caller gets a field path rather than a
canonicalisation failure.

The declared set lives in `canonical/unordered.ts` and is keyed by version:
`evidencePackage` is `[]` for v1.0, frozen; `evidencePackageV2` is `['claims']`.
Canonicalisation reads the rule set off the validated document's own `version` and
**refuses** for a version it does not know, rather than defaulting to "nothing is
unordered" and producing a hash under the wrong rules.

---

## 7. The rules binding

> `EvidencePackage.rulesHash` **must** equal the market's `rulesHash`.

This is a security boundary, not a consistency check. Evidence bound to another agreement
can be well-formed, internally consistent and entirely true, and still justify nothing about
the market it is offered for. Accepting one would let a resolution be defended with facts
about a different question.

Three entry points, all in `packages/shared`, all pure — no clock, no database, no network:

```ts
assertEvidenceBinding(evidence, expectedRulesHash)        // throws EvidenceBindingError
buildBoundEvidenceCommitment(input, { rulesHash })        // validate → hash → bind
buildEvidenceCommitmentForSpec(specification, input)      // derive the hash, then bind
```

**Use `buildEvidenceCommitmentForSpec` in the resolution engine.** It is stronger in two
ways:

1. The expected `rulesHash` is *derived* from the specification rather than supplied
   alongside it, so a caller cannot pass a hash that does not belong to the document it
   holds.
2. Every source is reconciled against the approved source it cites — the index must be in
   range for that specification, and the URL must be the one approved at that position.

That second check is what makes `approvedSourceIndex` trustworthy. Carrying both an index
and a URL is two representations of one fact, which ADR-0008 warns against; they are not
deduplicated, they are made **unable to disagree**. The URL stays because a package should
be readable without fetching the specification to find out what was consulted.

A mismatch raises `EvidenceBindingError` (`EVIDENCE_RULES_MISMATCH`, HTTP 409), distinct
from `HASH_MISMATCH`: the document reproduces its own digest perfectly and is simply
evidence for something else.

Ordering inside the builders is deliberate: **validate first**, so a malformed package fails
as a validation problem naming its fields rather than as a binding problem, and no
unvalidated `rulesHash` is ever compared.

The backend must refuse to construct or persist a package whose binding fails. That refusal
lives here, in shared code, rather than in a route handler — because the frontend verifier
and any third-party auditor must reach the same verdict, and a boundary enforced in one
place is a boundary with a way around it.

---

## 8. Credentials in URLs

An evidence package is served to anyone auditing a resolution, so a URL inside one is
published. `publicUrlSchema` refuses two forms of embedded credential:

- `https://user:pass@host` userinfo, which has no legitimate use here.
- Query parameters whose names can only mean a secret: `api_key`, `apikey`, `api-key`,
  `access_token`, `auth_token`, `authtoken`, `client_secret`, `private_key`, `password`,
  `passwd`, `secret`.

`key`, `token` and `signature` are deliberately **absent** from that list. They have
legitimate non-secret meanings (`?key=BTC`), and a false positive here does not mean a
warning — it means the evidence cannot be published and the market cannot be resolved.

This is a floor, not a guarantee. A credential can still hide in a path segment or an
unusually named parameter, and no schema can recognise that. The real control is which
sources an operator approves.

**Known asymmetry:** `ConditionSpec.approvedSources[].url` is *not* credential-checked,
because tightening a frozen v1.0 schema is a breaking protocol change. So a specification
may approve a URL that an evidence package may not republish, which makes such a market
unresolvable. Failing loudly beats publishing a key. Closing the gap is a ConditionSpec
v1.1 question and is recorded in BUILD_STATE.

---

## 9. What the resolution engine will inherit

Stated as a contract, because M5.2 onward has to honour it and none of it is built yet:

- Retrieval must populate `status` and `contentHash` together, and must record an unused
  approved fallback as `NOT_ATTEMPTED` rather than omitting it.
- Deterministic validators run **first** and can decide numeric-threshold and deadline
  conditions on their own. AI interpretation is for the residue that genuinely needs it.
- A model may propose claim text and an `outcome`; it may not widen a vocabulary. Every
  enum here is closed, and `.strict()` rejects invented fields rather than stripping them —
  the same gate the compiler uses, for the same reason.
- Below the confidence floor, or on source failure, the engine returns `NEEDS_REVIEW` and
  submits nothing on-chain.
- Nothing constructs a package without going through
  `buildEvidenceCommitmentForSpec` or `buildBoundEvidenceCommitment`.

---

## 10. Golden vectors

Twelve evidence vectors are committed in
[`packages/shared/vectors/golden.json`](../packages/shared/vectors/golden.json) — the two
frozen v1.0 packages, then ten v2.0 packages covering a YES, a NO, an INVALID, multiple
sources, multiple claims across all three support states, every deterministic check type,
a differing confidence, a differing `rulesHash`, a source permutation, and a
single-claim edit.

Each carries its input document, its expected canonical string, and its expected hash. The
tests assert against the committed file, never against a freshly computed value, and the
Solidity tests in `packages/contracts` re-derive every one of the twelve with
`ethers.keccak256(ethers.toUtf8Bytes(canonical))`.

> If a golden-vector test fails, the correct response is almost never to regenerate the
> file. It is to ask whether the protocol was meant to change, and if so, to add a version.

---

# Part II — Retrieval (Milestone 5.2)

Implementation: [`apps/backend/src/evidence/`](../apps/backend/src/evidence/).

> **Scope.** M5.2 acquires evidence. It does **not** interpret it. There is still no AI
> resolver, no claim extraction, no outcome, no confidence, and nothing submitted on-chain.
> The layer's whole job is: approved sources in, snapshots and `EvidenceSource` records out.

---

## 11. Where retrieval sits, and what it must never do

```
ConditionSpec.approvedSources   (ordered — index 0 is primary)
     ↓   precedence walk
EvidenceSourceAdapter           (the port; https in production, fake in tests)
     ↓   bounded retrieval
raw bytes
     ↓   status / content-type / parse / dataPath policy
EvidenceSnapshot                (normalised, bounded, hashed)
     ↓
EvidenceSource[]                (the v2.0 records Part I defines)
```

Three prohibitions, each enforced by a test:

- **It never adds a source.** The only URLs read are the ones in the specification the user
  approved, in the order they approved them. No discovery, no substitution, no "try the
  obvious alternative".
- **It never decides an outcome.** A source that could not be read produces a *failure
  record*, never a `NO`. Absence of evidence is not evidence of absence — which is precisely
  why `RetrievalStatus` is a separate vocabulary from `Outcome`, and why the failure
  vocabulary in §16 contains no member that could be mistaken for a determination.
- **It never mutates the ConditionSpec.** The specification is a read-only input. A
  retriever that edited it would change `rulesHash` and unbind every market that referenced
  it; a test asserts the document is byte-identical afterwards.

## 12. Source policy and precedence

`approvedSources` is ordered and its position *is* precedence (ADR-0008). Retrieval honours
that exactly:

1. Attempt sources in array order.
2. The **first** source that yields a usable snapshot ends the walk.
3. Everything **after** it is recorded as `NOT_ATTEMPTED` — recorded, not omitted, so the
   package distinguishes "we did not need it" from "we forgot it".
4. Everything **before** it is recorded with the status its failure maps to.

Point 4 is what makes a fallback legible. Reading position 1 is only legitimate when
position 0 is on record as having failed, and the evidence package carries both facts. A
resolution that used the fallback while the primary was fine is visible as such, without
anyone having to take the resolver's word for it.

## 13. The adapter boundary

```
EvidenceRetriever ──▶ EvidenceSourceAdapter ──┬──▶ HttpsSourceAdapter  (production)
                                              └──▶ FakeSourceAdapter   (tests, local dev)
```

The retriever depends on the interface and never on a transport. `node:https` is imported in
exactly one file, the same discipline that keeps the Anthropic SDK in one file and viem in
one file — and for the same payoff: **the entire retrieval suite runs with no network.**

> **A naming note.** The milestone brief calls this abstraction `EvidenceSource`. That name
> was already taken by the *hashed record* in `EvidencePackage` v2.0, and using one name for
> both a protocol document and a fetcher interface would be a genuine confusion in a
> codebase where the document's exact shape is the agreement. The port is
> `EvidenceSourceAdapter`; the record keeps `EvidenceSource`.

An adapter declares which `RetrievalKind`s it serves. `manual_attestation` is served by
none: it is a document handed over out of band, there is no endpoint to read, and inventing
a retrieval that never happened is exactly the class of thing this system exists to prevent.

## 14. Source identity: URL normalisation

Two URLs that differ only cosmetically are one source, and the retriever must not read them
twice or treat them as independent corroboration. Normalisation is therefore *identity*, not
tidiness.

The rules, in order:

| Rule | Behaviour | Why |
| --- | --- | --- |
| Must parse as absolute | `SOURCE_UNSUPPORTED` otherwise | |
| Scheme must be `https:` | `http:` is **refused, not upgraded** | Silently promoting a scheme changes what the user approved. `file:`, `data:`, `ftp:` and everything else are refused outright |
| No userinfo | `https://user:pass@host` is `SOURCE_FORBIDDEN` | It is a credential, and an evidence package is published. The same rule `publicUrlSchema` applies in `@covenant/shared`, enforced again here because a *redirect* can introduce one |
| Port must be allowlisted | Default `[443]` | The cheapest defence against reaching an internal service on 22, 6379 or 11211 |
| Fragment is stripped | `#frag` removed | A fragment is never transmitted, so two URLs differing only in one are the same request |
| Empty query normalised | `?` → nothing | Same reason |
| Host case, IDN punycode | Handled by `URL` | |
| **Query parameter order preserved** | Never sorted | Sorting would be a semantic change, not a normalisation — `?a=1&b=2` and `?b=2&a=1` can mean different things to a real API |

**The normalised URL is what gets requested. The specification's URL is what gets
recorded.** That distinction is load-bearing: `buildEvidenceCommitmentForSpec` refuses a
package whose source URL is not the one approved at the cited position (§7), so writing the
normalised form into the record would make every package unbindable.

Deduplication uses the normalised form. Two approved entries that normalise to the same URL
are read **once** and the second reuses the first's snapshot, with `deduplicatedFrom` naming
the source it reused. Reading twice would be two requests for one fact, and the two answers
could differ — putting two readings of one source into one package.

## 15. Retrieval bounds

Every bound exists so that one approved source cannot stall a resolution.

| Bound | Default | Notes |
| --- | --- | --- |
| Per-attempt timeout | 10s | Covers the **whole** attempt including redirects — and including DNS, see below |
| Max response size | 2 MiB | Enforced while streaming; the connection is destroyed the moment it is exceeded, not after buffering |
| Retained content | 20,000 chars | See §17 |
| Attempts per source | 3 | `1` disables retries |
| Retry backoff | 500ms × attempt | |
| Max redirects | 3 | Every hop re-checked against the full policy |
| Total walk budget | 60s | Ceiling across all sources for one market |

**Only genuinely transient failures are retried.** A 404, a wrong content-type and a policy
refusal are *answers*; asking again is noise aimed at a source that has already been
definitive. Retryability is carried on the error rather than derived from its kind, so the
distinction is explicit at each throw site.

> **A defect found by running it for real.** The first version bounded the connect but not
> the DNS lookup, on the assumption that a connect timeout covered the attempt — it does
> not, because the connect has not started yet. A live smoke run in an environment with no
> reachable resolver stalled indefinitely instead of classifying as a timeout: precisely the
> failure these bounds exist to prevent, in the one step that had none. `dns.lookup` is now
> inside the attempt deadline, and the retriever additionally refuses to wait on **any**
> transport past its deadline, because a contract is not an enforcement mechanism. Both are
> covered by regression tests. Every unit test passed throughout — a fake adapter cannot
> have a DNS problem, which is exactly why the live check exists.

## 16. Failure states

Six operational kinds, none of which is an outcome:

```
SOURCE_UNAVAILABLE   SOURCE_TIMEOUT   SOURCE_FORBIDDEN
SOURCE_UNSUPPORTED   SOURCE_INVALID   SOURCE_MALFORMED
```

They collapse onto the three protocol statuses the hashed package carries:

| Operational kind | Protocol status | Reasoning |
| --- | --- | --- |
| `SOURCE_UNAVAILABLE` | `UNAVAILABLE` | |
| `SOURCE_TIMEOUT` | `UNAVAILABLE` | |
| `SOURCE_FORBIDDEN` | `UNAVAILABLE` | Our policy blocked it — an operator needs to know that; a published document does not |
| `SOURCE_UNSUPPORTED` | `UNAVAILABLE` | |
| `SOURCE_INVALID` | `MALFORMED` | |
| `SOURCE_MALFORMED` | `MALFORMED` | |

The collapse is deliberate. Every extra member of a hashed vocabulary is one that every
reimplementation carries forever, and the difference between "blocked by our policy" and
"the host was down" is an operational fact, not a protocol one.

Note that `FORBIDDEN` and `UNSUPPORTED` map to `UNAVAILABLE` rather than `MALFORMED`:
`MALFORMED` is reserved for "the source answered and the answer could not be parsed as its
declared kind". In both of those cases nothing was read at all.

**HTTP status policy: only 200 is usable.** 204 and 206 are refused rather than treated as
empty successes — a source that returned no content has not answered the question, and
hashing an empty body as though it had would be worse than falling through to the approved
fallback.

An *unclassified* error becomes `SOURCE_UNAVAILABLE` rather than a crash. The resolver must
always be able to say what happened to a source, and an unexpected throw is still "we could
not read it".

## 17. What is retained: content policy and the tradeoff

Two hashes, over two different things, and the distinction matters:

- **`contentHash`** — keccak256 of the **complete raw body**, before any normalisation or
  truncation. This is the field that goes in the hashed package. It commits to what the
  source actually served.
- **`normalizedHash`** — keccak256 of the retained normalised text. Operational only; not
  part of the package.

For **JSON**, the body is parsed, the approved `dataPath` (a JSON pointer) is applied when
the specification names one, and the selection is re-serialised through the protocol's own
canonical JCS encoder. So key order in the response cannot change the snapshot. A payload
carrying a float is `SOURCE_MALFORMED` — the protocol bans floats from hashed documents, and
accepting one here would only defer the failure to a place with less context.

For **HTML**, script and style content is dropped and the remaining text is collapsed. This
is text extraction, not parsing: it is deliberately crude, because anything cleverer would be
a second implementation of a browser's idea of "the content", and M5.3 needs enough text to
extract claims from, not a faithful DOM.

**The tradeoff, stated plainly.** Retaining the full body would make later extraction
maximally faithful and would let an auditor re-derive every claim from the stored copy. It
would also mean a hostile or merely verbose source dictates our storage. The compromise:
`contentHash` commits to the *whole* body, so nothing is silently swapped, while only the
first 20,000 characters of normalised content are **retained** for extraction, with
`normalizedTruncated` recording that it happened. An oversized *raw* response (>2 MiB) is a
failure rather than a truncation, because hashing a prefix and calling it the content would
be a lie about what was read.

## 18. SSRF and the address policy

**The honest threat model first.** A URL reaching this layer is *not* attacker-controlled at
retrieval time. It came from `ConditionSpec.approvedSources`, which a user reviewed and
whose bytes are inside `rulesHash`. An attack therefore requires first getting a hostile URL
through compilation and approval. This is defence-in-depth, not the primary control — and it
is still necessary, because "the specification is the allowlist" only holds if nobody ever
approves a careless specification, and because **a redirect can take an innocent URL
somewhere else entirely.**

Two layers:

1. **Name-level** — scheme, userinfo, port, fragment (§14). Cheap, total, and re-run on
   every redirect hop. A host written as a bare IP is checked here too, so a specification
   pointing at `169.254.169.254` is refused before a socket exists.
2. **Address-level** — the actual IP the socket will connect to, refused if it falls in any
   blocked range: `0/8`, `10/8`, `100.64/10` (carrier-grade NAT), `127/8`, `169.254/16`
   (**including the cloud metadata endpoint**), `172.16/12`, `192.0.0/24`, `192.168/16`,
   documentation and benchmarking ranges, multicast and reserved space; and for IPv6
   loopback, unique-local, link-local, multicast, 6to4, the discard prefix and `::/8`.
   IPv4-mapped (`::ffff:127.0.0.1`) and NAT64 addresses are **unwrapped and re-checked
   against the IPv4 table**, or the whole table could be walked around by writing the
   address the other way.

The second layer is wired in through `https.request`'s **`lookup` hook**, which is what
closes DNS rebinding. Resolving a hostname, checking the answer, and then handing the
*hostname* to an HTTP client is a time-of-check/time-of-use hole: the client resolves again,
and a hostile authoritative server can answer differently the second time. Supplying the
function that `net.connect` itself calls removes the second resolution entirely — the socket
lands on an address this process vetted. This is the reason the adapter is built on
`node:https` rather than `fetch`, which exposes no equivalent hook without a dependency to
replace its dispatcher.

**The policy fails closed.** If a hostname resolves to several addresses and *any one* is
disallowed, the whole host is refused rather than the allowed addresses being used. A
split-horizon answer is exactly what an attacker would arrange.

An optional operator host allowlist exists and is empty by default. Empty means the
ConditionSpec's approved sources are the only name-level control, which is the design; a
non-empty list is matched on the exact host or a `.suffix` of it.

## 19. The snapshot

```
EvidenceSnapshot {
  sourceId, approvedSourceIndex, name, url, normalizedUrl, retrievalKind,
  retrievedAt, contentHash, normalizedContent, normalizedHash,
  normalizedTruncated, rawBytes, selection, finalUrl, redirects,
  attempts, deduplicatedFrom
}
```

Most of that is operational and stays in the backend. `toEvidenceSources` projects a walk
onto the v2.0 records the package needs — `sourceId`, `approvedSourceIndex`, `name`, `url`,
`retrievalKind`, `status`, `retrievedAt`, `contentHash` — in approved-source order, because
`sources` is an ordered collection whose position carries precedence.

`sourceId` is `source-<index>`, derived from the position rather than slugified from the
name. It must satisfy the protocol's identifier grammar, be unique, and be stable across
runs; slugifying user-supplied text satisfies none of those reliably — a non-ASCII name
would produce an empty slug and two similar names would collide. The human label is `name`.

A failed or skipped source contributes a record with `contentHash: null`, which is exactly
the case v2.0 made the field nullable for (ADR-0015). The output of a walk in which *every*
source failed is still a valid set of `EvidenceSource` records — a test asserts the package
accepts it — because "nothing could be read" is a resolution the engine must be able to
express.

## 20. Testing strategy

Every unit test runs against `FakeSourceAdapter`. That is not a convenience: it is the only
way to get a timeout, a malformed body, a wrong content-type, an oversized response and a
redirect loop *on demand and in the same second*, and those are the cases the layer's safety
properties are made of. A suite pointed at real websites would be slow, flaky, and would
stop testing the interesting half.

A separate opt-in live check, `tools/evidence-smoke-test.ts`, covers what a fake cannot: that
the real transport reaches a real host, that TLS works, that a real redirect is followed and
re-checked, and that the address policy refuses a real metadata endpoint. It is **not** part
of the test suite, because the suite must not depend on third-party uptime. It is also the
thing that found the unbounded-DNS defect in §15 — the class of bug a fake adapter is
structurally incapable of having.

---

# Part III — Deterministic validation (Milestone 5.3)

Implementation: [`apps/backend/src/validation/`](../apps/backend/src/validation/).

> **Scope.** M5.3 decides everything code can decide. It does **not** propose an outcome,
> write reasoning, or compute confidence. There is still no AI resolver and nothing goes
> on-chain.

---

## 21. The division of labour

**A model should read a page and say what it says. It should not be the thing that decides
whether `121340 > 120000`.**

| | Wrong | Right |
| --- | --- | --- |
| | Model: *"Bitcoin was above $120,000."* | Code: `observed=121340`, `threshold=120000`, `GREATER_THAN` → `PASS` |

The failure being avoided is not that models are bad at arithmetic. It is that they are
*almost always* right at it, so the rare wrong answer arrives with the same confident shape
as the right ones and nothing downstream can tell them apart. Comparison is cheap, total and
verifiable in code; spending a model on it buys nothing and costs the ability to re-derive
the answer.

Everything in `validation/` is therefore **pure**: no clock, no network, no model, no
randomness. This is not hygiene, it is the challenge mechanism working — a challenger
re-running these validators against the same evidence must reach the same verdict, or the
challenge window decides nothing.

## 22. The problem: `ConditionSpec` v1.0 cannot express a threshold

This is the milestone's central finding, and it is a **defect in the frozen schema**, not a
gap in this layer.

`resolutionMethod` has a member `deterministic_numeric_threshold`, documented in the schema
as *"a number from an approved source compared against a fixed threshold. Fully
deterministic."* **There is nowhere in `ConditionSpec` v1.0 to put that threshold.** The
only machine-readable criteria in the entire document are `deadline` (a normalised instant)
and `edgeCases[].outcome`. The number, the operator and the expected status string all live
in `successCondition`, which is prose written for a human to read.

So the enum promises a capability the schema cannot carry. Three ways to get the threshold,
two of them unacceptable:

1. **Parse it out of `successCondition` with a regex.** This is inventing acceptance
   criteria from prose. It would work on the fixtures and fail on the first real market
   phrased differently, and its failure mode is a confidently wrong number inside settlement
   arithmetic.
2. **Ask a model for it.** Forbidden here, and wrong regardless: it puts a model-chosen
   number inside the comparison that settles a market — the exact inversion of §21.
3. **Take it as an explicit, validated, separately-supplied input.** This is what was built.

## 23. The validation plan, and what is wrong with it

A `ValidationPlan` carries the criteria: which observation, which operator, which threshold.
It is validated by a strict Zod schema and is a **separate input** to the engine.

**It is not hashed, and it is not part of the agreement.** State that plainly rather than
dressing it up: it means the numeric criteria a market settles on are currently
*operator-supplied* rather than *user-approved*, and a user approving a `rulesHash` is not
approving the threshold their money turns on. That is a real weakening of the trust model
relative to everything else in this system, and it is temporary by intent.

Two constraints keep the damage bounded until `ConditionSpec` v1.1 can carry the criteria
inside the hash:

- **A plan may only reference approved sources.** `sourceId` must be `source-N`.
- **A deadline comparison may only use `spec_deadline`.** The schema has no literal-instant
  variant at all, so an unhashed plan *cannot* substitute a deadline for the one inside
  `rulesHash`. A test asserts the attempt is rejected. This is the single most valuable
  thing an attacker could change, so it is the one thing the plan is structurally forbidden
  from expressing.

## 24. The validators

Seven behaviours across five planned kinds, which is what the current schema can honestly
support — not dozens.

| Planned kind | Emitted `checkType` | Notes |
| --- | --- | --- |
| `NUMERIC_COMPARISON` | `NUMERIC_COMPARISON`, or `PRICE_ABOVE_THRESHOLD` / `PRICE_BELOW_THRESHOLD` when `isPrice` | Threshold **and** equality/inequality; six operators |
| `NUMERIC_RANGE` | `NUMERIC_COMPARISON` | Inclusive at both ends |
| `TEMPORAL_COMPARISON` | `DATE_BEFORE_DEADLINE` / `DATE_AFTER_DEADLINE` | Always against `spec.deadline` |
| `BOOLEAN_MATCH` | `BOOLEAN_MATCH` | |
| `CATEGORICAL_MATCH` | `STRING_MATCH` | Exact by default |

Each validator returns one of three things, and the difference between the last two matters:

| Outcome | Emits | Meaning |
| --- | --- | --- |
| `CHECK` | a `PASS`/`FAIL` check | It ran |
| `NOT_APPLICABLE` | **nothing** | This validator has nothing to say here |
| `VALIDATION_ERROR` | an `INDETERMINATE` check | It applies but could not run |

A check that could not run is evidence about the resolution and belongs in the package. A
validator that was never relevant is not, and recording it would pad the evidence with
non-events.

**An unreadable value is never a `FAIL`.** "The number could not be parsed" and "the number
was below the threshold" are different facts about the world and settle differently. Every
parse refusal produces `INDETERMINATE`.

## 25. Numeric semantics

**No floating point on any comparison path.** A decimal is `sign × digits / 10^scale` with
`digits` a `BigInt`; comparison rescales both operands and compares integers. `Number` never
touches a value being compared.

Accepted syntax is deliberately narrower than JSON's:

```
-? (0 | [1-9][0-9]*) ( . [0-9]+ )?
```

Refused, each because accepting it would be an act of interpretation: exponent notation
(`1e3`), leading `+`, leading zeros, bare `.5`, trailing `.`, thousands separators, currency
symbols, `Infinity`, `NaN`. Digits are capped at 64 — `BigInt` is unbounded, and a source
returning a megabyte of digits would otherwise turn a comparison into a denial of service
wearing the costume of a very precise number.

A quoted decimal string and a bare JSON number are read identically. A source that quotes
its numbers must not be unreadable while an identical one that does not works. Note that
the retrieval layer (§17) already refuses floats in JSON payloads, so a fractional price
arrives as a *string* — which is the protocol's rule for amounts everywhere else.

`1.50` and `1.5` compare equal while remaining textually distinct, because `observed`
records what the source said rather than a re-rendering of it.

## 26. Temporal semantics

All comparisons are UTC at whole-second resolution, delegating acceptance to
`utcInstantSchema` from `@covenant/shared` — the same definition a hashed document uses. A
second parser would eventually disagree with the first, and the disagreement would show up
as a market resolving differently from how it verifies.

**A timestamp without an explicit offset is refused, not assumed to be UTC.** A resolver
that guessed would be correct for every source reporting UTC and wrong for every source
reporting local time, which is exactly the shape of bug that survives testing.

**Nothing reads `Date.now()`.** Both operands come from documents: the deadline from the
approved specification, the observation from a retrieved source.

Second resolution is inherited from the protocol and matches block timestamps, so
`deadline − 1s`, `deadline`, `deadline + 1s` is the real boundary. `BEFORE` and
`AT_OR_BEFORE` differ at exactly one instant, and "delivered before 1 September" and
"delivered by 1 September" are different agreements — the check records which was applied.

## 27. Conflicting sources: precedence, never majority

`observation.sourceId` names the **highest-precedence position to consult**, not the only
one. Every approved source at or after it is read, because corroboration is what makes a
disagreement visible — consulting exactly one source would make conflict handling
unreachable and falling back when the primary is silent impossible. Naming a later position
is how a plan deliberately skips a source that does not carry the field.

When several approved sources answer the same observation and disagree:

1. Sources are consulted in `approvedSources` order. Index 0 is primary.
2. **The highest-precedence source that produced a usable value wins.** That is what
   precedence means (ADR-0008), and it is why the array is ordered and inside the hash.
3. The disagreement does not change the verdict but **is recorded** — in `conflicts` and on
   the check's own `explanation`, so a challenger sees that the sources differed and that
   the primary was preferred, rather than the disagreement being invisible.

**Majority voting is never used.** Three agreeing fallbacks do not outrank the primary,
because the user approved an ordering, not an electorate. A test asserts exactly this: with
the primary saying `in_transit` and the fallback saying `delivered`, the verdict follows the
primary.

`NEEDS_REVIEW` is returned when precedence cannot settle it — no source produced a usable
value, or a check could not run. Never `YES`, never `NO`.

## 28. The verdict is not an outcome

```
SATISFIED | REFUTED | NEEDS_REVIEW
```

Kept verbally distinct from `Outcome` on purpose. `SATISFIED` says *every planned check
passed*, which is a fact about the checks. Turning that into a proposed outcome means
reading `successCondition` and `failureCondition` against each other, and that is the next
milestone. Anyone mapping `SATISFIED → YES` has to do it deliberately, in code that also
reads the failure condition, rather than by assignment.

The rule is conservative: **any** check that could not run makes the whole verdict
`NEEDS_REVIEW`, even when every other check passed. A resolution built on "most of the
checks worked" is the kind that looks fine until the one that did not run was the one that
mattered.

`SOURCE_AVAILABLE` checks are emitted per approved source but are **informational** and
excluded from the verdict — a primary that failed while an approved fallback answered is
precedence working as designed, not a refutation.

## 29. What M5.4 inherits

- Map the verdict onto an `Outcome`, reading `successCondition` **and** `failureCondition`,
  and honouring `edgeCases[].outcome`.
- Extract claims — deterministic first (`JSON_POINTER` with a locator), model only for the
  residue (`MODEL_EXTRACTION`, null locator).
- Generate reasoning and confidence, neither of which exists yet.
- **Close §22.** `ConditionSpec` v1.1 should carry the validation criteria inside the hash,
  at which point the plan stops being an operator input and becomes part of the agreement
  the user approved. Until then, no market whose settlement depends on a numeric threshold
  should be treated as fully user-approved.

---

# Part IV — AI interpretation (Milestone 5.4)

Implementation: [`apps/backend/src/resolution/`](../apps/backend/src/resolution/).
Reasoning behind the shape: [ADR-0016](adr/0016-ai-proposes-code-decides.md).

> **Scope.** M5.4 produces a validated resolution proposal: an outcome, a confidence, a
> reasoning, a claim set, and an assembled `EvidencePackage` with its `evidenceHash`.
> **Nothing is submitted on-chain.** There is no signer, no chain client and no transaction
> anywhere in this layer, and challenge processing is a later milestone.

---

## 30. Where the model sits, and what it is not

**This is not an autonomous agent.** It has one question to answer, no tools, no memory, no
conversation history, and no way to act. It cannot fetch a URL, read a second document,
call a contract, sign anything, or widen its own instructions. It is a single-shot
structured extraction over three inputs — the immutable `ConditionSpec`, the retrieved
evidence, and the deterministic checks — and its output is a proposal that the code around
it either accepts or refuses.

```
ConditionSpec (immutable) + snapshots + DeterministicCheck[]
   │
   ├─ rules binding ....... hash the spec; refuse unless it is the market's rulesHash
   ├─ evidence present? ... no source read → NEEDS_REVIEW, and no model call
   ├─ verdict conclusive? . deterministic NEEDS_REVIEW → NEEDS_REVIEW, and no model call
   ├─ claim extraction .... every pointer-reachable value, before the model
   │
   ▼  the only model call
LLMProvider.complete()
   │
   ├─ JSON.parse .......... malformed → NEEDS_REVIEW
   ├─ Zod ................. wrong shape, invented field, bad confidence → NEEDS_REVIEW
   ├─ semantic gate ....... ungrounded value, uncited source, invented URL → NEEDS_REVIEW
   ├─ outcome mapping ..... model disagrees with the checks → NEEDS_REVIEW
   ├─ confidence floor .... below it → NEEDS_REVIEW
   ▼
assemble → validate → bind to rulesHash → evidenceHash
   ▼
PROPOSED     (and nothing is submitted)
```

Three of those gates run **before** the model is called. That is not only economy: a
resolution that cannot be proposed anyway should not put attacker-controlled content in
front of a model at all.

## 31. Four things the engine cannot do, structurally

| | Why it cannot |
| --- | --- |
| Modify the `ConditionSpec` | It is an input, read-only, and hashed at the end of the pipeline. A test asserts the document is byte-identical afterwards |
| Produce a `rulesHash` | The model's output schema has no such field, and `.strict()` rejects one. The hash is derived by `@covenant/shared` |
| Touch the settlement contract | Nothing in `resolution/` imports a chain client, an ABI, a signer or a key. There is no code path from the layer to a transaction |
| Settle by confidence | The floor is a threshold for *proposing at all*. The contract has no confidence parameter, and a 9999-bps proposal is still a proposal |

## 32. The outcome is a concurrence, not a choice

The full argument is [ADR-0016](adr/0016-ai-proposes-code-decides.md). The rule:

| Reading | Produced by | Can it *set* an outcome? | Can it *stop* one? |
| --- | --- | --- | --- |
| The deterministic verdict, mapped through `plan.encodes` | Code, from retrieved bytes | Yes — the authority | Yes |
| The model's reading of `successCondition` and `failureCondition` | The model | **No** | Yes |
| A matched `edgeCases[]` entry | The user at approval time; matched by the model | Only toward `INVALID` | Yes |

Anything short of agreement is `NEEDS_REVIEW`. A compromised or mistaken model can cost
liveness; it cannot cost correctness.

`SATISFIED` is still not `YES`. The mapping reads `plan.encodes` — which of the two
conditions the checks were written to test — so checks written against the *failure*
condition and coming back `SATISFIED` map to `NO`. The model's own outcome is its
independent reading of the same two prose conditions, and it is required to agree.

**The model's vocabulary is `RESOLVED_YES | RESOLVED_NO | NEEDS_REVIEW`.** `INVALID` is not
available to it. An `INVALID` proposal routes to refunds and is a determination the user
pre-approved in `edgeCases[].outcome`; it can arrive only that way.

## 33. `plan.encodes`, and the gap it inherits

Mapping a verdict onto an outcome needs to know which condition the checks encode.
`ConditionSpec` v1.0 cannot express that, for the same reason it cannot express a threshold
(§22), so it is carried on the unhashed `ValidationPlan`.

State it as plainly as §23 states the threshold problem: **`encodes` is operator-supplied,
not user-approved.** A user approving a `rulesHash` is not approving it. What stops a
mis-set `encodes` from inverting a payout is the concurrence rule in §32 — the model reads
both condition texts independently, disagrees with the inverted mapping, and the resolution
goes to review rather than to the wrong party. That is a real mitigation and it is not a
substitute for closing §22 in `ConditionSpec` v1.1.

## 34. Claim extraction: deterministic first

```
snapshots  ──►  JSON_POINTER claims   (the approved dataPath resolved a value)
           ──►  UNSUPPORTED claims    (the approved dataPath resolved nothing)
           ──►  everything else goes to the model, as MODEL_EXTRACTION
```

`extraction.method` is what tells an auditor which claims rest on a model's reading, and
the honest way to keep that number small is to extract everything a pointer can reach
before the model is called. The model is **never asked for `extraction`** — the assembler
stamps it — because a model able to label its own reading as a reproducible `JSON_POINTER`
could erase the one field that distinguishes the two.

`UNSUPPORTED` is reachable and is emitted deterministically: a source that was read
successfully and did not contain the approved `dataPath` is precisely the case v2.0's
`UNSUPPORTED` exists to express. An extractor that could only emit `SUPPORTED` would have
deleted the difference between "the carrier says undelivered" and "the carrier's response
had no status field", and those settle differently.

Several sources answering the same pointer produce **one** claim, not one each: its value
is the highest-precedence source's, its `sourceIds` cite everything consulted, and its
support is `DISPUTED` when they disagreed. Precedence, never a vote — §27, applied to
claims.

## 35. The semantic gate

Zod proves the output has the right *shape*. It cannot prove the output is about the
evidence that was actually retrieved. A well-formed response can cite a source that was
never read, quote a price that appears nowhere in the bytes, or name a URL nobody approved.

| Check | Refuses |
| --- | --- |
| `UNCITED_SOURCE` | A claim citing a source that produced no content — including an approved source that failed |
| `UNGROUNDED_VALUE` | A value that appears in no cited source's retained content and equals no cited selection |
| `SOURCE_PRECEDENCE_VIOLATED` | A claim carrying a value precedence rejected *while no claim reports the one it selected* |
| `INVENTED_URL` | A URL in the reasoning whose host is not an approved source |
| `PROTOCOL_VALUE_IN_REASONING` | A hash or an address in the reasoning — a resolver computes neither |
| `EDGE_CASE_OUT_OF_RANGE` | A `matchedEdgeCase` the specification does not have |

Any violation reviews the **whole proposal**, not the offending claim. There is no partial
credit: a model that fabricated one fact has not demonstrated anything about the others.

**Grounding is necessary, not sufficient.** A value can appear in a document and still be
the wrong value to read — and an injected instruction that plants its own vocabulary in the
page walks straight through this check. Sufficiency is what the deterministic checks are
for, and the two are complementary: the checks say the right value was compared correctly,
grounding says the model did not invent the value it is discussing.

The precedence rule is deliberately narrow. Reporting that a fallback disagreed is the
transparency the conflict record exists for; what is forbidden is *substitution* — carrying
the rejected reading while dropping the one precedence selected.

## 36. Prompt injection

Retrieved evidence is attacker-controlled by construction: it is the body of a document at
a URL somebody else operates. Three layers, in decreasing order of how much they are
trusted:

1. **The gate** (§32, §35). Nothing the model says survives unless it is grounded in
   retrieved bytes and concurs with the deterministic checks. This is the layer that holds,
   because it does not depend on the model having behaved.
2. **Framing.** Evidence is rendered inside fenced blocks identified as data, with the
   fence token *neutralised in the content* so a source cannot close its own block and
   continue at the top level. Neutralised rather than refused: a document containing the
   token is not thereby hostile, and rejecting one would be a denial of service any source
   could trigger.
3. **Instruction.** The prompt says plainly that instructions inside evidence are to be
   reported, not obeyed. Alone this would be security by politeness; it is here because it
   is nearly free.

The injection suite scripts a model that has **already been fully compromised** — it does
exactly what the hostile source told it — and asserts that nothing is proposed anyway. A
defence that only works when the model behaves is not a defence.

The specification is rendered *before* the evidence, and `settlement` is omitted from it
entirely: the model has no business reading the bond, the token or the challenge window,
and a number it cannot see is a number it cannot repeat.

## 37. Three statuses, and none of them is an action

| Status | Meaning | What a caller does |
| --- | --- | --- |
| `PROPOSED` | A validated, bound, hashed package exists | May be submitted, under whatever review policy the operator applies |
| `NEEDS_REVIEW` | The engine will not guess | A person reads the record. Nothing is submitted |
| `RESOLUTION_FAILED` | The provider could not be reached at all | Retry later. Nothing was attempted and nothing is known |

The last two are separate because they call for different actions: `NEEDS_REVIEW` means a
person has something to read and retrying changes nothing; `RESOLUTION_FAILED` means no
resolution was attempted and a person has nothing to read.

Neither is a 5xx. A resolver that crashed on ambiguous evidence would be a resolver that
cannot say "I do not know", and every review path in this layer exists so that saying so is
a normal, structured result.

## 38. Assembly

Assembly goes through `buildEvidenceCommitmentForSpec` and nothing else. It is stronger
than `buildBoundEvidenceCommitment` in two ways that matter here: it **derives** the
expected `rulesHash` from the specification rather than trusting one it was handed, and it
**reconciles every source** against the approved source it cites — index in range, URL
exactly the one approved at that position (§7).

Nothing on the path reads a clock. `resolvedAt` is supplied by the caller, like
`retrievedAt` before it: a hash that depends on when it was computed is not reproducible,
and a package nobody can re-hash is a package nobody can check.

## 39. What M5.5 inherits

- **On-chain submission.** A proposal plus its `evidenceHash` reaching `proposeResolution`,
  from a non-AI path holding the resolver key. Prove the `NEEDS_REVIEW` path before the
  happy path.
- **Diagnose the live semantic-gate failures** recorded in BUILD_STATE — the first
  real-model run reached the provider on four scenarios and none of them proposed. Until
  that is understood, the happy path is verified only against a scripted model.
- **Challenge processing.** Nothing in M5.4 touches it.
- **Close §22 and §33.** `ConditionSpec` v1.1 carrying validation criteria *and* `encodes`
  inside the hash. Until then, no market whose settlement turns on a threshold or on the
  direction of `encodes` is fully user-approved.
- **A serving path for the package**, so a challenger can read the document whose hash was
  committed.
