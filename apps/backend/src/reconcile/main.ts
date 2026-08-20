/**
 * Reconciliation command (§28).
 *
 *   npm run reconcile --workspace @covenant/backend
 *
 * Exits 0 when the indexed view matches the chain (warnings allowed), 1 when it
 * does not. The non-zero exit is the useful part: this is meant to be run in CI
 * and after every deployment, where a report nobody reads is worth nothing but
 * a failing job is impossible to ignore.
 */

import { createRuntime } from '../composition.js';
import { formatReconcileReport, reconcile } from './reconcile.js';

async function main(): Promise<void> {
  const runtime = await createRuntime();

  try {
    const report = await reconcile({
      client: runtime.chain,
      repositories: runtime.repositories,
      factoryAddress: runtime.addresses.factory,
    });

    console.log(formatReconcileReport(report));

    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(report, null, 2));
    }

    if (!report.healthy) process.exitCode = 1;
  } finally {
    await runtime.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
