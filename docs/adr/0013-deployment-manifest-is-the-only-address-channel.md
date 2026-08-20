# ADR-0013: The deployment manifest is the only channel for contract addresses

**Status:** Accepted — 2026-08-17

## Context

M4 is the first milestone where contract addresses exist. Until now `packages/shared`
deliberately held none — a test asserts that no 20-byte hex literal can appear in
`chains/xlayer.ts` — but the backend, the indexer and eventually the frontend all need to
know where the factory and the settlement token live.

The obvious options were an environment variable per address (`FACTORY_ADDRESS`,
`TESTUSD_ADDRESS`, …) or a constant per network in source. Both have the same defect: the
addresses become detached from the deployment that produced them, and nothing checks that
the set is coherent. A `.env` holding a testnet factory and a mainnet token is a valid
`.env`.

§14 of the milestone brief requires the backend to read a manifest and to fail clearly when
that manifest does not exist, is for another chain, is for mainnet, or contains invalid
addresses.

## Decision

A deployment writes one JSON manifest per network, and **that file is the only way an
address reaches an application.**

- The schema and its guards live in `packages/shared/src/deployment/manifest.ts`, so the
  deployer and the consumer cannot disagree about what a manifest is.
- `packages/contracts` is a CommonJS island (ADR-0010), so the deploy script builds the
  object against *types* — erased at compile time — and writes JSON. Nothing crosses the
  seam but data, exactly as the golden vectors do.
- The written file is validated twice, by two parties that do not share code paths: a unit
  test in `packages/shared` runs the schema against the committed manifest, and the backend
  runs the same validator at startup.
- `parseDeploymentManifest` takes the caller's *expected* chain id and environment as
  arguments. It is not a preference read out of the file; it is an assertion by the process
  about what it believes it is.

The manifest carries an explicit `environment: local | testnet | mainnet`. This is
redundant with the network key by construction — a `superRefine` rejects any manifest where
they disagree — and the redundancy is the point. Code that must never touch production
money checks a single word, and a reviewer can verify that check at a glance.

It also records the compiler settings (solc version, `evmVersion`, optimizer) and each
contract's constructor arguments, because a manifest that names an address without saying
how it was built cannot be checked against its own source, and explorer verification needs
exactly those values.

Verification status is stored as an outcome, not an intent: `verified`,
`attempted-failed`, `not-attempted` or `unsupported`. There is no code path that writes
`verified` without the explorer having said so.

## Consequences

- Startup fails, loudly and before the HTTP listener binds, when the manifest is missing,
  malformed, for another chain, or for another environment. A backend configured for
  testnet cannot consume a mainnet manifest even if every address in it is well-formed.
- `SETTLEMENT_TOKEN_ADDRESS` remains in the environment for the compiler's benefit, but the
  composition root overrides it with the manifest's value. The manifest wins because it is
  the artefact that records what was actually deployed.
- The `startBlock` field gives the indexer somewhere to begin. Starting later would silently
  miss markets; starting at genesis would scan tens of millions of empty blocks.
- A second deployment overwrites the manifest. That is intended — there is one current
  deployment per network — and the previous addresses survive in version control.
- The cost is one more file to keep in sync with reality. That is paid down by the two
  independent validations and by `reconcile`, which reads the chain through the manifest's
  factory address and reports when the database and the chain disagree.
