# ADR-0017 — The validation plan is stored per market, outside `rulesHash`

**Status:** accepted (M5.5–M5.7)
**Refines:** ADR-0008 (canonical hashing), ADR-0016 (the model concurs, it does not choose)

## Context

M5.3 found a defect in the frozen schema and recorded it: `resolutionMethod` has a
member `deterministic_numeric_threshold`, documented as *"a number from an approved
source compared against a fixed threshold"* — and **`ConditionSpec` v1.0 has nowhere
to put that threshold.** The only machine-readable criteria in the whole document are
`deadline` and `edgeCases[].outcome`. The number, the operator and the expected status
all live in `successCondition`, which is prose.

M5.3 answered this with a `ValidationPlan`: an explicit, validated, separately-supplied
document carrying the checks. It was passed as a function argument, because M5.3 had no
persistence and no API.

M5.5–M5.7 need the plan to survive between the moment a market is created and the
moment it is resolved, which may be days later and is certainly a different process.
That forces the question M5.3 could defer: **where does the plan live?**

## Decision

**A nullable `validation_plan` jsonb column on `markets`.**

1. **Supplied by the creator**, either alongside the specification at
   `POST /api/markets`, or afterwards at `POST /api/markets/:id/validation-plan`. Both
   require the authenticated wallet to be the specification's `creator`.
2. **Validated at write time** by `validateValidationPlan`, and again on **every read**.
   A plan that was valid under an earlier build and is not valid under this one produces
   `NEEDS_REVIEW`, not a best-effort interpretation.
3. **Every referenced source must be one this specification approved.** The route checks
   each `observation.sourceId` against `approvedSources.length` before storing.
4. **A market with no plan resolves to `NEEDS_REVIEW`**, with reason
   `NO_VALIDATION_PLAN`. It never falls back to asking the model for a threshold.

## What this weakens, stated plainly

**The numeric criteria a market settles on are operator-and-creator supplied rather than
hash-committed.** A user approving a `rulesHash` is not approving the threshold their
money turns on. That is a real weakening and it is not dressed up as anything else.

Four constraints bound the damage:

- **A plan may only reference approved sources.** It cannot widen the evidence policy
  that `approvedSources` exists to fix.
- **A deadline comparison may only use `spec_deadline`.** The schema has no
  literal-instant variant at all, so an unhashed plan *cannot* substitute a deadline for
  the one inside `rulesHash` — the single most valuable thing an attacker could change.
  A test asserts the attempt is rejected.
- **The model reads both condition texts independently** and must concur with the
  outcome the checks establish (ADR-0016). A mis-set plan — including a mis-set
  `encodes` — therefore produces a review rather than an inverted payout.
- **Only the creator may set it**, and the creator is a proved wallet (ADR-0014), not an
  address in a request body.

## Alternatives rejected

**Extract the threshold from `successCondition` with a regex.** This invents acceptance
criteria from prose. It works on the fixtures and fails on the first market phrased
differently, and its failure mode is a confidently wrong number inside settlement
arithmetic.

**Ask a model for the threshold.** Forbidden by ADR-0016 and wrong regardless: it puts a
model-chosen number inside the comparison that settles a market, which is the exact
inversion of what the deterministic layer is for.

**Put the plan in the `EvidencePackage`.** It is already there, as
`deterministicChecks` — the *results*, with `expected` and `observed`, inside
`evidenceHash`. That makes a resolution auditable after the fact, which is valuable and
is not the same thing as making the criteria approvable beforehand.

**Block M5.5 on `ConditionSpec` v1.1.** A schema version is a protocol change: new
golden vectors, a second validator, a migration for every committed hash. That is the
correct eventual answer and it is not a hackathon-week answer.

## Consequence

`ConditionSpec` v1.1 must carry acceptance criteria inside the hash. Until it does, this
is the largest gap between what a user approves and what settles their market, and it is
recorded in BUILD_STATE's security notes rather than only here.
