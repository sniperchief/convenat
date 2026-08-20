/**
 * Structured logging, and what must never reach it.
 *
 * Two layers of defence, because one is not enough:
 *
 * 1. **Secrets never enter a loggable object.** The configuration object is
 *    reduced by `describeConfig` before anything logs it, and no code path
 *    passes a raw key to a logger. This is the real protection.
 * 2. **Redaction as a backstop.** The pino paths below catch an authorization
 *    header or an api-key field that slips in via a serialiser someone adds
 *    later. It exists because layer 1 depends on every future author
 *    remembering, and this one does not.
 *
 * User prompts are treated as sensitive by default. A condition can name a
 * counterparty, a contract value, or a shipment — logging it wholesale is a
 * decision, so it takes an explicit `LOG_USER_CONTENT=true` and is off
 * otherwise. What is always logged instead is the shape: request id, route,
 * status, latency, compiler version, session id, rules hash.
 */

import type { FastifyServerOptions } from 'fastify';

import type { AppConfig } from './config.js';

/**
 * Header and field paths pino replaces with `[Redacted]`.
 *
 * Covers the incoming request, our own outgoing shapes, and the field names a
 * future serialiser is most likely to introduce.
 */
export const REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["anthropic-api-key"]',
  'res.headers["set-cookie"]',
  'apiKey',
  '*.apiKey',
  'ANTHROPIC_API_KEY',
  '*.ANTHROPIC_API_KEY',
  'privateKey',
  '*.privateKey',
  'resolverPrivateKey',
  '*.resolverPrivateKey',
  'RESOLVER_PRIVATE_KEY',
  '*.RESOLVER_PRIVATE_KEY',
  'DATABASE_URL',
  '*.DATABASE_URL',
  'databaseUrl',
  '*.databaseUrl',
  'password',
  '*.password',
];

/**
 * @returns `false` to disable logging entirely, or pino options. Never
 * `undefined` — an optional here would make the Fastify options object fail to
 * match its overload under `exactOptionalPropertyTypes`.
 */
export function buildLoggerOptions(
  config: AppConfig,
): NonNullable<FastifyServerOptions['logger']> {
  if (config.logLevel === 'silent') return false;
  return {
    level: config.logLevel,
    redact: { paths: [...REDACT_PATHS], censor: '[Redacted]' },
  };
}

/**
 * Prepare user-supplied text for a log line.
 *
 * Returns a length rather than the content unless logging user content is
 * explicitly enabled. A length is enough to debug a truncation or an empty
 * body, which is what a log is usually needed for.
 */
export function describeUserContent(
  content: string,
  config: AppConfig,
): { readonly length: number; readonly content?: string } {
  if (!config.logUserContent) return { length: content.length };
  return { length: content.length, content };
}
