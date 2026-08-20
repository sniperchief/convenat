/**
 * Export compiled ABIs as committed JSON.
 *
 *   npm run abi:export --workspace @covenant/contracts
 *
 * The backend declares its own `as const` ABI fragments so viem can infer types
 * from them, which a JSON import cannot provide. The obvious hazard is that
 * those fragments drift from what was actually compiled and deployed — a stale
 * event signature would decode a log into confident nonsense.
 *
 * This script writes the compiler's own output to `abi/*.json`, which
 * `apps/backend/test/abi-parity.test.ts` then compares the hand-written
 * fragments against. The JSON is committed, so the check runs without a
 * compilation step and drift fails a test rather than surfacing in production.
 *
 * Only JSON crosses the CommonJS seam (ADR-0010), which is exactly what this is.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { artifacts } from 'hardhat';

import { runScript } from './lib/support';

const CONTRACTS = ['MarketFactory', 'ConditionalMarket', 'TestUSD'] as const;

async function main(): Promise<void> {
  const outDir = resolve(__dirname, '..', 'abi');
  mkdirSync(outDir, { recursive: true });

  for (const name of CONTRACTS) {
    const artifact = await artifacts.readArtifact(name);
    const path = resolve(outDir, `${name}.json`);
    writeFileSync(path, `${JSON.stringify(artifact.abi, null, 2)}\n`, 'utf8');
    console.log(`${name.padEnd(20)} ${artifact.abi.length} fragments → ${path}`);
  }
}

runScript(main);
