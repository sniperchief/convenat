# The AI condition compiler

How a sentence becomes an enforceable, hashable condition — and, more often, how
it correctly fails to.

Implementation: [`apps/backend/src/compiler`](../apps/backend/src/compiler/).
The hashing it depends on: [docs/canonical-specification.md](canonical-specification.md).

> This document covers **compilation** (Milestone 3). The evidence package model and
> `evidenceHash` are Milestone 5.1 and are documented in
> [docs/ai-resolution.md](ai-resolution.md). Source retrieval, the deterministic validator
> implementations and on-chain submission are M5.2 onward and are not built.

---

## 1. What the compiler is for

Smart contracts execute deterministic conditions. People write conditions like *"pay the
supplier if the shipment arrives before September 1"*. The gap between those two is
interpretation, and interpretation is where money gets lost.

The compiler closes that gap by producing a specification precise enough that **two
independent reviewers, reading only the specification and its approved sources, would
reach the same outcome**. That sentence is the compiler's actual test, and it is in the
system prompt verbatim.

**The most important thing the compiler does is decline.** A model asked to turn a vague
sentence into a precise contract will, by default, fill the gaps plausibly. A plausible
guess is the worst available outcome: it produces a specification that *looks*
enforceable, gets approved by a user skimming it, and cannot be resolved once money is on
it. Every design decision below exists to make declining the easy path.

---

## 2. The pipeline

```
user message + session history
   │
   ▼  LLMProvider.complete()  — structured output, provider-agnostic
raw model text
   │
   ▼  Zod parse of the compiler output contract          ── GATE 1
CompilerOutput { status, interpretation, questions, condition }
   │
   ├── status INCOMPLETE, or condition null ──▶ return questions. Stop.
   │
   ▼  assemble: add version, nonce, creator, settlement   ── system, not model
ConditionSpecInput
   │
   ▼  validateConditionSpec()  (@covenant/shared)         ── GATE 2
   │       fails ──▶ return questions. Stop.
   ▼
   canonicalise + keccak256  (@covenant/shared)
   │
   ▼  persist compilation
COMPILED { specification, rulesHash, canonical }
```

Two paths that do not exist, by construction:

- **LLM → chain.** Nothing in the compiler signs, sends, or reads a transaction.
- **LLM → financial state.** A compiled specification is a *draft*. It becomes binding
  only when a user approves it and their own wallet commits the hash (ADR-0006).

---

## 3. The two gates

**Gate 1 — the output contract.** The model's response is parsed by a Zod schema before
anything else touches it. A provider-side JSON schema is also sent, but that is a
generation *aid*: a truncated response, a provider that ignores the constraint, or prose
wrapped around the JSON all produce output that satisfies nothing. Only the Zod parse is
load-bearing.

The schema is `.strict()`, so unknown keys are **rejected, not stripped**. A model that
invents a `rulesHash`, a `confidence`, an `outcome`, or a `settlement` block has
misunderstood its role, and that is worth failing loudly over — silently dropping the field
would hide the misunderstanding until it mattered.

**Gate 2 — the specification schema.** A draft that satisfies the output contract can
still fail the real `ConditionSpec` schema: a non-https source, a failure condition that
merely restates the success condition, a bad address. That is an *incomplete
specification*, not a server error, so it returns questions rather than a 500.

---

## 4. What the model produces, and what it must not

The model produces a **condition draft** — the substance of the agreement:

```
question, conditionType, successCondition, failureCondition,
deadline, timezone, resolutionMethod,
approvedSources[], evidenceRequirements[], ambiguities[], edgeCases[], risk
```

The **system** supplies everything else:

| Field | Source | Why not the model |
| --- | --- | --- |
| `version` | protocol constant | Not a judgement |
| `nonce` | CSPRNG at compile time | A model-chosen salt is not a salt |
| `creator` | the authenticated request | The model does not know who is asking |
| `settlement.token` | operator config, from the deployment manifest | A model inventing a token address is the archetypal hallucination |
| `settlement.tradingEndsAt` | `deadline − policy lead` | Arithmetic, not judgement |
| `challengeWindowSeconds`, `challengeBondBaseUnits`, `resolutionDeadlineSeconds` | operator policy | **A model has no business setting economic terms.** These sit inside the hash a user approves |

This split is the compiler's single most important structural decision. A model that can
choose the bond size can put invented economics inside a commitment a user is asked to
sign.

---

## 5. Approved sources are ordered

`approvedSources` is a precedence list: index 0 is primary, later entries are fallbacks in
priority order (ADR-0008). The compiler **preserves the model's order exactly** and never
sorts it. Reordering the list changes which source decides the outcome, so it changes the
agreement — and it changes the `rulesHash`, which a test asserts directly.

The prompt states this, and the assembly step passes the array through untouched.

---

## 6. INCOMPLETE is a product state, not an error

`POST /api/markets/compile` returns **HTTP 200** with `status: "INCOMPLETE"`. It is not a
4xx: the user did nothing wrong, and the compiler correctly declining to invent a deadline
is the system working.

The response carries:

- `questions[]` — `{ field, question, why }`, ordered, each answerable by a person
- `missing[]` — the same information as field-anchored issues, for programmatic use
- `partial` — whatever the model *did* extract, so the UI can pre-fill
- `interpretation` — the compiler's reading, in plain language

Compilation is conversational because clarification is the point. A `sessionId` carries the
exchange, and the next message is compiled with the full history in context.

### Three sources of INCOMPLETE

1. **The model asks.** The condition is subjective, or a required fact is missing.
2. **Assembly refuses.** The model produced a deadline that is unparseable, already past,
   or so near that funding would close before anyone could stake. These are checked
   against an injected clock, not asserted by the model.
3. **The specification schema refuses.** Gate 2 above.

All three surface identically to the user, because to the user they are the same thing: a
question that needs an answer.

---

## 7. Anti-hallucination rules

The system prompt carries thirteen absolute rules, each asserted by a test in
[`adversarial.test.ts`](../apps/backend/test/adversarial.test.ts):

1. Never invent a fact. 2. Never invent or infer a deadline. 3. Never invent a source.
4. Never invent acceptance criteria. 5. Never silently resolve an ambiguity.
6. Ask clarification questions. 7. Keep interpretation separate from the condition.
8. Order approved sources by precedence. 9. Compile only when complete.
10. Never calculate a rules hash. 11. Never claim the chain verified anything.
12. Never claim evidence was verified. 13. Never decide the outcome.

Rules 10–13 exist because a language model will happily narrate work it did not do. The
compiler has seen no evidence, touched no chain, and decided nothing; a sentence claiming
otherwise would be believed.

### Ambiguity is recorded, not resolved

Where a reading has to be chosen, it goes in `ambiguities[]` as
`{ description, assumption }` — and that array is **inside the hash**. A user approving the
rules approves the reading too, and the reading cannot be quietly changed afterwards.

`interpretation`, by contrast, is *outside* the hash. It is the compiler's commentary for
the review screen, and it is deliberately not part of the agreement.

---

## 8. Conditions that do and do not compile

The difference is never the topic. It is whether a threshold, a named source, and an
instant are all present.

| Will not compile | Missing |
| --- | --- |
| "Pay me if ETH does well." | Definition, threshold, source, deadline |
| "Was the launch successful?" | Definition of successful |
| "Did John do a good job?" | Criteria, assessor |
| "Pay me if the customer is happy." | Measurement |
| "Pay me if ETH reaches $5,000." | Deadline, source |
| "I'll pay Sarah if she finishes the project next month." | Exact date, completion criteria, verifier |

| Can compile | Because |
| --- | --- |
| "Did the repository have ≥20 merged PRs by 2026-09-01 00:00 UTC?" | Number, source, instant |
| "Did the official API report BTC above $100,000 at 2026-09-01 00:00 UTC?" | Number, named source, instant |
| "Did the signed acceptance form record a rating of at least 4/5?" | Threshold, named artefact |

---

## 9. The provider boundary

```
compiler ──▶ LLMProvider ──┬──▶ AnthropicLLMProvider   (production)
                           └──▶ FakeLLMProvider        (tests, local dev)
```

No Anthropic type, error class, or field name is visible above the provider — verified by a
sweep asserting the SDK is imported in exactly one file. That is what makes the fake a
complete substitute rather than an approximation, and why **the entire test suite runs with
no network, no API key, and no database**.

Provider failures are normalised to a `kind` (`timeout`, `rate_limited`, `unavailable`,
`auth`, `invalid_request`, `refused`, `unknown`) and mapped onto HTTP:

| Failure | HTTP | Reasoning |
| --- | --- | --- |
| Malformed output | 502 | The caller did nothing wrong; an upstream dependency misbehaved |
| Timeout | 504 | |
| Rate limited / unavailable / **auth** | 503 | `auth` is folded in deliberately: a bad key is an operator problem, and confirming key validity to a client is an information leak |
| Model refusal | 422 | A real outcome, distinct from an outage |

Three details the Anthropic adapter gets right because they are easy to get wrong:

- **Structured output, not prefill.** Assistant-turn prefill — the old way to force JSON —
  returns a 400 on current models.
- **`stop_reason` is checked before `content` is read.** A refusal returns HTTP 200 with an
  empty or partial content array; code that indexes `content[0]` first would crash, or
  worse, treat a refusal as an answer.
- **No retry loop of our own.** The SDK already retries 429 and 5xx with backoff. Wrapping
  that in another loop multiplies attempts and turns a rate limit into a retry storm.

---

## 10. Compiler versioning

`COMPILER_VERSION` is recorded on every session and every stored compilation, because the
same input under a different version can produce a different specification — and therefore
a different `rulesHash`.

| Bump | When |
| --- | --- |
| major | The output contract changed shape |
| minor | **The system prompt changed in a way that can change a specification.** Prompt edits are not cosmetic |
| patch | Cannot affect output — a comment, a refactor, an error's wording |

---

## 11. What the compiler cannot do

Stated plainly, because absent capabilities are easy to assume:

- It cannot resolve a condition. There is no `/decide` endpoint and no code path from a
  model to an outcome.
- It cannot create a market on-chain. The creator's own wallet does that.
- It cannot move, hold, or reference funds.
- It cannot produce a hash. `@covenant/shared` does, from the validated document.
- It cannot see evidence. At compile time none exists.
