# ADR-0003: RFC 8785 JCS canonicalization for rules and evidence hashes

**Status:** Accepted — 2026-08-16

## Context

`rulesHash = keccak256(canonicalSpecification)` is only meaningful if "canonical" is
defined precisely enough that two independent implementations — and the same
implementation two years apart — produce byte-identical output. `JSON.stringify` does not
qualify: key order follows insertion order, number formatting is engine-defined at the
edges, and unicode escaping is inconsistent.

## Decision

Canonical form is **RFC 8785 (JSON Canonicalization Scheme)**: object keys sorted by
UTF-16 code unit, no insignificant whitespace, ECMAScript `Number::toString` numeric
formatting, minimal string escaping, UTF-8 output.

```
rulesHash    = keccak256( utf8Bytes( JCS(spec) ) )
evidenceHash = keccak256( utf8Bytes( JCS(evidencePackage) ) )
```

Additional rules layered on top, because JCS alone does not make a *domain* canonical:

- The spec carries an explicit `version` string; canonicalization behaviour is frozen per
  version. Changing the encoding requires a new version value, never an in-place edit.
- Only fields in the schema are hashed. Unknown keys are stripped by Zod before hashing,
  so a spec cannot smuggle unhashed content.
- Arrays whose order is not semantically meaningful (`approvedSources`, `ambiguities`,
  `edgeCases`, `evidenceRequirements`) are sorted by a defined key before hashing, so two
  equivalent specs cannot produce different hashes.
- `deadline` is normalized to an RFC 3339 UTC instant with second precision and a `Z`
  suffix before hashing.
- Floating-point values are disallowed in the spec schema entirely, sidestepping the one
  genuinely fragile corner of JCS. `confidence` in the evidence package is stored as an
  integer in basis points.

## Consequences

- A golden-vector test suite (fixture spec → fixed hex digest, byte-for-byte) is part of
  Milestone 1 and is treated as a compatibility contract; a change to those digests is a
  breaking change requiring a version bump.
- Contract tests consume the same vectors, so on-chain and off-chain hashes are proven
  equal rather than assumed equal.
- The frontend can verify `hash(displayed spec) == market.rulesHash()` client-side with no
  trusted intermediary.
