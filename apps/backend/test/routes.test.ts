import { afterEach, describe, expect, it } from 'vitest';
import type { InjectOptions } from 'fastify';

import { buildRulesCommitment } from '@covenant/shared';

import { buildServer } from '../src/api/server.js';
import { AuthService } from '../src/auth/service.js';
import { createFailingRepositories, createInMemoryRepositories } from '../src/repositories/memory.js';
import {
  CREATOR,
  NOW,
  bearer,
  compiledOutput,
  createCompiler,
  createServer,
  incompleteOutput,
  signIn,
  validDraft,
} from './helpers.js';

const servers: { close: () => Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/**
 * A server with a signed-in wallet already attached.
 *
 * M4 made every mutating route require a proved wallet (§30). Rather than
 * thread a header through several dozen assertions that are about something
 * else entirely, `inject` attaches the bearer token by default; a test that
 * cares about the unauthenticated case passes its own `headers`.
 */
async function serve(scripts: Parameters<typeof createServer>[0]) {
  const harness = createServer(scripts);
  servers.push(harness.app);
  const token = await signIn(harness);

  const app = {
    inject: (options: InjectOptions) =>
      harness.app.inject({
        ...options,
        headers: { ...bearer(token), ...(options.headers ?? {}) },
      }),
  };

  return { ...harness, app, token, rawApp: harness.app };
}

const compileBody = { message: 'Pay if BTC is above 100k.', chainId: 1952 };

describe('GET /health', () => {
  it('reports the compiler version and chain', async () => {
    const { app } = await serve([]);
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ status: 'ok', chainId: 1952 });
    expect(response.json().data.compilerVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('POST /api/markets/compile', () => {
  it('returns a specification and hash, and opens a session', async () => {
    const { app } = await serve([{ kind: 'json', value: compiledOutput() }]);
    const response = await app.inject({
      method: 'POST',
      url: '/api/markets/compile',
      payload: compileBody,
    });

    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data.status).toBe('COMPILED');
    expect(data.rulesHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(data.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(data.interpretation.length).toBeGreaterThan(0);
  });

  it('persists the compilation under its rules hash', async () => {
    const { app, repositories } = await serve([{ kind: 'json', value: compiledOutput() }]);
    const response = await app.inject({
      method: 'POST',
      url: '/api/markets/compile',
      payload: compileBody,
    });

    const stored = await repositories.compilations.findByRulesHash(response.json().data.rulesHash);
    expect(stored).not.toBeNull();
    expect(stored?.compilerVersion).toBe(response.json().data.compilerVersion);
  });

  it('returns 200 with questions for an incomplete condition', async () => {
    const { app } = await serve([
      {
        kind: 'json',
        value: incompleteOutput([
          { field: 'deadline', question: 'Which exact date?', why: 'no instant given' },
        ]),
      },
    ]);
    const response = await app.inject({
      method: 'POST',
      url: '/api/markets/compile',
      payload: { ...compileBody, message: 'Pay if ETH does well.' },
    });

    // 200, not 4xx: an incomplete condition is a normal product outcome, not a
    // client error.
    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe('INCOMPLETE');
    expect(response.json().data.questions).toHaveLength(1);
  });

  it('carries a session across turns so a clarification is answered in context', async () => {
    const { app, provider } = await serve([
      {
        kind: 'json',
        value: incompleteOutput([
          { field: 'deadline', question: 'Which exact date?', why: 'no instant' },
        ]),
      },
      { kind: 'json', value: compiledOutput() },
    ]);

    const first = await app.inject({
      method: 'POST',
      url: '/api/markets/compile',
      payload: compileBody,
    });
    const sessionId = first.json().data.sessionId;

    const second = await app.inject({
      method: 'POST',
      url: '/api/markets/compile',
      payload: { ...compileBody, message: '2026-09-01 00:00 UTC.', sessionId },
    });

    expect(second.json().data.status).toBe('COMPILED');
    expect(second.json().data.sessionId).toBe(sessionId);
    // The second model call saw the first exchange.
    expect(provider.calls[1]?.messages.length).toBeGreaterThan(1);
  });

  it('rejects an unknown session', async () => {
    const { app } = await serve([]);
    const response = await app.inject({
      method: 'POST',
      url: '/api/markets/compile',
      payload: { ...compileBody, sessionId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('requires a signed-in wallet', async () => {
    const { app } = await serve([]);
    const response = await app.inject({
      method: 'POST',
      url: '/api/markets/compile',
      payload: compileBody,
      // Override the harness's token with nothing.
      headers: { authorization: '' },
    });
    expect(response.statusCode).toBe(401);
  });

  const invalid: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['a missing message', { chainId: 1952 }],
    ['an empty message', { ...compileBody, message: '   ' }],
    ['a missing chain id', { message: 'x' }],
    // `creator` was removed from the contract in M4: identity comes from the
    // session. A client still sending it is told, rather than silently ignored.
    ['a client-asserted creator', { ...compileBody, creator: CREATOR }],
    ['an unknown extra field', { ...compileBody, admin: true }],
    ['an over-long message', { ...compileBody, message: 'x'.repeat(5000) }],
  ];

  for (const [label, payload] of invalid) {
    it(`rejects ${label} with 400`, async () => {
      const { app } = await serve([]);
      const response = await app.inject({
        method: 'POST',
        url: '/api/markets/compile',
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_FAILED');
    });
  }

  it('rejects a chain this backend does not serve', async () => {
    const { app } = await serve([]);
    const response = await app.inject({
      method: 'POST',
      url: '/api/markets/compile',
      payload: { ...compileBody, chainId: 1 },
    });
    expect(response.statusCode).toBe(400);
  });

  it('maps malformed model output to 502, not 500', async () => {
    const { app } = await serve([{ kind: 'text', text: 'not json at all' }]);
    const response = await app.inject({
      method: 'POST',
      url: '/api/markets/compile',
      payload: compileBody,
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('COMPILER_OUTPUT_INVALID');
  });

  it('maps a provider outage to 503 and a timeout to 504', async () => {
    const outage = await serve([{ kind: 'error', failure: 'unavailable' }]);
    const first = await outage.app.inject({
      method: 'POST',
      url: '/api/markets/compile',
      payload: compileBody,
    });
    expect(first.statusCode).toBe(503);

    const slow = await serve([{ kind: 'error', failure: 'timeout' }]);
    const second = await slow.app.inject({
      method: 'POST',
      url: '/api/markets/compile',
      payload: compileBody,
    });
    expect(second.statusCode).toBe(504);
  });
});

describe('POST /api/markets', () => {
  async function approvedSpec() {
    const harness = createCompiler([{ kind: 'json', value: compiledOutput() }]);
    const result = await harness.compiler.compile({
      message: 'x',
      creator: CREATOR,
      history: [],
    });
    if (result.status !== 'COMPILED') throw new Error('expected COMPILED');
    return result;
  }

  it('registers an approved specification as PENDING_ONCHAIN', async () => {
    const { app } = await serve([]);
    const compiled = await approvedSpec();

    const response = await app.inject({
      method: 'POST',
      url: '/api/markets',
      payload: { specification: compiled.specification, rulesHash: compiled.rulesHash },
    });

    expect(response.statusCode).toBe(201);
    // Not OPEN: the backend does not create the market on-chain.
    expect(response.json().data.status).toBe('PENDING_ONCHAIN');
    expect(response.json().data.rulesHash).toBe(compiled.rulesHash);
  });

  it('recomputes the hash server-side and rejects a client mismatch', async () => {
    const { app } = await serve([]);
    const compiled = await approvedSpec();

    const response = await app.inject({
      method: 'POST',
      url: '/api/markets',
      payload: {
        specification: compiled.specification,
        rulesHash: `0x${'ff'.repeat(32)}`,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.issues[0]?.path).toBe('rulesHash');
  });

  it('rejects a specification tampered with after the hash was computed', async () => {
    const { app } = await serve([]);
    const compiled = await approvedSpec();
    const tampered = { ...compiled.specification, question: 'Something else entirely?' };

    const response = await app.inject({
      method: 'POST',
      url: '/api/markets',
      payload: { specification: tampered, rulesHash: compiled.rulesHash },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects an invalid specification with 400 and field paths', async () => {
    const { app } = await serve([]);
    const response = await app.inject({
      method: 'POST',
      url: '/api/markets',
      payload: { specification: { version: '1.0' }, rulesHash: `0x${'11'.repeat(32)}` },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.issues.length).toBeGreaterThan(0);
  });

  it('is idempotent: registering the same approved spec twice is not an error', async () => {
    const { app } = await serve([]);
    const compiled = await approvedSpec();
    const payload = { specification: compiled.specification, rulesHash: compiled.rulesHash };

    expect((await app.inject({ method: 'POST', url: '/api/markets', payload })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/api/markets', payload })).statusCode).toBe(201);
  });

  describe('once registered', () => {
    it('appears in the listing and can be fetched by rules hash', async () => {
      const { app } = await serve([]);
      const compiled = await approvedSpec();
      await app.inject({
        method: 'POST',
        url: '/api/markets',
        payload: { specification: compiled.specification, rulesHash: compiled.rulesHash },
      });

      const list = await app.inject({ method: 'GET', url: '/api/markets' });
      expect(list.statusCode).toBe(200);
      expect(list.json().data.markets).toHaveLength(1);
      expect(list.json().data.markets[0].status).toBe('PENDING_ONCHAIN');
      // Stake totals are on-chain facts nobody has read yet.
      expect(list.json().data.markets[0].totalYesBaseUnits).toBe('0');
      expect(list.json().data.markets[0].origin).toBe('indexer');

      const detail = await app.inject({ method: 'GET', url: `/api/markets/${compiled.rulesHash}` });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().data.rulesHashVerified).toBe(true);
      expect(detail.json().data.resolution).toBeNull();
    });

    it('re-derives the hash from the stored specification when serving it', async () => {
      const { app } = await serve([]);
      const compiled = await approvedSpec();
      await app.inject({
        method: 'POST',
        url: '/api/markets',
        payload: { specification: compiled.specification, rulesHash: compiled.rulesHash },
      });

      const detail = await app.inject({ method: 'GET', url: `/api/markets/${compiled.rulesHash}` });
      const served = detail.json().data;
      expect(buildRulesCommitment(served.specification).rulesHash).toBe(served.rulesHash);
    });

    it('filters the listing by creator and status', async () => {
      const { app } = await serve([]);
      const compiled = await approvedSpec();
      await app.inject({
        method: 'POST',
        url: '/api/markets',
        payload: { specification: compiled.specification, rulesHash: compiled.rulesHash },
      });

      const mine = await app.inject({ method: 'GET', url: `/api/markets?creator=${CREATOR}` });
      expect(mine.json().data.markets).toHaveLength(1);

      const other = await app.inject({
        method: 'GET',
        url: '/api/markets?creator=0x2222222222222222222222222222222222222222',
      });
      expect(other.json().data.markets).toHaveLength(0);

      const settled = await app.inject({ method: 'GET', url: '/api/markets?status=SETTLED' });
      expect(settled.json().data.markets).toHaveLength(0);
    });

    it('has no evidence to serve yet', async () => {
      const { app } = await serve([]);
      const compiled = await approvedSpec();
      await app.inject({
        method: 'POST',
        url: '/api/markets',
        payload: { specification: compiled.specification, rulesHash: compiled.rulesHash },
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/markets/${compiled.rulesHash}/evidence`,
      });
      // 404, not an empty package: a hollow evidence document would imply a
      // resolution that never happened.
      expect(response.statusCode).toBe(404);
    });
  });

  it('rejects a bad market id shape', async () => {
    const { app } = await serve([]);
    const response = await app.inject({ method: 'GET', url: '/api/markets/not-an-id' });
    expect(response.statusCode).toBe(400);
  });

  it('returns 404 for a market that does not exist', async () => {
    const { app } = await serve([]);
    const response = await app.inject({
      method: 'GET',
      url: `/api/markets/0x${'ab'.repeat(32)}`,
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('routes that are not implemented yet', () => {
  it('does not fake a resolution', async () => {
    const { app } = await serve([]);
    const response = await app.inject({
      method: 'POST',
      url: `/api/markets/0x${'ab'.repeat(32)}/resolve`,
      payload: {},
    });

    expect(response.statusCode).toBe(501);
    expect(response.json().error.code).toBe('NOT_IMPLEMENTED');
    // Nothing that could be mistaken for a proposal: no data payload at all,
    // and the error body carries only the three standard fields. (The message
    // may well say the word "outcome" — it is explaining that there isn't one.)
    expect(response.json().data).toBeUndefined();
    expect(Object.keys(response.json().error).sort()).toEqual(['code', 'issues', 'message']);
  });

  it('does not fake a challenge', async () => {
    const { app } = await serve([]);
    const response = await app.inject({
      method: 'POST',
      url: `/api/markets/0x${'ab'.repeat(32)}/challenge`,
      payload: {
        challenger: CREATOR,
        reason: 'The source was misread.',
        txHash: `0x${'cd'.repeat(32)}`,
      },
    });
    expect(response.statusCode).toBe(501);
    expect(response.json().error.code).toBe('NOT_IMPLEMENTED');
  });

  it('validates input before reporting not-implemented, so the contract is still enforced', async () => {
    const { app } = await serve([]);
    const response = await app.inject({
      method: 'POST',
      url: `/api/markets/0x${'ab'.repeat(32)}/challenge`,
      payload: { challenger: 'nope', reason: '', txHash: 'x' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('does not report an empty portfolio when there is no chain to read', async () => {
    // Positions became a real route in M4, but only when a chain is configured.
    // Without one it still refuses rather than answering "you hold nothing" —
    // the same reasoning that made it a 501 in M3.
    const { app } = await serve([]);
    const response = await app.inject({
      method: 'GET',
      url: `/api/positions?wallet=${CREATOR}`,
    });
    expect(response.statusCode).toBe(501);
    expect(response.json().error.message).toMatch(/chain/i);
  });

  it('requires authentication for positions', async () => {
    const { app } = await serve([]);
    const response = await app.inject({
      method: 'GET',
      url: '/api/positions',
      headers: { authorization: '' },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('storage failures', () => {
  it('returns 503 without leaking driver detail', async () => {
    const harness = createCompiler([{ kind: 'json', value: compiledOutput() }]);

    // Authentication is backed by working storage while the *application*
    // repositories are dead, so the request gets past the door and fails where
    // this test is aiming: at the compile handler's first query.
    const authStore = createInMemoryRepositories();
    const auth = new AuthService({
      nonces: authStore.authNonces,
      sessions: authStore.authSessions,
      policy: {
        domain: harness.config.auth.domain,
        uri: harness.config.auth.uri,
        chainId: harness.config.chainId,
        nonceTtlSeconds: harness.config.auth.nonceTtlSeconds,
        sessionTtlSeconds: harness.config.auth.sessionTtlSeconds,
      },
      now: () => NOW,
    });

    const app = buildServer({
      config: harness.config,
      repositories: {
        ...createFailingRepositories(
          'connection to postgresql://user:hunter2@db:5432 refused',
        ),
        // Sign-in must work so the request reaches the handler under test;
        // everything the handler itself touches is still dead.
        wallets: authStore.wallets,
        authNonces: authStore.authNonces,
        authSessions: authStore.authSessions,
      },
      compiler: harness.compiler,
      auth,
      now: () => NOW,
    });
    servers.push(app);

    const token = await signIn({ ...harness, app, auth, repositories: authStore });

    const response = await app.inject({
      method: 'POST',
      url: '/api/markets/compile',
      payload: compileBody,
      headers: bearer(token),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('REPOSITORY_UNAVAILABLE');

    const body = response.body;
    expect(body).not.toContain('hunter2');
    expect(body).not.toContain('postgresql://');
    expect(body).not.toContain('at ');
    expect(body).not.toContain('stack');
  });
});

describe('unknown routes', () => {
  it('returns a typed 404 rather than a framework page', async () => {
    const { app } = await serve([]);
    const response = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });
});

describe('error bodies', () => {
  it('never carry a stack trace or internals', async () => {
    const { app } = await serve([{ kind: 'text', text: 'garbage' }]);
    const response = await app.inject({
      method: 'POST',
      url: '/api/markets/compile',
      payload: compileBody,
    });

    const body = response.json();
    expect(Object.keys(body)).toEqual(['error']);
    expect(Object.keys(body.error).sort()).toEqual(['code', 'issues', 'message']);
    expect(response.body).not.toContain('node_modules');
    expect(response.body).not.toMatch(/\bat .+:\d+:\d+/);
  });
});

describe('validDraft fixture', () => {
  it('is genuinely valid, so a failing test means the code changed', async () => {
    const harness = createCompiler([{ kind: 'json', value: compiledOutput(validDraft()) }]);
    const result = await harness.compiler.compile({
      message: 'x',
      creator: CREATOR,
      history: [],
    });
    expect(result.status).toBe('COMPILED');
  });
});
