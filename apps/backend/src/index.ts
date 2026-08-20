/**
 * API process entry point.
 *
 * Dependencies are built by `createRuntime`, which loads the manifest and
 * confirms the chain id before this file binds a port. A backend that cannot
 * prove which chain it is on does not serve requests.
 */

import { buildServer } from './api/server.js';
import { createRuntime } from './composition.js';
import { describeConfig } from './config.js';
import { isCovenantError } from '@covenant/shared';

async function main(): Promise<void> {
  const runtime = await createRuntime();
  const { config } = runtime;

  const app = buildServer({
    config,
    repositories: runtime.repositories,
    compiler: runtime.compiler,
    auth: runtime.auth,
    chain: runtime.chain,
    contracts: {
      factory: runtime.addresses.factory,
      settlementToken: runtime.addresses.settlementToken,
    },
  });

  // describeConfig, never config: the raw object holds the API key, the
  // resolver key and the database URL, and none of those may reach a log.
  app.log.info(describeConfig(config), 'backend starting');
  app.log.info(
    {
      network: config.chain.networkKey,
      chainId: config.chainId,
      factory: runtime.addresses.factory,
      settlementToken: runtime.addresses.settlementToken,
      startBlock: runtime.addresses.startBlock.toString(),
      manifestEnvironment: runtime.manifest.environment,
    },
    'deployment manifest loaded and chain id verified',
  );

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await runtime.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.api.host, port: config.api.port });
}

main().catch((error: unknown) => {
  // Startup failures print the public projection for a typed error, so a
  // missing environment variable, a wrong-chain manifest or a chain-id mismatch
  // is named without a stack trace burying it.
  if (isCovenantError(error)) {
    console.error(JSON.stringify(error.toApiError(), null, 2));
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
