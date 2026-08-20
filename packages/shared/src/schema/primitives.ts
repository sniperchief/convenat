/**
 * Shared scalar schemas.
 *
 * Every schema here is also a *normaliser*: it produces the single canonical
 * textual form of the value it accepts. Normalising at the validation boundary
 * means canonicalisation itself only has to deal with structure, and it removes
 * whole classes of accidental hash divergence (mixed-case addresses, `+00:00`
 * versus `Z`, stray surrounding whitespace).
 */

import { z } from 'zod';

/** 2^256 - 1. The largest value a Solidity uint256 can hold. */
export const MAX_UINT256 = (1n << 256n) - 1n;

/** Non-empty, length-bounded human text. Surrounding whitespace is trimmed. */
export const text = (maxLength: number): z.ZodString =>
  z.string().trim().min(1, 'must not be empty').max(maxLength, `must be at most ${maxLength} characters`);

/** A 20-byte EVM address, normalised to lowercase hex. */
export const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte hex address')
  .transform((value) => value.toLowerCase() as `0x${string}`);

/** A 32-byte hash or opaque value, normalised to lowercase hex. */
export const bytes32Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 0x-prefixed 32-byte hex string')
  .transform((value) => value.toLowerCase() as `0x${string}`);

/**
 * An unsigned integer that may exceed IEEE-754 exact range (token amounts),
 * carried as a canonical decimal string with no leading zeros.
 *
 * The range check is total. Zod continues to run a `.refine()` after a failed
 * string check (a regex failure marks the result dirty, not aborted), so an
 * input like `"50.5"` reaches this callback despite failing the pattern. A bare
 * `BigInt(value)` would throw a raw `SyntaxError` straight past the typed error
 * model and surface as a 500 rather than a field-level validation failure.
 */
export const uint256StringSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, 'must be a decimal integer string with no leading zeros')
  .refine((value) => {
    try {
      return BigInt(value) <= MAX_UINT256;
    } catch {
      return false;
    }
  }, 'must not exceed 2^256 - 1');

/**
 * A non-negative integer that fits the exactly-representable range.
 *
 * `.safe()` bounds the value to ±Number.MAX_SAFE_INTEGER, which is also the
 * range the canonical encoder accepts — anything larger must be carried as a
 * decimal string. These stay plain `ZodNumber`s (no `.refine`) so callers can
 * narrow them further with `.min()` / `.max()`.
 */
export const nonNegativeIntSchema = z
  .number()
  .int('must be an integer')
  .nonnegative('must not be negative')
  .safe();

/** A strictly positive integer that fits the exactly-representable range. */
export const positiveIntSchema = z
  .number()
  .int('must be an integer')
  .positive('must be greater than zero')
  .safe();

/** Confidence as integer basis points. Floating point is never used in a hashed document. */
export const basisPointsSchema = z
  .number()
  .int('must be an integer number of basis points')
  .min(0, 'must not be negative')
  .max(10_000, 'must not exceed 10000 basis points');

const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

/** Days in a month, with the Gregorian leap rule applied to February. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * Whether the *written* date is a real calendar date.
 *
 * Necessary because `Date.parse` does not check: it **rolls over silently**.
 * `2026-02-31T00:00:00Z` parses to 3 March, `2026-04-31` to 1 May, and
 * `2025-02-29` — 29 February in a non-leap year — to 1 March. Each returns a
 * perfectly finite timestamp, so a `Number.isFinite` guard sees nothing wrong.
 *
 * In a hashed document that is a silent alteration of the agreement: a user
 * approving a deadline of 29 February would be committing to 1 March, a whole
 * extra day, with no error anywhere. Out-of-range *months* and days above 31 are
 * already rejected by `Date.parse`; it is the in-range-but-impossible day that
 * slips through, which is exactly the case a human is most likely to write.
 *
 * The check is on the written components, independent of the offset: an offset
 * shifts which instant a date denotes, never whether the date exists.
 */
function isRealCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  return day <= daysInMonth(year, month);
}

/**
 * An absolute instant.
 *
 * Accepts any RFC 3339 date-time carrying an explicit offset, and normalises it
 * to UTC with whole-second precision (`YYYY-MM-DDTHH:MM:SSZ`). Sub-second
 * components are truncated: the protocol's time resolution is one second,
 * matching block timestamps, and admitting milliseconds would let two
 * indistinguishable deadlines hash differently.
 *
 * A bare local date-time with no offset is rejected rather than assumed to be
 * UTC — guessing a timezone is precisely the ambiguity this product exists to
 * eliminate.
 */
export const utcInstantSchema = z.string().transform((raw, ctx) => {
  const match = RFC3339_PATTERN.exec(raw);
  if (match === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'must be an RFC 3339 date-time with an explicit UTC offset, e.g. 2026-09-01T23:59:59Z',
    });
    return z.NEVER;
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);

  // Checked before `Date.parse`, which would roll an impossible day forward
  // instead of refusing it. See `isRealCalendarDate`.
  if (!isRealCalendarDate(year, month, day)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `is not a real calendar date (${yearText}-${monthText}-${dayText} does not exist)`,
    });
    return z.NEVER;
  }

  // Same reasoning for the clock components: `24:00:00` is a legal RFC 3339
  // spelling of midnight that `Date.parse` accepts and rolls into the next day,
  // and a minute or second of 60 would roll likewise.
  if (Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'is not a real time of day; hours 0-23, minutes and seconds 0-59',
    });
    return z.NEVER;
  }

  const milliseconds = Date.parse(raw);
  if (!Number.isFinite(milliseconds)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'is not a real calendar date' });
    return z.NEVER;
  }

  const seconds = Math.floor(milliseconds / 1000);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be after the Unix epoch' });
    return z.NEVER;
  }

  return new Date(seconds * 1000).toISOString().replace(/\.000Z$/, 'Z');
});

/**
 * An IANA timezone label, or `UTC`.
 *
 * Validated by shape only. Runtime timezone databases differ between Node
 * versions and browsers, so validating against `Intl` would make acceptance
 * environment-dependent — and a document that validates on the backend but not
 * in the browser breaks client-side hash verification. The authoritative time
 * is always the UTC instant in `deadline`; this field records the human frame
 * that instant was derived from.
 */
export const timezoneSchema = z
  .string()
  .regex(
    /^(UTC|[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)+)$/,
    'must be "UTC" or an IANA timezone name such as "America/New_York"',
  );

/** An https URL. Plain http is rejected: evidence retrieval must be authenticated in transit. */
export const httpsUrlSchema = z
  .string()
  .url('must be a valid URL')
  .max(2048, 'must be at most 2048 characters')
  .refine((value) => value.startsWith('https://'), 'must use https');

/**
 * Query parameter names that are unambiguously credentials.
 *
 * Deliberately short. `key`, `token` and `signature` are *not* here: they have
 * legitimate non-secret meanings (`?key=BTC`), and a filter that rejects them
 * would make some markets unresolvable — in a resolution engine, a false
 * positive means the evidence cannot be published at all. Every name below has
 * no reading other than "a secret".
 */
const CREDENTIAL_QUERY_PARAMETERS: readonly string[] = [
  'api_key',
  'apikey',
  'api-key',
  'access_token',
  'auth_token',
  'authtoken',
  'client_secret',
  'private_key',
  'password',
  'passwd',
  'secret',
];

/**
 * An https URL that is safe to publish.
 *
 * An evidence package is served to anyone who wants to audit a resolution, so a
 * URL inside one is published. Two forms of embedded credential are refused:
 * `https://user:pass@host` userinfo, which has no legitimate use here, and a
 * query parameter whose name can only mean a secret.
 *
 * This is a floor, not a guarantee. A credential can still hide in a path
 * segment or an unusually named parameter, and no schema can recognise that.
 * The real control is which sources an operator approves; see
 * docs/ai-resolution.md §8.
 */
export const publicUrlSchema = httpsUrlSchema.superRefine((value, ctx) => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a valid URL' });
    return;
  }

  if (parsed.username !== '' || parsed.password !== '') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'must not embed credentials in the URL; an evidence package is published',
    });
  }

  for (const [name] of parsed.searchParams) {
    if (CREDENTIAL_QUERY_PARAMETERS.includes(name.toLowerCase())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `must not carry a credential in the query string (parameter "${name}"); an evidence package is published`,
      });
    }
  }
});

/**
 * A stable, human-readable identifier for an element inside a hashed document.
 *
 * Lowercase only. Two identifiers differing solely in case would be two names
 * for one thing and would hash differently, which is precisely the class of
 * accidental divergence the normalisation layer exists to remove.
 */
export const identifierSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._-]{0,63}$/,
    'must be 1-64 characters of lowercase letters, digits, dot, underscore or hyphen, starting with a letter or digit',
  );

/** A `major.minor.patch` version identifier for a resolver build. */
export const semverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, 'must be a major.minor.patch version');
