/**
 * A controlled test of the compiler against the real Anthropic provider (§29).
 *
 *   node --env-file=../../.env dist/tools/live-compiler-test.js
 *
 * What this is
 * ------------
 * A **validation experiment, not a benchmark.** Every M3 test used
 * `FakeLLMProvider`, which proves the system refuses whatever the model gets
 * wrong but says nothing about whether a real model, given this prompt, actually
 * declines when it should. Four fixed prompts are run once each and the outcome
 * recorded.
 *
 * What is recorded, and what is not
 * ---------------------------------
 * Recorded: whether the output parsed, whether the result was INCOMPLETE or
 * COMPILED, whether the resulting ConditionSpec passed shared validation, and
 * the rulesHash if one was produced.
 *
 * **Not recorded:** the model's response text, the interpretation, the question
 * wording, or anything else the provider returned. §29 is explicit that API
 * responses containing private or user data must not be committed, and the
 * cheapest way to honour that is never to write them down. The API key is read
 * from the environment, is never logged, and is not part of the output.
 *
 * Nothing in the production system depends on this file.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import { parseDeploymentManifest, validateConditionSpec } from '@covenant/shared';

import { ConditionCompiler } from '../compiler/compiler.js';
import { AnthropicLLMProvider } from '../llm/anthropic-provider.js';

/**
 * The four cases §29 names.
 *
 * `expected` is what the *system* should do, and it is an assertion about
 * objectivity rather than about the model's opinion. A condition nobody could
 * settle from an approved source must not acquire a hash, however confident the
 * model sounds.
 */
const CASES = [
  {
    label: 'clear',
    expected: 'COMPILED',
    why: 'A fixed instant, a numeric threshold, and a named source. Objectively settleable.',
    message:
      'Pay out YES if the closing price of Bitcoin in USD, as published by the CoinGecko ' +
      'public API, is strictly above 100000 at 2026-12-31T23:59:59Z. Otherwise NO. ' +
      'Use https://api.coingecko.com/api/v3/simple/price as the source.',
  },
  {
    label: 'ambiguous',
    expected: 'INCOMPLETE',
    why: '"Does well" has no threshold and no source. There is nothing to measure.',
    message: 'Pay out if Ethereum does well by the end of next quarter.',
  },
  {
    label: 'subjective',
    expected: 'INCOMPLETE',
    why: 'Whether a film is "the best" is a matter of taste, not a fact any source attests.',
    message:
      'Pay out YES if the best film of 2026 is a science fiction film, decided at the end of the year.',
  },
  {
    label: 'missing deadline',
    expected: 'INCOMPLETE',
    why:
      'Objective and sourced, but with no instant to measure at. The compiler must ask ' +
      'rather than invent one — an invented deadline would go inside a hash a user is asked to approve.',
    message:
      'Pay out YES if SpaceX successfully launches Starship to orbit, according to the official ' +
      'SpaceX website at https://www.spacex.com/launches.',
  },
] as const;

interface CaseResult {
  label: string;
  expected: string;
  outcome: 'COMPILED' | 'INCOMPLETE' | 'ERROR';
  matchedExpectation: boolean;
  outputParsed: boolean;
  sharedValidationPassed: boolean | null;
  rulesHash: string | null;
  questionCount: number | null;
  missingFields: readonly string[] | null;
  /** Error class name only. Never the message — it can quote provider payloads. */
  errorType: string | null;
}

async function main(): Promise<void> {
  const apiKey = process.env['ANTHROPIC_API_KEY']?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error('ANTHROPIC_API_KEY is not set.');
  }

  const repoRoot = resolve(process.cwd(), '..', '..');
  const manifest = parseDeploymentManifest(
    JSON.parse(
      readFileSync(
        resolve(repoRoot, 'packages/contracts/deployments/xlayer-testnet.json'),
        'utf8',
      ),
    ),
    { chainId: 1952, environment: 'testnet' },
  );

  const model = process.env['LLM_MODEL']?.trim() ?? 'claude-haiku-4-5';

  const compiler = new ConditionCompiler({
    provider: new AnthropicLLMProvider({ apiKey, model }),
    token: {
      chainId: manifest.chainId,
      address: manifest.contracts.TestUSD.address,
      symbol: 'TUSD',
      decimals: 6,
    },
    policy: {
      tradingEndsLeadSeconds: 86_400,
      challengeWindowSeconds: 7_200,
      challengeBondBaseUnits: '50000000',
      resolutionWindowSeconds: 604_800,
    },
    maxOutputTokens: 16_000,
    timeoutMs: 180_000,
    now: () => new Date(),
    nonce: () => `0x${randomBytes(32).toString('hex')}`,
  });

  const creator = (process.env['WALLET_A_ADDRESS'] ?? `0x${'11'.repeat(20)}`).toLowerCase();
  const results: CaseResult[] = [];

  console.log(`model      ${model}`);
  console.log(`compiler   ${compiler.version}`);
  console.log(`token      ${manifest.contracts.TestUSD.address} (chain ${manifest.chainId})`);
  console.log('');

  for (const testCase of CASES) {
    process.stdout.write(`${testCase.label.padEnd(17)} `);

    try {
      const result = await compiler.compile({
        message: testCase.message,
        creator,
        history: [],
      });

      if (result.status === 'COMPILED') {
        // Re-validate independently. The compiler already does this, but §29
        // asks specifically whether the resulting spec passes shared validation,
        // and asking the validator directly is a stronger answer than trusting
        // that the compiler asked it.
        const revalidated = validateConditionSpec(result.specification);
        results.push({
          label: testCase.label,
          expected: testCase.expected,
          outcome: 'COMPILED',
          matchedExpectation: testCase.expected === 'COMPILED',
          outputParsed: true,
          sharedValidationPassed: revalidated.ok,
          rulesHash: result.rulesHash,
          questionCount: null,
          missingFields: null,
          errorType: null,
        });
        console.log(
          `COMPILED    validation=${revalidated.ok ? 'pass' : 'FAIL'}  ${result.rulesHash}`,
        );
      } else {
        // Field *paths* only. The accompanying messages are dropped: they can
        // quote the model's own words, and §29 forbids recording those.
        const missingFields = result.missing.map((issue) =>
          typeof issue === 'string' ? issue : issue.path,
        );
        results.push({
          label: testCase.label,
          expected: testCase.expected,
          outcome: 'INCOMPLETE',
          matchedExpectation: testCase.expected === 'INCOMPLETE',
          outputParsed: true,
          sharedValidationPassed: null,
          rulesHash: null,
          questionCount: result.questions.length,
          missingFields,
          errorType: null,
        });
        console.log(
          `INCOMPLETE  questions=${result.questions.length}  missing=[${missingFields.join(', ')}]`,
        );
      }
    } catch (error) {
      const errorType = error instanceof Error ? error.constructor.name : 'unknown';
      results.push({
        label: testCase.label,
        expected: testCase.expected,
        outcome: 'ERROR',
        matchedExpectation: false,
        outputParsed: false,
        sharedValidationPassed: null,
        rulesHash: null,
        questionCount: null,
        missingFields: null,
        errorType,
      });
      console.log(`ERROR       ${errorType}`);
    }
  }

  const matched = results.filter((r) => r.matchedExpectation).length;

  console.log('');
  console.log(`${matched}/${results.length} cases matched the expected system behaviour.`);

  const outPath = resolve(repoRoot, 'docs/m4-live-compiler-test.json');
  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        note:
          'A validation experiment, not a benchmark. Four prompts, one run each. No model ' +
          'response text is recorded — only whether the system behaved correctly.',
        ranAt: new Date().toISOString(),
        model,
        compilerVersion: compiler.version,
        cases: CASES.map((c) => ({ label: c.label, expected: c.expected, why: c.why })),
        results,
        matched,
        total: results.length,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  console.log(`written to ${outPath}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
