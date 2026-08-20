# ADR-0015: EvidencePackage v2.0 — machine-checkable evidence, and a claim set that can say "not found"

**Status:** Accepted — 2026-08-19
**Refines:** [ADR-0008](0008-canonical-hashing.md)
**Applies to:** Milestone 5.1

## Context

Milestone 1 shipped `EvidencePackage` v1.0 as part of freezing the hashing protocol. It
was designed before any resolution engine existed, from the outside in: what would an
auditable resolution artefact plausibly contain? That got the frame right — market
identity, a rules binding, an outcome, sources, claims, deterministic checks, a resolver
identity — and the frame is unchanged here.

Building the actual M5 pipeline against it exposed four problems. Three are gaps; one is a
field set that quietly obliges a resolver to lie.

**1. A deterministic check could be read but never re-run.** v1.0 recorded
`{ validator: string, passed: boolean, detail: string }`. An auditor holding that learns
that something called `deadline-comparison` returned true, and nothing else — not what was
compared, not against what, not what was found. The entire argument for running
deterministic validators *before* the model is that their conclusions are checkable by
someone who does not trust us. A record of a check that cannot be re-derived from the
record is an assertion wearing the costume of evidence.

**2. A claim could not record an absence.** v1.0's claim was
`{ sourceIndex, statement, valueType, value }` with `value` required. There was no way to
say "the resolver looked for the consignee name and no approved source published it". So
an absence was either omitted — indistinguishable from never having been checked — or
written as a placeholder string, which is a fabrication sitting inside a financial
commitment.

**3. Transport metadata was inside the digest.** `httpStatus` and `contentType` are facts
about one request over one protocol. They are meaningless for `manual_attestation`, they
change when a CDN changes, and they carry no information the outcome depends on. An
evidence hash that moves because a `Content-Type` header gained `; charset=utf-8` is a
tamper alarm that cries wolf, and an alarm nobody believes is worse than no alarm.

**4. `contentHash` was mandatory even when nothing was retrieved.** The shipped
`unreachableSource` fixture demonstrates the consequence: a source that returned HTTP 503
on every attempt carries `contentHash: 0x6666…`, a hash of bytes that do not exist. The
schema required a value, so the fixture invented one. That is exactly the failure this
product exists to prevent, committed in our own golden vectors.

Two further points came out of re-reading the ordering decision rather than from the code.
`claims` was declared ordered in v1.0 because `claims[].sourceIndex` referenced `sources`
positionally, so reordering `sources` would have silently repointed every claim. That is a
sound reason to freeze the *sources* order — and no reason at all to freeze the claims
order, once the positional reference is gone.

Nothing constrains this decision from the chain: **no real evidence package has ever been
committed on-chain.** The M4 testnet lifecycle proposed
`keccak256("covenant:m4:placeholder-evidence:round-1")`, labelled as a placeholder in the
script. So the only cost of a new version is the discipline of carrying two.

## Decision

Introduce **EvidencePackage v2.0** as the version this build produces. **v1.0 is frozen and
still accepted**, byte for byte, digest for digest.

### 1. A new version, not an edit

A hashed document's schema is the agreement. It cannot be amended in place at any price,
so the choice was never "change v1.0 or not" but "which version does the new shape get".
The shape change to `deterministicChecks` is breaking, so: `2.0`.

v1.0's schema, its two fixtures and its two golden vectors are untouched.
`validateEvidencePackage` dispatches on the declared `version`, and a package whose label
does not match its shape is rejected by the schema that label selects — claiming to be
v2.0 does not make a v1.0 document one. A test asserts the two frozen v1.0 digests are the
ones Milestone 1 committed.

### 2. Deterministic checks record the comparison, not its verdict

```
{ checkId, checkType, sourceIds[], expected, observed, result, explanation }
```

`checkType` comes from a closed vocabulary (`NUMERIC_COMPARISON`,
`PRICE_ABOVE_THRESHOLD`, `PRICE_BELOW_THRESHOLD`, `DATE_BEFORE_DEADLINE`,
`DATE_AFTER_DEADLINE`, `BOOLEAN_MATCH`, `STRING_MATCH`, `SOURCE_AVAILABLE`). The
*vocabulary* is closed; the *record shape* is generic, which is what keeps it open to
future validators. Adding a member is a schema version bump, on the same footing as the
Solidity enum ordinals.

`result` is `PASS | FAIL | INDETERMINATE` rather than a boolean, because "the check could
not run" is neither, and a boolean forces it to be recorded as one of the two. This is the
same reasoning that keeps `NEEDS_REVIEW` out of the on-chain outcome enum: a system that
cannot say *I do not know* will say something false instead.

### 3. Claims carry a support state, and name how they were extracted

```
{ claimId, sourceIds[], statement, valueType, value, support, extraction }
```

`support` is `SUPPORTED | UNSUPPORTED | DISPUTED`, and `value` is null **exactly when**
`support` is `UNSUPPORTED`. There is no placeholder for a fact that was not found.

`extraction` is `{ method, locator }`. `JSON_POINTER`, `CSS_SELECTOR` and `REGEX` must name
their locator, so a third party holding the same bytes can re-extract the value and check
it. `MODEL_EXTRACTION` must not, and cannot be re-run that way. **The point of the field is
to make the non-deterministic case visible**: an auditor should be able to see at a glance
which claims rest on a locator anyone can run and which rest on a model's reading.

### 4. Sources describe evidence, not requests

`httpStatus` and `contentType` are gone. In their place, `status` from a closed set:
`RETRIEVED | UNAVAILABLE | MALFORMED | NOT_ATTEMPTED`. That is the protocol-level result of
reading a source, it means the same thing for every retrieval kind, and it is what an
INVALID-because-unreachable resolution actually needs. Where a status code genuinely
mattered, it belongs in a `SOURCE_AVAILABLE` check's `observed` field, which is a place for
observations.

`contentHash` is nullable, required exactly when `status` is `RETRIEVED` and forbidden
otherwise. Nothing retrieved, nothing to hash.

Every source also carries `approvedSourceIndex`, mandatory, with no null escape hatch:
**evidence may only come from a source the user approved when they approved the rules.** A
resolver that needs an unapproved source cannot resolve, and saying so — `INVALID`, refunds
— is correct behaviour rather than a limitation.

### 5. Sources and claims are referenced by id, not by position

`sourceId`, `claimId` and `checkId` are lowercase slugs, unique within a package. Claims
and checks cite `sourceIds[]`. This removes the positional coupling that made v1.0's
ordering decision for it, and lets one claim cite several sources — which is what a
`DISPUTED` claim is.

### 6. Three collections, three ordering answers

| Collection | Order | Why |
| --- | --- | --- |
| `sources` | **ordered** | Position carries precedence and retrieval sequence. A resolver that read the fallback before the primary did something different, and the hash should say so |
| `claims` | **unordered** | With positional references gone, what remains is a set of independent assertions. The sequence in which two unrelated facts were extracted is not part of why an outcome is justified — and leaving it ordered means a benign re-serialisation raises a tamper alarm |
| `deterministicChecks` | **ordered** | Execution order can matter: a validator that short-circuits after an earlier failure is a different run from one that does not |

`claims` is the first member of `UNORDERED_FIELDS.evidencePackageV2`. `UNORDERED_FIELDS.evidencePackage`
stays `[]` for v1.0, frozen. Canonicalisation reads the rule set off the validated
document's own `version`, and **refuses** rather than guessing for a version it does not
know.

### 7. The rules binding is enforced at construction

`assertEvidenceBinding`, `buildBoundEvidenceCommitment` and
`buildEvidenceCommitmentForSpec` live in `packages/shared`, are pure, and take no clock,
database or network. The check has to be available everywhere a package is built, served or
reviewed; a boundary enforced in one place is a boundary with a way around it.

`buildEvidenceCommitmentForSpec` is the form the resolution engine should use. It *derives*
the expected `rulesHash` from the specification rather than accepting one alongside it, and
it reconciles every source against the approved source it cites — the index must be in
range, and the URL must be the one approved at that position.

That last check answers the obvious objection to §4. Carrying both
`approvedSourceIndex` and `url` is two representations of one fact, which
ADR-0008 decision 1 warns against. They are not deduplicated; they are made **unable to
disagree**. The URL stays because a package should be readable on its own, without fetching
the specification to find out what was consulted.

A mismatch raises `EvidenceBindingError` / `EVIDENCE_RULES_MISMATCH`, distinct from
`HASH_MISMATCH`: the document is internally fine and is simply evidence for another
agreement.

### 8. Source URLs are checked for embedded credentials

An evidence package is published to anyone auditing a resolution, so a URL inside one is
published. `publicUrlSchema` refuses `https://user:pass@host` userinfo and a short list of
query parameters that can only mean a secret (`api_key`, `access_token`, `client_secret`,
`password`, …). `key`, `token` and `signature` are deliberately **not** on the list: they
have legitimate non-secret meanings, and a false positive here means the evidence cannot be
published at all.

## Consequences

- **Two schema versions to carry.** `EvidencePackage` is now a union, and code that reads
  fields must narrow on `version` first. Code that only stores, serves or hashes a package
  is unaffected.
- **v1.0's golden vectors are proven unchanged**, and the ten new v2.0 vectors sit after
  them in the same file, so `evidencePackages[0]` still means what the Solidity tests think
  it means.
- **`ConditionSpec.approvedSources[].url` is not credential-checked**, because tightening it
  would change a frozen v1.0 schema. That leaves an asymmetry: a specification may approve a
  URL that an evidence package may not republish, which makes such a market unresolvable.
  Failing loudly beats publishing a key, and closing the asymmetry is a ConditionSpec v1.1
  question — recorded in BUILD_STATE, not fixed here.
- **A v1.0 package cannot be reconciled against its approved sources**, because it carries
  no `approvedSourceIndex`. `buildEvidenceCommitmentForSpec` checks only the binding for
  v1.0 and states so. That gap is precisely why v2.0 exists.
- `confidenceBps` is unchanged and remains audit metadata. It is a floor for proposing at
  all, never a reason to settle: the contract receives an outcome and a hash, and has no
  confidence parameter to weigh.
- The M5.2 retrieval layer must populate `status` and `contentHash` together, and must
  record an unused approved fallback as `NOT_ATTEMPTED` rather than omitting it.
