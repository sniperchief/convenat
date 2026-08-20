/**
 * The compiler's output contract.
 *
 * Two representations of the same shape, for two different jobs:
 *
 * - `compilerOutputJsonSchema` is sent to the provider to constrain generation.
 *   It makes well-formed output *likely*.
 * - `compilerOutputSchema` (Zod) validates what comes back. It makes malformed
 *   output *impossible to use*.
 *
 * The second is the gate. A provider-side schema is a generation aid, not a
 * guarantee — a truncated response, a provider that ignores the constraint, or
 * a model that emits prose around the JSON all produce output that satisfies
 * nothing. Nothing reaches the hashing pipeline without passing the Zod parse.
 *
 * The model produces a *condition draft*, not a `ConditionSpec`. It is not
 * asked for `version`, `nonce`, `creator`, or the settlement block: those are
 * identifiers and economic terms, and letting a model invent an address, a
 * salt, or a bond size is exactly the class of hallucination this system is
 * built to prevent. Assembly happens in assemble.ts.
 */

import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);

/** A source the resolver may consult. Position is precedence (ADR-0008). */
const approvedSourceDraft = z
  .object({
    name: text(120),
    url: z.string().trim().url(),
    retrievalKind: z.enum(['http_json', 'http_html', 'manual_attestation']),
    dataPath: z.string().trim().min(1).max(500).nullable().default(null),
  })
  .strict();

const ambiguityDraft = z
  .object({
    description: text(1000),
    assumption: text(1000),
  })
  .strict();

const edgeCaseDraft = z
  .object({
    scenario: text(1000),
    outcome: z.enum(['YES', 'NO', 'INVALID']),
  })
  .strict();

/**
 * The condition, as the model produces it.
 *
 * Every field is required. An optional field invites the model to omit what it
 * could not determine and let the omission pass silently as "nothing to say" —
 * the exact failure the INCOMPLETE path exists to make visible.
 */
export const conditionDraftSchema = z
  .object({
    question: text(500),
    conditionType: z.literal('binary'),
    successCondition: text(2000),
    failureCondition: text(2000),
    deadline: text(64),
    timezone: text(64),
    resolutionMethod: z.enum([
      'deterministic_numeric_threshold',
      'deterministic_event_occurrence',
      'source_attested_status',
      'ai_evidence_interpretation',
    ]),
    approvedSources: z.array(approvedSourceDraft).max(8),
    evidenceRequirements: z.array(text(1000)).max(20),
    ambiguities: z.array(ambiguityDraft).max(20),
    edgeCases: z.array(edgeCaseDraft).max(20),
    risk: z.enum(['low', 'medium', 'high']),
  })
  .strict();

export type ConditionDraft = z.infer<typeof conditionDraftSchema>;

const clarificationSchema = z
  .object({
    field: text(120),
    question: text(500),
    why: text(500),
  })
  .strict();

export type Clarification = z.infer<typeof clarificationSchema>;

/**
 * The full model response.
 *
 * `.strict()` rejects unknown keys rather than stripping them. A model that
 * invents a `rulesHash`, a `confidence`, or a `settlement` field has
 * misunderstood its role, and that is worth failing loudly over — silently
 * dropping the field would hide the misunderstanding until it mattered.
 */
export const compilerOutputSchema = z
  .object({
    status: z.enum(['COMPILED', 'INCOMPLETE']),
    interpretation: text(2000),
    questions: z.array(clarificationSchema).max(12),
    condition: conditionDraftSchema.nullable(),
  })
  .strict()
  .superRefine((output, ctx) => {
    if (output.status === 'COMPILED' && output.condition === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['condition'],
        message: 'a COMPILED result must carry a condition',
      });
    }
    if (output.status === 'INCOMPLETE' && output.questions.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['questions'],
        message: 'an INCOMPLETE result must say what it needs',
      });
    }
  });

export type CompilerOutput = z.infer<typeof compilerOutputSchema>;

/**
 * JSON Schema sent to the provider.
 *
 * Written out rather than generated from the Zod schema. Provider-side schemas
 * support a narrower subset of JSON Schema than Zod expresses — length bounds
 * and string formats are not enforced there — so a generated schema would
 * either be rejected or silently drop constraints, and reading it would tell
 * you less than reading this. The bounds live in the Zod schema, which is where
 * they are actually enforced.
 */
export const compilerOutputJsonSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'interpretation', 'questions', 'condition'],
  properties: {
    status: { type: 'string', enum: ['COMPILED', 'INCOMPLETE'] },
    interpretation: {
      type: 'string',
      description: 'Your reading of the request, in plain language. Interpretation, not fact.',
    },
    questions: {
      type: 'array',
      description: 'What you need answered. Empty when status is COMPILED.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field', 'question', 'why'],
        properties: {
          field: { type: 'string', description: 'Field path this would fill, e.g. deadline.' },
          question: { type: 'string', description: 'A question a person can answer.' },
          why: { type: 'string', description: 'Why it cannot be resolved without an answer.' },
        },
      },
    },
    condition: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: [
            'question',
            'conditionType',
            'successCondition',
            'failureCondition',
            'deadline',
            'timezone',
            'resolutionMethod',
            'approvedSources',
            'evidenceRequirements',
            'ambiguities',
            'edgeCases',
            'risk',
          ],
          properties: {
            question: { type: 'string' },
            conditionType: { type: 'string', enum: ['binary'] },
            successCondition: { type: 'string', description: 'Exactly what must be observed for YES.' },
            failureCondition: { type: 'string', description: 'Exactly what must be observed for NO.' },
            deadline: {
              type: 'string',
              description: 'RFC 3339 instant with an explicit offset, e.g. 2026-09-01T23:59:59Z.',
            },
            timezone: { type: 'string', description: '"UTC" or an IANA name.' },
            resolutionMethod: {
              type: 'string',
              enum: [
                'deterministic_numeric_threshold',
                'deterministic_event_occurrence',
                'source_attested_status',
                'ai_evidence_interpretation',
              ],
            },
            approvedSources: {
              type: 'array',
              description: 'Ordered by precedence. Index 0 is primary; later entries are fallbacks.',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'url', 'retrievalKind', 'dataPath'],
                properties: {
                  name: { type: 'string' },
                  url: { type: 'string' },
                  retrievalKind: {
                    type: 'string',
                    enum: ['http_json', 'http_html', 'manual_attestation'],
                  },
                  dataPath: {
                    anyOf: [{ type: 'null' }, { type: 'string' }],
                    description: 'Selector locating the value in the response, or null.',
                  },
                },
              },
            },
            evidenceRequirements: {
              type: 'array',
              description: 'What must be extracted to decide the condition.',
              items: { type: 'string' },
            },
            ambiguities: {
              type: 'array',
              description: 'What was unclear, and the reading you committed to.',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['description', 'assumption'],
                properties: {
                  description: { type: 'string' },
                  assumption: { type: 'string' },
                },
              },
            },
            edgeCases: {
              type: 'array',
              description: 'Corner cases, each pre-decided to an outcome.',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['scenario', 'outcome'],
                properties: {
                  scenario: { type: 'string' },
                  outcome: { type: 'string', enum: ['YES', 'NO', 'INVALID'] },
                },
              },
            },
            risk: { type: 'string', enum: ['low', 'medium', 'high'] },
          },
        },
      ],
    },
  },
};
