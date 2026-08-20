/**
 * The deployment manifest — the only channel by which a contract address
 * reaches an application.
 *
 * No address is a build-time constant. A deployment produces addresses; a
 * manifest records them; every consumer reads them from there. That is what
 * stops a testnet token address from being compiled into a bundle and shipped,
 * and it is why `packages/shared/src/chains/xlayer.ts` deliberately holds no
 * address at all.
 *
 * The schema lives here rather than in the deployer or the backend because both
 * sides must agree on it. `packages/contracts` is a CommonJS island (ADR-0010)
 * and only JSON crosses that seam, so the deploy script builds the object
 * against the *types* here (erased at compile time) and this validator is what
 * actually checks the written file — in the backend at startup, and in a unit
 * test against the committed manifest.
 *
 * `environment` is the field that matters most. It is not decoration: the
 * backend refuses to start against a manifest whose environment it was not
 * configured for, so a mainnet manifest cannot be loaded by a testnet process
 * even if every other field looks plausible.
 */

import { z } from 'zod';

import { UnsupportedNetworkError } from '../errors.js';
import { getNetwork, isNetworkKey, type NetworkKey } from '../chains/xlayer.js';

/**
 * Which world this deployment belongs to.
 *
 * Separate from `network` on purpose. A network key names a chain; an
 * environment names the blast radius. Code that must never touch production
 * money checks this field, and a check against a single word is one a reviewer
 * can verify at a glance.
 */
export type DeploymentEnvironment = 'local' | 'testnet' | 'mainnet';

export const DEPLOYMENT_SCHEMA_VERSION = 1;

const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte hex address')
  .transform((value) => value.toLowerCase());

const txHashSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 0x-prefixed 32-byte hex hash')
  .transform((value) => value.toLowerCase());

/**
 * Explorer verification status, recorded as an outcome rather than an intent.
 *
 * `attempted-failed` exists so a failed verification is a value in the manifest
 * instead of an absence someone later reads as success. `unsupported` records
 * that this chain's explorer has no verification endpoint we could reach.
 */
const verificationSchema = z.object({
  status: z.enum(['verified', 'attempted-failed', 'not-attempted', 'unsupported']),
  /** Explorer URL for the verified source, when there is one. */
  url: z.string().url().nullable().default(null),
  note: z.string().default(''),
});

const contractSchema = z.object({
  address: addressSchema,
  transactionHash: txHashSchema.nullable(),
  blockNumber: z.number().int().nonnegative().nullable(),
  /**
   * ABI-level constructor arguments, as strings.
   *
   * Recorded because a verification request must reproduce them exactly, and
   * because a manifest that names an address without saying how it was
   * constructed cannot be checked against its own source.
   */
  constructorArgs: z.array(z.string()).default([]),
  verification: verificationSchema,
});

/**
 * Compiler settings, recorded so the deployed bytecode can be reproduced.
 *
 * Explorer verification fails unless these match exactly, and a manifest that
 * omitted them would leave the only copy of that information in a config file
 * that has since moved on.
 */
const compilerSchema = z.object({
  solc: z.string(),
  evmVersion: z.string(),
  optimizer: z.object({ enabled: z.boolean(), runs: z.number().int().nonnegative() }),
});

export const deploymentManifestSchema = z
  .object({
    schemaVersion: z.literal(DEPLOYMENT_SCHEMA_VERSION),
    environment: z.enum(['local', 'testnet', 'mainnet']),
    network: z.string().refine(isNetworkKey, 'must be a configured network key'),
    chainId: z.number().int().positive(),
    deployedAt: z.string().datetime({ offset: true }),
    /** Deployer EOA. An address, never a key — see the note at the bottom. */
    deployer: addressSchema,
    /** Holder of PROPOSER_ROLE at deployment. */
    resolver: addressSchema,
    compiler: compilerSchema,
    /**
     * Earliest block an indexer must scan from.
     *
     * The factory's deployment block. Starting later would silently miss
     * markets; starting at genesis would scan tens of millions of empty blocks.
     */
    startBlock: z.number().int().nonnegative(),
    contracts: z.object({
      TestUSD: contractSchema,
      ConditionalMarketImplementation: contractSchema,
      MarketFactory: contractSchema,
    }),
  })
  .strict()
  // The network key and the chain id are two spellings of the same fact. If
  // they disagree, one of them was edited by hand and neither can be trusted.
  .superRefine((manifest, ctx) => {
    const network = getNetwork(manifest.network);
    if (network.chainId !== manifest.chainId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['chainId'],
        message: `network "${manifest.network}" is chain ${network.chainId}, not ${manifest.chainId}`,
      });
    }
    const expectedEnvironment: DeploymentEnvironment =
      network.key === 'local' ? 'local' : network.isTestnet ? 'testnet' : 'mainnet';
    if (manifest.environment !== expectedEnvironment) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['environment'],
        message: `network "${manifest.network}" is a ${expectedEnvironment} network, not ${manifest.environment}`,
      });
    }
  });

export type DeploymentManifest = z.infer<typeof deploymentManifestSchema>;
export type DeployedContract = DeploymentManifest['contracts']['MarketFactory'];

/**
 * Parse and check a manifest against the environment the caller expects.
 *
 * Both guards are the caller's stated expectation, not a preference read out of
 * the file: a process configured for chain 1952 must not accept a manifest for
 * anything else, however well-formed. This is the check that makes "backend
 * configured for testnet, pointed at mainnet" impossible rather than merely
 * unlikely.
 *
 * @throws {UnsupportedNetworkError} if the document is malformed, or is for a
 *   different chain or environment than the caller expects.
 */
export function parseDeploymentManifest(
  input: unknown,
  expected: { chainId: number; environment: DeploymentEnvironment },
): DeploymentManifest {
  const parsed = deploymentManifestSchema.safeParse(input);
  if (!parsed.success) {
    throw new UnsupportedNetworkError(
      'The deployment manifest is not valid.',
      parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }

  const manifest = parsed.data;

  if (manifest.environment !== expected.environment) {
    throw new UnsupportedNetworkError(
      `Refusing a ${manifest.environment} deployment manifest: this process is configured for ` +
        `${expected.environment}.`,
      [{ path: 'environment', message: `expected ${expected.environment}` }],
    );
  }

  if (manifest.chainId !== expected.chainId) {
    throw new UnsupportedNetworkError(
      `The deployment manifest is for chain ${manifest.chainId}, but this process is configured ` +
        `for chain ${expected.chainId}.`,
      [{ path: 'chainId', message: `expected ${expected.chainId}` }],
    );
  }

  return manifest;
}

/** The environment a network key implies. Never inferred from anything else. */
export function environmentForNetwork(key: NetworkKey): DeploymentEnvironment {
  const network = getNetwork(key);
  if (network.key === 'local') return 'local';
  return network.isTestnet ? 'testnet' : 'mainnet';
}
