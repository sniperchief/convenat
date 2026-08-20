# Architecture Decision Records

One file per decision. Format: Context → Decision → Consequences. Once a record is
`Accepted`, it is not edited; it is superseded by a new record.

| ID | Decision | Status |
| --- | --- | --- |
| [0001](0001-monorepo-and-shared-package.md) | npm-workspace monorepo with a shared hashing/schema package | Accepted |
| [0002](0002-factory-with-clone-per-market.md) | Factory deploys an EIP-1167 clone per market | Accepted |
| [0003](0003-jcs-canonicalization.md) | RFC 8785 JCS canonicalization for rules and evidence hashes | Accepted |
| [0004](0004-challenge-rounds-and-liveness.md) | One challenge round, bond-based, with a cancellation safety valve | Accepted |
| [0005](0005-settlement-token.md) | Deploy our own test settlement token on X Layer testnet | Accepted |
| [0006](0006-user-creates-market-onchain.md) | The user's wallet creates the market; the backend joins on rulesHash | Accepted |
| [0007](0007-pausability-scope.md) | Pause covers creation and staking only, never claims | Accepted |
| [0008](0008-canonical-hashing.md) | The canonical hashing protocol as implemented (refines 0003) | Accepted |
| [0009](0009-invalid-outcome-is-challengeable.md) | An INVALID outcome runs through the challenge window (refines 0004) | Accepted |
| [0010](0010-hardhat-commonjs-island.md) | `packages/contracts` is a CommonJS island | Accepted |
| [0011](0011-conversational-compiler-contract.md) | The compile endpoint is conversational | Accepted |
| [0012](0012-evm-version-after-live-verification.md) | `evmVersion` stays at `paris` after live verification | Accepted |
| [0013](0013-deployment-manifest-is-the-only-address-channel.md) | The deployment manifest is the only channel for contract addresses | Accepted |
| [0014](0014-server-rendered-siwe.md) | The server renders the sign-in message; the client only signs it | Accepted |
| [0015](0015-evidence-package-v2.md) | EvidencePackage v2.0: machine-checkable evidence, claims that can say "not found" (refines 0008) | Accepted |
| [0016](0016-ai-proposes-code-decides.md) | The model concurs in an outcome, it does not choose one (refines 0015) | Accepted |

> **Housekeeping:** two files claim number 0012 —
> [`0012-evm-version-after-live-verification.md`](0012-evm-version-after-live-verification.md)
> (linked above) and [`0012-evm-version-and-chain-facts.md`](0012-evm-version-and-chain-facts.md).
> They record the same decision. One should be withdrawn or renumbered; neither was
> touched in M5.1 because deleting an accepted record is not a side effect to take
> unasked.
