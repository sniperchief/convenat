# ADR-0011: The compile endpoint is conversational

**Status:** Accepted — 2026-08-17
**Amends:** the `CompileMarketRequest` / `CompileMarketResponse` types in `@covenant/shared`

## Context

Milestone 1 sketched the compile contract before the compiler existed:

```ts
CompileMarketRequest  { prompt, creator, chainId }
CompileMarketResponse = { status: 'COMPILED', specification, rulesHash, canonical }
                      | { status: 'INCOMPLETE', missing, partial }
```

Building the compiler showed that shape cannot express what the product actually does.
`INCOMPLETE` is the common outcome, not the exception — most real conditions are
under-specified on the first attempt — and the useful response to one is a *question a
person can answer*, not a list of failed field paths. A user told
`missing: [{ path: 'deadline' }]` has to guess what to type next.

Worse, the single-shot shape gave the answer nowhere to go. Answering "2026-09-01 00:00
UTC" as a fresh `prompt` discards the condition the user already described, so either the
client reassembles the whole prompt itself — duplicating the compiler's understanding on
the client — or the exchange cannot happen at all.

## Decision

The contract becomes conversational.

- `prompt` becomes `message`, and an optional `sessionId` continues an existing
  compilation. The server holds the transcript and replays it as model context.
- Every response carries `sessionId`, `compilerVersion`, and `interpretation`.
- `INCOMPLETE` gains `questions[]` — `{ field, question, why }` — alongside the existing
  `missing[]` and `partial`.

`missing` and `partial` are kept rather than replaced: `questions` is for a person,
`missing` is for a client that wants to highlight fields, and `partial` pre-fills a form.

Three fields are added to every response because each answers a question the previous
shape left unanswerable:

- **`sessionId`** — where the next message goes.
- **`compilerVersion`** — the same input under a different version can produce a different
  specification, and therefore a different `rulesHash`. Without it, a compilation that no
  longer reproduces is indistinguishable from one that was never produced that way.
- **`interpretation`** — the compiler's reading in plain language, kept deliberately
  *outside* the hashed specification. Interpretation is never silently promoted to fact;
  where a reading actually binds the agreement it goes in `ambiguities[]`, which *is*
  inside the hash.

## Consequences

- **No hash is affected.** `ConditionSpec` is untouched, the canonicalisation rules are
  untouched, and the golden vectors still pass unchanged. This is a transport contract,
  not the protocol.
- The frontend gains a conversation, not a form that rejects. That is the difference
  between a compiler a person can use and one that says "invalid" until they guess the
  right phrasing.
- Transcripts are persisted (`compiler_sessions`, `compiler_turns`), so a compilation can
  be explained after the fact: which prompt, which clarifications, which version. They
  contain user prose, so they inherit the same handling posture as request logs.
- A session belongs to one wallet. Continuing someone else's is rejected — not as a
  permission system (there is no authentication yet) but because merging two users'
  conversations would corrupt the history for both.
