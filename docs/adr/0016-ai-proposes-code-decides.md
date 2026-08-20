# ADR-0016: The model concurs in an outcome, it does not choose one

**Status:** Accepted — 2026-08-20
**Refines:** [ADR-0015](0015-evidence-package-v2.md)
**Applies to:** Milestone 5.4

## Context

M5.1 built the evidence package, M5.2 the retrieval layer, M5.3 the deterministic
validators. Each stopped short of saying what the evidence *meant*. M5.4 is where a
language model finally enters the resolution path, and the question this record settles is
narrow and load-bearing:

> When the model's reading and the deterministic checks disagree, which one decides?

Everything else in the milestone follows from the answer.

The tempting design is the obvious one: give the model the specification, the evidence and
the checks, and let it return an outcome. It is the design most systems in this space use,
it is simple, and on almost every input it produces the right answer. The failure mode is
the problem. A model asked to resolve a financial condition does not fail loudly — it
fails *plausibly*, returning a confident, well-reasoned, wrong outcome that is
indistinguishable in shape from the thousands of correct ones. There is no downstream check
that catches it, because it looks exactly like success.

Two further pressures make that worse here than in a typical application:

1. **The evidence is attacker-controlled.** It is the body of a document at a URL somebody
   else operates. Prompt injection is not a hypothetical risk to be monitored; it is a
   guaranteed eventual input.
2. **The output is financial.** A wrong `YES` moves money between parties who cannot get it
   back, and the challenge window is the only recourse.

## Decision

**The deterministic checks decide the outcome. The model may confirm it or withhold it, and
can do nothing else.**

Concretely, an outcome is proposed only when three independent readings agree:

| Reading | Produced by | Can it *set* an outcome? | Can it *stop* one? |
| --- | --- | --- | --- |
| The deterministic verdict, mapped through `plan.encodes` | Code, from retrieved bytes | Yes — this is the authority | Yes |
| The model's reading of `successCondition` and `failureCondition` | The model | **No** | Yes |
| A matched `edgeCases[]` entry | The user, at approval time; matched by the model | Only toward `INVALID` | Yes |

Anything less than agreement is `NEEDS_REVIEW`. Four consequences worth stating explicitly,
because each is a place where a more permissive design was available:

**The model cannot flip an outcome.** If the checks establish `YES` and the model says
`RESOLVED_NO`, the result is not `NO` and it is not `YES` — it is `NEEDS_REVIEW`. The
disagreement means one of the two readings is wrong, and finding out which is a person's
job. This is the asymmetry the whole design rests on: a compromised or mistaken model can
cost us liveness, never correctness.

**The model has no `INVALID` in its vocabulary.** `RESOLVED_YES | RESOLVED_NO |
NEEDS_REVIEW`, and nothing else. `INVALID` routes to refunds and is a determination the
user pre-approved in `edgeCases[].outcome`; it can only arrive that way.

**A matched edge case may only make the proposal more conservative.** `edgeCases[].outcome`
is genuinely inside the hash and genuinely user-approved — but *which* case matches is a
prose judgement made by a model reading hostile content. If a matched edge case could carry
`YES`, a source that persuaded the model "this is edge case 2" could settle a market
against the checks. So a matched edge case that agrees with the checks confirms them, one
that says `INVALID` is honoured (refunds take money from nobody), and one that would flip a
settlement produces `NEEDS_REVIEW`.

**Every factual claim must be traceable to retrieved bytes.** A claim citing a source that
produced no content, or carrying a value that appears in no cited source, fails the
semantic gate and the whole proposal becomes `NEEDS_REVIEW` — not just that claim. A model
that fabricated one fact has not demonstrated anything about the others.

### The corollary: `plan.encodes`

Mapping a verdict onto an outcome requires knowing which of the two conditions the checks
were written to test. `SATISFIED` on checks written against the *failure* condition means
`NO`. `ConditionSpec` v1.0 cannot express this, for the same reason it cannot express a
threshold ([§22](../ai-resolution.md#22-the-problem-conditionspec-v10-cannot-express-a-threshold)),
so it is carried on the unhashed `ValidationPlan` as `encodes`.

State the weakness plainly: like the thresholds, this is **operator-supplied, not
user-approved**. What keeps a mis-set `encodes` from inverting a payout is precisely the
concurrence rule above — the model reads both condition texts independently, disagrees, and
the resolution goes to review rather than to the wrong party.

## Consequences

**What this buys.** No single failure — a hallucination, a successful prompt injection, a
mis-set operator field, a model that is simply wrong — can produce a settlement. Each of
them produces a review. The system's worst realistic outcome under adversarial input is
that it stops resolving, which is a liveness problem with an existing remedy: the
resolution deadline lets anyone cancel a market into full refunds.

**What it costs.** Markets that a human would settle without hesitation will land in review
— an ambiguous phrase, a source that changed its status vocabulary, a plan that does not
cover the case that actually occurred. This is a real operational cost and it will be the
most visible property of the system in practice. It is the intended trade: `NEEDS_REVIEW`
is recoverable and a wrong settlement is not.

**What it does not address.** The model is still the component that decides *whether the
evidence matches an edge case scenario* and *whether the deterministic reading is a fair
reading of the prose*. Those are judgements, they are why a model is here at all, and no
amount of gating removes them. What the gating does is bound their blast radius to
withholding a resolution.

**Rejected: a confidence threshold as the safety mechanism.** Confidence is recorded and is
a floor for proposing at all, but it decides nothing. A model that is wrong is typically
also confident, so a threshold filters the cases that were already going to be fine and
passes the ones that are not. The contract has no confidence parameter for exactly this
reason.

**Rejected: a second model checking the first.** It moves the trust rather than removing
it, doubles the injection surface, and shares failure modes with the model it is checking.

**Revisit when** `ConditionSpec` v1.1 carries validation criteria inside the hash. At that
point `encodes` and the thresholds become part of what the user approved, and the
deterministic authority in the table above stops resting on an operator input.
