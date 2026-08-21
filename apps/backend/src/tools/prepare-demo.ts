/**
 * Build the deterministic demo market: specification, rulesHash, validation plan.
 *
 *   npm run build --workspace @covenant/backend
 *   node --env-file=../../.env dist/tools/prepare-demo.js
 *
 * Writes `packages/contracts/deployments/xlayer-testnet-demo.json`, which the
 * contracts script reads to create the market on-chain and which
 * `register-demo.ts` posts to the API.
 *
 * ## Why this condition
 *
 * The brief asks for a condition that "can be resolved using publicly available
 * evidence" and warns against ambiguous real-world ones. The choice here is a
 * **numeric threshold against a public JSON API**, because that is the shape the
 * deterministic layer can actually decide:
 *
 *   Will `ethereum/go-ethereum` report more than 40,000 stargazers, as read from
 *   the GitHub REST API, at or before <deadline>?
 *
 * Three properties make it a good demo and a poor gamble:
 *
 * 1. **The answer is not in doubt.** The repository has had well over 40,000
 *    stars for years. A demo whose outcome is genuinely uncertain is a demo that
 *    can fail live for reasons that have nothing to do with the software.
 * 2. **The evidence is a single JSON field at a stable path.** `/stargazers_count`
 *    is an integer, extractable by JSON pointer, so the claim behind the outcome
 *    is `JSON_POINTER` — reproducible by anyone, not a model's reading.
 * 3. **The comparison is exact.** `NUMERIC_COMPARISON`, `GT`, `40000`, decided
 *    by `BigInt`-backed decimals. The model is asked to concur, never to compute.
 *
 * The api.github.com endpoint needs no credentials for a public repository, and
 * `url-policy.ts` refuses any URL carrying one, so none can be smuggled in.
 *
 * ## What is generated and what is fixed
 *
 * The deadline and trading end are relative to run time so the demo can be
 * driven in one sitting; `nonce` is random so a second run produces a different
 * `rulesHash` and does not collide with the factory's one-market-per-hash rule.
 * Everything else — the question, the conditions, the source, the threshold — is
 * fixed, because those are what the demo is showing.
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

import { validateValidationPlan, type ValidationPlanInput } from '../validation/plan.js';

/**
 * Timings, sized for a live demo rather than for a test.
 *
 * These are wall-clock waits against a public chain — there is no
 * `evm_increaseTime` on X Layer. Trading closes before the condition is due, and
 * the condition must be due before a proposal is accepted, so the floor on the
 * whole demo is `DEADLINE_SECONDS + CHALLENGE_WINDOW_SECONDS`.
 *
 * Overridable from the environment because the right value depends on what is
 * being done: a rehearsal wants the shortest window that still works, and a live
 * audience wants enough room to create the market, stake from two wallets and
 * talk through the specification before the deadline passes. The defaults are
 * sized for the second.
 *
 * **Setting these too low is how a demo fails**: `createMarket` reverts with
 * `TradingEndsInThePast` if trading has already ended by the time the
 * transaction lands, and a public chain does not mine on request.
 */
const seconds = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer number of seconds`);
  }
  return value;
};

const TRADING_SECONDS = seconds('DEMO_TRADING_SECONDS', 420);
const DEADLINE_SECONDS = seconds('DEMO_DEADLINE_SECONDS', 600);
/** The schema minimum. Long enough to demonstrate the window, short enough to wait out. */
const CHALLENGE_WINDOW_SECONDS = seconds('DEMO_CHALLENGE_WINDOW_SECONDS', 60);
const RESOLUTION_DEADLINE_SECONDS = 3600;
/** 25 TUSD, six decimals. */
const CHALLENGE_BOND = '25000000';

/** The threshold the market settles on. Exact, integer, and nowhere near the truth. */
const STAR_THRESHOLD = '40000';
const SOURCE_URL = 'https://api.github.com/repos/ethereum/go-ethereum';

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is not set.`);
  return value;
}

function buildSpec(input: {
  creator: string;
  token: { chainId: number; address: string; symbol: string; decimals: number };
  now: Date;
}): ConditionSpecInput {
  const deadline = new Date(input.now.getTime() + DEADLINE_SECONDS * 1000);
  const tradingEndsAt = new Date(input.now.getTime() + TRADING_SECONDS * 1000);

  return {
    version: '1.0',
    nonce: `0x${randomBytes(32).toString('hex')}`,
    creator: input.creator,
    question:
      'Will the ethereum/go-ethereum repository report more than 40,000 stargazers on the ' +
      'GitHub REST API at the deadline?',
    conditionType: 'binary',
    successCondition:
      'The GitHub REST API record for the repository ethereum/go-ethereum reports a ' +
      '`stargazers_count` strictly greater than 40000, read at or before the deadline.',
    failureCondition:
      'The GitHub REST API record for the repository ethereum/go-ethereum reports a ' +
      '`stargazers_count` of 40000 or fewer, read at or before the deadline.',
    deadline: deadline.toISOString(),
    timezone: 'UTC',
    resolutionMethod: 'deterministic_numeric_threshold',
    approvedSources: [
      {
        // Index 0 is primary. There is exactly one source, deliberately: the
        // demo is about the pipeline, and a fallback that is never read would
        // only add a `NOT_ATTEMPTED` row nobody learns anything from.
        name: 'GitHub REST API — ethereum/go-ethereum repository record',
        url: SOURCE_URL,
        retrievalKind: 'http_json',
        dataPath: '/stargazers_count',
      },
    ],
    evidenceRequirements: [
      'The `stargazers_count` field of the GitHub repository record, at retrieval time.',
      'The UTC instant of retrieval.',
      'The keccak256 hash of the complete response body, so the reading can be checked.',
    ],
    ambiguities: [
      {
        description:
          'GitHub may serve a cached count, so two reads seconds apart can differ by a few stars.',
        assumption:
          'The count read from the approved source at resolution time is the count, whatever ' +
          'caching produced it. The threshold is set far from the current value so that cache ' +
          'skew cannot change the outcome.',
      },
      {
        description: 'The repository could be renamed, transferred or made private.',
        assumption:
          'Only the approved URL is consulted. If it does not serve a repository record, no ' +
          'outcome is inferred from its absence.',
      },
    ],
    edgeCases: [
      {
        scenario:
          'The approved source is unreachable, or does not return a readable stargazers_count, ' +
          'throughout the resolution window.',
        // Refunds. It takes money from nobody, which is why an edge case is
        // permitted to reach it and why the model may apply one.
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

/**
 * The deterministic acceptance criteria.
 *
 * `encodes: 'successCondition'` says these checks were written against the
 * success condition, so a `SATISFIED` verdict maps to `YES`. Getting that
 * backwards is the mistake `resolution/outcome.ts` exists to prevent, and it is
 * why the field is explicit rather than assumed.
 */
const VALIDATION_PLAN: ValidationPlanInput = {
  checks: [
    {
      checkId: 'stargazers-above-threshold',
      kind: 'NUMERIC_COMPARISON',
      observation: { sourceId: 'source-0', pointer: '/stargazers_count' },
      operator: 'GREATER_THAN',
      threshold: STAR_THRESHOLD,
    },
  ],
  encodes: 'successCondition',
};

function main(): void {
  const repoRoot = resolve(process.cwd(), '..', '..');
  const manifestPath =
    process.env['X_LAYER_DEPLOYMENT_MANIFEST'] ??
    resolve(repoRoot, 'packages/contracts/deployments/xlayer-testnet.json');

  const manifest = parseDeploymentManifest(JSON.parse(readFileSync(manifestPath, 'utf8')), {
    chainId: 1952,
    environment: 'testnet',
  });

  const creator = requireEnv('WALLET_A_ADDRESS').toLowerCase();
  const now = new Date();
  const token = {
    chainId: manifest.chainId,
    address: manifest.contracts.TestUSD.address,
    symbol: 'TUSD',
    decimals: 6,
  };

  const input = buildSpec({ creator, token, now });

  // The shared validator is the only gate. A specification that does not pass it
  // never acquires a hash and therefore never reaches a market.
  const validated = validateConditionSpec(input);
  if (!validated.ok) {
    throw new Error(
      'The demo specification failed shared validation:\n' +
        validated.issues.map((issue) => `  ${issue.path}: ${issue.message}`).join('\n'),
    );
  }

  // Validated here as well as at the API, so a broken plan is caught before a
  // market is created rather than at resolution time with money staked.
  const plan = validateValidationPlan(VALIDATION_PLAN);
  if (!plan.ok) {
    throw new Error(
      'The demo validation plan is invalid:\n' +
        plan.issues.map((issue) => `  ${issue.path}: ${issue.message}`).join('\n'),
    );
  }

  const commitment = buildRulesCommitment(validated.value);
  const spec = commitment.spec;

  const document = {
    generatedAt: now.toISOString(),
    chainId: manifest.chainId,
    environment: manifest.environment,
    factory: manifest.contracts.MarketFactory.address,
    creator,
    market: {
      variant: 'demo',
      rulesHash: commitment.rulesHash,
      canonical: commitment.canonical,
      specification: spec,
      validationPlan: plan.plan,
      createMarketParams: {
        token: token.address,
        rulesHash: commitment.rulesHash,
        tradingEndsAt: Math.floor(Date.parse(spec.settlement.tradingEndsAt) / 1000),
        conditionDeadline: Math.floor(Date.parse(spec.deadline) / 1000),
        challengeWindow: spec.settlement.challengeWindowSeconds,
        resolutionWindow: spec.settlement.resolutionDeadlineSeconds,
        challengeBond: spec.settlement.challengeBondBaseUnits,
      },
    },
  };

  const outPath = resolve(repoRoot, 'packages/contracts/deployments/xlayer-testnet-demo.json');
  writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  console.log(`chain          ${manifest.chainId} (${manifest.environment})`);
  console.log(`creator        ${creator}`);
  console.log(`token          ${token.address}`);
  console.log('');
  console.log(`question       ${spec.question}`);
  console.log(`source         ${SOURCE_URL} → /stargazers_count`);
  console.log(
    `criterion      stargazers_count GREATER_THAN ${STAR_THRESHOLD} (encodes successCondition)`,
  );
  console.log('');
  console.log(`rulesHash      ${commitment.rulesHash}`);
  console.log(`trading ends   ${spec.settlement.tradingEndsAt}`);
  console.log(`deadline       ${spec.deadline}`);
  console.log(`challenge win  ${spec.settlement.challengeWindowSeconds}s`);
  console.log('');
  console.log(`written to     ${outPath}`);
}

main();
