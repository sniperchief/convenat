/**
 * Sign-In with Ethereum (EIP-4361) message construction and verification.
 *
 * **The backend builds the message; the client only signs it.**
 *
 * The usual shape of this protocol has the client send back the full message
 * text alongside the signature, and the server parse it. That requires an ABNF
 * parser, and every field in it is attacker-controlled until the parser has
 * finished — a class of bug this project has no reason to take on. Here the
 * server stores `domain`, `uri`, `chainId`, `address`, `statement`, `nonce` and
 * both timestamps when it issues the challenge, returns the rendered message for
 * the wallet to display, and at verification time **rebuilds the message from
 * its own stored fields**. The client sends a nonce and a signature and nothing
 * else that matters.
 *
 * The consequence is worth stating plainly: a signature over any message other
 * than the one we issued recovers a different address, and is rejected. There is
 * no field a client can vary.
 *
 * No cryptography is implemented here. Recovery is viem's
 * `recoverMessageAddress`, which is EIP-191 `personal_sign` recovery over
 * secp256k1. This module formats a string and compares two addresses.
 *
 * Scope: **externally owned accounts only.** ERC-1271 contract signatures need
 * an on-chain call to the claimed signer and are not supported in M4; a contract
 * wallet will simply fail to authenticate rather than be silently accepted.
 */

import { getAddress, recoverMessageAddress } from 'viem';

import { UnauthenticatedError } from '../errors.js';

/** The fields that, together, are the message. All server-chosen. */
export interface SiweChallenge {
  readonly domain: string;
  readonly address: string;
  readonly statement: string;
  readonly uri: string;
  readonly chainId: number;
  readonly nonce: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

/**
 * Render an EIP-4361 message.
 *
 * The layout — including the blank lines, which are significant — follows the
 * specification exactly, because a wallet renders this text to a human and a
 * malformed one either fails to display or displays something the user did not
 * agree to.
 *
 * **The address is normalised to EIP-55 checksum form here, not by the caller.**
 * The specification requires checksum form, but the reason it happens in this
 * function is stricter than conformance: this message is rendered twice — once
 * when the challenge is issued and once when the signature is checked — and the
 * two renderings must be byte-identical or verification fails for a wallet that
 * did nothing wrong. Normalising at the single point where the string is built
 * makes that impossible to get wrong, whereas normalising at each call site is
 * a rule someone will eventually miss.
 */
export function renderSiweMessage(challenge: SiweChallenge): string {
  return [
    `${challenge.domain} wants you to sign in with your Ethereum account:`,
    getAddress(challenge.address),
    '',
    challenge.statement,
    '',
    `URI: ${challenge.uri}`,
    'Version: 1',
    `Chain ID: ${challenge.chainId}`,
    `Nonce: ${challenge.nonce}`,
    `Issued At: ${challenge.issuedAt.toISOString()}`,
    `Expiration Time: ${challenge.expiresAt.toISOString()}`,
  ].join('\n');
}

const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;

/**
 * Check that `signature` is this challenge's address signing this challenge.
 *
 * Expiry is checked here rather than only at the database, so a stored nonce
 * that outlives its window cannot be used even if a cleanup job has not run.
 *
 * @throws {UnauthenticatedError} on a malformed signature, an expired
 *   challenge, or a signature by any other key. The message never says which —
 *   distinguishing "wrong signer" from "expired" tells an attacker which half of
 *   their guess was right.
 */
export async function verifySiweSignature(
  challenge: SiweChallenge,
  signature: string,
  now: Date,
): Promise<void> {
  if (!SIGNATURE_PATTERN.test(signature)) {
    throw new UnauthenticatedError('The sign-in signature could not be verified.');
  }
  if (now >= challenge.expiresAt) {
    throw new UnauthenticatedError('The sign-in signature could not be verified.');
  }
  if (now < challenge.issuedAt) {
    // A clock that runs backwards across a restart would otherwise accept a
    // challenge before it was issued.
    throw new UnauthenticatedError('The sign-in signature could not be verified.');
  }

  const message = renderSiweMessage(challenge);

  let recovered: string;
  try {
    recovered = await recoverMessageAddress({ message, signature: signature as `0x${string}` });
  } catch {
    throw new UnauthenticatedError('The sign-in signature could not be verified.');
  }

  if (recovered.toLowerCase() !== challenge.address.toLowerCase()) {
    throw new UnauthenticatedError('The sign-in signature could not be verified.');
  }
}
