# ADR-0012: `evmVersion` stays at `paris` after live verification

**Status:** Accepted — 2026-08-17
**Supersedes the reasoning of:** ADR-0009 note 7 (not its conclusion)

## Context

M2 pinned the Solidity compiler to `evmVersion: paris` and recorded the reason honestly:
X Layer's opcode support had not been confirmed by this project, so Cancun additions
(`MCOPY`, `TSTORE`) were avoided on principle. `ReentrancyGuardTransient` was left unused
for the same reason. BUILD_STATE listed the pin under "known issues / accepted risks" with
the note *"Conservative, not knowledge-based … Revisit in M4."*

M4 revisits it. §5 of the milestone brief is explicit in both directions: verify what the
chain actually supports, and **do not switch EVM versions merely because a newer one
exists**.

## Investigation

The question was settled by probing the live network rather than by reading documentation,
because documentation about X Layer's testnet is currently mid-migration and demonstrably
stale in places (OKLink's Hardhat verification guide still describes the retired chain 195,
while the live testnet is chain 1952).

Against `https://testrpc.xlayer.tech/terigon`:

| Probe | Result | Implies |
| --- | --- | --- |
| `web3_clientVersion` | `reth/v2.3.0-81573d2/x86_64-unknown-linux-gnu/xlayer/v0.0.7` | op-reth; OP Stack, not Polygon CDK zkEVM |
| `eth_getBlockByNumber` header | contains `withdrawalsRoot` | Shanghai active |
| " | contains `blobGasUsed`, `excessBlobGas`, `parentBeaconBlockRoot` | **Cancun active** |
| " | contains `requestsHash` | **Prague active** |

So the factual premise of the M2 pin is no longer true. Cancun and Prague opcodes *are*
available on X Layer testnet.

This also explains the architectural change behind it: X Layer migrated from a Polygon-CDK
zkEVM to an OP Stack rollup, which is why EVM equivalence is now much closer to L1 than the
M2 assumption allowed for.

## Decision

**Keep `evmVersion: paris`.**

The constraint is lifted; the pin stays. Those are different statements, and conflating
them is what §5 warns against.

Reasons, all of which are about this codebase rather than about the chain:

1. **Nothing here uses a Cancun feature.** `ConditionalMarket` uses the storage-slot
   `ReentrancyGuard`, chosen deliberately and verified clone-safe by reading the installed
   OpenZeppelin source (ADR-0009 note 6). No contract performs the large memory copies
   where `MCOPY` would pay. The compiled output would be near-identical.
2. **`paris` output runs unchanged on a Cancun/Prague chain.** It is a strict subset. The
   pin costs correctness nothing, and the deployment proves it: all three contracts deployed
   and executed on chain 1952 with this setting.
3. **The M2 audit was performed against this bytecode.** 144 contract tests and a manual
   security review targeted this compilation. Re-targeting the compiler to gain a
   rounding-error gas saving would invalidate that work for no benefit anyone can measure.

## Consequences

- The manifest records `evmVersion: paris` alongside the solc version and optimizer
  settings, because explorer verification must reproduce the exact settings that produced
  the deployed bytecode, and a manifest that omitted them would leave that information only
  in a config file that has since moved on.
- `ReentrancyGuardTransient`, `MCOPY` and `TSTORE` are now available *as options*. Adopting
  one becomes an ordinary engineering decision with a measurable justification, not a leap
  into unverified territory.
- The BUILD_STATE entry moves from "accepted risk — unverified" to "settled decision". The
  risk it described no longer exists; the choice it produced remains.
- If a future milestone targets a chain whose opcode support is again unknown, the same
  probe is the cheap way to answer it: read a block header and look at which fields are
  present.
