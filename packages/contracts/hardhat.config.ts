import '@nomicfoundation/hardhat-ethers';
import '@nomicfoundation/hardhat-chai-matchers';
import '@nomicfoundation/hardhat-network-helpers';
import '@nomicfoundation/hardhat-verify';

import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import type { HardhatUserConfig } from 'hardhat/config';

// The repo-root .env, so one file serves the contracts and the backend. Never
// committed; see .gitignore.
loadEnv({ path: resolve(__dirname, '..', '..', '.env') });

/**
 * Network and compiler configuration.
 *
 * Networks are listed explicitly and never share configuration (§8). `hardhat`
 * is the in-process chain; `xlayerTestnet` is chain 1952. **There is no mainnet
 * entry**, and its absence is the point — a mainnet deployment should require
 * someone to add a network and explain why in review, not a flag that already
 * works.
 *
 * `evmVersion` is pinned to `paris` — see the decision below.
 */

/**
 * Accounts come from the environment or not at all.
 *
 * An empty array means "no signer configured", which makes every deployment
 * command fail with a clear error rather than silently falling back to a
 * default account. No key, mnemonic or derivation path appears in this file.
 */
function accountsFrom(...names: readonly string[]): string[] {
  return names
    .map((name) => process.env[name]?.trim())
    .filter((key): key is string => key !== undefined && key.length > 0);
}

const XLAYER_TESTNET_CHAIN_ID = 1952;

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.24',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      /**
       * **Decision (M4): `paris` stays.**
       *
       * The M2 pin was defensive — X Layer's opcode support was unconfirmed, so
       * Cancun additions (MCOPY, TSTORE) were avoided on principle. Milestone 4
       * settled the factual question by probing the live chain: X Layer testnet
       * runs op-reth (`reth/v2.3.0 … xlayer/v0.0.7`) and its block headers carry
       * `parentBeaconBlockRoot`, `blobGasUsed` and `excessBlobGas` (Cancun) as
       * well as `requestsHash` (Prague). Cancun and Prague opcodes **are**
       * available.
       *
       * The pin is kept anyway, for reasons that are about this codebase rather
       * than the chain:
       *
       *  - Nothing here uses a Cancun feature. `ReentrancyGuard` is the
       *    storage-slot version, deliberately (ADR-0009 note 6), and no contract
       *    performs the large memory copies where MCOPY would pay.
       *  - `paris` output is a strict subset of what a Cancun/Prague chain
       *    executes, so the pin costs correctness nothing.
       *  - The M2 test suite and security review were performed against this
       *    bytecode. Changing the compilation target to gain nothing measurable
       *    would invalidate that work for a rounding-error gas saving.
       *
       * What has changed is that this is now a *choice* rather than an unknown.
       * `ReentrancyGuardTransient` and MCOPY are available whenever there is a
       * reason to want them. Recorded as ADR-0012.
       */
      evmVersion: 'paris',
    },
  },
  paths: {
    sources: 'contracts',
    tests: 'test',
    cache: 'cache',
    artifacts: 'artifacts',
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    xlayerTestnet: {
      url: process.env['XLAYER_TESTNET_RPC_URL']?.trim() || 'https://testrpc.xlayer.tech/terigon',
      // Declared so Hardhat itself rejects a mismatch before a script runs. The
      // deploy script checks again against the live node (§9) — this is the
      // cheap guard, that one is the real one.
      chainId: XLAYER_TESTNET_CHAIN_ID,
      accounts: accountsFrom(
        'DEPLOYER_PRIVATE_KEY',
        'RESOLVER_PRIVATE_KEY',
        'WALLET_A_PRIVATE_KEY',
        'WALLET_B_PRIVATE_KEY',
      ),
    },
  },
  /**
   * Explorer verification.
   *
   * X Layer testnet moved to chain 1952 with the OP Stack migration; OKLink's
   * published Hardhat instructions still describe the retired chain 195. The
   * endpoint below is therefore **unconfirmed** and `scripts/verify.ts` reports
   * honestly whether it worked rather than assuming it did (§11).
   */
  etherscan: {
    apiKey: {
      xlayerTestnet: process.env['XLAYER_EXPLORER_API_KEY']?.trim() ?? '',
    },
    customChains: [
      {
        network: 'xlayerTestnet',
        chainId: XLAYER_TESTNET_CHAIN_ID,
        urls: {
          apiURL: 'https://www.oklink.com/api/v5/explorer/contract/verify-source-code-plugin/XLAYER_TESTNET',
          browserURL: 'https://web3.okx.com/explorer/x-layer-testnet',
        },
      },
    ],
  },
  mocha: {
    timeout: 120_000,
  },
};

export default config;
