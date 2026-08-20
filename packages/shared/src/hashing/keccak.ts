/**
 * The one place canonical text becomes a protocol hash.
 *
 * Both `rulesHash` and `evidenceHash` route through this function. Keeping the
 * encode-and-hash step single-sourced is what guarantees the two commitments
 * cannot drift apart, and gives one place to look when reproducing a hash in
 * another language.
 *
 * Algorithm: keccak256 over the UTF-8 bytes of the canonical JSON string. This
 * is Ethereum's keccak256 (as used by Solidity's `keccak256`), *not* NIST
 * SHA3-256 and not SHA-256 — a verifier using the wrong primitive will produce
 * a different digest for identical input.
 */

import { keccak256 } from 'viem';
import type { Hex } from 'viem';

import { HashingError } from '../errors.js';

/** A 0x-prefixed, lowercase, 32-byte hex digest. */
export type Bytes32Hex = Hex;

/** True if `value` is a well-formed lowercase bytes32 hex string. */
export function isBytes32Hex(value: unknown): value is Bytes32Hex {
  return typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value);
}

/**
 * The single keccak256 invocation in this repository.
 *
 * Both public helpers below route through it, which is what guarantees the two
 * commitments cannot drift apart and gives one place to look when reproducing a
 * digest in another language.
 */
function digestBytes(bytes: Uint8Array, what: string): Bytes32Hex {
  let digest: Hex;
  try {
    digest = keccak256(bytes);
  } catch (cause) {
    throw new HashingError(
      `Failed to hash ${what}: ${cause instanceof Error ? cause.message : 'unknown error'}`,
    );
  }

  if (!isBytes32Hex(digest)) {
    throw new HashingError('keccak256 returned a value that is not a 32-byte hex string');
  }
  return digest;
}

/**
 * keccak256 over the UTF-8 encoding of `canonical`.
 *
 * @throws {HashingError} if encoding or hashing fails, or if the digest is not
 * a well-formed bytes32 — the output is checked rather than assumed, because
 * every downstream consumer treats it as a Solidity `bytes32`.
 */
export function hashCanonicalText(canonical: string): Bytes32Hex {
  return digestBytes(new TextEncoder().encode(canonical), 'canonical representation');
}

/**
 * keccak256 over raw retrieved bytes — the `contentHash` of an evidence source.
 *
 * Separate from `hashCanonicalText` because the input is *not* canonicalised and
 * must not be: it is exactly what a source returned, byte for byte, so anyone
 * holding the same response reproduces the same digest. Decoding it to text
 * first would put a charset guess between the bytes and the commitment.
 *
 * The caller is responsible for these being the **complete** bytes. Hashing a
 * truncated body while calling the result the hash of the response would be a
 * quiet lie; the retrieval layer therefore rejects an oversized response rather
 * than trimming it.
 *
 * @throws {HashingError} if hashing fails or the digest is malformed.
 */
export function hashContentBytes(bytes: Uint8Array): Bytes32Hex {
  return digestBytes(bytes, 'retrieved content');
}
