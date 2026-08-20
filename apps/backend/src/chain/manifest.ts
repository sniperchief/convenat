/**
 * Loading the deployment manifest (§14).
 *
 * The backend learns every contract address from this file and from nowhere
 * else. There is no `FACTORY_ADDRESS` constant, no fallback, and no "if the
 * manifest is missing, assume local" branch — a process that cannot say which
 * contracts it is talking to should not start.
 *
 * The schema and the environment/chain checks live in `@covenant/shared` so the
 * deployer and the backend cannot drift apart about what a manifest is. This
 * module only adds the filesystem: read the path, parse the JSON, hand the
 * result to the shared validator, and turn every failure into an error that
 * names the path so an operator can act on it.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import {
  parseDeploymentManifest,
  type DeploymentEnvironment,
  type DeploymentManifest,
} from '@covenant/shared';

import { ConfigurationError } from '../errors.js';
import type { Address } from './types.js';

export interface LoadManifestOptions {
  readonly path: string;
  readonly chainId: number;
  readonly environment: DeploymentEnvironment;
  /** Base for a relative path. Defaults to the process working directory. */
  readonly cwd?: string;
}

/**
 * Read, parse and validate a deployment manifest.
 *
 * @throws {ConfigurationError} if the file is missing, unreadable, not JSON, not
 *   a valid manifest, or is for a different chain or environment. Every one of
 *   those is an operator error at startup, which is why they share a type and a
 *   fatal disposition rather than being smoothed over.
 */
export function loadDeploymentManifest(options: LoadManifestOptions): DeploymentManifest {
  const path = isAbsolute(options.path)
    ? options.path
    : resolve(options.cwd ?? process.cwd(), options.path);

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new ConfigurationError(
      `No deployment manifest at ${path}. Deploy the contracts first, or point ` +
        'X_LAYER_DEPLOYMENT_MANIFEST at the manifest for this network.',
      [{ path: 'X_LAYER_DEPLOYMENT_MANIFEST', message: 'file not found or unreadable' }],
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigurationError(`The deployment manifest at ${path} is not valid JSON.`, [
      { path: 'X_LAYER_DEPLOYMENT_MANIFEST', message: 'malformed JSON' },
    ]);
  }

  try {
    return parseDeploymentManifest(parsed, {
      chainId: options.chainId,
      environment: options.environment,
    });
  } catch (cause) {
    // The shared validator's message already says what is wrong — wrong chain,
    // wrong environment, bad address. Re-raise it as a configuration error so
    // startup treats it as fatal, and prefix the path so the operator knows
    // which file to fix.
    const issues =
      cause instanceof Error && 'issues' in cause
        ? ((cause as { issues: readonly { path: string; message: string }[] }).issues ?? [])
        : [];
    const error = new ConfigurationError(
      `The deployment manifest at ${path} was rejected: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      issues,
    );
    (error as { cause?: unknown }).cause = cause;
    throw error;
  }
}

/** The addresses the backend actually uses, extracted once at startup. */
export interface DeployedAddresses {
  readonly factory: Address;
  readonly implementation: Address;
  readonly settlementToken: Address;
  readonly startBlock: bigint;
}

export function addressesFrom(manifest: DeploymentManifest): DeployedAddresses {
  return {
    factory: manifest.contracts.MarketFactory.address as Address,
    implementation: manifest.contracts.ConditionalMarketImplementation.address as Address,
    settlementToken: manifest.contracts.TestUSD.address as Address,
    startBlock: BigInt(manifest.startBlock),
  };
}
