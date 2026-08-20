/**
 * The condition compiler.
 *
 * The pipeline, in order, with no shortcut around any step:
 *
 *   session history + message
 *     -> LLM provider (structured output)
 *     -> Zod validation of the model's output      <- the gate
 *     -> INCOMPLETE? return questions, stop here
 *     -> assemble identifiers and market terms     <- system, not model
 *     -> validate as a ConditionSpec (@covenant/shared)
 *     -> canonicalise + rulesHash (@covenant/shared)
 *     -> persist the compilation
 *     -> COMPILED
 *
 * Two paths that do not exist, deliberately:
 *
 * - **LLM to chain.** Nothing here signs, sends, or reads a transaction.
 * - **LLM to financial state.** A compiled specification is a draft. It becomes
 *   binding only when a user approves it and their own wallet commits the hash.
 *
 * `rulesHash` is computed by `@covenant/shared` and nowhere else. The compiler
 * does not canonicalise, does not hash, and never asks the model for a hash.
 */

import {
  buildRulesCommitment,
  validateConditionSpec,
  type Bytes32Hex,
  type ConditionSpec,
  type ConditionSpecInput,
  type CompilerQuestion,
  type FieldIssue,
} from '@covenant/shared';

import type { MarketPolicy, SettlementTokenConfig } from '../config.js';
import { CompilerOutputError, LlmRefusedError, LlmTimeoutError, LlmUnavailableError } from '../errors.js';
import { LLMProviderError, type LLMProvider } from '../llm/provider.js';
import { assembleConditionSpec } from './assemble.js';
import { COMPILER_SYSTEM_PROMPT, buildContextBlock } from './prompt.js';
import {
  compilerOutputJsonSchema,
  compilerOutputSchema,
  type CompilerOutput,
  type ConditionDraft,
} from './output-schema.js';
import { COMPILER_VERSION } from './version.js';

export interface CompilerTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface CompileInput {
  readonly message: string;
  readonly creator: string;
  /** Prior turns in this session, oldest first. Empty for a new session. */
  readonly history: readonly CompilerTurn[];
}

export type CompileResult =
  | {
      readonly status: 'COMPILED';
      readonly compilerVersion: string;
      readonly interpretation: string;
      readonly specification: ConditionSpec;
      readonly rulesHash: Bytes32Hex;
      readonly canonical: string;
      /** Verbatim model output, stored as the assistant turn. */
      readonly rawOutput: string;
    }
  | {
      readonly status: 'INCOMPLETE';
      readonly compilerVersion: string;
      readonly interpretation: string;
      readonly questions: readonly CompilerQuestion[];
      readonly missing: readonly FieldIssue[];
      readonly partial: Partial<ConditionSpecInput>;
      readonly rawOutput: string;
    };

export interface ConditionCompilerOptions {
  readonly provider: LLMProvider;
  readonly token: SettlementTokenConfig;
  readonly policy: MarketPolicy;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  /** Injected so tests are deterministic and nothing on this path reads a clock. */
  readonly now: () => Date;
  /**
   * Injected for the same reason. The nonce is what stops two users who approve
   * byte-identical wording from colliding on one `rulesHash` (ADR-0006).
   */
  readonly nonce: () => string;
}

export class ConditionCompiler {
  constructor(private readonly options: ConditionCompilerOptions) {}

  get version(): string {
    return COMPILER_VERSION;
  }

  async compile(input: CompileInput): Promise<CompileResult> {
    const now = this.options.now();
    const output = await this.callModel(input, now);

    if (output.status === 'INCOMPLETE' || output.condition === null) {
      return this.incomplete(output, output.questions, output.condition);
    }

    // The model produced a condition. The system supplies everything else.
    const assembled = assembleConditionSpec(output.condition, {
      creator: input.creator,
      nonce: this.options.nonce(),
      token: this.options.token,
      policy: this.options.policy,
      now,
    });

    if (!assembled.ok) {
      // A model-produced deadline that is unparseable, past, or too near is a
      // question for the user, not a server error.
      return this.incomplete(output, assembled.problems, output.condition);
    }

    // The shared schema is the second gate. A draft that satisfies the model's
    // output contract can still fail here (a non-https source, a failure
    // condition identical to the success condition), and that is an incomplete
    // specification, not a crash.
    const validated = validateConditionSpec(assembled.spec);
    if (!validated.ok) {
      return this.incompleteFromIssues(output, validated.issues, assembled.spec);
    }

    const commitment = buildRulesCommitment(validated.value);
    return {
      status: 'COMPILED',
      compilerVersion: COMPILER_VERSION,
      interpretation: output.interpretation,
      specification: commitment.spec,
      rulesHash: commitment.rulesHash,
      canonical: commitment.canonical,
      rawOutput: JSON.stringify(output),
    };
  }

  // -------------------------------------------------------------------------

  private async callModel(input: CompileInput, now: Date): Promise<CompilerOutput> {
    const messages = [
      ...input.history.map((turn) => ({ role: turn.role, content: turn.content })),
      { role: 'user' as const, content: input.message },
    ];

    let text: string;
    try {
      const response = await this.options.provider.complete({
        system: `${COMPILER_SYSTEM_PROMPT}\n\n${buildContextBlock(now)}`,
        messages,
        maxOutputTokens: this.options.maxOutputTokens,
        timeoutMs: this.options.timeoutMs,
        jsonSchema: { name: 'compiler_output', schema: compilerOutputJsonSchema },
      });

      if (response.stopReason === 'max_output_tokens') {
        // Truncated JSON would parse as malformed anyway, but saying why is
        // more useful than a generic parse failure.
        throw new CompilerOutputError(
          'The compiler response was cut off before it was complete.',
          [{ path: '', message: 'model output exceeded the token budget' }],
        );
      }
      text = response.text;
    } catch (cause) {
      throw translateProviderFailure(cause);
    }

    return parseCompilerOutput(text);
  }

  private incomplete(
    output: CompilerOutput,
    problems: readonly { field: string; question: string; why: string }[],
    draft: ConditionDraft | null,
  ): CompileResult {
    const questions: CompilerQuestion[] = problems.map((problem) => ({
      field: problem.field,
      question: problem.question,
      why: problem.why,
    }));

    return {
      status: 'INCOMPLETE',
      compilerVersion: COMPILER_VERSION,
      interpretation: output.interpretation,
      questions,
      missing: questions.map((question) => ({
        path: question.field,
        message: question.why,
      })),
      partial: toPartialSpec(draft),
      rawOutput: JSON.stringify(output),
    };
  }

  private incompleteFromIssues(
    output: CompilerOutput,
    issues: readonly FieldIssue[],
    partial: ConditionSpecInput,
  ): CompileResult {
    return {
      status: 'INCOMPLETE',
      compilerVersion: COMPILER_VERSION,
      interpretation: output.interpretation,
      questions: issues.map((issue) => ({
        field: issue.path,
        question: `The compiled condition is not usable yet: ${issue.message}. Could you clarify this part?`,
        why: issue.message,
      })),
      missing: issues,
      partial,
      rawOutput: JSON.stringify(output),
    };
  }
}

/**
 * Parse and validate raw model text.
 *
 * Exported for direct testing: this is the function standing between a model
 * and the hashing pipeline, and it should be exercised against garbage
 * directly rather than only through the compiler.
 *
 * @throws {CompilerOutputError} on anything that is not a valid compiler output.
 */
export function parseCompilerOutput(text: string): CompilerOutput {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CompilerOutputError('The compiler returned output that is not valid JSON.', [
      { path: '', message: 'response body did not parse as JSON' },
    ]);
  }

  const parsed = compilerOutputSchema.safeParse(json);
  if (!parsed.success) {
    throw new CompilerOutputError(
      'The compiler returned output that does not match the expected shape.',
      parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return parsed.data;
}

/** Whatever the model did manage to extract, for the user to complete. */
function toPartialSpec(draft: ConditionDraft | null): Partial<ConditionSpecInput> {
  if (draft === null) return {};
  return {
    question: draft.question,
    conditionType: draft.conditionType,
    successCondition: draft.successCondition,
    failureCondition: draft.failureCondition,
    deadline: draft.deadline,
    timezone: draft.timezone,
    resolutionMethod: draft.resolutionMethod,
    approvedSources: draft.approvedSources,
    evidenceRequirements: draft.evidenceRequirements,
    ambiguities: draft.ambiguities,
    edgeCases: draft.edgeCases,
    risk: draft.risk,
  };
}

/** Map a provider failure onto the backend error model. */
function translateProviderFailure(cause: unknown): unknown {
  if (!(cause instanceof LLMProviderError)) return cause;

  switch (cause.kind) {
    case 'timeout':
      return new LlmTimeoutError('The condition compiler timed out. Please try again.');
    case 'refused':
      return new LlmRefusedError('The compiler declined to process this request.');
    case 'rate_limited':
    case 'unavailable':
    case 'auth':
      // `auth` is folded in on purpose: a misconfigured key is an operator
      // problem, and telling a client that our credentials are wrong is both
      // useless to them and an information leak.
      return new LlmUnavailableError('The condition compiler is temporarily unavailable.');
    case 'invalid_request':
    case 'unknown':
    default:
      return new CompilerOutputError('The condition compiler could not process this request.');
  }
}
