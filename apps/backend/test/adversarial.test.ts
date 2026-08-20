/**
 * Anti-hallucination tests.
 *
 * The most important safety property of the compiler is that it declines. These
 * tests cover the two halves of that:
 *
 * 1. **The model's job** — vague, subjective, and under-specified conditions
 *    must come back INCOMPLETE. What the model does is governed by the prompt,
 *    so these tests assert on the prompt rules and on the pipeline honouring an
 *    INCOMPLETE verdict, not on a scripted model magically being right.
 * 2. **The system's job** — even when the model *does* claim COMPILED, the
 *    backend independently rejects anything unhashable, unverifiable, or
 *    invented. That is what these tests really pin down, because it is the part
 *    that holds when the model is wrong.
 *
 * The scenarios come from the milestone brief verbatim, so the recorded
 * expectations are testable rather than aspirational.
 */

import { describe, expect, it } from 'vitest';

import { COMPILER_SYSTEM_PROMPT } from '../src/compiler/prompt.js';
import { CompilerOutputError } from '../src/errors.js';
import {
  CREATOR,
  compiledOutput,
  createCompiler,
  incompleteOutput,
  validDraft,
} from './helpers.js';

const ask = (harness: ReturnType<typeof createCompiler>, message: string) =>
  harness.compiler.compile({ message, creator: CREATOR, history: [] });

describe('conditions that must not compile', () => {
  const vague: ReadonlyArray<readonly [string, string, string]> = [
    ['Pay me if ETH does well.', 'successCondition', 'no definition of "does well"'],
    ['Pay me if the customer is happy.', 'successCondition', 'no measurement of "happy"'],
    ['Was the launch successful?', 'successCondition', 'no definition of "successful"'],
    ['Did John do a good job?', 'successCondition', 'no criteria and no named assessor'],
    ['Pay me if ETH reaches $5,000.', 'deadline', 'no deadline and no source'],
    [
      "I'll pay Sarah if she finishes the project next month.",
      'deadline',
      'no exact date, no completion criteria, no verifier',
    ],
  ];

  for (const [prompt, field, why] of vague) {
    it(`returns INCOMPLETE for "${prompt}"`, async () => {
      const harness = createCompiler([
        {
          kind: 'json',
          value: incompleteOutput([
            { field, question: `Please specify ${field}.`, why },
          ]),
        },
      ]);
      const result = await ask(harness, prompt);

      expect(result.status).toBe('INCOMPLETE');
      if (result.status !== 'INCOMPLETE') return;
      expect(result.questions.length).toBeGreaterThan(0);
      expect(result).not.toHaveProperty('specification');
      expect(result).not.toHaveProperty('rulesHash');
    });
  }
});

describe('conditions that can compile once objective criteria are supplied', () => {
  it('compiles a price threshold with a deadline and a named source', async () => {
    const harness = createCompiler([{ kind: 'json', value: compiledOutput() }]);
    const result = await ask(
      harness,
      'Pay me if ETH reaches $5,000 before 2026-09-01 00:00 UTC, using the exchange official API.',
    );
    expect(result.status).toBe('COMPILED');
  });

  it('compiles an acceptance-form rating with a stated threshold', async () => {
    const draft = validDraft({
      question: 'Did the signed acceptance form record a rating of at least 4 out of 5?',
      successCondition:
        'The signed acceptance form at the approved location records an overall rating of 4 or 5 out of 5.',
      failureCondition:
        'The signed acceptance form records an overall rating of 3 or below, or no signed form exists at the deadline.',
      resolutionMethod: 'source_attested_status',
      approvedSources: [
        {
          name: 'Signed acceptance form',
          url: 'https://records.example.test/acceptance/9f12',
          retrievalKind: 'manual_attestation',
          dataPath: null,
        },
      ],
      evidenceRequirements: ['The overall rating recorded on the signed acceptance form.'],
      edgeCases: [
        { scenario: 'The form is signed but the rating field is blank.', outcome: 'INVALID' },
      ],
    });
    const harness = createCompiler([{ kind: 'json', value: compiledOutput(draft) }]);
    const result = await ask(
      harness,
      'Pay if the customer gives the project at least 4/5 in the signed acceptance form.',
    );
    expect(result.status).toBe('COMPILED');
  });
});

describe('the system rejects invention even when the model claims COMPILED', () => {
  it('will not hash a condition whose deadline the model invented from "next Friday"', async () => {
    // The model resolved "next Friday" to a date on its own. The date parses,
    // so only a system-side check catches it — and here it does not: a past
    // date is refused outright.
    const draft = validDraft({ deadline: '2020-03-06T00:00:00Z' });
    const harness = createCompiler([{ kind: 'json', value: compiledOutput(draft) }]);
    const result = await ask(harness, "Pay when the shipment arrives, sometime next Friday.");

    expect(result.status).toBe('INCOMPLETE');
    if (result.status !== 'INCOMPLETE') return;
    expect(result.questions[0]?.field).toBe('deadline');
  });

  it('will not hash a specification with no approved source, however confident the model is', async () => {
    const draft = validDraft({ approvedSources: [], evidenceRequirements: [] });
    const harness = createCompiler([{ kind: 'json', value: compiledOutput(draft) }]);
    const result = await ask(harness, 'Pay if the news says the merger closed.');
    expect(result.status).toBe('INCOMPLETE');
  });

  it('rejects a model that invents an unknown ConditionSpec field', async () => {
    const draft = { ...validDraft(), oracleAddress: '0xdeadbeef' };
    const harness = createCompiler([
      { kind: 'json', value: { ...(compiledOutput() as object), condition: draft } },
    ]);
    await expect(ask(harness, 'anything')).rejects.toBeInstanceOf(CompilerOutputError);
  });

  it('rejects a model that invents a resolution method outside the schema', async () => {
    const draft = { ...validDraft(), resolutionMethod: 'vibes_based_consensus' };
    const harness = createCompiler([
      { kind: 'json', value: { ...(compiledOutput() as object), condition: draft } },
    ]);
    await expect(ask(harness, 'anything')).rejects.toBeInstanceOf(CompilerOutputError);
  });

  it('rejects a model that invents an outcome outside the schema', async () => {
    const draft = validDraft({
      edgeCases: [{ scenario: 'unclear', outcome: 'PROBABLY' as 'YES' }],
    });
    const harness = createCompiler([{ kind: 'json', value: compiledOutput(draft) }]);
    await expect(ask(harness, 'anything')).rejects.toBeInstanceOf(CompilerOutputError);
  });

  it('rejects a model that tries to report a confidence score', async () => {
    // Confidence is a resolution concept and never authorises anything. A
    // compiler that reports one is confusing its role.
    const smuggled = { ...(compiledOutput() as object), confidence: 0.99 };
    const harness = createCompiler([{ kind: 'json', value: smuggled }]);
    await expect(ask(harness, 'anything')).rejects.toBeInstanceOf(CompilerOutputError);
  });

  it('rejects a model that tries to declare an outcome', async () => {
    const smuggled = { ...(compiledOutput() as object), outcome: 'YES' };
    const harness = createCompiler([{ kind: 'json', value: smuggled }]);
    await expect(ask(harness, 'anything')).rejects.toBeInstanceOf(CompilerOutputError);
  });
});

describe('interpretation is never promoted to fact', () => {
  it('keeps the model reading separate from the enforceable condition', async () => {
    const harness = createCompiler([{ kind: 'json', value: compiledOutput() }]);
    const result = await ask(harness, 'anything');
    if (result.status !== 'COMPILED') throw new Error('expected COMPILED');

    // The interpretation is returned to the user for review, and is not part of
    // the hashed document.
    expect(result.interpretation.length).toBeGreaterThan(0);
    expect(result.canonical).not.toContain(result.interpretation);
    expect(Object.keys(result.specification)).not.toContain('interpretation');
  });

  it('records an assumption as an ambiguity rather than silently applying it', async () => {
    const draft = validDraft({
      ambiguities: [
        {
          description: '"above 100k" did not state whether the threshold is inclusive.',
          assumption: 'Read as strictly above 100000.',
        },
      ],
    });
    const harness = createCompiler([{ kind: 'json', value: compiledOutput(draft) }]);
    const result = await ask(harness, 'anything');
    if (result.status !== 'COMPILED') throw new Error('expected COMPILED');

    // The ambiguity is inside the hash, so a user approving the rules approves
    // the reading too.
    expect(result.specification.ambiguities).toHaveLength(1);
    expect(result.canonical).toContain('strictly above 100000');
  });
});

describe('the prompt states the rules it is judged on', () => {
  const requiredRules: ReadonlyArray<readonly [string, RegExp]> = [
    ['never invent facts', /Never invent a fact/i],
    ['never invent deadlines', /Never invent or infer a deadline/i],
    ['never invent sources', /Never invent an evidence source/i],
    ['never invent acceptance criteria', /Never invent acceptance criteria/i],
    ['never silently resolve ambiguity', /Never silently resolve an ambiguity/i],
    ['ask clarification questions', /Ask clarification questions/i],
    ['separate interpretation from the condition', /Keep interpretation separate/i],
    ['approved sources in precedence order', /precedence order/i],
    ['compile only when complete', /Return COMPILED only when/i],
    ['never calculate a rules hash', /Never calculate, guess at, or mention a rules hash/i],
    ['never claim the chain verified anything', /Never claim that a blockchain has verified/i],
    ['never claim evidence was verified', /Never claim that evidence has been checked/i],
    ['never decide the outcome', /Never decide the outcome/i],
  ];

  for (const [label, pattern] of requiredRules) {
    it(`instructs the model to ${label}`, () => {
      expect(COMPILER_SYSTEM_PROMPT).toMatch(pattern);
    });
  }

  it('gives worked examples of what does and does not compile', () => {
    expect(COMPILER_SYSTEM_PROMPT).toContain('Did the product do well?');
    expect(COMPILER_SYSTEM_PROMPT).toContain('at least 20 merged pull requests');
  });

  it('states the objectivity test as two independent reviewers agreeing', () => {
    expect(COMPILER_SYSTEM_PROMPT).toMatch(/two independent reviewers/i);
  });
});
