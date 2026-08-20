/**
 * The AI resolution layer.
 *
 * Every test runs the real engine against a scripted model. That is the whole
 * design of the suite: the properties worth proving are what the system does
 * when the model is *wrong* — when it invents a source, quotes a price that is
 * not in the evidence, contradicts a comparison code already made, or returns
 * something that is not JSON at all. A real model produces those rarely and
 * never on request; `FakeLLMProvider` produces them on demand, in order.
 *
 * The suite therefore says nothing about how often a real model behaves. It says
 * that when it misbehaves, nothing is proposed. §11 of the milestone covers the
 * other half with a controlled live run, deliberately outside this suite so that
 * `npm test` never depends on a vendor being reachable.
 */

import { describe, expect, it } from 'vitest';

import {
  buildRulesCommitment,
  parseConditionSpec,
  verifyEvidenceHash,
  type ConditionSpec,
} from '@covenant/shared';
import { conditionSpecFixtures } from '@covenant/shared/testing';

import { parseResolutionOutput, ResolutionEngine } from '../src/resolution/engine.js';
import { deterministicOutcome } from '../src/resolution/outcome.js';
import { classifyValue, extractDeterministicClaims } from '../src/resolution/claims.js';
import { indexEvidence, isGrounded } from '../src/resolution/grounding.js';
import { resolutionOutputSchema } from '../src/resolution/output-schema.js';
import { RESOLVER_VERSION } from '../src/resolution/version.js';
import { FakeLLMProvider } from '../src/llm/fake-provider.js';
import {
  MARKET,
  RESOLVED_AT,
  deliveredPlan,
  evidenceSources,
  failure,
  harness,
  modelNo,
  modelReview,
  modelYes,
  plan,
  rulesHashOf,
  snapshot,
  spec,
} from './resolution-helpers.js';

const run = (h: ReturnType<typeof harness>) => h.engine.resolve(h.input);

/**
 * A model that reads the evidence correctly and then draws the opposite
 * conclusion.
 *
 * Its claim is grounded — the shipment really is recorded as delivered — so the
 * semantic gate has nothing to object to. The only thing wrong is the outcome,
 * which is exactly what these tests need to isolate: a resolution refused for
 * contradicting the checks rather than for citing something that is not there.
 */
const contradictingModel = (overrides: Record<string, unknown> = {}): unknown =>
  modelNo({
    reasoning: 'source-0 reports delivered, but I do not consider that final delivery.',
    claims: [
      {
        sourceIds: ['source-0'],
        statement: 'The carrier reports the shipment as delivered.',
        valueType: 'string',
        value: 'delivered',
        support: 'SUPPORTED',
      },
    ],
    ...overrides,
  });

// ---------------------------------------------------------------------------
// 1 & 2. The two outcomes that can be proposed at all.
// ---------------------------------------------------------------------------

describe('YES', () => {
  it('proposes YES when the checks are satisfied and the model concurs', async () => {
    const result = await run(harness([{ kind: 'json', value: modelYes() }]));

    expect(result.status).toBe('PROPOSED');
    if (result.status !== 'PROPOSED') return;

    expect(result.outcome).toBe('YES');
    expect(result.confidenceBps).toBe(9200);
    expect(result.verdict).toBe('SATISFIED');
    expect(result.reasoning).toContain('delivered');
  });

  it('produces a package that validates, binds to the rules and hashes', async () => {
    const result = await run(harness([{ kind: 'json', value: modelYes() }]));
    if (result.status !== 'PROPOSED') throw new Error(`expected PROPOSED, got ${result.status}`);

    expect(result.evidence.version).toBe('2.0');
    expect(result.rulesHash).toBe(rulesHashOf(spec()));
    expect(result.evidence.rulesHash).toBe(result.rulesHash);
    expect(result.evidenceHash).toMatch(/^0x[0-9a-f]{64}$/);
    // The hash comes from @covenant/shared and is re-derivable from the document.
    expect(verifyEvidenceHash(result.evidence, result.evidenceHash)).toBe(true);
  });

  it('records the resolver build and the model that served the request', async () => {
    const result = await run(harness([{ kind: 'json', value: modelYes() }]));
    if (result.status !== 'PROPOSED') throw new Error('expected PROPOSED');

    expect(result.evidence.resolver.version).toBe(RESOLVER_VERSION);
    expect(result.evidence.resolver.model).toBe('fake-model');
  });

  it('carries the deterministic checks into the package unchanged', async () => {
    const h = harness([{ kind: 'json', value: modelYes() }]);
    const result = await run(h);
    if (result.status !== 'PROPOSED') throw new Error('expected PROPOSED');

    expect(result.evidence.deterministicChecks).toEqual(h.input.validation.checks);
    expect(result.evidence.deterministicChecks.map((check) => check.checkId)).toContain(
      'status-delivered',
    );
  });
});

describe('NO', () => {
  it('proposes NO when the checks refute the success condition', async () => {
    const result = await run(
      harness([{ kind: 'json', value: modelNo() }], {
        snapshots: [snapshot({ index: 0, status: 'in_transit' })],
      }),
    );

    expect(result.status).toBe('PROPOSED');
    if (result.status !== 'PROPOSED') return;
    expect(result.outcome).toBe('NO');
    expect(result.verdict).toBe('REFUTED');
  });

  it('does not reach NO by assigning SATISFIED to YES', () => {
    // The mapping reads which condition the checks encode. Same verdict, opposite
    // outcome, and nothing about the verdict itself changed.
    expect(deterministicOutcome('SATISFIED', 'successCondition')).toBe('YES');
    expect(deterministicOutcome('SATISFIED', 'failureCondition')).toBe('NO');
    expect(deterministicOutcome('REFUTED', 'successCondition')).toBe('NO');
    expect(deterministicOutcome('REFUTED', 'failureCondition')).toBe('YES');
    expect(deterministicOutcome('NEEDS_REVIEW', 'successCondition')).toBeNull();
  });

  it('proposes YES from a plan that encodes the failure condition and is REFUTED', async () => {
    const failurePlan = plan({
      checks: [
        {
          checkId: 'status-returned',
          kind: 'CATEGORICAL_MATCH',
          observation: { sourceId: 'source-0', pointer: null },
          accepted: ['returned_to_sender'],
          caseSensitive: false,
        },
      ],
      encodes: 'failureCondition',
    });

    const result = await run(
      harness([{ kind: 'json', value: modelYes() }], {
        plan: failurePlan,
        snapshots: [snapshot({ index: 0, status: 'delivered' })],
      }),
    );

    if (result.status !== 'PROPOSED') throw new Error(`expected PROPOSED, got ${result.status}`);
    expect(result.verdict).toBe('REFUTED');
    expect(result.outcome).toBe('YES');
  });
});

// ---------------------------------------------------------------------------
// 3. Insufficient evidence.
// ---------------------------------------------------------------------------

describe('insufficient evidence', () => {
  it('returns NEEDS_REVIEW without calling the model when nothing was retrieved', async () => {
    const h = harness([{ kind: 'json', value: modelYes() }], {
      snapshots: [],
      failures: [failure(0), failure(1)],
    });
    const result = await run(h);

    expect(result.status).toBe('NEEDS_REVIEW');
    if (result.status !== 'NEEDS_REVIEW') return;
    expect(result.reason).toBe('INSUFFICIENT_EVIDENCE');
    // Not merely unused — never called. Attacker-controlled content should not
    // reach a model on a resolution that cannot be proposed anyway.
    expect(h.provider.calls).toHaveLength(0);
  });

  it('treats an unavailable source as absence of evidence, never as NO', async () => {
    const h = harness([{ kind: 'json', value: modelYes() }], {
      snapshots: [],
      failures: [failure(0), failure(1)],
    });
    const result = await run(h);

    if (result.status !== 'NEEDS_REVIEW') throw new Error('expected NEEDS_REVIEW');
    expect(result).not.toHaveProperty('outcome');
    expect(result.detail).toContain('absence of evidence');
  });

  it('returns NEEDS_REVIEW when the model abstains', async () => {
    const result = await run(harness([{ kind: 'json', value: modelReview() }]));

    expect(result.status).toBe('NEEDS_REVIEW');
    if (result.status !== 'NEEDS_REVIEW') return;
    expect(result.reason).toBe('MODEL_ABSTAINED');
    // The abstention's own words are kept, because a person reads this.
    expect(result.reasoning).not.toBeNull();
  });

  it('carries the checks and sources into the review record', async () => {
    const result = await run(harness([{ kind: 'json', value: modelReview() }]));
    if (result.status !== 'NEEDS_REVIEW') throw new Error('expected NEEDS_REVIEW');

    expect(result.sources).toHaveLength(2);
    expect(result.deterministicChecks.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Conflicting evidence.
// ---------------------------------------------------------------------------

describe('conflicting evidence', () => {
  it('returns NEEDS_REVIEW when a check could not run, without calling the model', async () => {
    // A snapshot whose approved dataPath selected nothing: the check is
    // INDETERMINATE, so the deterministic verdict is NEEDS_REVIEW.
    const h = harness([{ kind: 'json', value: modelYes() }], {
      snapshots: [snapshot({ index: 0, status: null })],
    });
    const result = await run(h);

    expect(result.status).toBe('NEEDS_REVIEW');
    if (result.status !== 'NEEDS_REVIEW') return;
    expect(result.reason).toBe('DETERMINISTIC_INCONCLUSIVE');
    expect(h.provider.calls).toHaveLength(0);
  });

  it('settles a source disagreement by precedence, not by the model', async () => {
    const snapshots = [
      snapshot({ index: 0, status: 'delivered' }),
      snapshot({ index: 1, status: 'in_transit' }),
    ];
    const h = harness([{ kind: 'json', value: modelYes() }], { snapshots });

    expect(h.input.validation.conflicts).toHaveLength(1);

    const result = await run(h);
    if (result.status !== 'PROPOSED') throw new Error(`expected PROPOSED, got ${result.status}`);

    // The primary's reading governs; the fallback's disagreement is recorded.
    expect(result.outcome).toBe('YES');
    const check = result.deterministicChecks.find((entry) => entry.checkId === 'status-delivered');
    expect(check?.explanation).toContain('precedence selected source-0');
  });

  it('refuses a claim that carries the value precedence rejected', async () => {
    const snapshots = [
      snapshot({ index: 0, status: 'delivered' }),
      snapshot({ index: 1, status: 'in_transit' }),
    ];

    // The model prefers the fallback's reading, which is exactly the override
    // §5 forbids. The value is genuinely present in source-1's bytes, so only
    // the precedence rule catches it.
    const result = await run(
      harness(
        [
          {
            kind: 'json',
            value: modelYes({
              claims: [
                {
                  sourceIds: ['source-1'],
                  statement: 'The public tracking page is more current and says in_transit.',
                  valueType: 'string',
                  value: 'in_transit',
                  support: 'SUPPORTED',
                },
              ],
            }),
          },
        ],
        { snapshots },
      ),
    );

    expect(result.status).toBe('NEEDS_REVIEW');
    if (result.status !== 'NEEDS_REVIEW') return;
    expect(result.reason).toBe('MODEL_OUTPUT_UNGROUNDED');
    expect(result.violations).toContain('SOURCE_PRECEDENCE_VIOLATED');
  });
});

// ---------------------------------------------------------------------------
// 5. Invalid model output.
// ---------------------------------------------------------------------------

describe('invalid model output', () => {
  const rejected: ReadonlyArray<readonly [string, unknown]> = [
    ['a bare string', 'the shipment was delivered'],
    ['an array', [{ outcome: 'RESOLVED_YES' }]],
    ['null', null],
    ['an empty object', {}],
    ['a missing outcome', { ...(modelYes() as object), outcome: undefined }],
    ['a missing reasoning', { ...(modelYes() as object), reasoning: undefined }],
  ];

  for (const [label, value] of rejected) {
    it(`returns NEEDS_REVIEW for ${label}`, async () => {
      const result = await run(harness([{ kind: 'json', value }]));

      expect(result.status).toBe('NEEDS_REVIEW');
      if (result.status !== 'NEEDS_REVIEW') return;
      expect(result.reason).toBe('MODEL_OUTPUT_INVALID');
      expect(result.issues.length).toBeGreaterThan(0);
    });
  }

  it('returns NEEDS_REVIEW, not a throw, for text that is not JSON', async () => {
    const result = await run(
      harness([{ kind: 'text', text: 'I think it was delivered. Here is my reasoning...' }]),
    );

    expect(result.status).toBe('NEEDS_REVIEW');
    if (result.status !== 'NEEDS_REVIEW') return;
    expect(result.reason).toBe('MODEL_OUTPUT_INVALID');
    expect(result.issues[0]?.message).toContain('did not parse as JSON');
  });

  it('returns NEEDS_REVIEW for JSON wrapped in prose', async () => {
    const result = await run(
      harness([
        { kind: 'text', text: `Here is my answer:\n${JSON.stringify(modelYes())}\nHope that helps.` },
      ]),
    );

    expect(result.status).toBe('NEEDS_REVIEW');
  });

  it('returns NEEDS_REVIEW when the response was truncated', async () => {
    const result = await run(
      harness([{ kind: 'text', text: '{"outcome":"RESOLVED_', stopReason: 'max_output_tokens' }]),
    );

    // Truncation is a provider-level fact, not a fact about the evidence.
    expect(result.status).toBe('RESOLUTION_FAILED');
    if (result.status !== 'RESOLUTION_FAILED') return;
    expect(result.reason).toBe('PROVIDER_UNAVAILABLE');
  });

  it('rejects fields the model was never asked for, rather than stripping them', () => {
    for (const extra of [
      { rulesHash: `0x${'11'.repeat(32)}` },
      { evidenceHash: `0x${'22'.repeat(32)}` },
      { settlement: { payout: '1000000' } },
      { payoutBaseUnits: '5000000' },
      { transaction: { to: `0x${'33'.repeat(20)}`, data: '0xdeadbeef' } },
      { deterministicChecks: [] },
    ]) {
      const parsed = resolutionOutputSchema.safeParse({ ...(modelYes() as object), ...extra });
      expect(parsed.success, `${Object.keys(extra)[0]} must be rejected`).toBe(false);
    }
  });

  it('refuses a model-supplied rulesHash end to end', async () => {
    const result = await run(
      harness([{ kind: 'json', value: { ...(modelYes() as object), rulesHash: `0x${'ab'.repeat(32)}` } }]),
    );

    expect(result.status).toBe('NEEDS_REVIEW');
    if (result.status !== 'NEEDS_REVIEW') return;
    expect(result.reason).toBe('MODEL_OUTPUT_INVALID');
  });

  it('rejects a claim whose extraction the model tried to label itself', () => {
    const parsed = resolutionOutputSchema.safeParse({
      ...(modelYes() as object),
      claims: [
        {
          sourceIds: ['source-0'],
          statement: 'The carrier reports delivered.',
          valueType: 'string',
          value: 'delivered',
          support: 'SUPPORTED',
          extraction: { method: 'JSON_POINTER', locator: '/shipment/status' },
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it('parses a valid output directly, so the gate is testable on its own', () => {
    const parsed = parseResolutionOutput(JSON.stringify(modelYes()));
    expect(parsed.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Hallucinated source and hallucinated facts.
// ---------------------------------------------------------------------------

describe('hallucinated evidence', () => {
  it('refuses a claim citing a source that was never read', async () => {
    const result = await run(
      harness([
        {
          kind: 'json',
          value: modelYes({
            claims: [
              {
                sourceIds: ['source-4'],
                statement: 'A carrier status page confirms delivery.',
                valueType: 'string',
                value: 'delivered',
                support: 'SUPPORTED',
              },
            ],
          }),
        },
      ]),
    );

    expect(result.status).toBe('NEEDS_REVIEW');
    if (result.status !== 'NEEDS_REVIEW') return;
    expect(result.reason).toBe('MODEL_OUTPUT_UNGROUNDED');
    expect(result.violations).toContain('UNCITED_SOURCE');
  });

  it('refuses a claim citing an approved source that failed to answer', async () => {
    const snapshots = [snapshot({ index: 0, status: 'delivered' })];
    const result = await run(
      harness(
        [
          {
            kind: 'json',
            value: modelYes({
              claims: [
                {
                  sourceIds: ['source-1'],
                  statement: 'The public page also shows delivered.',
                  valueType: 'string',
                  value: 'delivered',
                  support: 'SUPPORTED',
                },
              ],
            }),
          },
        ],
        { snapshots, failures: [failure(1)] },
      ),
    );

    expect(result.status).toBe('NEEDS_REVIEW');
    if (result.status !== 'NEEDS_REVIEW') return;
    expect(result.violations).toContain('UNCITED_SOURCE');
  });

  it('refuses a value that appears nowhere in the retrieved bytes', async () => {
    const result = await run(
      harness([
        {
          kind: 'json',
          value: modelYes({
            claims: [
              {
                sourceIds: ['source-0'],
                statement: 'The carrier reports the shipment was signed for by J. Smith.',
                valueType: 'string',
                value: 'J. Smith',
                support: 'SUPPORTED',
              },
            ],
          }),
        },
      ]),
    );

    expect(result.status).toBe('NEEDS_REVIEW');
    if (result.status !== 'NEEDS_REVIEW') return;
    expect(result.violations).toContain('UNGROUNDED_VALUE');
  });

  it('refuses an invented URL in the reasoning', async () => {
    const result = await run(
      harness([
        {
          kind: 'json',
          value: modelYes({
            reasoning:
              'Delivery is confirmed at https://tracking.totally-real-carrier.example/status/1Z999 ' +
              'which corroborates source-0.',
          }),
        },
      ]),
    );

    expect(result.status).toBe('NEEDS_REVIEW');
    if (result.status !== 'NEEDS_REVIEW') return;
    expect(result.violations).toContain('INVENTED_URL');
  });

  it('allows the reasoning to name an approved source URL', async () => {
    const approved = spec().approvedSources[0]!.url;
    const result = await run(
      harness([
        { kind: 'json', value: modelYes({ reasoning: `Read from ${approved}, status delivered.` }) },
      ]),
    );

    expect(result.status).toBe('PROPOSED');
  });

  it('refuses a hash or an address written into the reasoning', async () => {
    const result = await run(
      harness([
        {
          kind: 'json',
          value: modelYes({
            reasoning: `Delivered per source-0; committed under rules 0x${'ab'.repeat(32)}.`,
          }),
        },
      ]),
    );

    expect(result.status).toBe('NEEDS_REVIEW');
    if (result.status !== 'NEEDS_REVIEW') return;
    expect(result.violations).toContain('PROTOCOL_VALUE_IN_REASONING');
  });

  it('accepts a second claim grounded elsewhere in the same document', async () => {
    // The tracking number is in the retrieved bytes but is not what the approved
    // dataPath selects. A model reading it has not invented anything, and
    // refusing the claim would mean only the selected field could ever be cited.
    const result = await run(
      harness([
        {
          kind: 'json',
          value: modelYes({
            claims: [
              {
                sourceIds: ['source-0'],
                statement: 'The carrier reports the shipment as delivered.',
                valueType: 'string',
                value: 'delivered',
                support: 'SUPPORTED',
              },
              {
                sourceIds: ['source-0'],
                statement: 'The record is for tracking number 1Z999AA10123456784.',
                valueType: 'string',
                value: '1Z999AA10123456784',
                support: 'SUPPORTED',
              },
            ],
          }),
        },
      ]),
    );

    expect(result.status).toBe('PROPOSED');
  });

  describe('grounding, directly', () => {
    const index = indexEvidence([snapshot({ index: 0, status: 'delivered' })]);

    it('accepts the approved selection itself', () => {
      expect(isGrounded('delivered', ['source-0'], index)).toBe(true);
    });

    it('accepts a difference of letter case', () => {
      // The document renders a status; a model reporting `Delivered` has read it,
      // not invented it. The validators are case-sensitive by default and that
      // difference is intentional: matching an approved criterion is a stricter
      // question than not having made a value up.
      expect(isGrounded('Delivered', ['source-0'], index)).toBe(true);
    });

    it('accepts the same number rendered differently', () => {
      const numeric = indexEvidence([
        {
          ...snapshot({ index: 0, status: 'delivered' }),
          normalizedContent: '{"weightGrams":"1440"}',
          selection: { pointer: '/weightGrams', value: '"1440"' },
        },
      ]);
      // 1440 and 1440.00 are one weight rendered two ways. Refusing the second
      // would fail a resolution over formatting rather than over facts.
      expect(isGrounded('1440.00', ['source-0'], numeric)).toBe(true);
    });

    it('refuses a value that is nowhere in the bytes', () => {
      expect(isGrounded('J. Smith', ['source-0'], index)).toBe(false);
    });

    it('refuses a value grounded only in a source the claim does not cite', () => {
      const two = indexEvidence([
        snapshot({ index: 0, status: 'delivered' }),
        snapshot({ index: 1, status: 'returned_to_sender' }),
      ]);
      expect(isGrounded('returned_to_sender', ['source-0'], two)).toBe(false);
      expect(isGrounded('returned_to_sender', ['source-1'], two)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 7. A changed rulesHash.
// ---------------------------------------------------------------------------

describe('rules binding', () => {
  it('refuses to resolve when the specification does not hash to the market rules', async () => {
    const h = harness([{ kind: 'json', value: modelYes() }], {
      expectedRulesHash: `0x${'ff'.repeat(32)}`,
    });
    const result = await run(h);

    expect(result.status).toBe('NEEDS_REVIEW');
    if (result.status !== 'NEEDS_REVIEW') return;
    expect(result.reason).toBe('RULES_HASH_MISMATCH');
    expect(h.provider.calls).toHaveLength(0);
  });

  it('refuses when a single character of the specification was altered', async () => {
    const original = spec();
    const tampered: ConditionSpec = parseConditionSpec({
      ...conditionSpecFixtures.shipment,
      // One word changed in the success condition. Everything else is identical.
      successCondition: original.successCondition.replace('delivered', 'dispatched'),
    });

    const result = await run(
      harness([{ kind: 'json', value: modelYes() }], {
        specification: tampered,
        expectedRulesHash: rulesHashOf(original),
      }),
    );

    expect(result.status).toBe('NEEDS_REVIEW');
    if (result.status !== 'NEEDS_REVIEW') return;
    expect(result.reason).toBe('RULES_HASH_MISMATCH');
  });

  it('accepts a rules hash that differs only in letter case', async () => {
    const result = await run(
      harness([{ kind: 'json', value: modelYes() }], {
        expectedRulesHash: rulesHashOf(spec()).toUpperCase().replace('0X', '0x'),
      }),
    );

    expect(result.status).toBe('PROPOSED');
  });

  it('leaves the specification byte-identical after resolving', async () => {
    const h = harness([{ kind: 'json', value: modelYes() }]);
    const before = JSON.stringify(h.input.specification);

    await run(h);

    expect(JSON.stringify(h.input.specification)).toBe(before);
    expect(buildRulesCommitment(h.input.specification).rulesHash).toBe(rulesHashOf(spec()));
  });
});

// ---------------------------------------------------------------------------
// 8. Confidence.
// ---------------------------------------------------------------------------

describe('confidence', () => {
  const invalid = [-1, 10_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY];

  for (const value of invalid) {
    it(`rejects a confidence of ${String(value)}`, async () => {
      const result = await run(
        harness([{ kind: 'json', value: modelYes({ confidenceBps: value }) }]),
      );

      expect(result.status).toBe('NEEDS_REVIEW');
      if (result.status !== 'NEEDS_REVIEW') return;
      expect(result.reason).toBe('MODEL_OUTPUT_INVALID');
    });
  }

  it('rejects a confidence expressed as a percentage string', async () => {
    const result = await run(harness([{ kind: 'json', value: modelYes({ confidenceBps: '92%' }) }]));

    expect(result.status).toBe('NEEDS_REVIEW');
    if (result.status !== 'NEEDS_REVIEW') return;
    expect(result.reason).toBe('MODEL_OUTPUT_INVALID');
  });

  it('returns NEEDS_REVIEW below the operator floor', async () => {
    const result = await run(
      harness([{ kind: 'json', value: modelYes({ confidenceBps: 4000 }) }], {
        confidenceFloorBps: 7000,
      }),
    );

    expect(result.status).toBe('NEEDS_REVIEW');
    if (result.status !== 'NEEDS_REVIEW') return;
    expect(result.reason).toBe('CONFIDENCE_BELOW_FLOOR');
    // Recorded for the person reading the review, never acted on.
    expect(result.confidenceBps).toBe(4000);
  });

  it('does not let high confidence settle anything on its own', async () => {
    // Maximum confidence, a perfectly grounded claim, and an outcome that
    // contradicts the checks. Confidence is not a vote: the contradiction wins.
    const result = await run(
      harness([
        { kind: 'json', value: contradictingModel({ confidenceBps: 10_000 }) },
      ]),
    );

    expect(result.status).toBe('NEEDS_REVIEW');
    if (result.status !== 'NEEDS_REVIEW') return;
    expect(result.reason).toBe('OUTCOME_CONTRADICTS_CHECKS');
  });

  it('proposes at exactly the floor, and not one basis point below', async () => {
    const at = await run(
      harness([{ kind: 'json', value: modelYes({ confidenceBps: 7000 }) }], {
        confidenceFloorBps: 7000,
      }),
    );
    const below = await run(
      harness([{ kind: 'json', value: modelYes({ confidenceBps: 6999 }) }], {
        confidenceFloorBps: 7000,
      }),
    );

    expect(at.status).toBe('PROPOSED');
    expect(below.status).toBe('NEEDS_REVIEW');
  });
});

// ---------------------------------------------------------------------------
// 9. Arbitrary outcomes.
// ---------------------------------------------------------------------------

describe('arbitrary outcomes', () => {
  const invented = [
    'YES',
    'NO',
    'INVALID',
    'PROBABLY_YES',
    'RESOLVED_MAYBE',
    'resolved_yes',
    'SETTLED',
    'REFUND',
    '',
  ];

  for (const outcome of invented) {
    it(`rejects the outcome "${outcome}"`, async () => {
      const result = await run(harness([{ kind: 'json', value: modelYes({ outcome }) }]));

      expect(result.status).toBe('NEEDS_REVIEW');
      if (result.status !== 'NEEDS_REVIEW') return;
      expect(result.reason).toBe('MODEL_OUTPUT_INVALID');
    });
  }

  it('gives the model no way to propose INVALID directly', () => {
    const parsed = resolutionOutputSchema.safeParse({
      ...(modelYes() as object),
      outcome: 'RESOLVED_INVALID',
    });
    expect(parsed.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Deterministic precedence over the model.
// ---------------------------------------------------------------------------

describe('deterministic checks take precedence', () => {
  it('refuses an outcome that contradicts a conclusive verdict', async () => {
    const result = await run(harness([{ kind: 'json', value: contradictingModel() }]));

    expect(result.status).toBe('NEEDS_REVIEW');
    if (result.status !== 'NEEDS_REVIEW') return;
    expect(result.reason).toBe('OUTCOME_CONTRADICTS_CHECKS');
    expect(result.detail).toContain('YES');
  });

  it('hands the checks to the model as facts, with expected and observed', async () => {
    const h = harness([{ kind: 'json', value: modelYes() }]);
    await run(h);

    const message = h.provider.calls[0]?.messages[0]?.content ?? '';
    expect(message).toContain('already computed in code, treat as established');
    expect(message).toContain('expected:');
    expect(message).toContain('observed:');
    expect(message).toContain('status-delivered');
  });

  it('never shows the model an outcome, only the verdict vocabulary', async () => {
    const h = harness([{ kind: 'json', value: modelYes() }]);
    await run(h);

    const message = h.provider.calls[0]?.messages[0]?.content ?? '';
    expect(message).toContain('verdict: SATISFIED');
    expect(message).not.toContain('proposed outcome');
  });

  it('does not put the settlement terms in front of the model', async () => {
    const h = harness([{ kind: 'json', value: modelYes() }]);
    await run(h);

    const message = h.provider.calls[0]?.messages[0]?.content ?? '';
    // The bond, the token and the challenge window are none of its business.
    expect(message).not.toContain('challengeBondBaseUnits');
    expect(message).not.toContain('50000000');
    expect(message).not.toContain('binary_parimutuel');
  });
});

// ---------------------------------------------------------------------------
// Edge cases: user-approved, and unable to flip a settlement.
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('applies a pre-approved INVALID rather than the deterministic outcome', async () => {
    // Fixture edge case 0: "delivered" with no timestamp → INVALID.
    const result = await run(harness([{ kind: 'json', value: modelYes({ matchedEdgeCase: 0 }) }]));

    if (result.status !== 'PROPOSED') throw new Error(`expected PROPOSED, got ${result.status}`);
    expect(result.outcome).toBe('INVALID');
    expect(result.rationale).toContain('edge case 0');
  });

  it('refuses an edge case that would flip a settlement', async () => {
    // Fixture edge case 1: "returned to sender" → NO, against a SATISFIED verdict.
    const result = await run(harness([{ kind: 'json', value: modelYes({ matchedEdgeCase: 1 }) }]));

    expect(result.status).toBe('NEEDS_REVIEW');
    if (result.status !== 'NEEDS_REVIEW') return;
    expect(result.reason).toBe('EDGE_CASE_CONTRADICTS_CHECKS');
  });

  it('refuses an edge case index the specification does not have', async () => {
    const result = await run(harness([{ kind: 'json', value: modelYes({ matchedEdgeCase: 9 }) }]));

    expect(result.status).toBe('NEEDS_REVIEW');
    if (result.status !== 'NEEDS_REVIEW') return;
    expect(result.violations).toContain('EDGE_CASE_OUT_OF_RANGE');
  });
});

// ---------------------------------------------------------------------------
// Claim extraction: deterministic first, model for the residue.
// ---------------------------------------------------------------------------

describe('claim extraction', () => {
  it('extracts the approved dataPath deterministically, with its locator', () => {
    const claims = extractDeterministicClaims([snapshot({ index: 0, status: 'delivered' })]);

    expect(claims).toHaveLength(1);
    expect(claims[0]?.extraction).toEqual({ method: 'JSON_POINTER', locator: '/shipment/status' });
    expect(claims[0]?.value).toBe('delivered');
    expect(claims[0]?.support).toBe('SUPPORTED');
  });

  it('emits UNSUPPORTED when a source answered but the dataPath found nothing', () => {
    const claims = extractDeterministicClaims([snapshot({ index: 0, status: null })]);

    expect(claims).toHaveLength(1);
    expect(claims[0]?.support).toBe('UNSUPPORTED');
    expect(claims[0]?.value).toBeNull();
    expect(claims[0]?.extraction).toEqual({ method: 'NONE', locator: null });
  });

  it('records a disagreement as one DISPUTED claim carrying the primary value', () => {
    const claims = extractDeterministicClaims([
      snapshot({ index: 0, status: 'delivered' }),
      snapshot({ index: 1, status: 'in_transit' }),
    ]);

    expect(claims).toHaveLength(1);
    expect(claims[0]?.support).toBe('DISPUTED');
    expect(claims[0]?.value).toBe('delivered');
    expect(claims[0]?.sourceIds).toEqual(['source-0', 'source-1']);
  });

  it('labels a model reading as MODEL_EXTRACTION with no locator', async () => {
    const result = await run(
      harness([
        {
          kind: 'json',
          value: modelYes({
            claims: [
              {
                sourceIds: ['source-0'],
                statement: 'The carrier records a delivery timestamp.',
                valueType: 'timestamp',
                value: '2026-08-30T14:02:00Z',
                support: 'SUPPORTED',
              },
            ],
          }),
        },
      ]),
    );

    if (result.status !== 'PROPOSED') throw new Error(`expected PROPOSED, got ${result.status}`);
    const modelClaim = result.claims.find((claim) => claim.claimId.startsWith('model-'));
    expect(modelClaim?.extraction).toEqual({ method: 'MODEL_EXTRACTION', locator: null });

    const deterministic = result.claims.find((claim) => claim.claimId.startsWith('det-'));
    expect(deterministic?.extraction.method).toBe('JSON_POINTER');
  });

  it('does not repeat a deterministic claim under a model provenance', async () => {
    // The model asserts exactly what the pointer already established.
    const result = await run(harness([{ kind: 'json', value: modelYes() }]));
    if (result.status !== 'PROPOSED') throw new Error('expected PROPOSED');

    const delivered = result.claims.filter((claim) => claim.value === 'delivered');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.extraction.method).toBe('JSON_POINTER');
  });

  it('classifies values without ever producing a float', () => {
    expect(classifyValue('true')).toBe('boolean');
    expect(classifyValue('2026-08-30T14:02:00Z')).toBe('timestamp');
    expect(classifyValue('121340')).toBe('integer');
    expect(classifyValue('121340.55')).toBe('decimal_string');
    expect(classifyValue('delivered')).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// The provider boundary.
// ---------------------------------------------------------------------------

describe('the provider is replaceable', () => {
  it('runs end to end with a provider that names no vendor', async () => {
    const result = await run(harness([{ kind: 'json', value: modelYes() }]));
    expect(result.status).toBe('PROPOSED');
  });

  it('reports a timeout as a failure to resolve, not as an outcome', async () => {
    const result = await run(harness([{ kind: 'error', failure: 'timeout' }]));

    expect(result.status).toBe('RESOLUTION_FAILED');
    if (result.status !== 'RESOLUTION_FAILED') return;
    expect(result.reason).toBe('PROVIDER_TIMEOUT');
  });

  it('reports a refusal distinctly from an unreachable provider', async () => {
    const refused = await run(harness([{ kind: 'error', failure: 'refused' }]));
    const down = await run(harness([{ kind: 'error', failure: 'unavailable' }]));

    if (refused.status !== 'RESOLUTION_FAILED') throw new Error('expected RESOLUTION_FAILED');
    if (down.status !== 'RESOLUTION_FAILED') throw new Error('expected RESOLUTION_FAILED');
    expect(refused.reason).toBe('PROVIDER_REFUSED');
    expect(down.reason).toBe('PROVIDER_UNAVAILABLE');
  });

  it('does not leak provider credentials or internals into the record', async () => {
    const result = await run(
      harness([{ kind: 'error', failure: 'auth', message: 'invalid api key sk-ant-secret' }]),
    );

    if (result.status !== 'RESOLUTION_FAILED') throw new Error('expected RESOLUTION_FAILED');
    expect(result.detail).not.toContain('sk-ant');
    expect(result.reason).toBe('PROVIDER_UNAVAILABLE');
  });

  it('makes exactly one model call per resolution', async () => {
    const h = harness([{ kind: 'json', value: modelYes() }]);
    await run(h);
    expect(h.provider.calls).toHaveLength(1);
  });

  it('sends no conversation history and no tools', async () => {
    const h = harness([{ kind: 'json', value: modelYes() }]);
    await run(h);

    const call = h.provider.calls[0];
    expect(call?.messages).toHaveLength(1);
    expect(call?.messages[0]?.role).toBe('user');
    expect(call?.jsonSchema?.name).toBe('resolution_output');
  });
});

// ---------------------------------------------------------------------------
// Nothing on this path reaches a chain.
// ---------------------------------------------------------------------------

describe('the engine cannot act', () => {
  it('proposes without submitting anything', async () => {
    const result = await run(harness([{ kind: 'json', value: modelYes() }]));
    if (result.status !== 'PROPOSED') throw new Error('expected PROPOSED');

    // A proposal is a document plus a hash. There is no transaction, no signer
    // and no receipt anywhere in the result.
    expect(Object.keys(result)).not.toContain('transactionHash');
    expect(Object.keys(result)).not.toContain('receipt');
    expect(result.evidenceHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('reads no clock: the same inputs hash identically twice', async () => {
    const first = await run(harness([{ kind: 'json', value: modelYes() }]));
    const second = await run(harness([{ kind: 'json', value: modelYes() }]));

    if (first.status !== 'PROPOSED' || second.status !== 'PROPOSED') {
      throw new Error('expected PROPOSED');
    }
    expect(second.evidenceHash).toBe(first.evidenceHash);
    expect(second.canonical).toBe(first.canonical);
  });

  it('changes the evidence hash when the reasoning changes', async () => {
    const baseline = await run(harness([{ kind: 'json', value: modelYes() }]));
    const edited = await run(
      harness([
        { kind: 'json', value: modelYes({ reasoning: 'The shipment arrived, per source-0.' }) },
      ]),
    );

    if (baseline.status !== 'PROPOSED' || edited.status !== 'PROPOSED') {
      throw new Error('expected PROPOSED');
    }
    // Reasoning is inside the hash: a resolver cannot rewrite its argument after
    // committing to it.
    expect(edited.evidenceHash).not.toBe(baseline.evidenceHash);
  });

  it('changes the evidence hash when the confidence changes', async () => {
    const baseline = await run(harness([{ kind: 'json', value: modelYes() }]));
    const edited = await run(harness([{ kind: 'json', value: modelYes({ confidenceBps: 9100 }) }]));

    if (baseline.status !== 'PROPOSED' || edited.status !== 'PROPOSED') {
      throw new Error('expected PROPOSED');
    }
    expect(edited.evidenceHash).not.toBe(baseline.evidenceHash);
  });
});

// ---------------------------------------------------------------------------
// Assembly.
// ---------------------------------------------------------------------------

describe('assembly', () => {
  it('refuses a package whose source URL is not the one approved at that position', async () => {
    const h = harness([{ kind: 'json', value: modelYes() }]);
    const tampered = h.input.sources.map((source, index) =>
      index === 0 ? { ...source, url: 'https://api.other-carrier.test/v1/track/1Z999' } : source,
    );

    const result = await h.engine.resolve({ ...h.input, sources: tampered });

    expect(result.status).toBe('NEEDS_REVIEW');
    if (result.status !== 'NEEDS_REVIEW') return;
    expect(result.reason).toBe('PACKAGE_INVALID');
  });

  it('refuses a package whose resolution predates its evidence', async () => {
    const h = harness([{ kind: 'json', value: modelYes() }]);
    const result = await h.engine.resolve({ ...h.input, resolvedAt: '2026-09-01T00:00:00Z' });

    expect(result.status).toBe('NEEDS_REVIEW');
    if (result.status !== 'NEEDS_REVIEW') return;
    expect(result.reason).toBe('PACKAGE_INVALID');
  });

  it('records every approved source, including the one never needed', async () => {
    const result = await run(harness([{ kind: 'json', value: modelYes() }]));
    if (result.status !== 'PROPOSED') throw new Error('expected PROPOSED');

    expect(result.evidence.sources).toHaveLength(2);
    expect(result.evidence.sources[1]?.status).toBe('NOT_ATTEMPTED');
    expect(result.evidence.sources[1]?.contentHash).toBeNull();
  });

  it('places the market identity the caller supplied, not one the model chose', async () => {
    const result = await run(harness([{ kind: 'json', value: modelYes() }]));
    if (result.status !== 'PROPOSED') throw new Error('expected PROPOSED');

    expect(result.evidence.chainId).toBe(MARKET.chainId);
    expect(result.evidence.marketId).toBe(MARKET.marketId);
    expect(result.evidence.marketAddress).toBe(MARKET.marketAddress);
    expect(result.evidence.resolvedAt).toBe(RESOLVED_AT);
  });
});

// ---------------------------------------------------------------------------
// A sanity check on the harness itself.
// ---------------------------------------------------------------------------

describe('the fixtures under test are what they claim', () => {
  it('uses a plan whose checks encode the success condition', () => {
    expect(deliveredPlan().encodes).toBe('successCondition');
  });

  it('builds sources whose URLs are the approved ones', () => {
    const sources = evidenceSources([snapshot({ index: 0, status: 'delivered' })]);
    expect(sources.map((source) => source.url)).toEqual(
      spec().approvedSources.map((source) => source.url),
    );
  });

  it('fails loudly when a test scripts fewer responses than the engine needs', async () => {
    const engine = new ResolutionEngine({
      provider: new FakeLLMProvider([]),
      maxOutputTokens: 1000,
      timeoutMs: 1000,
    });
    const h = harness([]);
    await expect(engine.resolve(h.input)).rejects.toThrow(/ran out of scripted responses/);
  });
});
