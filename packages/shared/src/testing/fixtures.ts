/**
 * Canonical example documents.
 *
 * These live in `src`, not `test`, and ship with the built package: the
 * contract tests in Milestone 2 need real specifications whose `rulesHash` was
 * produced by this exact code, and the golden-vector generator builds its
 * output from them. Keeping one set of examples means the vectors the Solidity
 * tests assert against are the same ones the TypeScript tests assert against.
 *
 * These are **inputs**, in the shape a caller supplies. They are deliberately
 * not pre-normalised: several of them exercise normalisation on purpose (mixed
 * case addresses, a non-UTC offset, untrimmed text, non-ASCII characters).
 *
 * Changing a fixture changes the golden vectors, which is a breaking protocol
 * change. Add a new fixture instead.
 *
 * NOTE: this file is intentionally UTF-8 and contains non-ASCII characters in
 * `productLaunchConditionSpec`. That is load-bearing - it locks the UTF-8
 * encoding step of the hash into a golden vector. Do not "clean up" those
 * characters, and do not rewrite this file with a tool that guesses encodings.
 */

import type { ConditionSpecInput } from '../schema/condition-spec.js';
import type {
  EvidencePackageV1Input,
  EvidencePackageV2Input,
} from '../schema/evidence-package.js';

/**
 * A placeholder settlement token for fixtures only.
 *
 * This is not a real deployment. Real token addresses come from
 * `packages/contracts/deployments/<network>.json` once Milestone 4 deploys
 * them; nothing in this repository asserts that a token exists at this address.
 */
const FIXTURE_TOKEN = {
  chainId: 1952,
  address: '0x000000000000000000000000000000000000dead',
  symbol: 'TUSD',
  decimals: 6,
} as const;

/**
 * A supply-chain payment condition - the motivating example for the product:
 * an agreement whose trigger is a real-world event described in prose.
 */
export const shipmentConditionSpec: ConditionSpecInput = {
  version: '1.0',
  nonce: '0x1111111111111111111111111111111111111111111111111111111111111111',
  creator: '0x1111111111111111111111111111111111111111',
  question: 'Will shipment 1Z999AA10123456784 be delivered before 1 September 2026?',
  conditionType: 'binary',
  successCondition:
    'The primary approved carrier tracking source reports status "delivered" with a delivery timestamp at or before 2026-09-01T23:59:59Z.',
  failureCondition:
    'The primary approved carrier tracking source reports any status other than "delivered" as of 2026-09-01T23:59:59Z, or reports a delivery timestamp after that instant.',
  deadline: '2026-09-01T23:59:59Z',
  timezone: 'UTC',
  resolutionMethod: 'source_attested_status',
  approvedSources: [
    {
      name: 'Carrier tracking API',
      url: 'https://api.example-carrier.test/v1/track/1Z999AA10123456784',
      retrievalKind: 'http_json',
      dataPath: '/shipment/status',
    },
    {
      name: 'Carrier public tracking page',
      url: 'https://www.example-carrier.test/track?id=1Z999AA10123456784',
      retrievalKind: 'http_html',
      dataPath: null,
    },
  ],
  evidenceRequirements: [
    'A delivery status string retrieved from an approved source.',
    'A delivery timestamp expressed as a UTC instant.',
  ],
  ambiguities: [
    {
      description:
        '"Arrives" was not qualified as arrival at the port or delivery to the consignee.',
      assumption:
        'Read as final delivery to the consignee, which is what the carrier reports as "delivered".',
    },
  ],
  edgeCases: [
    {
      scenario: 'The carrier reports "delivered" but with no timestamp attached.',
      outcome: 'INVALID',
    },
    {
      scenario: 'The shipment is marked returned to sender before the deadline.',
      outcome: 'NO',
    },
  ],
  risk: 'medium',
  settlement: {
    kind: 'binary_parimutuel',
    token: FIXTURE_TOKEN,
    tradingEndsAt: '2026-08-25T00:00:00Z',
    challengeWindowSeconds: 7200,
    challengeBondBaseUnits: '50000000',
    resolutionDeadlineSeconds: 604800,
  },
};

/**
 * A product-launch question - the prediction-market shape, which is one
 * application of the same primitive rather than the primitive itself.
 *
 * Exercises normalisation deliberately: the creator address is mixed case, the
 * deadline carries a non-UTC offset, strings have stray whitespace, and the
 * text contains a non-ASCII typographic apostrophe. All of that must normalise
 * or encode identically on every platform that reproduces the hash.
 */
export const productLaunchConditionSpec: ConditionSpecInput = {
  version: '1.0',
  nonce: '0xABCDEF0123456789abcdef0123456789ABCDEF0123456789abcdef0123456789',
  creator: '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa',
  question: '  Will Apple announce an iPhone priced under $500 before 31 December 2026?  ',
  conditionType: 'binary',
  successCondition:
    'Apple’s official newsroom publishes, before the deadline, an announcement of a new iPhone model with a US launch price strictly below USD 500.00 before tax.',
  failureCondition:
    'No such announcement appears on Apple’s official newsroom at or before the deadline.',
  deadline: '2026-12-31T18:59:59-05:00',
  timezone: 'America/New_York',
  resolutionMethod: 'deterministic_numeric_threshold',
  approvedSources: [
    {
      name: 'Apple Newsroom',
      url: 'https://www.apple.com/newsroom/',
      retrievalKind: 'http_html',
      dataPath: null,
    },
  ],
  evidenceRequirements: [
    'The announced US launch price in USD.',
    'The publication date of the announcement.',
    'The model name of the announced device.',
  ],
  ambiguities: [
    {
      description: '"Under $500" did not state whether tax or carrier subsidy is included.',
      assumption: 'Read as the pre-tax, unsubsidised US list price.',
    },
    {
      description: 'It was unclear whether refurbished or prior-generation models count.',
      assumption: 'Only newly announced models count.',
    },
  ],
  edgeCases: [
    { scenario: 'A device is announced at exactly USD 500.00.', outcome: 'NO' },
    {
      scenario: 'A qualifying device is announced but only outside the United States.',
      outcome: 'NO',
    },
    {
      scenario: 'Apple Newsroom is unreachable throughout the resolution window.',
      outcome: 'INVALID',
    },
  ],
  risk: 'high',
  settlement: {
    kind: 'binary_parimutuel',
    token: FIXTURE_TOKEN,
    tradingEndsAt: '2026-12-24T00:00:00Z',
    challengeWindowSeconds: 7200,
    challengeBondBaseUnits: '25000000',
    resolutionDeadlineSeconds: 259200,
  },
};

/** A minimal specification: every nullable field left empty, every set empty. */
export const minimalConditionSpec: ConditionSpecInput = {
  version: '1.0',
  nonce: '0x0000000000000000000000000000000000000000000000000000000000000001',
  creator: '0x2222222222222222222222222222222222222222',
  question: 'Did block 10000000 exist on X Layer before 2026-10-01T00:00:00Z?',
  conditionType: 'binary',
  successCondition:
    'The approved explorer reports block 10000000 with a timestamp before the deadline.',
  failureCondition: 'The approved explorer reports no block 10000000 at or before the deadline.',
  deadline: '2026-10-01T00:00:00Z',
  timezone: 'UTC',
  resolutionMethod: 'deterministic_event_occurrence',
  approvedSources: [
    {
      name: 'Explorer API',
      url: 'https://explorer.example.test/api/block/10000000',
      retrievalKind: 'http_json',
      dataPath: '/result/timestamp',
    },
  ],
  evidenceRequirements: ['The block timestamp as a UTC instant.'],
  ambiguities: [],
  edgeCases: [],
  risk: 'low',
  settlement: {
    kind: 'binary_parimutuel',
    token: FIXTURE_TOKEN,
    tradingEndsAt: '2026-09-30T00:00:00Z',
    challengeWindowSeconds: 7200,
    challengeBondBaseUnits: '0',
    resolutionDeadlineSeconds: 86400,
  },
};

export const conditionSpecFixtures = {
  shipment: shipmentConditionSpec,
  productLaunch: productLaunchConditionSpec,
  minimal: minimalConditionSpec,
} as const;

/**
 * An evidence package resolving the shipment condition to YES.
 *
 * Note the shape of an honest resolution: two deterministic checks ran and are
 * recorded, the extracted values travel as strings, and the confidence is an
 * integer basis-point figure that documents the resolver's certainty without
 * granting it any authority.
 */
export const deliveredEvidencePackage: EvidencePackageV1Input = {
  version: '1.0',
  chainId: 1952,
  marketId: '7',
  marketAddress: '0x3333333333333333333333333333333333333333',
  rulesHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
  outcome: 'YES',
  confidenceBps: 9800,
  reasoning:
    'The primary carrier source reported status "delivered" with delivery timestamp 2026-08-28T14:02:11Z, which is before the deadline of 2026-09-01T23:59:59Z. The deterministic deadline comparison decided the outcome; no interpretation was required.',
  sources: [
    {
      name: 'Carrier tracking API',
      url: 'https://api.example-carrier.test/v1/track/1Z999AA10123456784',
      retrievalKind: 'http_json',
      retrievedAt: '2026-09-02T00:05:00Z',
      httpStatus: 200,
      contentType: 'application/json',
      contentHash: '0x4444444444444444444444444444444444444444444444444444444444444444',
    },
  ],
  claims: [
    {
      sourceIndex: 0,
      statement: 'Reported shipment status.',
      valueType: 'string',
      value: 'delivered',
    },
    {
      sourceIndex: 0,
      statement: 'Reported delivery timestamp.',
      valueType: 'timestamp',
      value: '2026-08-28T14:02:11Z',
    },
  ],
  deterministicChecks: [
    {
      validator: 'status-equals',
      passed: true,
      detail: 'Reported status "delivered" matches the success condition exactly.',
    },
    {
      validator: 'deadline-comparison',
      passed: true,
      detail: 'Delivery at 2026-08-28T14:02:11Z precedes the deadline 2026-09-01T23:59:59Z.',
    },
  ],
  resolver: { version: '1.0.0', model: null },
  resolvedAt: '2026-09-02T00:05:30Z',
};

/**
 * An evidence package resolving to INVALID because the approved source could
 * not be reached. The engine records the failure rather than inventing a
 * result, and INVALID routes to refunds rather than to a winner.
 */
export const unreachableSourceEvidencePackage: EvidencePackageV1Input = {
  version: '1.0',
  chainId: 1952,
  marketId: '11',
  marketAddress: '0x5555555555555555555555555555555555555555',
  rulesHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
  outcome: 'INVALID',
  confidenceBps: 0,
  reasoning:
    'The single approved source returned HTTP 503 on every attempt within the resolution window. No fallback source was approved for this condition, and substituting an unapproved source is not permitted. The condition cannot be resolved on approved evidence.',
  sources: [
    {
      name: 'Explorer API',
      url: 'https://explorer.example.test/api/block/10000000',
      retrievalKind: 'http_json',
      retrievedAt: '2026-10-01T00:10:00Z',
      httpStatus: 503,
      contentType: null,
      contentHash: '0x6666666666666666666666666666666666666666666666666666666666666666',
    },
  ],
  claims: [],
  deterministicChecks: [
    {
      validator: 'source-availability',
      passed: false,
      detail: 'Approved source returned HTTP 503 on 5 of 5 attempts.',
    },
  ],
  resolver: { version: '1.0.0', model: null },
  resolvedAt: '2026-10-01T00:15:00Z',
};

// ---------------------------------------------------------------------------
// EvidencePackage v2.0 (Milestone 5.1)
// ---------------------------------------------------------------------------

/**
 * The frozen `rulesHash` of `shipmentConditionSpec`.
 *
 * Written as a literal rather than computed, for the same reason the golden
 * vectors are: a fixture that derived its own binding from the hashing code
 * would agree with that code by construction and could never catch it changing.
 * `evidence-package-v2.test.ts` asserts this literal equals
 * `hashConditionSpec(shipmentConditionSpec)`, so a drift in either breaks
 * loudly. The value is the one committed in `vectors/golden.json`.
 */
const SHIPMENT_RULES_HASH =
  '0x739735cae491d20d3242742eda9d9efcdf1ef0e6d34a2cbca7555ed868ff6e97';

/** The frozen `rulesHash` of `productLaunchConditionSpec`. Same discipline. */
const PRODUCT_LAUNCH_RULES_HASH =
  '0x642729c0448c1e2a38ccddd00baae7b04dd5364df9bcdab40e2cdebea3cba1cf';

/** Identity of the market these fixtures resolve. Shared, so hashes differ only where meant. */
const SHIPMENT_MARKET = {
  chainId: 1952,
  marketId: '7',
  marketAddress: '0x3333333333333333333333333333333333333333',
  rulesHash: SHIPMENT_RULES_HASH,
} as const;

/** The two sources `shipmentConditionSpec` approves, in its precedence order. */
const CARRIER_API_URL = 'https://api.example-carrier.test/v1/track/1Z999AA10123456784';
const CARRIER_PAGE_URL = 'https://www.example-carrier.test/track?id=1Z999AA10123456784';

/**
 * The shape of an honest resolution: the primary source answered, two claims
 * were extracted by JSON pointer — so anyone holding the same bytes can
 * re-extract them — and two deterministic checks decided the outcome before any
 * model was consulted. `resolver.model` is null because none was needed.
 */
export const shipmentYesEvidence: EvidencePackageV2Input = {
  version: '2.0',
  ...SHIPMENT_MARKET,
  outcome: 'YES',
  confidenceBps: 9800,
  reasoning:
    'The primary approved source reported status "delivered" with delivery timestamp 2026-08-28T14:02:11Z, which precedes the deadline of 2026-09-01T23:59:59Z. Both deterministic checks passed and decided the outcome; no interpretation was required.',
  sources: [
    {
      sourceId: 'carrier-api',
      approvedSourceIndex: 0,
      name: 'Carrier tracking API',
      url: CARRIER_API_URL,
      retrievalKind: 'http_json',
      status: 'RETRIEVED',
      retrievedAt: '2026-09-02T00:05:00Z',
      contentHash: '0x4444444444444444444444444444444444444444444444444444444444444444',
    },
  ],
  claims: [
    {
      claimId: 'reported-status',
      sourceIds: ['carrier-api'],
      statement: 'Reported shipment status.',
      valueType: 'string',
      value: 'delivered',
      support: 'SUPPORTED',
      extraction: { method: 'JSON_POINTER', locator: '/shipment/status' },
    },
    {
      claimId: 'delivery-timestamp',
      sourceIds: ['carrier-api'],
      statement: 'Reported delivery timestamp.',
      valueType: 'timestamp',
      value: '2026-08-28T14:02:11Z',
      support: 'SUPPORTED',
      extraction: { method: 'JSON_POINTER', locator: '/shipment/deliveredAt' },
    },
  ],
  deterministicChecks: [
    {
      checkId: 'status-matches',
      checkType: 'STRING_MATCH',
      sourceIds: ['carrier-api'],
      expected: 'shipment status == "delivered"',
      observed: 'delivered',
      result: 'PASS',
      explanation: 'Matches the success condition exactly, with no normalisation applied.',
    },
    {
      checkId: 'delivered-before-deadline',
      checkType: 'DATE_BEFORE_DEADLINE',
      sourceIds: ['carrier-api'],
      expected: 'delivery timestamp <= 2026-09-01T23:59:59Z',
      observed: '2026-08-28T14:02:11Z',
      result: 'PASS',
      explanation: null,
    },
  ],
  resolver: { version: '1.0.0', model: null },
  resolvedAt: '2026-09-02T00:05:30Z',
};

/**
 * The same market resolving the other way: the shipment was still moving when
 * the deadline passed. A NO is a positive determination, not the absence of a
 * YES, so it carries the same evidence burden.
 */
export const shipmentNoEvidence: EvidencePackageV2Input = {
  version: '2.0',
  ...SHIPMENT_MARKET,
  outcome: 'NO',
  confidenceBps: 9600,
  reasoning:
    'The primary approved source reported status "in_transit" at the deadline of 2026-09-01T23:59:59Z and published no delivery timestamp. The failure condition is therefore met on approved evidence.',
  sources: [
    {
      sourceId: 'carrier-api',
      approvedSourceIndex: 0,
      name: 'Carrier tracking API',
      url: CARRIER_API_URL,
      retrievalKind: 'http_json',
      status: 'RETRIEVED',
      retrievedAt: '2026-09-02T00:05:00Z',
      contentHash: '0xaaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111',
    },
  ],
  claims: [
    {
      claimId: 'reported-status',
      sourceIds: ['carrier-api'],
      statement: 'Reported shipment status.',
      valueType: 'string',
      value: 'in_transit',
      support: 'SUPPORTED',
      extraction: { method: 'JSON_POINTER', locator: '/shipment/status' },
    },
    {
      claimId: 'delivery-timestamp',
      sourceIds: ['carrier-api'],
      statement: 'Reported delivery timestamp.',
      valueType: 'timestamp',
      value: null,
      support: 'UNSUPPORTED',
      extraction: { method: 'NONE', locator: null },
    },
  ],
  deterministicChecks: [
    {
      checkId: 'status-matches',
      checkType: 'STRING_MATCH',
      sourceIds: ['carrier-api'],
      expected: 'shipment status == "delivered"',
      observed: 'in_transit',
      result: 'FAIL',
      explanation: null,
    },
  ],
  resolver: { version: '1.0.0', model: null },
  resolvedAt: '2026-09-02T00:05:30Z',
};

/**
 * Precedence in action: the primary source was unreachable, so the approved
 * fallback decided the outcome.
 *
 * This is why `sources` is ordered. Reading the fallback because the primary
 * failed and reading it because it happened to be first are different resolution
 * behaviours, and the hash distinguishes them.
 */
export const shipmentMultiSourceEvidence: EvidencePackageV2Input = {
  version: '2.0',
  ...SHIPMENT_MARKET,
  outcome: 'YES',
  confidenceBps: 8800,
  reasoning:
    'The primary approved source was unavailable throughout the resolution window. The approved fallback, which the specification ranks second, reported delivery on 2026-08-28. The outcome rests on the fallback alone, which is why confidence is lower than a two-source agreement would justify.',
  sources: [
    {
      sourceId: 'carrier-api',
      approvedSourceIndex: 0,
      name: 'Carrier tracking API',
      url: CARRIER_API_URL,
      retrievalKind: 'http_json',
      status: 'UNAVAILABLE',
      retrievedAt: '2026-09-02T00:01:00Z',
      contentHash: null,
    },
    {
      sourceId: 'carrier-page',
      approvedSourceIndex: 1,
      name: 'Carrier public tracking page',
      url: CARRIER_PAGE_URL,
      retrievalKind: 'http_html',
      status: 'RETRIEVED',
      retrievedAt: '2026-09-02T00:03:00Z',
      contentHash: '0xbbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222',
    },
  ],
  claims: [
    {
      claimId: 'reported-status',
      sourceIds: ['carrier-page'],
      statement: 'Status shown on the public tracking page.',
      valueType: 'string',
      value: 'Delivered',
      support: 'SUPPORTED',
      extraction: { method: 'CSS_SELECTOR', locator: '#tracking-status .state' },
    },
    {
      claimId: 'delivery-date',
      sourceIds: ['carrier-page'],
      statement: 'Delivery date shown on the public tracking page.',
      valueType: 'timestamp',
      value: '2026-08-28T00:00:00Z',
      support: 'SUPPORTED',
      extraction: { method: 'CSS_SELECTOR', locator: '#tracking-status time[datetime]' },
    },
  ],
  deterministicChecks: [
    {
      checkId: 'primary-available',
      checkType: 'SOURCE_AVAILABLE',
      sourceIds: ['carrier-api'],
      expected: 'primary approved source responds within the resolution window',
      observed: 'no response on 5 of 5 attempts',
      result: 'FAIL',
      explanation: 'Precedence fell through to the approved fallback.',
    },
    {
      checkId: 'fallback-available',
      checkType: 'SOURCE_AVAILABLE',
      sourceIds: ['carrier-page'],
      expected: 'fallback approved source responds within the resolution window',
      observed: 'responded on the first attempt',
      result: 'PASS',
      explanation: null,
    },
    {
      checkId: 'delivered-before-deadline',
      checkType: 'DATE_BEFORE_DEADLINE',
      sourceIds: ['carrier-page'],
      expected: 'delivery date <= 2026-09-01T23:59:59Z',
      observed: '2026-08-28T00:00:00Z',
      result: 'PASS',
      explanation: null,
    },
  ],
  resolver: { version: '1.0.0', model: null },
  resolvedAt: '2026-09-02T00:04:00Z',
};

/**
 * A claim set exercising all three support states and both extraction families.
 *
 * `carrier-note` is the case worth reading: a model read a free-text field, and
 * the package says so. An auditor can see at a glance which claims rest on a
 * locator anyone can re-run and which rest on a model's reading.
 */
export const shipmentMultiClaimEvidence: EvidencePackageV2Input = {
  version: '2.0',
  ...SHIPMENT_MARKET,
  outcome: 'YES',
  confidenceBps: 9100,
  reasoning:
    'The primary source reports delivery before the deadline. The two sources disagree on the delivery time by four hours, which does not affect the outcome because both fall before the deadline; the disagreement is recorded rather than smoothed over. The consignee name could not be established from approved evidence and is not required by the condition.',
  sources: [
    {
      sourceId: 'carrier-api',
      approvedSourceIndex: 0,
      name: 'Carrier tracking API',
      url: CARRIER_API_URL,
      retrievalKind: 'http_json',
      status: 'RETRIEVED',
      retrievedAt: '2026-09-02T00:05:00Z',
      contentHash: '0xcccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333',
    },
    {
      sourceId: 'carrier-page',
      approvedSourceIndex: 1,
      name: 'Carrier public tracking page',
      url: CARRIER_PAGE_URL,
      retrievalKind: 'http_html',
      status: 'RETRIEVED',
      retrievedAt: '2026-09-02T00:05:10Z',
      contentHash: '0xdddd4444dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444',
    },
  ],
  claims: [
    {
      claimId: 'reported-status',
      sourceIds: ['carrier-api', 'carrier-page'],
      statement: 'Reported shipment status.',
      valueType: 'string',
      value: 'delivered',
      support: 'SUPPORTED',
      extraction: { method: 'JSON_POINTER', locator: '/shipment/status' },
    },
    {
      claimId: 'delivery-timestamp',
      sourceIds: ['carrier-api', 'carrier-page'],
      statement: 'Reported delivery timestamp.',
      valueType: 'timestamp',
      value: '2026-08-28T14:02:11Z',
      support: 'DISPUTED',
      extraction: { method: 'JSON_POINTER', locator: '/shipment/deliveredAt' },
    },
    {
      claimId: 'consignee-name',
      sourceIds: ['carrier-api', 'carrier-page'],
      statement: 'Name of the party who signed for the shipment.',
      valueType: 'string',
      value: null,
      support: 'UNSUPPORTED',
      extraction: { method: 'NONE', locator: null },
    },
    {
      claimId: 'carrier-note',
      sourceIds: ['carrier-page'],
      statement: 'The tracking page states the parcel was left with the building concierge.',
      valueType: 'boolean',
      value: 'true',
      support: 'SUPPORTED',
      extraction: { method: 'MODEL_EXTRACTION', locator: null },
    },
    {
      claimId: 'scan-count',
      sourceIds: ['carrier-api'],
      statement: 'Number of tracking scans recorded for the shipment.',
      valueType: 'integer',
      value: '14',
      support: 'SUPPORTED',
      extraction: { method: 'REGEX', locator: '"scans"\\s*:\\s*\\[(.*?)\\]' },
    },
  ],
  deterministicChecks: [
    {
      checkId: 'delivered-before-deadline',
      checkType: 'DATE_BEFORE_DEADLINE',
      sourceIds: ['carrier-api'],
      expected: 'delivery timestamp <= 2026-09-01T23:59:59Z',
      observed: '2026-08-28T14:02:11Z',
      result: 'PASS',
      explanation: 'The disputed alternative reading, 2026-08-28T18:00:00Z, also passes.',
    },
  ],
  resolver: { version: '1.0.0', model: 'claude-haiku-4-5-20251001' },
  resolvedAt: '2026-09-02T00:06:00Z',
};

/**
 * Every deterministic check type this build knows, run once, including an
 * `INDETERMINATE` result.
 *
 * The vocabulary is closed and this fixture is what keeps it honest: adding a
 * member without adding it here leaves the new validator unexercised by any
 * golden vector.
 */
export const checkVocabularyEvidence: EvidencePackageV2Input = {
  version: '2.0',
  ...SHIPMENT_MARKET,
  outcome: 'YES',
  confidenceBps: 9500,
  reasoning:
    'Every deterministic validator this build knows was run against the primary source. One could not run, because the source published no declared-value field, and is recorded as INDETERMINATE rather than as a pass or a failure. The outcome rests on the checks that did run.',
  sources: [
    {
      sourceId: 'carrier-api',
      approvedSourceIndex: 0,
      name: 'Carrier tracking API',
      url: CARRIER_API_URL,
      retrievalKind: 'http_json',
      status: 'RETRIEVED',
      retrievedAt: '2026-09-02T00:05:00Z',
      contentHash: '0xeeee5555eeee5555eeee5555eeee5555eeee5555eeee5555eeee5555eeee5555',
    },
  ],
  claims: [
    {
      claimId: 'reported-status',
      sourceIds: ['carrier-api'],
      statement: 'Reported shipment status.',
      valueType: 'string',
      value: 'delivered',
      support: 'SUPPORTED',
      extraction: { method: 'JSON_POINTER', locator: '/shipment/status' },
    },
  ],
  deterministicChecks: [
    {
      checkId: 'source-available',
      checkType: 'SOURCE_AVAILABLE',
      sourceIds: ['carrier-api'],
      expected: 'primary approved source responds within the resolution window',
      observed: 'responded on the first attempt',
      result: 'PASS',
      explanation: null,
    },
    {
      checkId: 'status-string',
      checkType: 'STRING_MATCH',
      sourceIds: ['carrier-api'],
      expected: 'shipment status == "delivered"',
      observed: 'delivered',
      result: 'PASS',
      explanation: null,
    },
    {
      checkId: 'signature-flag',
      checkType: 'BOOLEAN_MATCH',
      sourceIds: ['carrier-api'],
      expected: 'signatureRequired == true',
      observed: 'true',
      result: 'PASS',
      explanation: null,
    },
    {
      checkId: 'scan-count-range',
      checkType: 'NUMERIC_COMPARISON',
      sourceIds: ['carrier-api'],
      expected: 'scan count >= 1',
      observed: '14',
      result: 'PASS',
      explanation: null,
    },
    {
      checkId: 'declared-value-floor',
      checkType: 'PRICE_ABOVE_THRESHOLD',
      sourceIds: ['carrier-api'],
      expected: 'declared value > USD 0.00',
      observed: null,
      result: 'INDETERMINATE',
      explanation: 'The source published no declared-value field, so nothing was observed.',
    },
    {
      checkId: 'declared-value-ceiling',
      checkType: 'PRICE_BELOW_THRESHOLD',
      sourceIds: ['carrier-api'],
      expected: 'declared value < USD 100000.00',
      observed: 'USD 2450.00',
      result: 'PASS',
      explanation: 'Read from the customs block rather than the shipment block.',
    },
    {
      checkId: 'delivered-before-deadline',
      checkType: 'DATE_BEFORE_DEADLINE',
      sourceIds: ['carrier-api'],
      expected: 'delivery timestamp <= 2026-09-01T23:59:59Z',
      observed: '2026-08-28T14:02:11Z',
      result: 'PASS',
      explanation: null,
    },
    {
      checkId: 'shipped-after-order',
      checkType: 'DATE_AFTER_DEADLINE',
      sourceIds: ['carrier-api'],
      expected: 'dispatch timestamp >= 2026-08-20T00:00:00Z',
      observed: '2026-08-21T09:14:00Z',
      result: 'PASS',
      explanation: null,
    },
  ],
  resolver: { version: '1.0.0', model: null },
  resolvedAt: '2026-09-02T00:07:00Z',
};

/**
 * An INVALID resolution: no approved source could be read.
 *
 * The engine records the failure instead of substituting an unapproved source or
 * guessing, and INVALID routes to refunds rather than to a winner. Note the
 * second source: approved, never attempted because the first attempt exhausted
 * the window, and recorded as `NOT_ATTEMPTED` with a null `contentHash` rather
 * than given a fabricated one.
 */
export const shipmentInvalidEvidence: EvidencePackageV2Input = {
  version: '2.0',
  ...SHIPMENT_MARKET,
  outcome: 'INVALID',
  confidenceBps: 0,
  reasoning:
    'Neither approved source could be read within the resolution window: the primary returned no response on every attempt and the fallback was never reached before the window closed. Substituting an unapproved source is not permitted, so the condition cannot be decided on approved evidence.',
  sources: [
    {
      sourceId: 'carrier-api',
      approvedSourceIndex: 0,
      name: 'Carrier tracking API',
      url: CARRIER_API_URL,
      retrievalKind: 'http_json',
      status: 'UNAVAILABLE',
      retrievedAt: '2026-09-02T00:00:00Z',
      contentHash: null,
    },
    {
      sourceId: 'carrier-page',
      approvedSourceIndex: 1,
      name: 'Carrier public tracking page',
      url: CARRIER_PAGE_URL,
      retrievalKind: 'http_html',
      status: 'NOT_ATTEMPTED',
      retrievedAt: '2026-09-02T00:00:00Z',
      contentHash: null,
    },
  ],
  claims: [],
  deterministicChecks: [
    {
      checkId: 'primary-available',
      checkType: 'SOURCE_AVAILABLE',
      sourceIds: ['carrier-api'],
      expected: 'primary approved source responds within the resolution window',
      observed: 'no response on 5 of 5 attempts',
      result: 'FAIL',
      explanation: null,
    },
    {
      checkId: 'fallback-available',
      checkType: 'SOURCE_AVAILABLE',
      sourceIds: ['carrier-page'],
      expected: 'fallback approved source responds within the resolution window',
      observed: null,
      result: 'INDETERMINATE',
      explanation: 'The resolution window closed before the fallback was attempted.',
    },
  ],
  resolver: { version: '1.0.0', model: null },
  resolvedAt: '2026-09-02T00:10:00Z',
};

/**
 * The YES resolution with a different confidence and nothing else changed.
 *
 * Confidence is inside the hash even though it authorises nothing, because a
 * resolver that later claimed to have been more certain than it was would be
 * rewriting the record. Derived by spread so the delta is the whole diff.
 */
export const shipmentLowConfidenceEvidence: EvidencePackageV2Input = {
  ...shipmentYesEvidence,
  confidenceBps: 5100,
};

/**
 * The YES resolution offered for a different agreement.
 *
 * Byte-identical to `shipmentYesEvidence` apart from `rulesHash`, so its only
 * job is to prove the binding is inside the digest — and that
 * `assertEvidenceBinding` refuses it for the shipment market.
 */
export const shipmentYesForOtherRulesEvidence: EvidencePackageV2Input = {
  ...shipmentYesEvidence,
  rulesHash: PRODUCT_LAUNCH_RULES_HASH,
};

/**
 * `shipmentMultiSourceEvidence` with its two sources swapped.
 *
 * Semantically a different resolution — it says the fallback was consulted
 * first — so it must hash differently. Every claim still resolves, because
 * claims cite `sourceId` rather than a position, which is exactly why the
 * permutation is legible instead of silently repointing the evidence.
 */
export const shipmentSourceOrderSwappedEvidence: EvidencePackageV2Input = {
  ...shipmentMultiSourceEvidence,
  sources: [
    shipmentMultiSourceEvidence.sources[1]!,
    shipmentMultiSourceEvidence.sources[0]!,
  ],
};

/**
 * `shipmentYesEvidence` with one claim's value changed, and nothing else.
 *
 * The smallest meaningful edit an auditor would want caught: the delivery
 * timestamp now falls after the deadline, which contradicts the outcome the
 * package still asserts. The schema cannot detect that contradiction — a human
 * or a validator must — but the hash makes the edit undeniable.
 */
export const shipmentClaimEditedEvidence: EvidencePackageV2Input = {
  ...shipmentYesEvidence,
  claims: [
    shipmentYesEvidence.claims[0]!,
    { ...shipmentYesEvidence.claims[1]!, value: '2026-09-04T14:02:11Z' },
  ],
};

/**
 * Every shipped evidence package fixture, keyed by name.
 *
 * v1.0 entries come first and their positions are load-bearing: the Solidity
 * golden-vector test reads `evidencePackages[0]`, and the committed vector file
 * is asserted against, not regenerated.
 */
export const evidencePackageFixtures = {
  delivered: deliveredEvidencePackage,
  unreachableSource: unreachableSourceEvidencePackage,
  v2ShipmentYes: shipmentYesEvidence,
  v2ShipmentNo: shipmentNoEvidence,
  v2MultiSource: shipmentMultiSourceEvidence,
  v2MultiClaim: shipmentMultiClaimEvidence,
  v2CheckVocabulary: checkVocabularyEvidence,
  v2Invalid: shipmentInvalidEvidence,
  v2LowConfidence: shipmentLowConfidenceEvidence,
  v2OtherRules: shipmentYesForOtherRulesEvidence,
  v2SourceOrderSwapped: shipmentSourceOrderSwappedEvidence,
  v2ClaimEdited: shipmentClaimEditedEvidence,
} as const;

/** The v2.0 fixtures alone, for tests that are about the current schema. */
export const evidencePackageV2Fixtures = {
  shipmentYes: shipmentYesEvidence,
  shipmentNo: shipmentNoEvidence,
  multiSource: shipmentMultiSourceEvidence,
  multiClaim: shipmentMultiClaimEvidence,
  checkVocabulary: checkVocabularyEvidence,
  invalid: shipmentInvalidEvidence,
  lowConfidence: shipmentLowConfidenceEvidence,
  otherRules: shipmentYesForOtherRulesEvidence,
  sourceOrderSwapped: shipmentSourceOrderSwappedEvidence,
  claimEdited: shipmentClaimEditedEvidence,
} as const;
