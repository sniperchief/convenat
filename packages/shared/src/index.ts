/**
 * @covenant/shared — the protocol core.
 *
 * Everything that must be identical across the backend, the frontend and the
 * contract tooling lives here: the condition specification, the canonical byte
 * encoding, and the two protocol hashes. There is exactly one implementation of
 * `rulesHash` and one of `evidenceHash`; no consumer may reimplement either.
 *
 * See docs/canonical-specification.md for the protocol definition and
 * docs/adr/0008-canonical-hashing.md for the reasoning behind it.
 */

export * from './errors.js';

// --- schema -----------------------------------------------------------------
export * from './schema/enums.js';
export * from './schema/primitives.js';
export * from './schema/condition-spec.js';
export * from './schema/evidence-package.js';
export * from './schema/validate.js';

// --- canonicalisation -------------------------------------------------------
export * from './canonical/jcs.js';
export * from './canonical/unordered.js';
export * from './canonical/canonicalize.js';

// --- hashing ----------------------------------------------------------------
export * from './hashing/keccak.js';
export * from './hashing/rules-hash.js';
export * from './hashing/evidence-hash.js';

// --- evidence ---------------------------------------------------------------
export * from './evidence/binding.js';

// --- networks ---------------------------------------------------------------
export * from './chains/xlayer.js';

// --- deployment -------------------------------------------------------------
export * from './deployment/manifest.js';

// --- shared application types ----------------------------------------------
export * from './types/domain.js';
export * from './types/api.js';
