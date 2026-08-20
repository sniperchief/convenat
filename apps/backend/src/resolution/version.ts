/**
 * Resolver version.
 *
 * Recorded inside every evidence package as `resolver.version`, and therefore
 * inside `evidenceHash`. The same evidence under a different resolver version
 * can produce a different proposal, so a package that no longer reproduces has
 * to be distinguishable from one that was never produced that way.
 *
 * `major.minor.patch`, bumped by what changed:
 *
 * - **major** — the model output contract changed shape.
 * - **minor** — the system prompt, the semantic gate, or the outcome mapping
 *   changed in a way that can change a proposal for the same evidence. A prompt
 *   edit here is a minor bump, never a tweak.
 * - **patch** — changes that cannot affect a proposal (comments, refactors,
 *   error wording that is not fed to the model).
 */
export const RESOLVER_VERSION = '1.0.0';
