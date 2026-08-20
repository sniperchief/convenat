/**
 * Pieces of the evidence model that are identical in every schema version.
 *
 * Kept in their own module so the frozen v1.0 schema and the current v2.0 schema
 * can share them without either importing the other. A shape that appears in two
 * versions and is defined twice will eventually be defined differently.
 */

import { z } from 'zod';

import { semverSchema } from './primitives.js';

/**
 * Which resolver build produced a package.
 *
 * Deliberately *not* the resolver's wallet address. The address that submits
 * `proposeResolution` is recorded by the chain as `msg.sender`, and putting it
 * inside the hash as well would mean a key rotation between building a package
 * and submitting it invalidates a document that is otherwise still true.
 *
 * `version` follows the same discipline as `COMPILER_VERSION`: the minor
 * component moves whenever a prompt or a validator changes in a way that can
 * change a resolution. A model identifier alone would not capture that.
 */
export const resolverIdentitySchema = z
  .object({
    version: semverSchema,
    /** Model identifier when AI interpretation was used, otherwise null. */
    model: z.string().trim().min(1).max(120).nullable().default(null),
  })
  .strict();

export type ResolverIdentity = z.infer<typeof resolverIdentitySchema>;
