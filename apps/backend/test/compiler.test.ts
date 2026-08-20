import { describe, expect, it } from 'vitest';

import { hashConditionSpec, verifyRulesHash } from '@covenant/shared';

import { ConditionCompiler, parseCompilerOutput } from '../src/compiler/compiler.js';
import { COMPILER_VERSION } from '../src/compiler/version.js';
import { CompilerOutputError, LlmRefusedError, LlmTimeoutError, LlmUnavailableError } from '../src/errors.js';
import { FakeLLMProvider } from '../src/llm/fake-provider.js';
import {
  CREATOR,
  FIXED_NONCE,
  NOW,
  TEST_POLICY,
  TEST_TOKEN,
  compiledOutput,
  createCompiler,
  incompleteOutput,
  validDraft,
} from './helpers.js';

const compile = (harness: ReturnType<typeof createCompiler>) =>
  harness.compiler.compile({ message: 'anything', creator: CREATOR, history: [] });

describe('COMPILED', () => {
  it('produces a validated specification, canonical form and rules hash', async () => {
    const harness = createCompiler([{ kind: 'json', value: compiledOutput() }]);
    const result = await compile(harness);

    expect(result.status).toBe('COMPILED');
    if (result.status !== 'COMPILED') return;

    expect(result.rulesHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.compilerVersion).toBe(COMPILER_VERSION);
    expect(result.specification.question).toContain('BTC');
    expect(result.canonical.startsWith('{')).toBe(true);
  });

  it('derives the hash exclusively from @covenant/shared', async () => {
    const harness = createCompiler([{ kind: 'json', value: compiledOutput() }]);
    const result = await compile(harness);
    if (result.status !== 'COMPILED') throw new Error('expected COMPILED');

    // The same value the shared package computes for the same document. If the
    // backend ever grew its own hashing, this diverges.
    expect(hashConditionSpec(result.specification)).toBe(result.rulesHash);
    expect(verifyRulesHash(result.specification, result.rulesHash)).toBe(true);
  });

  it('produces the same hash for the same specification, twice', async () => {
    const first = await compile(createCompiler([{ kind: 'json', value: compiledOutput() }]));
    const second = await compile(createCompiler([{ kind: 'json', value: compiledOutput() }]));
    if (first.status !== 'COMPILED' || second.status !== 'COMPILED') {
      throw new Error('expected COMPILED');
    }
    expect(second.rulesHash).toBe(first.rulesHash);
  });

  it('gives a different hash when the nonce differs, so identical wording cannot collide', async () => {
    const baseline = await compile(createCompiler([{ kind: 'json', value: compiledOutput() }]));
    if (baseline.status !== 'COMPILED') throw new Error('expected COMPILED');

    const provider = new FakeLLMProvider([{ kind: 'json', value: compiledOutput() }]);
    const other = new ConditionCompiler({
      provider,
      token: TEST_TOKEN,
      policy: TEST_POLICY,
      maxOutputTokens: 8000,
      timeoutMs: 30_000,
      now: () => NOW,
      nonce: () => `0x${'22'.repeat(32)}`,
    });
    const result = await other.compile({ message: 'anything', creator: CREATOR, history: [] });
    if (result.status !== 'COMPILED') throw new Error('expected COMPILED');

    expect(result.rulesHash).not.toBe(baseline.rulesHash);
  });
});

describe('the system supplies what the model must not', () => {
  it('sets creator, nonce and version from the request, not the model', async () => {
    const harness = createCompiler([{ kind: 'json', value: compiledOutput() }]);
    const result = await compile(harness);
    if (result.status !== 'COMPILED') throw new Error('expected COMPILED');

    expect(result.specification.creator).toBe(CREATOR);
    expect(result.specification.nonce).toBe(FIXED_NONCE);
    expect(result.specification.version).toBe('1.0');
  });

  it('sets the settlement terms from operator policy, not the model', async () => {
    const harness = createCompiler([{ kind: 'json', value: compiledOutput() }]);
    const result = await compile(harness);
    if (result.status !== 'COMPILED') throw new Error('expected COMPILED');

    const settlement = result.specification.settlement;
    expect(settlement.token.address).toBe(TEST_TOKEN.address);
    expect(settlement.token.symbol).toBe('TUSD');
    expect(settlement.challengeWindowSeconds).toBe(TEST_POLICY.challengeWindowSeconds);
    expect(settlement.challengeBondBaseUnits).toBe(TEST_POLICY.challengeBondBaseUnits);
    expect(settlement.resolutionDeadlineSeconds).toBe(TEST_POLICY.resolutionWindowSeconds);
    // tradingEndsAt = deadline - lead, computed here rather than proposed.
    expect(settlement.tradingEndsAt).toBe('2026-08-31T00:00:00Z');
  });

  it('rejects a model that tries to set economic terms itself', async () => {
    // `.strict()` means an invented field is a hard failure, not a silent drop.
    const smuggled = {
      ...(compiledOutput() as Record<string, unknown>),
      settlement: { challengeBondBaseUnits: '1' },
    };
    const harness = createCompiler([{ kind: 'json', value: smuggled }]);
    await expect(compile(harness)).rejects.toBeInstanceOf(CompilerOutputError);
  });

  it('rejects a model that invents a rules hash', async () => {
    const smuggled = {
      ...(compiledOutput() as Record<string, unknown>),
      rulesHash: `0x${'ff'.repeat(32)}`,
    };
    const harness = createCompiler([{ kind: 'json', value: smuggled }]);
    await expect(compile(harness)).rejects.toBeInstanceOf(CompilerOutputError);
  });
});

describe('approved source precedence', () => {
  it('preserves the model order exactly, primary first', async () => {
    const harness = createCompiler([{ kind: 'json', value: compiledOutput() }]);
    const result = await compile(harness);
    if (result.status !== 'COMPILED') throw new Error('expected COMPILED');

    expect(result.specification.approvedSources.map((source) => source.name)).toEqual([
      'Exchange official price API',
      'Exchange public price page',
    ]);
  });

  it('never sorts them: a reversed list is a different agreement and a different hash', async () => {
    const forward = await compile(createCompiler([{ kind: 'json', value: compiledOutput() }]));
    const reversedDraft = validDraft({
      approvedSources: [...validDraft().approvedSources].reverse(),
    });
    const reversed = await compile(
      createCompiler([{ kind: 'json', value: compiledOutput(reversedDraft) }]),
    );

    if (forward.status !== 'COMPILED' || reversed.status !== 'COMPILED') {
      throw new Error('expected COMPILED');
    }
    expect(reversed.specification.approvedSources[0]?.name).toBe('Exchange public price page');
    expect(reversed.rulesHash).not.toBe(forward.rulesHash);
  });
});

describe('INCOMPLETE', () => {
  it('returns the model questions rather than a specification', async () => {
    const harness = createCompiler([
      {
        kind: 'json',
        value: incompleteOutput([
          {
            field: 'deadline',
            question: 'What exact date and time is the deadline?',
            why: '"next month" does not identify an instant.',
          },
        ]),
      },
    ]);
    const result = await compile(harness);

    expect(result.status).toBe('INCOMPLETE');
    if (result.status !== 'INCOMPLETE') return;
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0]?.field).toBe('deadline');
    expect(result.missing[0]?.path).toBe('deadline');
    expect(result).not.toHaveProperty('rulesHash');
  });

  it('returns whatever partial condition the model did extract', async () => {
    const partial = validDraft({ deadline: 'sometime next month' });
    const harness = createCompiler([
      {
        kind: 'json',
        value: incompleteOutput(
          [{ field: 'deadline', question: 'Which exact date?', why: 'ambiguous' }],
          partial,
        ),
      },
    ]);
    const result = await compile(harness);
    if (result.status !== 'INCOMPLETE') throw new Error('expected INCOMPLETE');

    expect(result.partial.question).toBe(partial.question);
    expect(result.partial.deadline).toBe('sometime next month');
  });

  it('rejects an INCOMPLETE result that asks nothing', async () => {
    const harness = createCompiler([
      { kind: 'json', value: incompleteOutput([]) },
    ]);
    await expect(compile(harness)).rejects.toBeInstanceOf(CompilerOutputError);
  });

  it('rejects a COMPILED result with no condition', async () => {
    const harness = createCompiler([
      {
        kind: 'json',
        value: { status: 'COMPILED', interpretation: 'x', questions: [], condition: null },
      },
    ]);
    await expect(compile(harness)).rejects.toBeInstanceOf(CompilerOutputError);
  });
});

describe('deadlines are checked, not trusted', () => {
  it('asks again when the model returns a deadline in the past', async () => {
    const draft = validDraft({ deadline: '2020-01-01T00:00:00Z' });
    const harness = createCompiler([{ kind: 'json', value: compiledOutput(draft) }]);
    const result = await compile(harness);

    expect(result.status).toBe('INCOMPLETE');
    if (result.status !== 'INCOMPLETE') return;
    expect(result.questions[0]?.field).toBe('deadline');
    expect(result.questions[0]?.question).toContain('already passed');
  });

  it('asks again when the deadline leaves no time to fund the market', async () => {
    // Ten minutes out, against a policy that closes funding a day early.
    const draft = validDraft({ deadline: '2026-08-01T00:10:00Z' });
    const harness = createCompiler([{ kind: 'json', value: compiledOutput(draft) }]);
    const result = await compile(harness);

    expect(result.status).toBe('INCOMPLETE');
    if (result.status !== 'INCOMPLETE') return;
    expect(result.questions[0]?.why).toContain('fund');
  });

  it('asks again when the deadline is not an unambiguous instant', async () => {
    const draft = validDraft({ deadline: 'next Friday' });
    const harness = createCompiler([{ kind: 'json', value: compiledOutput(draft) }]);
    const result = await compile(harness);

    expect(result.status).toBe('INCOMPLETE');
    if (result.status !== 'INCOMPLETE') return;
    expect(result.questions[0]?.field).toBe('deadline');
  });

  it('normalises an offset deadline to the equivalent UTC instant', async () => {
    const draft = validDraft({ deadline: '2026-08-31T20:00:00-04:00' });
    const harness = createCompiler([{ kind: 'json', value: compiledOutput(draft) }]);
    const result = await compile(harness);
    if (result.status !== 'COMPILED') throw new Error('expected COMPILED');
    expect(result.specification.deadline).toBe('2026-09-01T00:00:00Z');
  });
});

describe('the shared schema is the second gate', () => {
  it('asks again rather than hashing a spec with a non-https source', async () => {
    const draft = validDraft({
      approvedSources: [
        {
          name: 'Insecure feed',
          url: 'http://api.exchange.test/price',
          retrievalKind: 'http_json',
          dataPath: null,
        },
      ],
    });
    const harness = createCompiler([{ kind: 'json', value: compiledOutput(draft) }]);
    const result = await compile(harness);

    expect(result.status).toBe('INCOMPLETE');
    if (result.status !== 'INCOMPLETE') return;
    expect(result.missing.some((issue) => issue.path.startsWith('approvedSources'))).toBe(true);
  });

  it('asks again when the failure condition merely repeats the success condition', async () => {
    const draft = validDraft({ failureCondition: validDraft().successCondition });
    const harness = createCompiler([{ kind: 'json', value: compiledOutput(draft) }]);
    const result = await compile(harness);

    expect(result.status).toBe('INCOMPLETE');
    if (result.status !== 'INCOMPLETE') return;
    expect(result.missing.some((issue) => issue.path === 'failureCondition')).toBe(true);
  });

  it('asks again when no source is approved', async () => {
    const draft = validDraft({ approvedSources: [] });
    const harness = createCompiler([{ kind: 'json', value: compiledOutput(draft) }]);
    const result = await compile(harness);
    expect(result.status).toBe('INCOMPLETE');
  });
});

describe('malformed model output', () => {
  const rejected: ReadonlyArray<readonly [string, string]> = [
    ['plain prose', 'Sure! Here is your condition.'],
    ['an empty body', ''],
    ['truncated JSON', '{"status":"COMPILED","interpretation":"x","questions":[],"cond'],
    ['a JSON array', '[]'],
    ['a JSON scalar', '"COMPILED"'],
    ['JSON wrapped in prose', 'Here you go: {"status":"COMPILED"}'],
    ['a missing status', '{"interpretation":"x","questions":[],"condition":null}'],
    ['an unknown status', '{"status":"MAYBE","interpretation":"x","questions":[],"condition":null}'],
  ];

  for (const [label, text] of rejected) {
    it(`refuses to compile ${label}`, async () => {
      const harness = createCompiler([{ kind: 'text', text }]);
      await expect(compile(harness)).rejects.toBeInstanceOf(CompilerOutputError);
    });
  }

  it('refuses truncated output and says why', async () => {
    const harness = createCompiler([
      { kind: 'text', text: '{"status":"COMPILED"', stopReason: 'max_output_tokens' },
    ]);
    await expect(compile(harness)).rejects.toThrow(/cut off/i);
  });

  it('never lets malformed output reach the hashing pipeline', async () => {
    const harness = createCompiler([{ kind: 'text', text: 'not json' }]);
    await expect(compile(harness)).rejects.toBeInstanceOf(CompilerOutputError);
    // Nothing was persisted, and no hash exists to be persisted.
    expect(await harness.repositories.compilations.findByRulesHash(`0x${'00'.repeat(32)}`)).toBeNull();
  });

  it('exposes the parser directly, with field-anchored problems', () => {
    try {
      parseCompilerOutput('{"status":"COMPILED","interpretation":"","questions":[],"condition":null}');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CompilerOutputError);
      const issues = (error as CompilerOutputError).issues;
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.every((issue) => typeof issue.path === 'string')).toBe(true);
    }
  });
});

describe('provider failures', () => {
  it('maps a timeout to a timeout error', async () => {
    const harness = createCompiler([{ kind: 'error', failure: 'timeout' }]);
    await expect(compile(harness)).rejects.toBeInstanceOf(LlmTimeoutError);
  });

  it('maps rate limiting and outages to unavailable', async () => {
    for (const failure of ['rate_limited', 'unavailable'] as const) {
      const harness = createCompiler([{ kind: 'error', failure }]);
      await expect(compile(harness)).rejects.toBeInstanceOf(LlmUnavailableError);
    }
  });

  it('maps a refusal to a refusal error, distinct from an outage', async () => {
    const harness = createCompiler([{ kind: 'error', failure: 'refused' }]);
    await expect(compile(harness)).rejects.toBeInstanceOf(LlmRefusedError);
  });

  it('does not disclose that our own credentials are the problem', async () => {
    const harness = createCompiler([
      { kind: 'error', failure: 'auth', message: 'invalid x-api-key sk-ant-secret' },
    ]);
    try {
      await compile(harness);
      expect.unreachable('should have thrown');
    } catch (error) {
      const projected = JSON.stringify((error as LlmUnavailableError).toApiError());
      expect(projected).not.toContain('sk-ant');
      expect(projected).not.toContain('x-api-key');
      expect(projected).toContain('temporarily unavailable');
    }
  });
});

describe('the prompt sent to the model', () => {
  it('carries the rules, a JSON schema, and the current time', async () => {
    const harness = createCompiler([{ kind: 'json', value: compiledOutput() }]);
    await compile(harness);

    const request = harness.provider.calls[0];
    expect(request).toBeDefined();
    expect(request?.system).toContain('Never invent a fact');
    expect(request?.system).toContain('objectivity test');
    expect(request?.system).toContain('2026-08-01T00:00:00Z');
    expect(request?.jsonSchema?.name).toBe('compiler_output');
    expect(request?.timeoutMs).toBe(30_000);
  });

  it('replays session history so a clarification lands in context', async () => {
    const harness = createCompiler([{ kind: 'json', value: compiledOutput() }]);
    await harness.compiler.compile({
      message: 'The deadline is 2026-09-01 00:00 UTC.',
      creator: CREATOR,
      history: [
        { role: 'user', content: 'Pay if BTC goes above 100k.' },
        { role: 'assistant', content: '{"status":"INCOMPLETE"}' },
      ],
    });

    const messages = harness.provider.calls[0]?.messages ?? [];
    expect(messages).toHaveLength(3);
    expect(messages[0]?.content).toContain('Pay if BTC');
    expect(messages[2]?.content).toContain('2026-09-01');
  });
});
