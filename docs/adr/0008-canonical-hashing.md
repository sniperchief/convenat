# ADR-0008: The canonical hashing protocol as implemented

**Status:** Accepted — 2026-08-16
**Refines:** [ADR-0003](0003-jcs-canonicalization.md)

## Context

ADR-0003 chose RFC 8785 and sketched the surrounding rules before any code existed.
Implementing it in Milestone 1 forced four decisions that the sketch left open or got
wrong. This record captures them so the reasoning is not lost in a diff.

## Decisions

### 1. `approvedSources` is ordered, and the `role` field is gone

ADR-0003 listed `approvedSources` among the arrays to be sorted, and the architecture
sketch gave each source a `role: primary | secondary`. That is two independent
representations of one fact — precedence — which can disagree. Worse, sorting the array
would mean permuting the fallback chain does not change the hash, even though it changes
which source decides the outcome.

`approvedSources` is now **ordered**: index 0 is primary, later entries are fallbacks in
priority order, and `role` is removed. Position is the only precedence.

Three fields remain unordered — `ambiguities`, `edgeCases`, `evidenceRequirements` — and
every array in `EvidencePackage` is ordered, because a package is a record of what the
resolver did in the order it did it, and `claims[].sourceIndex` references `sources`
positionally.

### 2. Unknown keys are rejected, not stripped

ADR-0003 said unknown keys would be stripped by Zod before hashing, "so a spec cannot
smuggle unhashed content". Stripping does prevent smuggling, but it does so silently: a
caller who believed an extra field was part of the agreement gets a commitment that omits
it, with no signal. Every schema is now `.strict()`, so the document is rejected instead.

This also gives evidence packages their storage-independence for free: a package still
carrying a database row id fails validation loudly rather than hashing differently.

### 3. Unordered sets are sorted by their own canonical JSON, and duplicates are rejected

ADR-0003 said "sorted by a defined key", which would have required naming a key per field
and would break for fields holding plain strings. Sorting each element by
`jcsSerialize(element)` needs no per-field configuration, is total, and behaves identically
for scalars and nested objects.

Duplicates within an unordered set are rejected rather than deduplicated. Silently
collapsing repeats would change the document the user approved.

### 4. Every hashed document is closed and non-optional

No hashed field may be optional-by-absence. Fields that can carry "nothing" are declared
nullable with a `null` default, so a validated document always has the same key set. An
absent key and an explicit `null` would otherwise be two encodings of one meaning — the
single most likely source of a cross-implementation hash mismatch.

Combined with the ban on floating point (ADR-0003) and the `.strict()` decision above, the
restricted profile is strictly narrower than RFC 8785 and never wider, so any conformant
JCS implementation can reproduce our output; the reverse is not required.

## Consequences

- The protocol is fully specified in `docs/canonical-specification.md`, including the
  cross-environment trap list. That document, not the code, is the reference.
- Golden vectors are committed as JSON and exported from the package, so the Milestone 2
  Solidity tests and any third-party reimplementation check against the same file rather
  than against a freshly computed value.
- The removal of `role` from `ApprovedSource` means the compiler prompt in Milestone 3 must
  emit sources in precedence order, and the review UI in Milestone 6 must present position
  as precedence. Both are noted in BUILD_STATE.md.
- Sub-second timestamp precision is discarded. The protocol resolves to one second, which
  matches block timestamps; two deadlines a millisecond apart are the same deadline.
