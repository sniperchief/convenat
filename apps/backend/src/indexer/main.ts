/**
 * Indexer process entry point.
 *
 *   npm run start:indexer --workspace @covenant/backend
 *   npm run start:indexer --workspace @covenant/backend -- --once
 *
 * A separate process from the API on purpose: the indexer's failure mode is
 * "falls behind", the API's is "stops answering", and coupling them would make
 * the first cause the second. It shares the composition root, so it performs the
 * same manifest and chain-id checks before reading a single log.
 */

import { createRuntime } from '../composition.js';
import { MarketIndexer } from './indexer.js';

async function main(): Promise<void> {
  const once = process.argv.includes('--once');
  const runtime = await createRuntime();

  const logger = {
    info: (payload: Record<string, unknown>, message: string): void =>
      console.log(message, JSON.stringify(payload)),
    warn: (payload: Record<string, unknown>, message: string): void =>
      console.warn(message, JSON.stringify(payload)),
    error: (payload: Record<string, unknown>, message: string): void =>
      console.error(message, payload),
  };

  const override = runtime.config.chain.startBlockOverride;
  const startBlock = override ?? runtime.addresses.startBlock;

  if (override !== null && override !== runtime.addresses.startBlock) {
    // Loud, because starting forward of the deployment block is how markets go
    // missing. An operator doing this deliberately should still see it said.
    console.warn(
      `WARNING: INDEXER_START_BLOCK=${override} overrides the manifest's deployment block ` +
        `${runtime.addresses.startBlock}. Any market created before ${override} will not be ` +
        'indexed.',
    );
  }

  const indexer = new MarketIndexer({
    client: runtime.chain,
    repositories: runtime.repositories,
    startBlock,
    reorgWindow: runtime.config.chain.reorgWindow,
    logger,
  });

  console.log(
    `indexer starting — chain ${runtime.config.chainId} (${runtime.config.chain.networkKey}), ` +
      `factory ${runtime.addresses.factory}, start block ${startBlock}, ` +
      `${runtime.config.chain.confirmations} confirmations, reorg window ` +
      `${runtime.config.chain.reorgWindow}`,
  );

  if (once) {
    // Catch up fully, but in bounded passes — each one commits its checkpoint,
    // so an interrupted bootstrap resumes rather than restarting.
    let totalEvents = 0;
    let totalInserted = 0;

    const final = await indexer.catchUp((pass) => {
      totalEvents += pass.eventsSeen;
      totalInserted += pass.eventsInserted;
      const remaining = pass.safeHead - pass.toBlock;
      console.log(
        `  blocks ${pass.fromBlock}–${pass.toBlock}  events=${pass.eventsSeen} ` +
          `new=${pass.eventsInserted}  remaining=${remaining}`,
      );
    });

    console.log('');
    console.log(
      `caught up to safe head ${final.safeHead} — ${totalEvents} events seen, ` +
        `${totalInserted} newly stored`,
    );
    await runtime.close();
    return;
  }

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} — stopping after the current pass`);
    indexer.stop();
    await runtime.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await indexer.run(runtime.config.chain.pollIntervalMs);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
