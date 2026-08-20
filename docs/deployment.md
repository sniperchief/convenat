# Deployment

How this system is deployed to X Layer Testnet, and the guarantees the process
is built to provide. Written in M4, against a real deployment — every address,
block and limit below was observed, not planned.

**Mainnet is out of scope.** There is no mainnet network in the Hardhat config,
`loadConfig` rejects `NETWORK=xlayer-mainnet` outright, and the backend refuses a
manifest whose `environment` is `mainnet`. That is three independent refusals,
and they are deliberate: an external audit has not been performed.

---

## 1. The chain

| | |
| --- | --- |
| Network | X Layer Testnet |
| Chain ID | **1952** (`0x7a0`) |
| RPC | `https://testrpc.xlayer.tech/terigon` |
| Client | `reth/v2.3.0-81573d2/…/xlayer/v0.0.7` — op-reth, OP Stack |
| Native gas token | OKB |
| Hardforks active | Shanghai, Cancun, Prague (see ADR-0012) |
| Typical gas price | ~0.02 gwei |
| Block gas limit | 210,000,000 |
| `eth_getLogs` cap | **100 blocks** per request |
| Faucet | <https://web3.okx.com/xlayer/faucet/xlayerfaucet> — 0.2 OKB/day |

Chain ID was confirmed with a live `eth_chainId` call before anything was
deployed, and `packages/shared/src/chains/xlayer.ts` records that confirmation
with its date. A network still marked `unverified` there must not be deployed to.

---

## 2. The deployed system

Recorded in [`packages/contracts/deployments/xlayer-testnet.json`](../packages/contracts/deployments/xlayer-testnet.json).
**That file is the only place a contract address exists.** No address is
compiled into any source file — the backend reads them from the manifest at
startup, and `packages/shared/src/chains/xlayer.ts` holds none by design.

| Contract | Address |
| --- | --- |
| TestUSD | `0x6d7227b319972af3006337fc5cda17737571c2e2` |
| ConditionalMarket (implementation) | `0xc9619d94a57f0480271142d6e22182a3264ac7d1` |
| MarketFactory | `0x0b039cfbd96c13c34a2fe9445d4e155a403cfb3e` |

Deployment block **38,533,494**. Compiler: solc 0.8.24, `evmVersion: paris`,
optimizer enabled at 200 runs.

---

## 3. Order, and why it is fixed

1. **TestUSD** — its constructor refuses any chain outside an explicit allowlist
   (31337 and 1952), so a deployment that reached the wrong network reverts here
   regardless of the script's own guards.
2. **ConditionalMarket implementation** — the logic contract every market clones.
   Its constructor calls `_disableInitializers()`, so it cannot be initialized
   directly.
3. **MarketFactory** — takes the implementation address as a constructor
   argument, so it cannot come first.

---

## 4. The guards

The deployment script performs these **before broadcasting anything**:

| Guard | Failure |
| --- | --- |
| Hardhat network name matches the intended target | throws, nothing sent |
| Live `eth_chainId` equals the target's chain ID | throws, nothing sent |
| Deployer key present in the environment | throws, nothing sent |
| Deployer holds a non-zero balance | throws, nothing sent |

The chain-ID check is the important one. Hardhat's own `chainId` setting is a
*declaration of intent*; the check asks the node and believes only the answer.
There is no code path that reaches a deployment transaction without it having
passed.

**Keys come from the environment and go nowhere else.** The manifest records the
deployer and resolver as *addresses*. No script logs a key, writes one to a file,
or includes one in an error message — error text names the missing variable, never
its value.

---

## 5. Running it

All commands from the repo root. Requires a populated `.env` (see
`.env.example`); it is gitignored.

```bash
# 1. compile, and export ABIs for the backend's parity test
npm run build     --workspace @covenant/contracts
npm run abi:export --workspace @covenant/contracts

# 2. deploy — writes deployments/xlayer-testnet.json
npm run deploy:testnet --workspace @covenant/contracts

# 3. explorer verification (see §7 — may report unsupported)
npm run verify:testnet --workspace @covenant/contracts

# 4. distribute gas and TestUSD to the participant wallets
npm run fund:testnet --workspace @covenant/contracts

# 5. build the ConditionSpecs and their rules hashes (uses @covenant/shared)
node --env-file=.env apps/backend/dist/tools/prepare-market.js

# 6. create the markets, verifying the hash survives the round trip
npm run market:testnet --workspace @covenant/contracts

# 7. drive the lifecycle — resumable, safe to re-run
npx hardhat run scripts/resume-lifecycle.ts --network xlayerTestnet
```

Steps 6 and 7 are resumable and derive what to do from on-chain state, so
re-running after a dropped connection repeats at most one transaction.

---

## 6. Reproducibility

The deployment is deterministic with respect to source, compiler settings,
constructor arguments and network. The manifest records all four:

- `compiler.solc`, `compiler.evmVersion`, `compiler.optimizer` — read from the
  Hardhat config at deploy time rather than retyped, so they cannot drift from
  the settings that actually produced the bytecode.
- `contracts.*.constructorArgs` — recorded because a verification request must
  reproduce them exactly, and because an address without its construction cannot
  be checked against its own source.
- `startBlock` — the factory's deployment block, which is where the indexer
  bootstraps from.

`schemaVersion`, `environment`, `network` and `chainId` are validated together by
`@covenant/shared`'s `parseDeploymentManifest`: the network key and the chain ID
must agree, and the environment must match what the network implies. A
hand-edited manifest fails rather than being half-trusted.

---

## 7. Explorer verification

**Status: unresolved.** OKLink's published Hardhat verification endpoint
documents `XLAYER_TESTNET` as **chain 195** — the retired Polygon-CDK zkEVM
testnet. This deployment is on **1952**, the OP Stack testnet that replaced it.
Whether that endpoint serves 1952 has not been established, and no explorer API
key was available during M4.

`scripts/verify.ts` records the outcome as a value in the manifest —
`verified`, `attempted-failed`, `unsupported`, or `not-attempted` — together with
the explorer's own message. There is no path through it that marks a contract
verified without the explorer having said so.

**Clone verification.** Markets are EIP-1167 minimal proxies. Their 45-byte
runtime contains no Solidity source, so "verifying a market" means verifying the
*implementation* it delegates to, which the script does. Explorers that
understand proxies then display the implementation's ABI against the clone. A
clone is recorded as `unsupported` with that explanation rather than left looking
unverified for no stated reason.

---

## 8. Backend startup

The backend performs three checks in order, before it binds a port:

1. **Configuration** — every missing variable reported at once. `NETWORK` and
   `CHAIN_ID` must agree; `xlayer-mainnet` is refused.
2. **Manifest** — loaded from `X_LAYER_DEPLOYMENT_MANIFEST`. Refused if missing,
   malformed, for another chain, or for another environment.
3. **Chain ID** — the RPC endpoint is asked what chain it serves, and a mismatch
   is fatal.

Check 3 is what makes "backend configured for testnet, RPC pointed at mainnet" a
startup crash rather than a silent and expensive mistake.

### Confirmation policy

The indexer never reads past `latest − INDEXER_CONFIRMATIONS`. The floor is a
network property (`minConfirmations`, 5 for X Layer testnet); an operator may lag
further behind head but **not less** — a smaller value is refused at startup
rather than clamped, because indexing closer to head than the chain warrants is
not a tuning choice but a decision to persist blocks that can still be replaced.

A transaction hash is not an outcome. The chain adapter distinguishes
`SUBMITTED` (the node accepted it), `CONFIRMED` (mined, succeeded, and buried
under the configured depth) and `FAILED` (mined and reverted). A mined revert is
`FAILED`, never success.

---

## 9. Operational notes learned the hard way

- **`eth_getLogs` is capped at 100 blocks.** Not documented anywhere this project
  found; discovered when a 2000-block request was rejected.
- **Catch-up is chunked and checkpointed per pass.** A bootstrap can span
  hundreds of thousands of blocks — at 100 per request that is thousands of
  calls, and committing the checkpoint only at the end means a dropped connection
  discards all of it. `maxBlocksPerPass` bounds the work a failure repeats.
- **IPv6.** If the database host resolves to both IPv4 and IPv6 and the machine
  cannot route IPv6, `pg` fails with `AggregateError [ETIMEDOUT]` after a long
  hang. Run node with `--dns-result-order=ipv4first`. This is an environment
  fault, not a code fault, but it is indistinguishable from "the database is
  down" unless you know to look.
- **`INDEXER_START_BLOCK`** overrides the manifest's bootstrap block. It exists
  to skip a known-empty prefix during development and **loses data if set forward
  of a real market**. The indexer logs a warning whenever it differs from the
  manifest.
