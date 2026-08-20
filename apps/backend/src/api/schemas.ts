/**
 * Request validation.
 *
 * Every route parses its input here before a handler sees it. Client-supplied
 * state is never trusted: a `rulesHash` sent by a client is recomputed from the
 * specification server-side and compared, a creator address is normalised, a
 * limit is clamped.
 *
 * These schemas describe the *wire* shape. The domain shape is
 * `@covenant/shared`'s, and there is exactly one of those.
 */

import { z } from 'zod';

import { marketStatusSchema } from '@covenant/shared';

const addressSchema = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte hex address')
  .transform((value) => value.toLowerCase());

const bytes32Schema = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 0x-prefixed 32-byte hex string')
  .transform((value) => value.toLowerCase());

export const MAX_PROMPT_LENGTH = 4000;

/**
 * Sign-in challenge request.
 *
 * The address is the wallet the caller *claims*. It is not believed — it only
 * selects which address the challenge is bound to, and only a signature by that
 * address's key completes the exchange (§30).
 */
export const authNonceRequestSchema = z
  .object({
    address: addressSchema,
  })
  .strict();

/**
 * Sign-in completion.
 *
 * Note what is absent: the message. The server rebuilds it from the fields it
 * stored when it issued the nonce, so there is nothing here for a client to
 * vary. See `auth/siwe.ts`.
 */
export const authVerifyRequestSchema = z
  .object({
    nonce: z.string().trim().min(1).max(200),
    signature: z
      .string()
      .trim()
      .regex(/^0x[0-9a-fA-F]{130}$/, 'must be a 65-byte hex signature'),
  })
  .strict();

/**
 * Compiling a condition.
 *
 * **`creator` is gone.** It used to be an address the client asserted; it is now
 * the authenticated wallet, taken from the session and never from the body
 * (§30). A field a caller could set to someone else's address is not an
 * identity, and leaving it in the schema would leave the door open.
 */
export const compileRequestSchema = z
  .object({
    message: z
      .string()
      .trim()
      .min(1, 'message must not be empty')
      .max(MAX_PROMPT_LENGTH, `message must be at most ${MAX_PROMPT_LENGTH} characters`),
    chainId: z.number().int().positive(),
    sessionId: z.string().uuid('must be a session id from a previous compile').optional(),
  })
  .strict();

export type CompileRequestBody = z.infer<typeof compileRequestSchema>;

/**
 * Registering an approved specification.
 *
 * The client sends the hash it computed. The server recomputes it from the
 * specification and rejects a mismatch — the client's value is a checksum to
 * verify, never the value that gets stored.
 */
export const registerMarketRequestSchema = z
  .object({
    // The specification is validated by the shared schema, not here. A second
    // copy of that schema would be a second thing to drift.
    specification: z.record(z.unknown()),
    rulesHash: bytes32Schema,
  })
  .strict();

export type RegisterMarketRequestBody = z.infer<typeof registerMarketRequestSchema>;

const positiveIntFromQuery = z
  .union([z.number(), z.string()])
  .transform((value) => (typeof value === 'number' ? value : Number.parseInt(value, 10)))
  .refine((value) => Number.isSafeInteger(value) && value > 0, 'must be a positive integer');

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export const listMarketsQuerySchema = z
  .object({
    chainId: positiveIntFromQuery.optional(),
    status: marketStatusSchema.optional(),
    creator: addressSchema.optional(),
    limit: positiveIntFromQuery
      .transform((value) => Math.min(value, MAX_PAGE_SIZE))
      .optional(),
    cursor: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export type ListMarketsQuery = z.infer<typeof listMarketsQuerySchema>;

/**
 * A market path parameter.
 *
 * Accepts either a `rulesHash` or a decimal on-chain market id. Both identify
 * the same market and both are in circulation: the hash exists from the moment
 * a specification is approved, the sequential id only once the factory assigns
 * one. Until Milestone 4 puts markets on-chain, only the hash resolves.
 */
export const marketIdParamSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .refine(
        (value) => /^0x[0-9a-fA-F]{64}$/.test(value) || /^\d+$/.test(value),
        'must be a rules hash (0x...) or a decimal on-chain market id',
      ),
  })
  .strict();

export const challengeRequestSchema = z
  .object({
    challenger: addressSchema,
    reason: z.string().trim().min(1).max(4000),
    txHash: z
      .string()
      .trim()
      .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a transaction hash'),
  })
  .strict();

export const resolveRequestSchema = z
  .object({
    force: z.boolean().optional(),
  })
  .strict()
  .default({});

/**
 * Positions.
 *
 * `wallet` is optional and defaults to the authenticated wallet. Supplying
 * another address is permitted — a position is a public on-chain fact that
 * anyone can read from the contract, so hiding it here would be theatre rather
 * than privacy.
 */
export const listPositionsQuerySchema = z
  .object({
    wallet: addressSchema.optional(),
    chainId: positiveIntFromQuery.optional(),
  })
  .strict();
