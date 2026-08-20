/**
 * Build the ConditionSpecs for the testnet lifecycle, and hash them (§22).
 *
 *   node dist/tools/prepare-market.js
 *
 * This is the off-chain half of the flow the milestone specifies:
 *
 *     ConditionSpec → shared validation → rulesHash → (createMarket)
 *
 * It runs here, in the ESM workspace, because `@covenant/shared` is the *only*
 * implementation of canonicalisation and hashing and nothing may reimplement
 * either. `packages/contracts` is a CommonJS island (ADR-0010), so the result
 * crosses to the deploy scripts as JSON — the same seam `golden.json` already
 * uses. The contracts script then creates the market with this hash and reads it
 * back off the chain to confirm they match; if they ever differ, that script
 * stops.
 *
 * Two specifications are produced, because §24 and §25 need different fates:
 *
 *   `plain`      — proposed once, left to finalize unchallenged.
 *   `challenged` — proposed, challenged by Wallet B, re-proposed, then finalized.
 *
 * They differ in wording, so they hash differently and the factory's
 * one-market-per-rules-hash rule is satisfied without a contrived nonce.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  buildRulesCommitment,
  parseDeploymentManifest,
  validateConditionSpec,
  type ConditionSpecInput,
} from '@covenant/shared';

/**
 * Lifecycle timings, chosen to be short enough to run and long enough to be
 * real.
 *
 * These are wall-clock waits against a live chain, not fast-forwarded test time
 * — X Layer has no `evm_increaseTime`. The condition deadline is what forces the
 * floor: a resolution cannot be proposed before it, so the script genuinely
 * waits. The challenge window is the schema minimum (60s).
 */
// Sized from a measured run, not guessed. The first attempt used 240s and the
// window closed before staking: preparing the specs, creating two markets and
// starting the lifecycle is a sequence of real transactions against a public
// chain, each waiting on a real block. The budget below leaves room for that
// whole sequence plus the operator time between commands.
const TRADING_SECONDS = 900;
const DEADLINE_SECONDS = 1200;
const CHALLENGE_WINDOW_SECONDS = 60;
/** Schema minimum. A deadline for the resolver, not a wait — we propose at once. */
const RESOLUTION_DEADLINE_SECONDS = 3600;
/** 25 TUSD, six decimals. */
const CHALLENGE_BOND = '25000000';

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is not set.`);
  }
  return value;
}

function buildSpec(input: {
  creator: string;
  token: { chainId: number; address: string; symbol: string; decimals: number };
  variant: 'plain' | 'challenged';
  now: Date;
}): ConditionSpecInput {
  const deadline = new Date(input.now.getTime() + DEADLINE_SECONDS * 1000);
  const tradingEndsAt = new Date(input.now.getTime() + TRADING_SECONDS * 1000);

  // Deliberately mundane and self-contained. This exists to exercise the
  // machinery, not to pose an interesting question, and a condition that
  // depended on real-world data would make the test flaky for reasons that have
  // nothing to do with the protocol.
  const label = input.variant === 'plain' ? 'A' : 'B';

  return {
    version: '1.0',
    nonce: `0x${randomBytes(32).toString('hex')}`,
    creator: input.creator,
    question: `Did designated X Layer testnet integration probe ${label} report status OK?`,
    conditionType: 'binary',
    successCondition:
      `The integration probe ${label} publishes a record whose status field is exactly "OK" ` +
      'at or before the deadline.',
    failureCondition:
      `The integration probe ${label} publishes a record whose status field is anything other ` +
      'than "OK", or publishes no record at all, by the deadline.',
    deadline: deadline.toISOString(),
    timezone: 'UTC',
    resolutionMethod: 'source_attested_status',
    approvedSources: [
      {
        name: `Covenant integration probe ${label} (primary)`,
        url: `https://example.org/covenant/testnet-probe-${label.toLowerCase()}/status.json`,
        retrievalKind: 'http_json',
        dataPath: '/status',
      },
    ],
    evidenceRequirements: [
      'The retrieved record, including its status field, captured at retrieval time.',
      'The UTC instant of retrieval.',
    ],
    ambiguities: [
      {
        description: 'The probe could publish a status after the deadline.',
        assumption: 'Only records published at or before the deadline are considered.',
      },
    ],
    edgeCases: [
      {
        scenario: 'The source is unreachable throughout the resolution window.',
        outcome: 'INVALID',
      },
    ],
    risk: 'low',
    settlement: {
      kind: 'binary_parimutuel',
      token: input.token,
      tradingEndsAt: tradingEndsAt.toISOString(),
      challengeWindowSeconds: CHALLENGE_WINDOW_SECONDS,
      challengeBondBaseUnits: CHALLENGE_BOND,
      resolutionDeadlineSeconds: RESOLUTION_DEADLINE_SECONDS,
    },
  };
}

function main(): void {
  const repoRoot = resolve(process.cwd(), '..', '..');
  const manifestPath =
    process.env['X_LAYER_DEPLOYMENT_MANIFEST'] ??
    resolve(repoRoot, 'packages/contracts/deployments/xlayer-testnet.json');

  const manifest = parseDeploymentManifest(
    JSON.parse(readFileSync(manifestPath, 'utf8')),
    { chainId: 1952, environment: 'testnet' },
  );

  const creator = requireEnv('WALLET_A_ADDRESS').toLowerCase();
  const now = new Date();

  const token = {
    chainId: manifest.chainId,
    address: manifest.contracts.TestUSD.address,
    symbol: 'TUSD',
    decimals: 6,
  };

  const markets = (['plain', 'challenged'] as const).map((variant) => {
    const input = buildSpec({ creator, token, variant, now });

    // The shared validator is the only gate. A specification that does not pass
    // it never acquires a hash, and therefore never reaches a market.
    const validated = validateConditionSpec(input);
    if (!validated.ok) {
      throw new Error(
        `The ${variant} specification failed shared validation:\n` +
          validated.issues.map((issue) => `  ${issue.path}: ${issue.message}`).join('\n'),
      );
    }

    const commitment = buildRulesCommitment(validated.value);

    return {
      variant,
      rulesHash: commitment.rulesHash,
      canonical: commitment.canonical,
      specification: commitment.spec,
      createMarketParams: {
        token: token.address,
        rulesHash: commitment.rulesHash,
        tradingEndsAt: Math.floor(Date.parse(commitment.spec.settlement.tradingEndsAt) / 1000),
        conditionDeadline: Math.floor(Date.parse(commitment.spec.deadline) / 1000),
        challengeWindow: commitment.spec.settlement.challengeWindowSeconds,
        resolutionWindow: commitment.spec.settlement.resolutionDeadlineSeconds,
        challengeBond: commitment.spec.settlement.challengeBondBaseUnits,
      },
    };
  });

  const outPath = resolve(repoRoot, 'packages/contracts/deployments/xlayer-testnet-markets.json');
  const document = {
    generatedAt: now.toISOString(),
    chainId: manifest.chainId,
    environment: manifest.environment,
    factory: manifest.contracts.MarketFactory.address,
    creator,
    markets,
  };

  writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  console.log(`chain      ${manifest.chainId} (${manifest.environment})`);
  console.log(`creator    ${creator}`);
  console.log(`token      ${token.address}`);
  console.log('');
  for (const market of markets) {
    console.log(`${market.variant.padEnd(11)} rulesHash ${market.rulesHash}`);
    console.log(`${''.padEnd(11)} deadline  ${market.specification.deadline}`);
  }
  console.log('');
  console.log(`written to ${outPath}`);
}

main();
