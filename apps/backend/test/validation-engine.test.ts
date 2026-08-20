/**
 * The deterministic validation engine: plans, precedence, conflicts, and the
 * checks that go into an `EvidencePackage`.
 *
 * The engine takes snapshots rather than making requests, so every test here is
 * a pure function call. That is not just convenient — it is the property the
 * milestone is about. If any of these needed a network, a clock or a model, the
 * validators would not be deterministic and a challenge could not re-run them.
 */

import { describe, expect, it } from 'vitest';

import {
  buildEvidenceCommitmentForSpec,
  parseConditionSpec,
  type ConditionSpec,
  type EvidencePackageV2Input,
} from '@covenant/shared';
import { conditionSpecFixtures } from '@covenant/shared/testing';

import type { EvidenceSnapshot } from '../src/evidence/retriever.js';
import { DeterministicValidationEngine } from '../src/validation/engine.js';
import { validateValidationPlan, type ValidationPlanInput } from '../src/validation/plan.js';

const spec = (): ConditionSpec => parseConditionSpec(conditionSpecFixtures.shipment);

/** The shipment fixture's deadline, for readability in the assertions below. */
const DEADLINE = '2026-09-01T23:59:59Z';

function plan(input: ValidationPlanInput) {
  const result = validateValidationPlan(input);
  if (!result.ok) throw new Error(`plan invalid: ${JSON.stringify(result.issues)}`);
  return result.plan;
}

/**
 * A snapshot carrying one selected value.
 *
 * `selection.value` is canonical JSON, exactly as M5.2 produces it — so a string
 * arrives quoted and a number bare, and the engine has to cope with both.
 */
function snapshot(options: {
  index: number;
  selection: string | null;
  content?: string;
  truncated?: boolean;
}): EvidenceSnapshot {
  return {
    sourceId: `source-${options.index}`,
    approvedSourceIndex: options.index,
    name: `Source ${options.index}`,
    url: `https://source-${options.index}.test/x`,
    normalizedUrl: `https://source-${options.index}.test/x`,
    retrievalKind: 'http_json',
    retrievedAt: '2026-09-02T00:05:00Z',
    contentHash: `0x${String(options.index).repeat(64).slice(0, 64)}` as `0x${string}`,
    normalizedContent: options.content ?? '{}',
    normalizedHash: `0x${'a'.repeat(64)}` as `0x${string}`,
    normalizedTruncated: options.truncated ?? false,
    rawBytes: 64,
    selection: options.selection === null ? null : { pointer: '/shipment/status', value: options.selection },
    finalUrl: `https://source-${options.index}.test/x`,
    redirects: [],
    attempts: 1,
    deduplicatedFrom: null,
  };
}

const engine = new DeterministicValidationEngine();

// ---------------------------------------------------------------------------

describe('numeric threshold, end to end', () => {
  const numericPlan = plan({
    checks: [
      {
        checkId: 'price-above',
        kind: 'NUMERIC_COMPARISON',
        observation: { sourceId: 'source-0', pointer: null },
        operator: 'GREATER_THAN',
        threshold: '120000',
        isPrice: true,
      },
    ],
  });

  const run = (value: string) =>
    engine.validate({
      specification: spec(),
      plan: numericPlan,
      snapshots: [snapshot({ index: 0, selection: value })],
    });

  it('records what was expected, what was observed, and the result', () => {
    const result = run('121340');
    const check = result.checks.find((entry) => entry.checkId === 'price-above');

    expect(check?.checkType).toBe('PRICE_ABOVE_THRESHOLD');
    expect(check?.expected).toBe('observed > 120000');
    expect(check?.observed).toBe('121340');
    expect(check?.result).toBe('PASS');
    expect(result.verdict).toBe('SATISFIED');
  });

  it('walks the boundary: threshold-1, threshold, threshold+1', () => {
    expect(run('119999').verdict).toBe('REFUTED');
    expect(run('120000').verdict).toBe('REFUTED');
    expect(run('120001').verdict).toBe('SATISFIED');
  });

  it('reads a quoted decimal string exactly as it reads a bare number', () => {
    // A source that quotes its numbers must not be unreadable while an identical
    // one that does not works.
    expect(run('"121340.50"').checks[0]?.observed).toBe('121340.50');
    expect(run('"121340.50"').verdict).toBe('SATISFIED');
  });

  it('does not decide when the observed value is unreadable', () => {
    // "unreadable" and "below the threshold" are different facts.
    const result = run('"about 121k"');
    expect(result.checks[0]?.result).toBe('INDETERMINATE');
    expect(result.checks[0]?.observed).toBeNull();
    expect(result.verdict).toBe('NEEDS_REVIEW');
    expect(result.validationErrors[0]?.checkId).toBe('price-above');
  });

  it('refuses exponent notation rather than interpreting it', () => {
    expect(run('"1.2134e5"').verdict).toBe('NEEDS_REVIEW');
  });

  it('does not decide when no source produced the value', () => {
    const result = engine.validate({
      specification: spec(),
      plan: numericPlan,
      snapshots: [snapshot({ index: 0, selection: null })],
    });
    expect(result.checks[0]?.result).toBe('INDETERMINATE');
    expect(result.verdict).toBe('NEEDS_REVIEW');
  });

  it('does not decide when there are no snapshots at all', () => {
    const result = engine.validate({ specification: spec(), plan: numericPlan, snapshots: [] });
    expect(result.verdict).toBe('NEEDS_REVIEW');
  });
});

// ---------------------------------------------------------------------------

describe('deadline comparison', () => {
  const deadlinePlan = (operator: 'BEFORE' | 'AT_OR_BEFORE') =>
    plan({
      checks: [
        {
          checkId: 'delivered-in-time',
          kind: 'TEMPORAL_COMPARISON',
          observation: { sourceId: 'source-0', pointer: null },
          operator,
          reference: 'spec_deadline',
        },
      ],
    });

  const run = (value: string, operator: 'BEFORE' | 'AT_OR_BEFORE' = 'AT_OR_BEFORE') =>
    engine.validate({
      specification: spec(),
      plan: deadlinePlan(operator),
      snapshots: [snapshot({ index: 0, selection: JSON.stringify(value) })],
    });

  it('measures against the specification deadline, not a plan-supplied one', () => {
    expect(run('2026-08-28T14:02:11Z').checks[0]?.expected).toBe(`observed <= ${DEADLINE}`);
  });

  it('walks the boundary: deadline-1s, deadline, deadline+1s', () => {
    expect(run('2026-09-01T23:59:58Z').verdict).toBe('SATISFIED');
    expect(run('2026-09-01T23:59:59Z').verdict).toBe('SATISFIED');
    expect(run('2026-09-02T00:00:00Z').verdict).toBe('REFUTED');
  });

  it('distinguishes "before" from "by" at exactly the deadline', () => {
    expect(run('2026-09-01T23:59:59Z', 'BEFORE').verdict).toBe('REFUTED');
    expect(run('2026-09-01T23:59:59Z', 'AT_OR_BEFORE').verdict).toBe('SATISFIED');
  });

  it('converts an offset timestamp before comparing', () => {
    // 19:59:58-04:00 is 23:59:58Z — inside the deadline, despite an earlier
    // wall clock.
    const result = run('2026-09-01T19:59:58-04:00');
    expect(result.checks[0]?.observed).toBe('2026-09-01T23:59:58Z');
    expect(result.verdict).toBe('SATISFIED');
  });

  it('refuses a local date-time rather than assuming UTC', () => {
    const result = run('2026-08-28T14:02:11');
    expect(result.checks[0]?.result).toBe('INDETERMINATE');
    expect(result.verdict).toBe('NEEDS_REVIEW');
  });

  it('cannot be pointed at any instant other than the approved deadline', () => {
    // The plan schema has no literal-instant variant, so an unhashed plan cannot
    // substitute a deadline the user never agreed to.
    const rejected = validateValidationPlan({
      checks: [
        {
          checkId: 'smuggled',
          kind: 'TEMPORAL_COMPARISON',
          observation: { sourceId: 'source-0', pointer: null },
          operator: 'BEFORE',
          reference: '2027-01-01T00:00:00Z',
        },
      ],
    });
    expect(rejected.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('categorical and boolean matches', () => {
  const statusPlan = (accepted: string[], caseSensitive = true) =>
    plan({
      checks: [
        {
          checkId: 'status',
          kind: 'CATEGORICAL_MATCH',
          observation: { sourceId: 'source-0', pointer: null },
          accepted,
          caseSensitive,
        },
      ],
    });

  const run = (value: string, accepted: string[], caseSensitive = true) =>
    engine.validate({
      specification: spec(),
      plan: statusPlan(accepted, caseSensitive),
      snapshots: [snapshot({ index: 0, selection: JSON.stringify(value) })],
    });

  it('matches exactly, and records the accepted set', () => {
    const result = run('delivered', ['delivered']);
    expect(result.checks[0]?.checkType).toBe('STRING_MATCH');
    expect(result.checks[0]?.expected).toBe('observed in [delivered]');
    expect(result.verdict).toBe('SATISFIED');
  });

  it('is case-sensitive by default, because a status is an identifier', () => {
    expect(run('Delivered', ['delivered']).verdict).toBe('REFUTED');
    expect(run('Delivered', ['delivered'], false).verdict).toBe('SATISFIED');
  });

  it('refutes a value outside the accepted set rather than guessing at intent', () => {
    expect(run('in_transit', ['delivered']).verdict).toBe('REFUTED');
  });

  it('accepts any member of the set', () => {
    expect(run('DELIVERED', ['delivered', 'DELIVERED']).verdict).toBe('SATISFIED');
  });

  const booleanPlan = plan({
    checks: [
      {
        checkId: 'signed-for',
        kind: 'BOOLEAN_MATCH',
        observation: { sourceId: 'source-0', pointer: null },
        expected: true,
      },
    ],
  });

  const runBoolean = (selection: string) =>
    engine.validate({
      specification: spec(),
      plan: booleanPlan,
      snapshots: [snapshot({ index: 0, selection })],
    });

  it('matches a boolean from JSON or from an unambiguous word', () => {
    expect(runBoolean('true').verdict).toBe('SATISFIED');
    expect(runBoolean('"yes"').verdict).toBe('SATISFIED');
    expect(runBoolean('false').verdict).toBe('REFUTED');
    expect(runBoolean('"no"').verdict).toBe('REFUTED');
  });

  it('refuses 1 and 0 as ambiguous rather than reading them as booleans', () => {
    // `1` may be true, or may be a count of one.
    expect(runBoolean('1').verdict).toBe('NEEDS_REVIEW');
    expect(runBoolean('0').verdict).toBe('NEEDS_REVIEW');
  });
});

// ---------------------------------------------------------------------------

describe('conflicting sources are settled by precedence, never by majority', () => {
  const statusPlan = plan({
    checks: [
      {
        checkId: 'status',
        kind: 'CATEGORICAL_MATCH',
        observation: { sourceId: 'source-0', pointer: null },
        accepted: ['delivered'],
        caseSensitive: true,
      },
    ],
  });

  it('prefers the primary even when every fallback disagrees', () => {
    const result = engine.validate({
      specification: spec(),
      plan: statusPlan,
      snapshots: [
        snapshot({ index: 0, selection: '"delivered"' }),
        snapshot({ index: 1, selection: '"in_transit"' }),
      ],
    });

    expect(result.verdict).toBe('SATISFIED');
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.preferredSourceId).toBe('source-0');
    expect(result.conflicts[0]?.dissenting[0]?.sourceId).toBe('source-1');
  });

  it('records the disagreement on the check itself, so a package carries it', () => {
    const result = engine.validate({
      specification: spec(),
      plan: statusPlan,
      snapshots: [
        snapshot({ index: 0, selection: '"delivered"' }),
        snapshot({ index: 1, selection: '"in_transit"' }),
      ],
    });

    const check = result.checks.find((entry) => entry.checkId === 'status');
    expect(check?.explanation).toContain('precedence selected source-0');
    expect(check?.explanation).toContain('source-1');
  });

  it('falls to the approved fallback when the primary produced nothing', () => {
    const result = engine.validate({
      specification: spec(),
      plan: statusPlan,
      snapshots: [
        snapshot({ index: 0, selection: null }),
        snapshot({ index: 1, selection: '"delivered"' }),
      ],
    });

    expect(result.verdict).toBe('SATISFIED');
    expect(result.checks[0]?.sourceIds).toEqual(['source-1']);
    expect(result.conflicts).toHaveLength(0);
  });

  it('does not let agreeing fallbacks outvote the primary', () => {
    const result = engine.validate({
      specification: spec(),
      plan: statusPlan,
      snapshots: [
        snapshot({ index: 0, selection: '"in_transit"' }),
        snapshot({ index: 1, selection: '"delivered"' }),
      ],
    });

    // Two-to-one for `delivered` on a majority count. Precedence says otherwise.
    expect(result.verdict).toBe('REFUTED');
    expect(result.checks[0]?.observed).toBe('in_transit');
  });

  it('lets a plan skip a source that does not carry the field', () => {
    // `observation.sourceId` names the highest-precedence position to consult,
    // not the only one. Naming source-1 deliberately ignores the primary.
    const skipping = plan({
      checks: [
        {
          checkId: 'status',
          kind: 'CATEGORICAL_MATCH',
          observation: { sourceId: 'source-1', pointer: null },
          accepted: ['delivered'],
          caseSensitive: true,
        },
      ],
    });

    const result = engine.validate({
      specification: spec(),
      plan: skipping,
      snapshots: [
        snapshot({ index: 0, selection: '"in_transit"' }),
        snapshot({ index: 1, selection: '"delivered"' }),
      ],
    });

    expect(result.checks[0]?.observed).toBe('delivered');
    expect(result.checks[0]?.sourceIds).toEqual(['source-1']);
    expect(result.conflicts).toHaveLength(0);
    expect(result.verdict).toBe('SATISFIED');
  });

  it('records no conflict when the sources agree', () => {
    const result = engine.validate({
      specification: spec(),
      plan: statusPlan,
      snapshots: [
        snapshot({ index: 0, selection: '"delivered"' }),
        snapshot({ index: 1, selection: '"delivered"' }),
      ],
    });
    expect(result.conflicts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('the verdict is conservative, and is never an outcome', () => {
  it('is NEEDS_REVIEW when any check could not run, even if the rest passed', () => {
    const mixed = plan({
      checks: [
        {
          checkId: 'ok',
          kind: 'CATEGORICAL_MATCH',
          observation: { sourceId: 'source-0', pointer: null },
          accepted: ['delivered'],
        },
        {
          checkId: 'broken',
          kind: 'NUMERIC_COMPARISON',
          observation: { sourceId: 'source-1', pointer: '/nope' },
          operator: 'GREATER_THAN',
          threshold: '1',
        },
      ],
    });

    const result = engine.validate({
      specification: spec(),
      plan: mixed,
      snapshots: [snapshot({ index: 0, selection: '"delivered"' })],
    });

    expect(result.checks.find((c) => c.checkId === 'ok')?.result).toBe('PASS');
    expect(result.verdict).toBe('NEEDS_REVIEW');
  });

  it('emits no YES, NO or INVALID anywhere in its output', () => {
    const result = engine.validate({
      specification: spec(),
      plan: plan({
        checks: [
          {
            checkId: 'status',
            kind: 'CATEGORICAL_MATCH',
            observation: { sourceId: 'source-0', pointer: null },
            accepted: ['delivered'],
          },
        ],
      }),
      snapshots: [snapshot({ index: 0, selection: '"delivered"' })],
    });

    expect(['SATISFIED', 'REFUTED', 'NEEDS_REVIEW']).toContain(result.verdict);
    expect(JSON.stringify(result)).not.toMatch(/"(YES|NO|INVALID)"/);
  });
});

// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('gives byte-identical output across repeated runs', () => {
    const input = {
      specification: spec(),
      plan: plan({
        checks: [
          {
            checkId: 'status',
            kind: 'CATEGORICAL_MATCH' as const,
            observation: { sourceId: 'source-0', pointer: null },
            accepted: ['delivered'],
          },
        ],
      }),
      snapshots: [snapshot({ index: 0, selection: '"delivered"' })],
    };

    const first = JSON.stringify(engine.validate(input));
    for (let i = 0; i < 25; i += 1) {
      expect(JSON.stringify(engine.validate(input))).toBe(first);
    }
  });

  it('does not read a clock', () => {
    // Both operands come from documents. If the engine consulted `Date.now`,
    // moving it would move the verdict.
    const input = {
      specification: spec(),
      plan: plan({
        checks: [
          {
            checkId: 'in-time',
            kind: 'TEMPORAL_COMPARISON' as const,
            observation: { sourceId: 'source-0', pointer: null },
            operator: 'AT_OR_BEFORE' as const,
            reference: 'spec_deadline' as const,
          },
        ],
      }),
      snapshots: [snapshot({ index: 0, selection: '"2026-08-28T14:02:11Z"' })],
    };

    const before = engine.validate(input);
    const realNow = Date.now;
    Date.now = () => new Date('2099-01-01T00:00:00Z').getTime();
    try {
      expect(JSON.stringify(engine.validate(input))).toBe(JSON.stringify(before));
    } finally {
      Date.now = realNow;
    }
  });
});

// ---------------------------------------------------------------------------

describe('source availability is informational, never decisive', () => {
  it('records a check per approved source that was read', () => {
    const result = engine.validate({
      specification: spec(),
      plan: plan({
        checks: [
          {
            checkId: 'status',
            kind: 'CATEGORICAL_MATCH',
            observation: { sourceId: 'source-0', pointer: null },
            accepted: ['delivered'],
          },
        ],
      }),
      snapshots: [snapshot({ index: 0, selection: '"delivered"' })],
    });

    const availability = result.checks.filter((entry) => entry.checkType === 'SOURCE_AVAILABLE');
    expect(availability).toHaveLength(1);
    expect(availability[0]?.result).toBe('PASS');
  });

  it('does not let an unavailable primary refute a condition the fallback settled', () => {
    const result = engine.validate({
      specification: spec(),
      plan: plan({
        checks: [
          {
            checkId: 'status',
            kind: 'CATEGORICAL_MATCH',
            observation: { sourceId: 'source-0', pointer: null },
            accepted: ['delivered'],
          },
        ],
      }),
      snapshots: [snapshot({ index: 1, selection: '"delivered"' })],
      failures: [
        {
          sourceId: 'source-0',
          approvedSourceIndex: 0,
          name: 'Carrier tracking API',
          url: 'https://api.example-carrier.test/v1/track/1Z999AA10123456784',
          normalizedUrl: null,
          retrievalKind: 'http_json',
          attemptedAt: '2026-09-02T00:01:00Z',
          failure: 'SOURCE_UNAVAILABLE',
          detail: 'no response',
          attempts: 3,
        },
      ],
    });

    // The availability check is INDETERMINATE, and the verdict is still decided.
    const availability = result.checks.filter((entry) => entry.checkType === 'SOURCE_AVAILABLE');
    expect(availability.some((entry) => entry.result === 'INDETERMINATE')).toBe(true);
    expect(result.verdict).toBe('SATISFIED');
  });
});

// ---------------------------------------------------------------------------

describe('integration with EvidencePackage v2.0', () => {
  it('produces checks a package accepts', () => {
    const specification = spec();
    const result = engine.validate({
      specification,
      plan: plan({
        checks: [
          {
            checkId: 'status',
            kind: 'CATEGORICAL_MATCH',
            observation: { sourceId: 'source-0', pointer: null },
            accepted: ['delivered'],
          },
          {
            checkId: 'in-time',
            kind: 'TEMPORAL_COMPARISON',
            observation: { sourceId: 'source-0', pointer: null },
            operator: 'AT_OR_BEFORE',
            reference: 'spec_deadline',
          },
        ],
      }),
      snapshots: [snapshot({ index: 0, selection: '"delivered"' })],
    });

    const evidence: EvidencePackageV2Input = {
      version: '2.0',
      chainId: 1952,
      marketId: '7',
      marketAddress: '0x3333333333333333333333333333333333333333',
      rulesHash: '0x739735cae491d20d3242742eda9d9efcdf1ef0e6d34a2cbca7555ed868ff6e97',
      outcome: 'YES',
      confidenceBps: 0,
      reasoning:
        'Placeholder reasoning. M5.3 produces deterministic checks only; the outcome, the reasoning and the confidence are the next milestone and are not derived here.',
      sources: [
        {
          sourceId: 'source-0',
          approvedSourceIndex: 0,
          name: 'Carrier tracking API',
          url: 'https://api.example-carrier.test/v1/track/1Z999AA10123456784',
          retrievalKind: 'http_json',
          status: 'RETRIEVED',
          retrievedAt: '2026-09-02T00:05:00Z',
          contentHash: `0x${'4'.repeat(64)}`,
        },
      ],
      claims: [],
      deterministicChecks: result.checks.filter((entry) =>
        entry.sourceIds.every((id) => id === 'source-0'),
      ),
      resolver: { version: '1.0.0', model: null },
      resolvedAt: '2026-09-02T00:06:00Z',
    };

    expect(() =>
      buildEvidenceCommitmentForSpec(conditionSpecFixtures.shipment, evidence),
    ).not.toThrow();
  });

  it('gives every check a unique id, which the package requires', () => {
    const result = engine.validate({
      specification: spec(),
      plan: plan({
        checks: [
          {
            checkId: 'a',
            kind: 'CATEGORICAL_MATCH',
            observation: { sourceId: 'source-0', pointer: null },
            accepted: ['delivered'],
          },
          {
            checkId: 'b',
            kind: 'CATEGORICAL_MATCH',
            observation: { sourceId: 'source-0', pointer: null },
            accepted: ['delivered'],
          },
        ],
      }),
      snapshots: [snapshot({ index: 0, selection: '"delivered"' })],
    });

    const ids = result.checks.map((entry) => entry.checkId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------

describe('plan validation', () => {
  it('rejects a duplicate check id', () => {
    const result = validateValidationPlan({
      checks: [
        {
          checkId: 'same',
          kind: 'CATEGORICAL_MATCH',
          observation: { sourceId: 'source-0', pointer: null },
          accepted: ['a'],
        },
        {
          checkId: 'same',
          kind: 'CATEGORICAL_MATCH',
          observation: { sourceId: 'source-0', pointer: null },
          accepted: ['b'],
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects an inverted range at configuration time, not at run time', () => {
    const result = validateValidationPlan({
      checks: [
        {
          checkId: 'range',
          kind: 'NUMERIC_RANGE',
          observation: { sourceId: 'source-0', pointer: null },
          low: '200',
          high: '100',
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.path.endsWith('high'))).toBe(true);
  });

  it('rejects a threshold that is not an exact decimal', () => {
    for (const threshold of ['1e5', '120,000', '$120000']) {
      const result = validateValidationPlan({
        checks: [
          {
            checkId: 'x',
            kind: 'NUMERIC_COMPARISON',
            observation: { sourceId: 'source-0', pointer: null },
            operator: 'GREATER_THAN',
            threshold,
          },
        ],
      });
      expect(result.ok, threshold).toBe(false);
    }
  });

  it('rejects a source id that is not an approved-source reference', () => {
    const result = validateValidationPlan({
      checks: [
        {
          checkId: 'x',
          kind: 'CATEGORICAL_MATCH',
          observation: { sourceId: 'https://elsewhere.test', pointer: null },
          accepted: ['a'],
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown field rather than stripping it', () => {
    const result = validateValidationPlan({
      checks: [
        {
          checkId: 'x',
          kind: 'CATEGORICAL_MATCH',
          observation: { sourceId: 'source-0', pointer: null },
          accepted: ['a'],
          weight: 3,
        },
      ],
    });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('a truncated document is not silently half-read', () => {
  it('declines an explicit pointer into a truncated snapshot', () => {
    const result = engine.validate({
      specification: spec(),
      plan: plan({
        checks: [
          {
            checkId: 'x',
            kind: 'NUMERIC_COMPARISON',
            observation: { sourceId: 'source-0', pointer: '/price' },
            operator: 'GREATER_THAN',
            threshold: '1',
          },
        ],
      }),
      snapshots: [
        snapshot({ index: 0, selection: null, content: '{"price":5', truncated: true }),
      ],
    });

    expect(result.checks[0]?.result).toBe('INDETERMINATE');
    expect(result.verdict).toBe('NEEDS_REVIEW');
  });

  it('reads an explicit pointer from an intact document', () => {
    const result = engine.validate({
      specification: spec(),
      plan: plan({
        checks: [
          {
            checkId: 'x',
            kind: 'NUMERIC_COMPARISON',
            observation: { sourceId: 'source-0', pointer: '/price' },
            operator: 'GREATER_THAN',
            threshold: '1',
          },
        ],
      }),
      snapshots: [snapshot({ index: 0, selection: null, content: '{"price":5}' })],
    });

    expect(result.checks[0]?.observed).toBe('5');
    expect(result.verdict).toBe('SATISFIED');
  });
});
