# The canonical specification protocol

This document defines `rulesHash` and `evidenceHash`. It is a **protocol
specification**, not a description of an implementation: the canonical byte encoding is
part of the agreement between the chain, the backend, the frontend and any third party who
wants to verify a commitment. Changing anything described here changes every hash that has
ever been produced.

Reference implementation: [`packages/shared`](../packages/shared/).
Reasoning behind the choices: [ADR-0003](adr/0003-jcs-canonicalization.md),
[ADR-0008](adr/0008-canonical-hashing.md).

---

## 1. The two hashes

```
rulesHash    = keccak256( UTF8( JCS( normalise( validate( ConditionSpec    ) ) ) ) )
evidenceHash = keccak256( UTF8( JCS( normalise( validate( EvidencePackage ) ) ) ) )
```

Identical pipeline, different documents. Four stages, in this order, none skippable:

| Stage | Module | What it guarantees |
| --- | --- | --- |
| validate | `schema/` | The document is structurally complete and every value is in range |
| normalise | `schema/` + `canonical/unordered.ts` | One textual form per value; one ordering per unordered set |
| JCS | `canonical/jcs.ts` | One byte sequence per document |
| keccak256 | `hashing/keccak.ts` | A 32-byte commitment Solidity can compare |

**Nothing may be hashed without being validated first.** An unvalidated object could carry
an unnormalised timestamp, a mixed-case address or an unknown field, and would then commit
users to rules nobody agreed to.

`keccak256` here is Ethereum's keccak256 — the one Solidity's `keccak256` computes. It is
**not** NIST SHA3-256 and **not** SHA-256. A reimplementation using either will produce a
different digest for identical input.

---

## 2. ConditionSpec

The approved description of a conditional agreement. Version `1.0`.

| Field | Type | Notes |
| --- | --- | --- |
| `version` | `"1.0"` | Fixed. A different value is a different protocol |
| `nonce` | bytes32 | Uniqueness salt fixed at approval |
| `creator` | address | The wallet that approves and commits these rules |
| `question` | text | The condition in one sentence |
| `conditionType` | `binary` | Settlement shape |
| `successCondition` | text | What must be true for YES |
| `failureCondition` | text | What must be true for NO |
| `deadline` | UTC instant | The moment the condition is measured against |
| `timezone` | `UTC` or IANA name | The human frame the deadline was derived from |
| `resolutionMethod` | enum | How the resolver is expected to decide |
| `approvedSources[]` | **ordered** | Index 0 primary, later entries fallbacks in priority order |
| `evidenceRequirements[]` | **unordered** | What must be extracted to decide |
| `ambiguities[]` | **unordered** | `{ description, assumption }` |
| `edgeCases[]` | **unordered** | `{ scenario, outcome }` |
| `risk` | `low` \| `medium` \| `high` | Compiler's assessment |
| `settlement` | object | Token, trading end, challenge window, bond, resolution deadline |

`settlement` is inside the hash because the challenge window and bond a user agreed to must
not be alterable when the market is created.

### The nonce exists to prevent a collision

Two users approving byte-identical wording would otherwise produce the same `rulesHash`,
and the indexer joins on-chain markets to off-chain specifications by that hash. The nonce
makes each approved document unique. See [ADR-0006](adr/0006-user-creates-market-onchain.md).

---

## 3. EvidencePackage

The record of how a resolution was reached. **Two versions exist**, and both are part of
the protocol:

| Version | Status | Introduced |
| --- | --- | --- |
| `1.0` | **Frozen.** Accepted, never produced | Milestone 1 |
| `2.0` | **Current.** What this build produces | Milestone 5.1, [ADR-0015](adr/0015-evidence-package-v2.md) |

A hashed document's schema is the agreement and cannot be amended in place, so a change is
always a new version. v1.0 keeps validating and hashing exactly as it did, and its two
golden vectors are unchanged. Validation dispatches on the declared `version`; a package
whose label does not match its shape is rejected by the schema that label selects.

### 3.1 v2.0 — current

| Field | Type | Notes |
| --- | --- | --- |
| `version` | `"2.0"` | Fixed |
| `chainId`, `marketId`, `marketAddress` | identity | Which condition this resolves |
| `rulesHash` | bytes32 | Binds the package to the exact rules it was resolved against. Enforced at construction — §3.3 |
| `outcome` | `YES` \| `NO` \| `INVALID` | No unresolved member — see below |
| `confidenceBps` | integer 0–10000 | Basis points. Audit metadata; it authorises nothing |
| `reasoning` | text | Why the outcome follows from the claims and checks |
| `sources[]` | **ordered** | `{ sourceId, approvedSourceIndex, name, url, retrievalKind, status, retrievedAt, contentHash }` |
| `claims[]` | **unordered** | `{ claimId, sourceIds[], statement, valueType, value, support, extraction }` |
| `deterministicChecks[]` | **ordered** | `{ checkId, checkType, sourceIds[], expected, observed, result, explanation }` |
| `resolver` | object | `{ version, model }` |
| `resolvedAt` | UTC instant | When the resolution was produced |

Four closed vocabularies are new in v2.0, and each exists to keep a "could not" from being
recorded as a "did":

```
source.status      RETRIEVED | UNAVAILABLE | MALFORMED | NOT_ATTEMPTED
claim.support      SUPPORTED | UNSUPPORTED | DISPUTED
check.result       PASS | FAIL | INDETERMINATE
check.checkType    NUMERIC_COMPARISON | PRICE_ABOVE_THRESHOLD | PRICE_BELOW_THRESHOLD |
                   DATE_BEFORE_DEADLINE | DATE_AFTER_DEADLINE | BOOLEAN_MATCH |
                   STRING_MATCH | SOURCE_AVAILABLE
```

Three fields are null **exactly when** their companion says they must be, so that "nothing"
has one encoding rather than two: `contentHash` iff `status` is not `RETRIEVED`, `value`
iff `support` is `UNSUPPORTED`, `observed` iff `result` is `INDETERMINATE`.

Full field-by-field commentary is in [docs/ai-resolution.md](ai-resolution.md).

### 3.2 v1.0 — frozen

| Field | Type | Notes |
| --- | --- | --- |
| `version` | `"1.0"` | Fixed |
| `chainId`, `marketId`, `marketAddress`, `rulesHash` | identity | As v2.0 |
| `outcome`, `confidenceBps`, `reasoning` | | As v2.0 |
| `sources[]` | **ordered** | `{ name, url, retrievalKind, retrievedAt, httpStatus, contentType, contentHash }` |
| `claims[]` | **ordered** | `{ sourceIndex, statement, valueType, value }` |
| `deterministicChecks[]` | **ordered** | `{ validator, passed, detail }` |
| `resolver`, `resolvedAt` | | As v2.0 |

Every array is ordered here because `claims[].sourceIndex` references `sources`
positionally, so reordering `sources` would silently repoint every claim. Removing that
positional coupling is what let v2.0 revisit the question — see §4.

### 3.3 Both versions

Three rules make an evidence package reproducible:

**No storage-layer fields.** Database row ids, insertion timestamps and internal sequence
numbers are absent from the schema and *rejected* if present. A package restored from
Postgres, served over the API, or read from a JSON file must hash identically. The schema
is `strict`, so a stray `id` column causes a loud validation failure rather than a silently
different hash.

**Timestamps are evidence, not clock reads.** `retrievedAt` and `resolvedAt` record when
something actually happened and are supplied by the caller. No code on the
canonicalisation or hashing path reads a clock, so hashing the same package tomorrow
yields the same digest.

**The package binds to the rules.** `evidence.rulesHash` must equal the market's
`rulesHash`, checked at construction by `buildBoundEvidenceCommitment` or
`buildEvidenceCommitmentForSpec` rather than only at review. Evidence gathered against a
different agreement can be well-formed and true and still justify nothing here. A mismatch
raises `EvidenceBindingError` (`EVIDENCE_RULES_MISMATCH`), which is distinct from
`HASH_MISMATCH`: the document reproduces its own digest perfectly and is simply evidence
for something else.

### There is no `UNRESOLVED` outcome

`NEEDS_REVIEW` and `RESOLUTION_FAILED` are resolver *statuses*, carried in
`ResolutionProposal`, and never appear in a hashed evidence package or on-chain. An
unresolved condition must leave the contract untouched, not settle it. `INVALID` is a
different thing: a definite determination that the condition cannot be decided on approved
evidence, which routes to refunds.

---

## 4. Ordered versus unordered arrays

**Array order is significant by default.** There is no "sort all arrays" helper anywhere in
this codebase, and adding one would be a bug.

Four fields are declared unordered, and the set is keyed by document version:

| Document | Unordered fields |
| --- | --- |
| `ConditionSpec` v1.0 | `ambiguities`, `edgeCases`, `evidenceRequirements` |
| `EvidencePackage` v1.0 | *(none — frozen)* |
| `EvidencePackage` v2.0 | `claims` |

The three in `ConditionSpec` are sets of independent statements; listing them differently
does not describe a different agreement, so two inputs differing only by permutation must
hash identically. They are normalised by sorting on each element's own canonical JSON —
which needs no per-field sort key and behaves identically for strings and nested objects.

Everything else is ordered, and deliberately:

- **`ConditionSpec.approvedSources`** — index *is* precedence. Element 0 is the primary
  source; later entries are fallbacks in priority order. Permuting it changes which source
  decides the outcome, so it must change the hash. Precedence is carried by position
  alone; a separate `role: primary|secondary` field would be a second, conflictable source
  of truth for the same fact.
- **`EvidencePackage.sources`** — same reasoning, plus retrieval sequence. A resolver that
  read the fallback before the primary did something different from one that did not.
- **`EvidencePackage.deterministicChecks`** — execution order can matter: a validator that
  short-circuits after an earlier failure is a different run from one that does not.
- **Every array in `EvidencePackage` v1.0**, including `claims`, because
  `claims[].sourceIndex` references `sources` positionally.

**Why `claims` is unordered in v2.0 and ordered in v1.0.** v2.0 replaced positional
`sourceIndex` references with `sourceId`, so a claim's identity no longer depends on where
it sits. What remains is a set of independent assertions, and the sequence in which two
unrelated facts were extracted is not part of why an outcome is justified. Weigh the
failure modes rather than the aesthetics: an ordered `claims` breaks the hash when a benign
re-serialisation reorders it, raising a tamper alarm for a change that means nothing —
while an unordered one cannot hide a real change, because permuting independent claims
*is* no change. `sources` is the opposite case, and gets the opposite answer.

Duplicates inside an unordered set are **rejected**, not deduplicated: a set with repeats
is ambiguous, and quietly collapsing it would change the document the user approved. In
v2.0 a duplicate claim is caught earlier still, as a repeated `claimId`, so the caller gets
a field path rather than a canonicalisation failure.

The declared set lives in one place, `canonical/unordered.ts`, and is asserted by the
golden-vector file. Canonicalisation selects the rule set from the validated document's own
`version` and **refuses** for a version it does not know, rather than defaulting to
"nothing is unordered" and producing a hash under the wrong rules. Adding a field to an
existing version's set is a protocol change requiring a version bump.

---

## 5. Canonicalisation rules

RFC 8785 (JSON Canonicalization Scheme), with a **restricted profile** that is strictly
narrower than the RFC, never wider.

From RFC 8785:

- Object members are emitted in ascending order of the key's **UTF-16 code units**. Note
  this is not UTF-8 byte order and not locale collation; the comparator is written out
  explicitly rather than relying on a default sort.
- Strings use ECMAScript `JSON.stringify` escaping: `"`, `\` and C0 controls escaped, lone
  surrogates escaped as `\udXXX`, everything else literal.
- No insignificant whitespace anywhere.
- `null`, `true`, `false` spelled literally.

Narrowed by this protocol:

| Rule | Why |
| --- | --- |
| **Integers only.** Floating point is rejected outright | Removes every double-to-string edge case from the protocol. Token amounts travel as decimal strings; confidence travels as integer basis points |
| Integers must be within ±2^53−1 | Beyond that, exactness is not guaranteed; use a decimal string |
| **No optional keys.** "Nothing" is an explicit `null` | An absent key and an explicit null would otherwise be two encodings of one meaning |
| **Unknown keys rejected**, not stripped | Silently dropping a field the caller believed was part of the agreement is the exact failure this product exists to prevent |
| `undefined`, bigint, function, symbol rejected | No JSON representation; each would otherwise vanish or coerce |
| Non-plain objects rejected (`Date`, `Map`, `Set`, class instances) | Their JSON form is implementation-defined |
| Circular structures rejected | Would otherwise overflow the stack |
| `-0` serialises as `0` | Signed zero must not split a hash |

Every rejection throws `CanonicalizationError` carrying the path of the offending value.
Nothing is silently coerced.

### Scalar normalisation

Applied at the validation boundary, so canonicalisation only handles structure:

| Value | Normal form | Rejected |
| --- | --- | --- |
| Timestamps | UTC, whole seconds, `Z` suffix: `2026-09-01T23:59:59Z` | A local date-time with no offset — guessing a timezone is the ambiguity this product exists to remove |
| | Sub-second components truncated: protocol resolution is one second, matching block timestamps | A date that does not exist — `2026-02-31`, `2025-02-29`, `2026-04-31` — and a time of day that does not exist: `24:00:00`, `23:60:00`, `23:59:60` |
| Addresses | lowercase hex | Anything not 20 bytes |
| bytes32 | lowercase hex | Anything not 32 bytes |
| Text | leading/trailing whitespace trimmed; internal spacing preserved | Empty after trimming |
| Amounts | decimal string, no leading zeros | JSON numbers — they cannot carry a uint256 |
| URLs | as given | Plain `http` |

---

## 6. Cross-environment reproducibility

The same hash must be derivable in the backend (Node), the frontend (browser), the
contract tests (Hardhat), and by any third party in any language. The traps, and how each
is closed:

| Trap | Closure |
| --- | --- |
| `JSON.stringify` key order follows insertion order | Keys explicitly sorted by UTF-16 code unit |
| Number formatting differs at the edges | Floats banned; integers bounded to the exactly-representable range |
| UTF-8 vs UTF-16 encoding | Encoding is specified as UTF-8 and applied in exactly one function |
| Lone surrogates producing invalid UTF-8 | ECMAScript well-formed stringify escapes them |
| Timezone assumptions | Offsets mandatory; everything normalised to UTC seconds |
| Hex casing from explorers and logs | Normalised to lowercase; verification compares case-insensitively |
| `null` vs absent key | No optional keys in a hashed document |
| Array reordering by a database, a serialiser or an ORM | Ordered by default; only three named fields are permitted to be reordered, and they are sorted deterministically |
| Runtime-dependent validation (e.g. `Intl` timezone tables) | Timezone validated by shape, never against a runtime database — a document that validates on the server but not in the browser would break client-side verification |
| **`Date.parse` rolls an impossible date forward instead of refusing it** — `2026-02-31` becomes 3 March, `2025-02-29` becomes 1 March, `24:00:00` becomes the next midnight | The written date and time-of-day components are validated against the Gregorian calendar **before** parsing. Without this, a user approving a deadline of 29 February commits to 1 March and nothing reports it |

**JavaScript's implicit serialisation behaviour must never define the protocol by
accident.** That is why the encoder is written out rather than delegated to
`JSON.stringify`, and why the restricted profile bans everything whose serialisation is
engine-defined.

---

## 7. Golden vectors

[`packages/shared/vectors/golden.json`](../packages/shared/vectors/golden.json) contains,
for each fixture: the **input** document, the **expected canonical string**, and the
**expected hash**. Three `ConditionSpec` vectors and twelve `EvidencePackage` vectors —
the two frozen v1.0 packages first, then ten v2.0 packages.

The expected values were produced once by the implementation and then committed. The test
suite asserts against the committed file, never against a freshly computed value — so any
change to the schema, the unordered-field set, the normalisation rules or the encoder
breaks the tests loudly instead of silently redefining the protocol.

> If a golden-vector test fails, the correct response is almost never to regenerate the
> file. It is to ask whether the protocol was meant to change, and if so, to bump the
> specification version.

The file is exported from the package (`@covenant/shared/vectors/golden.json`) so the
Solidity tests in Milestone 2, deployment verification tooling, and any reimplementation
can check themselves against it.

Regeneration, for a deliberate version bump only:

```
npm run vectors:generate --workspace @covenant/shared
```

---

## 8. Verifying a commitment

```ts
import { verifyRulesHash, assertRulesHash } from '@covenant/shared';

// boolean form, for rendering a badge
verifyRulesHash(specificationFromApi, onchainRulesHash);

// throwing form, for a path where a mismatch is a hard stop
assertRulesHash(specificationFromApi, onchainRulesHash);
```

The frontend runs this in the browser against the value read from
`ConditionalMarket.rulesHash()`. A mismatch means the rules on display are not the rules
the money is subject to. The check only means anything because both sides run this same
implementation — which is why there is exactly one, in `packages/shared`, and why no
consumer may reimplement it.
