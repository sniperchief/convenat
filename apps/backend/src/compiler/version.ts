/**
 * Compiler version.
 *
 * The same natural-language input under a different compiler version can
 * produce a different `ConditionSpec`, and therefore a different `rulesHash`.
 * Recording the version alongside every compilation is what makes a past
 * compilation explicable later — without it, a specification that no longer
 * reproduces is indistinguishable from one that was never produced that way.
 *
 * `major.minor.patch`, bumped by what changed:
 *
 * - **major** — the output contract changed shape.
 * - **minor** — the system prompt changed in a way that can change a
 *   specification for the same input. Prompt edits are not cosmetic here.
 * - **patch** — changes that cannot affect output (wording of an error, a
 *   comment, a refactor).
 */
export const COMPILER_VERSION = '1.0.0';
