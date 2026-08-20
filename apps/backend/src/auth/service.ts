/**
 * Wallet authentication (§30) and the identity it establishes (§31).
 *
 * What this proves and what it does not
 * ------------------------------------
 * A completed sign-in proves one thing: whoever is holding this session
 * controls the private key for this address. That is enough to stop a client
 * opening a compiler session in someone else's name, or reading someone else's
 * draft — the M3 gap where `creator` was an address the client simply asserted.
 *
 * It is **not** authority over anything on-chain. The contracts do not know this
 * session exists. A market is opened by the creator's own wallet signing a
 * transaction (ADR-0006), a stake moves the staker's own tokens, and no session
 * token here can cause any of that. Authentication decides whose *records* you
 * may touch; the chain decides whose *money* moves. Conflating the two is how a
 * web session ends up able to spend funds, so the split is deliberate and
 * absolute.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { ForbiddenError, UnauthenticatedError } from '../errors.js';
import type { AuthNonceRepository, AuthSessionRepository } from '../repositories/types.js';
import { renderSiweMessage, verifySiweSignature, type SiweChallenge } from './siwe.js';

export interface AuthPolicy {
  /** Domain bound into the message. Must be the origin serving the frontend. */
  readonly domain: string;
  readonly uri: string;
  readonly chainId: number;
  readonly nonceTtlSeconds: number;
  readonly sessionTtlSeconds: number;
}

/** The wallet identity a request is acting as. */
export interface AuthenticatedWallet {
  readonly address: string;
  readonly chainId: number;
  readonly sessionId: string;
  readonly expiresAt: string;
}

const STATEMENT =
  'Sign in to Covenant. This signature proves you control this wallet. ' +
  'It authorises no transaction, moves no funds, and costs no gas.';

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** SHA-256 of a bearer token. Only the digest is ever stored. */
const digest = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

export class AuthService {
  constructor(
    private readonly deps: {
      readonly nonces: AuthNonceRepository;
      readonly sessions: AuthSessionRepository;
      readonly policy: AuthPolicy;
      readonly now: () => Date;
    },
  ) {}

  /**
   * Issue a challenge for `address`.
   *
   * The nonce is bound to the address at issue time. An unbound nonce could be
   * requested by one party and completed by another's signature, which would
   * make the challenge prove nothing about who asked.
   */
  async createChallenge(address: string): Promise<{ message: string; nonce: string; expiresAt: string }> {
    if (!ADDRESS_PATTERN.test(address)) {
      throw new UnauthenticatedError('That is not a valid wallet address.');
    }

    const issuedAt = this.deps.now();
    const expiresAt = new Date(issuedAt.getTime() + this.deps.policy.nonceTtlSeconds * 1000);
    // 16 bytes of CSPRNG output, hex. Guessing one inside its short window is
    // not a threat model anyone needs to reason about at this size.
    const nonce = randomBytes(16).toString('hex');

    // Lowercase is the storage form throughout this backend; `renderSiweMessage`
    // re-checksums it for display. Normalising here rather than trusting the
    // route schema means the service is correct however it is called.
    const identity = address.toLowerCase();

    const challenge: SiweChallenge = {
      domain: this.deps.policy.domain,
      address: identity,
      statement: STATEMENT,
      uri: this.deps.policy.uri,
      chainId: this.deps.policy.chainId,
      nonce,
      issuedAt,
      expiresAt,
    };

    await this.deps.nonces.issue({
      nonce,
      address: identity,
      chainId: challenge.chainId,
      domain: challenge.domain,
      uri: challenge.uri,
      statement: challenge.statement,
      issuedAt,
      expiresAt,
    });

    return {
      message: renderSiweMessage(challenge),
      nonce,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Complete a sign-in.
   *
   * The order matters. The nonce is consumed **before** the signature is
   * checked, by an update conditional on `consumed_at IS NULL`. A single-use
   * value that is only marked used after a successful verification is not
   * single-use: two concurrent replays both pass the check, both verify, and
   * both get a session. Consuming first means the loser of that race finds the
   * nonce already spent.
   */
  async verify(input: { nonce: string; signature: string }): Promise<{
    wallet: AuthenticatedWallet;
    token: string;
  }> {
    const now = this.deps.now();

    const record = await this.deps.nonces.consume(input.nonce, now);
    if (record === null) {
      // Unknown, already used, or expired — one message for all three.
      throw new UnauthenticatedError('The sign-in signature could not be verified.');
    }

    await verifySiweSignature(
      {
        domain: record.domain,
        address: record.address,
        statement: record.statement,
        uri: record.uri,
        chainId: record.chainId,
        nonce: record.nonce,
        issuedAt: new Date(record.issuedAt),
        expiresAt: new Date(record.expiresAt),
      },
      input.signature,
      now,
    );

    // 32 bytes, base64url. Returned to the client once; only its hash is
    // persisted, so this table cannot be used to impersonate anyone.
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + this.deps.policy.sessionTtlSeconds * 1000);

    const session = await this.deps.sessions.create({
      tokenHash: digest(token),
      address: record.address,
      chainId: record.chainId,
      createdAt: now,
      expiresAt,
    });

    return {
      token,
      wallet: {
        address: record.address,
        chainId: record.chainId,
        sessionId: session.id,
        expiresAt: expiresAt.toISOString(),
      },
    };
  }

  /**
   * Resolve a bearer token to a wallet identity.
   *
   * Lookup is by digest, so a token never reaches a query in plaintext. The
   * constant-time comparison afterwards guards the digest itself, which is
   * cheap insurance against a timing oracle on the index probe.
   */
  async authenticate(token: string | null): Promise<AuthenticatedWallet> {
    if (token === null || token.length === 0) {
      throw new UnauthenticatedError('This endpoint requires a signed-in wallet.');
    }

    const hash = digest(token);
    const session = await this.deps.sessions.findByTokenHash(hash);
    if (session === null) {
      throw new UnauthenticatedError('That session is not valid.');
    }

    const expected = Buffer.from(session.tokenHash, 'utf8');
    const actual = Buffer.from(hash, 'utf8');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new UnauthenticatedError('That session is not valid.');
    }

    const now = this.deps.now();
    if (session.revokedAt !== null || new Date(session.expiresAt) <= now) {
      throw new UnauthenticatedError('That session has expired. Sign in again.');
    }

    return {
      address: session.address,
      chainId: session.chainId,
      sessionId: session.id,
      expiresAt: session.expiresAt,
    };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.deps.sessions.revoke(sessionId, this.deps.now());
  }
}

/**
 * Assert that the authenticated wallet is the one that owns `owner`.
 *
 * The single place ownership is decided (§31), so "can this caller touch this
 * record" has one answer rather than one per route.
 *
 * @throws {ForbiddenError} — a 403, not a 404. The caller has proved who they
 *   are; telling them this resource belongs to someone else reveals nothing they
 *   could not learn from the chain, and a 404 here would send an honest user
 *   hunting for a record that does exist.
 */
export function assertOwns(wallet: AuthenticatedWallet, owner: string, what: string): void {
  if (wallet.address.toLowerCase() !== owner.toLowerCase()) {
    throw new ForbiddenError(`That ${what} belongs to a different wallet.`);
  }
}

/** Extract a bearer token from an Authorization header. */
export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match?.[1] ?? null;
}
