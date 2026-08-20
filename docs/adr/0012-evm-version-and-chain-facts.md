# ADR-0012 — `evmVersion: paris` stays, now as a choice rather than an unknown

**Status:** Accepted (M4)
**Supersedes the open question in:** ADR-0009 note 7

## Context

M2 pinned the Solidity compiler to `evmVersion: paris` defensively. The reasoning
recorded at the time was honest about being a guess:

> X Layer's opcode support is unconfirmed, so Cancun additions (`MCOPY`,
> `TSTORE`) are avoided. This is also why `ReentrancyGuardTransient` is unused.

M4 was required to settle the factual question against the live chain rather than
against documentation (§5).

## What was measured

Probed `https://testrpc.xlayer.tech/terigon` directly:

| Probe | Result |
| --- | --- |
| `eth_chainId` | `0x7a0` — 1952 |
| `net_version` | `1952` |
| `web3_clientVersion` | `reth/v2.3.0-81573d2/x86_64-unknown-linux-gnu/xlayer/v0.0.7` |
| Block header fields | `parentBeaconBlockRoot`, `blobGasUsed`, `excessBlobGas` present |
| Block header fields | `requestsHash` present |
| `eth_gasPrice` | `0x1312d01` ≈ 0.02 gwei |
| `gasLimit` | 210,000,000 |

The client is **op-reth** — X Layer is an OP Stack rollup following its 2025
migration away from Polygon CDK. `parentBeaconBlockRoot` / `blobGasUsed` /
`excessBlobGas` in the header mean **Cancun is active**; `requestsHash` means
**Prague is active**.

So the M2 assumption was wrong in the safe direction: Cancun and Prague opcodes
*are* available. `MCOPY`, `TSTORE`, and therefore `ReentrancyGuardTransient`
would all work.

## Decision

**Keep `evmVersion: paris`.**

The milestone brief is explicit that a newer EVM version must not be adopted
merely because it exists, and there is no reason here beyond existence:

1. **Nothing in this codebase uses a Cancun feature.** `ReentrancyGuard` is the
   storage-slot version, chosen deliberately in ADR-0009 note 6 after reading the
   installed OpenZeppelin source to confirm it is clone-safe. No contract does
   the large memory copying where `MCOPY` would pay.
2. **`paris` output runs identically on a Cancun/Prague chain.** It is a strict
   subset of what the chain executes, so the pin costs no correctness.
3. **The M2 test suite and security review were performed against this
   bytecode.** Changing the compilation target invalidates that work in exchange
   for a rounding-error gas saving.

## Consequence

The pin is now a *decision* rather than a *hedge*, and the difference matters for
whoever reads it next. `ReentrancyGuardTransient` and `MCOPY` are available the
moment there is a reason to want them; adopting either is a deliberate change
with its own test and review cost, not a blocked one.

The deployed testnet bytecode was compiled at `paris` with the optimizer enabled
at 200 runs, and those settings are recorded in the deployment manifest
(`compiler.solc`, `compiler.evmVersion`, `compiler.optimizer`) so the deployment
can be reproduced and verified against its own source.

## Other chain facts established at the same time

Recorded here because they were measured, not documented anywhere this project
could find, and because each of them broke something before it was known:

- **`eth_getLogs` is capped at 100 blocks.** A wider request is rejected with
  `block range greater than 100 max`. The indexer's default range was 2000 and
  failed on its first real call. This is why `INDEXER_LOG_RANGE` defaults to 100.
- **The native gas token is OKB**, confirmed by the chain accepting transactions
  paid in it and by the deployer's faucet balance. `packages/shared` already
  recorded this; M4 confirmed it rather than continuing to assume it.
- **`proposeResolution` has no upper deadline.** The resolution deadline only
  *enables* permissionless `cancel()`; it does not prevent a late proposal. This
  was verified by reading the contract and then relied upon to drive markets that
  were 26 hours past their resolution deadline through a full lifecycle. It is a
  property of the contract, not of the chain, but it was discovered during M4 and
  belongs with the other findings.
