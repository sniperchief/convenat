# ADR-0010: `packages/contracts` is a CommonJS island

**Status:** Accepted — 2026-08-16

## Context

The workspace is ESM: the root and `packages/shared` both declare `"type": "module"`, and
`shared` is built with `module: NodeNext` and emits ESM only. Hardhat 2's config loading
and its Mocha integration are CommonJS; running them inside a `"type": "module"` package
means either an ESM-aware Hardhat setup whose behaviour this project has not verified, or
a hybrid arrangement where `.cjs` shims and `ts-node` register hooks paper over the seam.

BUILD_STATE listed this as an open question for M2 precisely so it would be answered
before test code was written rather than discovered halfway through.

## Decision

`packages/contracts` declares `"type": "commonjs"` and overrides the module settings from
`tsconfig.base.json` (`module: CommonJS`, `moduleResolution: Node`). It is the only
CommonJS package in the repository, and the boundary is a package boundary — not a mix of
module systems inside one package.

**No TypeScript is imported across the seam.** The only thing the contract tests need from
`@covenant/shared` is the golden-vector file, and that is JSON: it is read with
`readFileSync` from a path resolved via `require.resolve('@covenant/shared/vectors/golden.json')`,
with a workspace-relative fallback. No ESM/CJS interop is involved at all.

The hash chain is still proven end to end, without importing the canonicaliser:

```
canonical text (from the vector file, produced by @covenant/shared)
  -> ethers.keccak256(ethers.toUtf8Bytes(canonical))
  -> equals the locked rulesHash
  -> passed to createMarket
  -> read back from the chain unchanged
```

Solidity does not reproduce JCS canonicalisation, and the tests do not claim it does.
Parsing and re-serialising JSON in the EVM is exactly what committing a hash avoids.

## Consequences

- Hardhat, `ts-node` and Mocha all run in the configuration they are designed for. No
  `.cjs` shims, no loader flags, no hybrid.
- The seam is enforced by the shape of the dependency: JSON in, nothing else. If a future
  milestone genuinely needs shared TypeScript in contract tooling, the options are a CJS
  build output from `shared` or moving that tooling to a vitest+viem harness — both
  deliberate changes, not accidents.
- `packages/contracts` is excluded from the root `typecheck`/`test` sweeps only in the
  sense that it runs its own; the root scripts use `--workspaces --if-present` and pick it
  up normally.
- TypeChain is not installed. Contract handles in tests are loosely typed through a small
  `ContractHandle` interface. That is a real ergonomic cost, accepted because every
  assertion in these tests checks on-chain state rather than relying on compile-time
  shapes, and because `Contract.connect()` in ethers v6 returns `BaseContract` and would
  have needed a wrapper regardless.
