# @covenant/contracts

The financial and lifecycle layer. Three contracts, no more.

```
MarketFactory ── Clones.clone ──▶ ConditionalMarket  (one per condition, own balance)
     │
     └── role registry (PROPOSER_ROLE) + pause switch
```

| Contract | Role |
| --- | --- |
| [`MarketFactory`](contracts/MarketFactory.sol) | Creates markets; holds the protocol's only two privileges. Has **no** function that can move a market's funds |
| [`ConditionalMarket`](contracts/ConditionalMarket.sol) | One conditional agreement, custodying its own tokens. Source of truth for every financial fact about it |
| [`TestUSD`](contracts/TestUSD.sol) | A worthless six-decimal test token. Deployable only on development chains |

Read [docs/market-lifecycle.md](../../docs/market-lifecycle.md) for the state machine and
[docs/security.md](../../docs/security.md) for the trust model before changing anything
here.

## Commands

```bash
npm run build     --workspace @covenant/contracts   # hardhat compile
npm test          --workspace @covenant/contracts   # hardhat test
npm run typecheck --workspace @covenant/contracts
npm run deploy:local --workspace @covenant/contracts
```

## What the contracts guarantee

- **Nobody can take user funds.** Not the admin, not the resolver, not the creator. A test
  enumerates every function in both ABIs to prove no such path exists.
- **Each market holds only its own money.** EIP-1167 clones, not a shared pool.
- **`rulesHash` is written once** and no function writes it again.
- **Pause cannot freeze funds.** It reaches new markets and new stakes, and nothing else —
  never a claim, a refund, or a cancellation.
- **Funds cannot be stranded.** `close`, `finalize` and `cancel` are permissionless, so an
  abandoned resolver means a delay and then a full refund, never a lockup.
- **The challenge process terminates.** One proposal, one permitted replacement, and the
  replacement is uncontestable.

## This package is CommonJS

Deliberately, and it is the only one in the repository (ADR-0010). Nothing crosses the
seam except `@covenant/shared/vectors/golden.json`, read as JSON.

The tests prove the hash chain without importing the canonicaliser:

```
canonical text (from the shared vectors)
  -> ethers.keccak256(ethers.toUtf8Bytes(...))
  -> equals the locked rulesHash
  -> passed to createMarket
  -> read back from the chain unchanged
```

Solidity does not reproduce RFC 8785 canonicalisation, and the tests do not claim it does.
Parsing and re-serialising JSON in the EVM is exactly what committing a hash avoids.

## Compiler settings

Solidity 0.8.24, optimizer on (200 runs), **`evmVersion: paris`**.

The EVM target is pinned rather than left at the compiler default because X Layer is a
Polygon CDK zkEVM chain whose supported opcode set this project has not confirmed. `paris`
avoids Cancun additions such as `MCOPY` and `TSTORE`, costs nothing here, and is revisited
in Milestone 4 when the chain is actually probed. It is also why the contracts use
`ReentrancyGuard` rather than `ReentrancyGuardTransient`.

## No network deployment

`hardhat.config.ts` configures no X Layer network, and `scripts/deploy-local.ts` refuses
any chain id outside development. The testnet path arrives in Milestone 4, after a live
`eth_chainId` call confirms the values that `@covenant/shared` currently marks
`unverified`.
