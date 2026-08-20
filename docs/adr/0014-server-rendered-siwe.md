# ADR-0014: The server renders the sign-in message; the client only signs it

**Status:** Accepted — 2026-08-17

## Context

Through M3 there was no authentication. A `creator` was an address the client asserted in a
request body. Nothing financial depended on it — a market is opened by the creator's own
wallet signing an on-chain transaction (ADR-0006) — but a compiler session could be opened
in another wallet's name, and BUILD_STATE recorded that as an open issue blocking the
frontend.

§30 requires wallet ownership to be proved by signature, and says plainly: *do not invent
cryptography*.

## Decision

Sign-In with Ethereum (EIP-4361), with one deviation from the common implementation shape.

**The usual pattern**: the client composes the message, signs it, and sends both the message
text and the signature. The server parses the message, extracts the nonce, domain, chain id
and address, and verifies.

**What this project does instead**: the server chooses `domain`, `uri`, `chainId`,
`address`, `statement`, `nonce`, `issuedAt` and `expiresAt` when the challenge is issued and
stores all of them. It returns the *rendered* message for the wallet to display. At
verification time the client sends only a nonce and a signature, and the server **rebuilds
the message from its own stored fields**.

The reason is that the usual pattern requires an ABNF parser for a security-critical
grammar, and every field in that message is attacker-controlled until the parser has
finished. Writing one is inventing exactly the kind of thing §30 warns against. Rebuilding
from stored state removes the parser entirely: there is no field a client can vary, because
the client never supplies one. A signature over any message other than the one we issued
recovers a different address and is rejected.

No cryptography is implemented. Recovery is viem's `recoverMessageAddress` — EIP-191
`personal_sign` over secp256k1. This layer formats a string and compares two addresses.

Two details that turned out to matter:

- **Address normalisation happens inside `renderSiweMessage`.** EIP-4361 requires EIP-55
  checksum form, but the operational reason is stronger: the message is rendered twice, once
  at issue and once at verify, and the two renderings must be byte-identical or a wallet
  that did everything right fails to sign in. Normalising at the single point where the
  string is built makes that impossible to get wrong. This was found by a test — an earlier
  version normalised at the call site, worked through the HTTP route (whose schema
  lowercases addresses) and failed when the service was called directly.
- **The nonce is consumed before the signature is checked**, by an `UPDATE … WHERE
  consumed_at IS NULL` that returns the row. A single-use value marked used only after
  successful verification is not single-use: two concurrent replays both observe `null`,
  both verify, and both get a session. Letting the database decide the winner is what makes
  the window actually closed.

## Consequences

- `creator` is gone from the compile request schema. A client still sending it gets a 400
  rather than being silently ignored — a caller that believes it is choosing the creator
  should find out immediately.
- Authorization is a separate concern from authentication, and the split is absolute.
  `assertOwns` decides whose *records* a caller may touch. The chain decides whose *money*
  moves. No session token can cause a transaction; the contracts do not know sessions exist.
  Conflating the two is how a web session ends up able to spend funds.
- Bearer tokens are stored as SHA-256 digests. A dump of `auth_sessions` cannot be used to
  impersonate anyone, for the same reason a password table stores hashes.
- **Externally owned accounts only.** ERC-1271 contract signatures need an on-chain call to
  the claimed signer and are not supported. A contract wallet fails to authenticate rather
  than being silently accepted — which is the correct direction, but it is a real limitation
  to remove before a public frontend.
- `AUTH_DOMAIN` must be the origin actually serving the frontend. That binding is what makes
  a signature captured on one site useless on another, so a misconfigured domain is a
  security defect, not a cosmetic one.
