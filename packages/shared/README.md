# @covenant/shared

The protocol core. Everything that must be byte-identical across the backend, the frontend
and the contract tooling lives here.

**There is exactly one implementation of `rulesHash` and one of `evidenceHash`. No consumer
may reimplement either.** The frontend's "these rules match the on-chain commitment" badge
is only meaningful because it runs the same code that produced the commitment.

```ts
import {
  hashConditionSpec,
  buildRulesCommitment,
  verifyRulesHash,
  hashEvidencePackage,
  validateConditionSpec,
  getNetworkByChainId,
} from '@covenant/shared';

// Validate, canonicalise and hash in one step.
const { spec, canonical, rulesHash } = buildRulesCommitment(approvedSpecification);

// Verify a served specification against what the chain says.
verifyRulesHash(specificationFromApi, await market.read.rulesHash());

// Invalid input is an expected outcome, not an exception, on the compile path.
const result = validateConditionSpec(modelOutput);
if (!result.ok) {
  // result.issues names every field that is missing or wrong.
}
```

## Layout

```
src/
  schema/       ConditionSpec, EvidencePackage v1.0 (frozen) and v2.0, primitives, validation
  canonical/    RFC 8785 encoder, unordered-set normalisation, document pipeline
  hashing/      keccak256 over canonical UTF-8; rulesHash and evidenceHash
  evidence/     the rulesHash binding - refusing evidence gathered for other rules
  chains/       X Layer network configuration - the only place a chain id or RPC lives
  types/        domain records and typed API contracts shared with the frontend
  testing/      example documents, shipped so contract tests reuse them
  errors.ts     typed errors with a public, stack-free API projection
vectors/
  golden.json   locked input -> canonical -> hash vectors
```

## The protocol

Read [docs/canonical-specification.md](../../docs/canonical-specification.md) before
changing anything in `schema/` or `canonical/`. The canonical byte encoding is part of the
agreement between the chain, the backend, the frontend and any third-party verifier —
changing it changes every hash that has ever been produced.

Short version:

```
rulesHash    = keccak256( UTF8( JCS( normalise( validate( ConditionSpec    ) ) ) ) )
evidenceHash = keccak256( UTF8( JCS( normalise( validate( EvidencePackage ) ) ) ) )
```

- **Nothing is hashed without being validated first.**
- Integers only — no floating point in a hashed document, ever.
- No optional keys; "nothing" is an explicit `null`.
- Unknown keys are rejected, not stripped.
- Array order is significant **by default**, and the unordered set is keyed by document
  version: `ambiguities`, `edgeCases`, `evidenceRequirements` in `ConditionSpec`; nothing in
  `EvidencePackage` v1.0; `claims` in v2.0. `approvedSources` and `EvidencePackage.sources`
  are ordered, because index is fallback precedence.
- `EvidencePackage.rulesHash` must equal the market's. Enforced at construction by
  `evidence/binding.ts`, not only at review — see
  [docs/ai-resolution.md](../../docs/ai-resolution.md).
- `keccak256` here is Ethereum's, as computed by Solidity — not SHA3-256, not SHA-256.

## Commands

```bash
npm run typecheck --workspace @covenant/shared
npm test          --workspace @covenant/shared
npm run build     --workspace @covenant/shared
```

## Golden vectors

`vectors/golden.json` holds, per fixture, the input document, the expected canonical
string and the expected hash. The values were produced once by the implementation and then
committed; the tests assert against the file, never against a freshly computed value.

> If a golden-vector test fails, the correct response is almost never to regenerate the
> file. It is to ask whether the protocol was meant to change — and if it was, to bump the
> specification version.

Regeneration, for a deliberate version bump only:

```bash
npm run vectors:generate --workspace @covenant/shared
```

## Dependencies

`zod` and `viem` only, and deliberately so — this package is imported by the browser
bundle. Nothing HTTP, database- or AI-related may enter it.
