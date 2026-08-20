/**
 * Turning a raw response into a normalised, bounded evidence artifact.
 *
 * ## What is hashed, and what is merely kept
 *
 * `contentHash` is `keccak256` of the **complete raw body**, exactly as it
 * arrived. Not the normalised text, not a prefix of it: anyone holding the same
 * response reproduces the same digest with no charset guess and no parser in
 * between. That is what makes a stored copy checkable.
 *
 * This is why an oversized response is a *failure* rather than a truncation. A
 * hash over the first two megabytes, labelled as the hash of the response, would
 * be a quiet lie inside a document whose purpose is to be trustworthy. The
 * retrieval layer refuses; precedence moves to the next approved source.
 *
 * `normalizedContent` is a derivative, and it *may* be truncated — that is the
 * tradeoff §17 of docs/ai-resolution.md documents. It carries its own
 * `normalizedHash` so the extraction step in a later milestone commits to
 * exactly the text it read, and `truncated` is recorded rather than inferred.
 *
 * ## What is deliberately not here
 *
 * No claim extraction, no threshold comparison, no outcome. This module answers
 * "what did the source say, in a stable form" and stops.
 */

import { hashCanonicalText, hashContentBytes, jcsSerialize, type Bytes32Hex } from '@covenant/shared';
import type { RetrievalKind } from '@covenant/shared';

import { SourceRetrievalError } from './types.js';

/** Content types accepted per retrieval kind. Anything else is `SOURCE_INVALID`. */
const ACCEPTED_MEDIA_TYPES: Readonly<Record<string, readonly string[]>> = {
  http_json: ['application/json', 'text/json'],
  http_html: ['text/html', 'application/xhtml+xml', 'text/plain'],
};

/**
 * The `dataPath` result for a source whose specification named one.
 *
 * `value` is canonical JSON so that a selected number, string or object has one
 * textual form — the same discipline the protocol applies everywhere else.
 */
export interface SnapshotSelection {
  /** The RFC 6901 pointer taken from `ConditionSpec.approvedSources[].dataPath`. */
  readonly pointer: string;
  /** Canonical JSON of the selected value. */
  readonly value: string;
}

export interface NormalizedContent {
  readonly contentHash: Bytes32Hex;
  readonly normalizedContent: string;
  readonly normalizedHash: Bytes32Hex;
  readonly normalizedTruncated: boolean;
  /** Size of the complete raw body, in bytes. */
  readonly rawBytes: number;
  readonly selection: SnapshotSelection | null;
}

export interface NormalizeOptions {
  readonly retrievalKind: RetrievalKind;
  readonly contentType: string | null;
  readonly body: Uint8Array;
  /** `ConditionSpec.approvedSources[].dataPath`, or null. */
  readonly dataPath: string | null;
  /** Ceiling on the retained `normalizedContent`, in characters. */
  readonly maxRetainedChars: number;
}

/**
 * Check a `Content-Type` against the kind the specification declared.
 *
 * Strict, including on a missing header. A source whose response is not labelled
 * is a source we would be guessing about, and guessing is what this system
 * exists to remove — the market falls through to its approved fallback instead,
 * which is a defined and visible behaviour rather than a silent assumption.
 *
 * @throws {SourceRetrievalError} `SOURCE_INVALID`.
 */
export function assertContentType(kind: RetrievalKind, contentType: string | null): void {
  const accepted = ACCEPTED_MEDIA_TYPES[kind];
  if (accepted === undefined) {
    throw new SourceRetrievalError(
      'SOURCE_UNSUPPORTED',
      `no content type is defined for retrieval kind ${kind}`,
    );
  }

  if (contentType === null) {
    throw new SourceRetrievalError(
      'SOURCE_INVALID',
      `no content type; ${kind} requires one of ${accepted.join(', ')}`,
    );
  }

  // `application/json; charset=utf-8` — the parameters are transport detail.
  const mediaType = (contentType.split(';')[0] ?? '').trim().toLowerCase();

  // `+json` structured suffixes (`application/problem+json`,
  // `application/vnd.carrier.tracking+json`) are JSON by definition (RFC 6839),
  // and refusing them would reject well-behaved APIs over a naming convention.
  const accepts =
    accepted.includes(mediaType) || (kind === 'http_json' && mediaType.endsWith('+json'));

  if (!accepts) {
    throw new SourceRetrievalError(
      'SOURCE_INVALID',
      `content type ${mediaType === '' ? '(empty)' : mediaType} is not one of ${accepted.join(', ')}`,
    );
  }
}

/**
 * Decode a body as UTF-8, refusing anything that is not valid UTF-8.
 *
 * `fatal: true` matters: the lenient default replaces bad bytes with U+FFFD, so
 * a mis-declared encoding would become text full of replacement characters and
 * be extracted from as though it were fine.
 *
 * @throws {SourceRetrievalError} `SOURCE_MALFORMED`.
 */
function decodeUtf8(body: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new SourceRetrievalError('SOURCE_MALFORMED', 'body is not valid UTF-8');
  }
}

/**
 * Resolve an RFC 6901 JSON pointer.
 *
 * Returns `undefined` for a pointer that does not resolve, which the caller
 * turns into `SOURCE_INVALID`: the specification named where the value lives, so
 * a source that no longer publishes it there has not met the contract the user
 * approved. Falling back to "use the whole document" would be the system
 * deciding for itself where a value probably is.
 */
export function resolveJsonPointer(document: unknown, pointer: string): unknown {
  if (pointer === '') return document;
  if (!pointer.startsWith('/')) return undefined;

  let current: unknown = document;
  for (const rawSegment of pointer.slice(1).split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined;
      current = current[Number.parseInt(segment, 10)];
    } else if (typeof current === 'object' && current !== null) {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}

/**
 * Collapse HTML to the text a later extraction step would actually read.
 *
 * Script and style contents are dropped entirely — they are the bulk of a modern
 * page and none of it is evidence — tags are removed, the handful of entities
 * that matter are decoded, and runs of whitespace collapse to one space. The
 * result is stable across the cosmetic churn (minification, attribute order,
 * injected analytics) that would otherwise make two readings of an unchanged
 * page look different.
 *
 * It is deliberately not a parser. A DOM library would be a dependency and a
 * parsing-differential surface, and the goal here is a bounded, stable text
 * projection rather than a faithful document tree.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Produce the normalised artifact for one retrieved body.
 *
 * @throws {SourceRetrievalError} `SOURCE_MALFORMED` if the body is not the kind
 * it claims to be, `SOURCE_INVALID` if a declared `dataPath` does not resolve.
 */
export function normalizeContent(options: NormalizeOptions): NormalizedContent {
  const { retrievalKind, body, dataPath, maxRetainedChars } = options;

  // Hashed first, and from the bytes — before any decoding can change them.
  const contentHash = hashContentBytes(body);
  const text = decodeUtf8(body);

  let normalized: string;
  let selection: SnapshotSelection | null = null;

  if (retrievalKind === 'http_json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new SourceRetrievalError('SOURCE_MALFORMED', 'body is not valid JSON');
    }

    // Canonical JSON, so that a re-serialised or key-reordered response
    // normalises identically. This is the same encoder the protocol hashes with,
    // which is why a float in a source payload is refused here too rather than
    // travelling on to become a claim value.
    try {
      normalized = jcsSerialize(parsed);
    } catch (cause) {
      throw new SourceRetrievalError(
        'SOURCE_MALFORMED',
        'JSON payload cannot be represented canonically (floating point, or a value outside the safe integer range)',
        { cause },
      );
    }

    if (dataPath !== null) {
      const selected = resolveJsonPointer(parsed, dataPath);
      if (selected === undefined) {
        throw new SourceRetrievalError(
          'SOURCE_INVALID',
          `the approved dataPath ${dataPath} is not present in the response`,
        );
      }
      try {
        selection = { pointer: dataPath, value: jcsSerialize(selected) };
      } catch (cause) {
        throw new SourceRetrievalError(
          'SOURCE_MALFORMED',
          `the value at ${dataPath} cannot be represented canonically`,
          { cause },
        );
      }
    }
  } else {
    normalized = htmlToText(text);
    // A `dataPath` on an HTML source is a selector, not a JSON pointer.
    // Evaluating selectors belongs to the extraction milestone; recording that
    // one was declared but not applied would imply work that did not happen, so
    // it is left alone here and the text projection is what the snapshot holds.
  }

  const normalizedTruncated = normalized.length > maxRetainedChars;
  const retained = normalizedTruncated ? normalized.slice(0, maxRetainedChars) : normalized;

  return {
    contentHash,
    normalizedContent: retained,
    normalizedHash: hashCanonicalText(retained),
    normalizedTruncated,
    rawBytes: body.length,
    selection,
  };
}
