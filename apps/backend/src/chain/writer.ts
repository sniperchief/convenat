/**
 * The resolver's signer.
 *
 * The only file in the backend that holds a private key at run time, and the
 * only one that can produce a signed transaction. It is deliberately small and
 * deliberately separate from `client.ts`: reading the chain and signing for it
 * are different capabilities, and a component that is handed a `ChainClient`
 * should be structurally unable to transact.
 *
 * ## What this key can and cannot do
 *
 * The resolver address holds `PROPOSER_ROLE` on the factory and nothing else. On
 * the market contract that role reaches exactly one function,
 * `proposeResolution`, which writes an outcome and an evidence commitment and
 * transfers nothing. `packages/contracts/test/security.test.ts` enumerates the
 * whole ABI and asserts no fund-moving function is reachable by it.
 *
 * The other call here, `finalize()`, is permissionless on the contract and takes
 * no arguments. Sending it from the resolver key is a convenience, not a
 * privilege — any address may send it, and it makes the *standing* proposal
 * final rather than choosing one.
 *
 * ## Two rules this file enforces
 *
 * 1. **A key is never logged, never returned, and never persisted.** It is read
 *    once from configuration and turned into an account object. `describeConfig`
 *    reports only whether one is configured.
 * 2. **A transaction hash is not a result.** These methods return a hash and
 *    stop. Learning whether the effect happened is `waitForTransaction`'s job on
 *    the read client, which reports a mined revert as `FAILED`.
 */

import { createWalletClient, http, type Account, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { ChainUnavailableError, ConfigurationError } from '../errors.js';
import { conditionalMarketAbi } from './abi.js';
import { outcomeOrdinal } from './enums.js';
import type { Address, Hex, OnChainOutcome, ResolverChainWriter } from './types.js';

export interface ViemResolverWriterOptions {
  readonly chainId: number;
  readonly rpcUrl: string;
  /** 0x-prefixed 32-byte hex. Validated here; never echoed anywhere. */
  readonly privateKey: string;
  readonly requestTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Wrap an RPC or signing failure.
 *
 * The cause is attached for the log; the client-facing message on
 * `ChainUnavailableError` is fixed, because an RPC URL can carry an API key in
 * its path and a signing error can quote calldata.
 */
async function send(operation: string, run: () => Promise<Hex>): Promise<Hex> {
  try {
    return await run();
  } catch (cause) {
    const error = new ChainUnavailableError(`The resolver could not submit ${operation}.`);
    (error as { cause?: unknown }).cause = cause;
    throw error;
  }
}

export class ViemResolverWriter implements ResolverChainWriter {
  readonly resolverAddress: Address;

  private readonly account: Account;
  private readonly client: WalletClient;
  private readonly chainId: number;

  constructor(options: ViemResolverWriterOptions) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(options.privateKey.trim())) {
      // Refused at construction rather than at the first transaction: a
      // malformed key discovered while a market is waiting to be resolved is a
      // configuration error found at the worst possible moment.
      throw new ConfigurationError('The resolver private key is not a 0x-prefixed 32-byte hex value.', [
        { path: 'RESOLVER_PRIVATE_KEY', message: 'must be 0x followed by 64 hex characters' },
      ]);
    }

    this.account = privateKeyToAccount(options.privateKey.trim() as Hex);
    this.resolverAddress = this.account.address.toLowerCase() as Address;
    this.chainId = options.chainId;
    this.client = createWalletClient({
      account: this.account,
      transport: http(options.rpcUrl, {
        timeout: options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
        retryCount: 1,
      }),
    });
  }

  async proposeResolution(input: {
    readonly market: Address;
    readonly outcome: Exclude<OnChainOutcome, 'UNSET'>;
    readonly evidenceHash: Hex;
  }): Promise<Hex> {
    // `UNSET` is excluded by the parameter type and rejected by the contract
    // (`InvalidOutcome`). The ordinal conversion is the shared one, so a
    // reordering of the Solidity enum breaks the parity test rather than
    // silently proposing the wrong outcome.
    const ordinal = outcomeOrdinal(input.outcome);

    return send(`a resolution proposal to ${input.market}`, () =>
      this.client.writeContract({
        account: this.account,
        // No `chain` preset: the chain is whatever the manifest and the startup
        // chain-id check agreed on, not a compile-time constant. viem needs the
        // field present, and `null` means "use the connected chain".
        chain: null,
        address: input.market,
        abi: conditionalMarketAbi,
        functionName: 'proposeResolution',
        args: [ordinal, input.evidenceHash],
      }),
    );
  }

  async finalize(market: Address): Promise<Hex> {
    return send(`a finalization for ${market}`, () =>
      this.client.writeContract({
        account: this.account,
        chain: null,
        address: market,
        abi: conditionalMarketAbi,
        functionName: 'finalize',
        args: [],
      }),
    );
  }

  /** The chain this writer was built for. Compared against the read client. */
  get configuredChainId(): number {
    return this.chainId;
  }
}
