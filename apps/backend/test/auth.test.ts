/**
 * Wallet authentication and authorization (§30, §31).
 *
 * Every signature here is a real secp256k1 signature produced by a real viem
 * account over the exact message the server rendered. Nothing is stubbed. A test
 * suite that mocked the verifier would pass just as happily against a verifier
 * that accepted everything, which is the one outcome that matters.
 */

import { describe, expect, it } from 'vitest';

import { AuthService } from '../src/auth/service.js';
import { renderSiweMessage } from '../src/auth/siwe.js';
import { createInMemoryRepositories } from '../src/repositories/memory.js';
import {
  CREATOR,
  CREATOR_ACCOUNT,
  OTHER_ACCOUNT,
  OTHER_WALLET,
  TEST_AUTH_DOMAIN,
  bearer,
  compiledOutput,
  createServer,
  signIn,
} from './helpers.js';

const POLICY = {
  domain: TEST_AUTH_DOMAIN,
  uri: 'https://covenant.test',
  chainId: 1952,
  nonceTtlSeconds: 300,
  sessionTtlSeconds: 86_400,
};

function service(now: () => Date = () => new Date('2026-08-17T00:00:00Z')): {
  auth: AuthService;
  repositories: ReturnType<typeof createInMemoryRepositories>;
} {
  const repositories = createInMemoryRepositories();
  return {
    repositories,
    auth: new AuthService({
      nonces: repositories.authNonces,
      sessions: repositories.authSessions,
      policy: POLICY,
      now,
    }),
  };
}

describe('the sign-in message', () => {
  it('is EIP-4361 shaped, with the fields the server chose', async () => {
    const { auth } = service();
    const { message } = await auth.createChallenge(CREATOR_ACCOUNT.address);

    expect(message.startsWith(`${TEST_AUTH_DOMAIN} wants you to sign in with your Ethereum account:`)).toBe(true);
    expect(message).toContain(CREATOR_ACCOUNT.address);
    expect(message).toContain('Version: 1');
    expect(message).toContain('Chain ID: 1952');
    expect(message).toContain('URI: https://covenant.test');
    expect(message).toContain('Expiration Time:');
  });

  it('says plainly that it authorises nothing', async () => {
    const { auth } = service();
    const { message } = await auth.createChallenge(CREATOR_ACCOUNT.address);
    // A user is being asked to sign something. The text has to tell them what
    // it does, and what it does is nothing on-chain.
    expect(message).toContain('authorises no transaction');
    expect(message).toContain('moves no funds');
  });
});

describe('verification', () => {
  it('accepts the address that signed, and issues a session for it', async () => {
    const { auth } = service();
    const challenge = await auth.createChallenge(CREATOR_ACCOUNT.address);
    const signature = await CREATOR_ACCOUNT.signMessage({ message: challenge.message });

    const { wallet, token } = await auth.verify({ nonce: challenge.nonce, signature });

    expect(wallet.address).toBe(CREATOR);
    expect(wallet.chainId).toBe(1952);
    expect(token.length).toBeGreaterThan(20);
  });

  it('rejects a signature by a different key', async () => {
    const { auth } = service();
    const challenge = await auth.createChallenge(CREATOR_ACCOUNT.address);
    // A valid signature — over the right message — by the wrong wallet.
    const signature = await OTHER_ACCOUNT.signMessage({ message: challenge.message });

    await expect(auth.verify({ nonce: challenge.nonce, signature })).rejects.toThrow(
      /could not be verified/,
    );
  });

  it('rejects a signature over a message with a different domain', async () => {
    const { auth } = service();
    const challenge = await auth.createChallenge(CREATOR_ACCOUNT.address);

    // The attacker signs a look-alike message naming their own site. The server
    // rebuilds the message from what it stored, so recovery gives a different
    // address and the signature does not match.
    const forged = renderSiweMessage({
      domain: 'evil.example',
      address: CREATOR_ACCOUNT.address,
      statement: 'Sign in',
      uri: 'https://evil.example',
      chainId: 1952,
      nonce: challenge.nonce,
      issuedAt: new Date('2026-08-17T00:00:00Z'),
      expiresAt: new Date('2026-08-17T00:05:00Z'),
    });
    const signature = await CREATOR_ACCOUNT.signMessage({ message: forged });

    await expect(auth.verify({ nonce: challenge.nonce, signature })).rejects.toThrow(
      /could not be verified/,
    );
  });

  it('refuses a malformed signature without attempting recovery', async () => {
    const { auth } = service();
    const challenge = await auth.createChallenge(CREATOR_ACCOUNT.address);

    await expect(auth.verify({ nonce: challenge.nonce, signature: '0xdeadbeef' })).rejects.toThrow(
      /could not be verified/,
    );
  });

  it('refuses an unknown nonce', async () => {
    const { auth } = service();
    const challenge = await auth.createChallenge(CREATOR_ACCOUNT.address);
    const signature = await CREATOR_ACCOUNT.signMessage({ message: challenge.message });

    await expect(auth.verify({ nonce: 'not-a-real-nonce', signature })).rejects.toThrow(
      /could not be verified/,
    );
  });
});

describe('replay and expiry', () => {
  it('will not accept the same nonce and signature twice', async () => {
    const { auth } = service();
    const challenge = await auth.createChallenge(CREATOR_ACCOUNT.address);
    const signature = await CREATOR_ACCOUNT.signMessage({ message: challenge.message });

    await auth.verify({ nonce: challenge.nonce, signature });

    // The identical, still-valid signature. Single use is the whole point of a
    // nonce; without this a captured signature is a permanent credential.
    await expect(auth.verify({ nonce: challenge.nonce, signature })).rejects.toThrow(
      /could not be verified/,
    );
  });

  it('rejects a signature presented after the challenge expired', async () => {
    let clock = new Date('2026-08-17T00:00:00Z');
    const { auth } = service(() => clock);

    const challenge = await auth.createChallenge(CREATOR_ACCOUNT.address);
    const signature = await CREATOR_ACCOUNT.signMessage({ message: challenge.message });

    // 300s TTL; arrive at 301s.
    clock = new Date('2026-08-17T00:05:01Z');

    await expect(auth.verify({ nonce: challenge.nonce, signature })).rejects.toThrow(
      /could not be verified/,
    );
  });

  it('rejects a session past its expiry', async () => {
    let clock = new Date('2026-08-17T00:00:00Z');
    const { auth } = service(() => clock);

    const challenge = await auth.createChallenge(CREATOR_ACCOUNT.address);
    const signature = await CREATOR_ACCOUNT.signMessage({ message: challenge.message });
    const { token } = await auth.verify({ nonce: challenge.nonce, signature });

    expect((await auth.authenticate(token)).address).toBe(CREATOR);

    clock = new Date('2026-08-18T00:00:01Z');
    await expect(auth.authenticate(token)).rejects.toThrow(/expired/);
  });

  it('rejects a revoked session', async () => {
    const { auth } = service();
    const challenge = await auth.createChallenge(CREATOR_ACCOUNT.address);
    const signature = await CREATOR_ACCOUNT.signMessage({ message: challenge.message });
    const { token, wallet } = await auth.verify({ nonce: challenge.nonce, signature });

    await auth.revoke(wallet.sessionId);

    await expect(auth.authenticate(token)).rejects.toThrow(/expired|not valid/);
  });
});

describe('token storage', () => {
  it('stores a digest, never the token', async () => {
    const { auth, repositories } = service();
    const challenge = await auth.createChallenge(CREATOR_ACCOUNT.address);
    const signature = await CREATOR_ACCOUNT.signMessage({ message: challenge.message });
    const { token } = await auth.verify({ nonce: challenge.nonce, signature });

    const stored = await repositories.authSessions.findByTokenHash(
      // Recompute the digest the way the service does.
      (await import('node:crypto')).createHash('sha256').update(token, 'utf8').digest('hex'),
    );

    expect(stored).not.toBeNull();
    // A dump of this table must not be usable as a set of credentials.
    expect(stored?.tokenHash).not.toBe(token);
    expect(stored?.tokenHash).toHaveLength(64);
  });
});

describe('authorization over HTTP (§31)', () => {
  it('refuses an unauthenticated compile', async () => {
    const harness = createServer([{ kind: 'text' as const, text: JSON.stringify(compiledOutput()) }]);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/markets/compile',
      payload: { message: 'Did it rain?', chainId: 1952 },
    });

    expect(response.statusCode).toBe(401);
  });

  it('uses the authenticated wallet as creator, ignoring anything in the body', async () => {
    const harness = createServer([{ kind: 'text' as const, text: JSON.stringify(compiledOutput()) }]);
    const token = await signIn(harness);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/markets/compile',
      // `creator` is not in the schema any more. Sending it is a 400, which is
      // stronger than ignoring it: a client that thinks it is choosing the
      // creator finds out immediately.
      payload: { message: 'Did it rain in Lagos on 2026-09-01?', chainId: 1952, creator: OTHER_WALLET },
      headers: bearer(token),
    });

    expect(response.statusCode).toBe(400);
  });

  it('records the signed-in wallet as the compilation creator', async () => {
    const harness = createServer([{ kind: 'text' as const, text: JSON.stringify(compiledOutput()) }]);
    const token = await signIn(harness);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/markets/compile',
      payload: { message: 'Did BTC close above 100000?', chainId: 1952 },
      headers: bearer(token),
    });

    expect(response.statusCode).toBe(200);
    const { sessionId } = response.json().data as { sessionId: string };
    const session = await harness.repositories.sessions.findById(sessionId);
    expect(session?.creator).toBe(CREATOR);
  });

  it("refuses to continue another wallet's compiler session", async () => {
    const harness = createServer([
      { kind: 'text' as const, text: JSON.stringify(compiledOutput()) },
      { kind: 'text' as const, text: JSON.stringify(compiledOutput()) },
    ]);

    const creatorToken = await signIn(harness, CREATOR_ACCOUNT);
    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/markets/compile',
      payload: { message: 'Did BTC close above 100000?', chainId: 1952 },
      headers: bearer(creatorToken),
    });
    const { sessionId } = first.json().data as { sessionId: string };

    const otherToken = await signIn(harness, OTHER_ACCOUNT);
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/markets/compile',
      payload: { message: 'and also…', chainId: 1952, sessionId },
      headers: bearer(otherToken),
    });

    // 403, not 404: the caller has proved who they are, and pretending the
    // session does not exist would send an honest user hunting for it.
    expect(response.statusCode).toBe(403);
  });

  it('refuses to register a specification naming a different creator', async () => {
    const harness = createServer([{ kind: 'text' as const, text: JSON.stringify(compiledOutput()) }]);
    const token = await signIn(harness, CREATOR_ACCOUNT);

    const compiled = await harness.app.inject({
      method: 'POST',
      url: '/api/markets/compile',
      payload: { message: 'Did BTC close above 100000?', chainId: 1952 },
      headers: bearer(token),
    });
    const { specification, rulesHash } = compiled.json().data as {
      specification: unknown;
      rulesHash: string;
    };

    // The other wallet tries to register a specification that names CREATOR as
    // its creator. The creator is inside the hash, so this would attribute an
    // approval to a wallet that never gave one.
    const otherToken = await signIn(harness, OTHER_ACCOUNT);
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/markets',
      payload: { specification, rulesHash },
      headers: bearer(otherToken),
    });

    expect(response.statusCode).toBe(403);
  });

  it('reports the authenticated wallet at /api/auth/me', async () => {
    const harness = createServer([]);
    const token = await signIn(harness);

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: bearer(token),
    });

    expect(response.statusCode).toBe(200);
    expect((response.json().data as { wallet: { address: string } }).wallet.address).toBe(CREATOR);
  });

  it('stops accepting a token after logout', async () => {
    const harness = createServer([]);
    const token = await signIn(harness);

    await harness.app.inject({ method: 'POST', url: '/api/auth/logout', headers: bearer(token) });

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(401);
  });

  it('never returns the session token in an error body', async () => {
    const harness = createServer([]);
    const token = await signIn(harness);

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/markets/0x' + 'ff'.repeat(32),
      headers: bearer(token),
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(token);
  });
});
