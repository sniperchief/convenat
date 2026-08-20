# ADR-0001: npm-workspace monorepo with a shared hashing/schema package

**Status:** Accepted — 2026-08-16

## Context

Four deliverables (contracts, backend, frontend, shared logic) must agree exactly on the
condition-spec schema, the canonical byte encoding of a spec, and the resulting
`rulesHash` / `evidenceHash`. If the backend computes a hash one way and the frontend
verifies it another way, the verification feature silently becomes theatre. Contract tests
also need real hash fixtures rather than hand-copied hex strings.

## Decision

A single repository using npm workspaces:

- `packages/shared` — Zod spec schema, RFC 8785 canonicalization, keccak hashing, chain
  config, typed API request/response contracts, generated ABIs. Zero runtime dependency on
  the backend or frontend. Depends only on `zod` and `viem` (for `keccak256`).
- `packages/contracts` — Hardhat project; imports `shared` in tests for hash fixtures.
- `apps/backend`, `apps/web` — both import `shared`.

TypeScript `strict` everywhere. No ORM/DB/HTTP/AI dependency may enter `shared`.

## Consequences

- One implementation of canonicalization, one golden-vector test suite, three consumers.
- Frontend hash verification is genuinely the same code path as backend hash generation.
- Workspace hoisting must not let backend-only packages leak into the browser bundle; the
  `shared` dependency list is kept deliberately tiny and reviewed on every addition.
- Deployment of backend and frontend as separate artifacts still works — they are built
  independently, and only their shared dependency is co-located.
