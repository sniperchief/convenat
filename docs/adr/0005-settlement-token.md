# ADR-0005: Deploy our own test settlement token on X Layer testnet

**Status:** Accepted — 2026-08-16

## Context

The MVP requires locking "testnet stablecoin funds". No canonical, faucet-backed
stablecoin address on X Layer testnet (chain 1952) has been confirmed by this project, and
§32 forbids inventing token addresses.

## Decision

`packages/contracts` includes `TestUSD` — an OpenZeppelin ERC-20 with 6 decimals and a
public `mint()` — deployed **only** to local and X Layer testnet. Its address is written
to `deployments/xlayer-testnet.json` and consumed from there; it is never a source
constant.

The market contract accepts the token address as an init parameter, so switching to a real
stablecoin on mainnet is a deployment-manifest change, not a code change. `TestUSD` is
guarded so it cannot be deployed to chain 196.

Should an official X Layer testnet stablecoin be confirmed later, the manifest is updated
and `TestUSD` is retired.

## Consequences

- Testnet end-to-end flow is unblocked without waiting on an external faucet.
- Anyone can mint the test token, which is correct for testnet and dangerous anywhere
  else — hence the chain-id guard in the deploy script.
- The mainnet settlement token remains an **unconfirmed dependency** and is tracked in
  BUILD_STATE.md. It must be resolved before any mainnet deployment.
- `SafeERC20` is used throughout, so tokens with non-standard return values are handled.
  Fee-on-transfer and rebasing tokens are explicitly **not** supported; the market
  validates its received balance delta on stake and reverts on mismatch.
