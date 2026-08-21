/**
 * The API client and the wallet plumbing.
 *
 * Two boundaries, kept apart:
 *
 * - `api.*` talks to the backend. Every response is `{ data }` or `{ error }`,
 *   so there is one place that branches on it and one shape of failure.
 * - `wallet.*` talks to the injected provider. It signs and it sends; it never
 *   computes a hash the protocol cares about and it never decides an outcome.
 *
 * ## Why the contract calls are hand-encoded
 *
 * There is no bundler here, so there is no ethers or viem in the page. The four
 * calls the demo needs — `approve`, `stake`, `challenge`, `claim` — take only
 * static types (`address`, `uint256`, `uint8`, `bytes32`), which ABI-encode as
 * 32-byte words with no offsets, no dynamic tails and no edge cases. That is
 * about twenty lines and it is exact.
 *
 * The selectors are **precomputed constants with their signatures written next
 * to them**, because keccak256 is not available in a browser without a library.
 * Each is checkable against `packages/contracts/abi/ConditionalMarket.json` with
 * one command, and `web-selectors.test.ts` in the backend suite recomputes all
 * of them from the compiled ABI and fails if any drifts.
 *
 * ## What this file cannot do
 *
 * It cannot produce an `evidenceHash` or a `rulesHash`. Those come from
 * `@covenant/shared` on the server, which is the only implementation of either
 * (ADR-0001). The page displays them and links to them; it never derives one.
 */

const API_BASE = window.COVENANT_API_BASE ?? 'http://127.0.0.1:8080';
const TOKEN_KEY = 'covenant.session';

// --- backend ---------------------------------------------------------------

export class ApiError extends Error {
  constructor(status, code, message, issues) {
    super(message);
    this.status = status;
    this.code = code;
    this.issues = issues ?? [];
  }
}

async function request(method, path, body) {
  const token = sessionToken();
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token !== null) headers.authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    throw new ApiError(0, 'NETWORK', `Could not reach the API at ${API_BASE}.`);
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = text === '' ? null : JSON.parse(text);
  } catch {
    throw new ApiError(response.status, 'MALFORMED', 'The API returned a response that is not JSON.');
  }

  if (!response.ok || (payload !== null && 'error' in payload)) {
    const error = payload?.error ?? {};
    throw new ApiError(
      response.status,
      error.code ?? 'UNKNOWN',
      error.message ?? `Request failed with ${response.status}.`,
      error.issues,
    );
  }

  return payload?.data ?? null;
}

export function sessionToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setSession(token, address) {
  if (token === null) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(`${TOKEN_KEY}.address`);
    return;
  }
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(`${TOKEN_KEY}.address`, address);
}

export function sessionAddress() {
  return localStorage.getItem(`${TOKEN_KEY}.address`);
}

export const api = {
  health: () => request('GET', '/health'),
  listMarkets: (query = '') => request('GET', `/api/markets${query}`),
  getMarket: (id) => request('GET', `/api/markets/${id}`),
  getResolution: (id) => request('GET', `/api/markets/${id}/resolution`),
  getEvidence: (id) => request('GET', `/api/markets/${id}/evidence`),

  compile: (message, chainId, sessionId) =>
    request('POST', '/api/markets/compile', {
      message,
      chainId,
      ...(sessionId === undefined ? {} : { sessionId }),
    }),

  register: (specification, rulesHash, validationPlan) =>
    request('POST', '/api/markets', {
      specification,
      rulesHash,
      ...(validationPlan === undefined ? {} : { validationPlan }),
    }),

  setValidationPlan: (id, validationPlan) =>
    request('POST', `/api/markets/${id}/validation-plan`, { validationPlan }),

  resolve: (id, options = {}) => request('POST', `/api/markets/${id}/resolve`, options),
  challengePrepare: (id, reason) =>
    request('POST', `/api/markets/${id}/challenge/prepare`, { reason }),
  challenge: (id, reason, txHash) => request('POST', `/api/markets/${id}/challenge`, { reason, txHash }),
  finalize: (id) => request('POST', `/api/markets/${id}/finalize`, {}),

  authNonce: (address) => request('POST', '/api/auth/nonce', { address }),
  authVerify: (nonce, signature) => request('POST', '/api/auth/verify', { nonce, signature }),
  me: () => request('GET', '/api/auth/me'),
  logout: () => request('POST', '/api/auth/logout', {}),
};

// --- wallet ----------------------------------------------------------------

function provider() {
  const injected = window.ethereum;
  if (injected === undefined || injected === null) {
    throw new Error('No wallet found. Install a browser wallet and reload this page.');
  }
  return injected;
}

/**
 * Function selectors, with the signature each was computed from.
 *
 * Verify any of them:
 *   node -e "console.log(require('viem').toFunctionSelector('stake(uint8,uint256)'))"
 *
 * `web-selectors.test.ts` does exactly that for all five, against the compiled
 * ABI, so a drift here fails the backend suite rather than the demo.
 */
export const SELECTOR = {
  /** approve(address,uint256) */
  approve: '0x095ea7b3',
  /** stake(uint8,uint256) */
  stake: '0xdd752e55',
  /** challenge(bytes32) */
  challenge: '0xcffd46dc',
  /** claim() */
  claim: '0x4e71d92d',
  /** withdrawRefund() */
  withdrawRefund: '0x110f8874',
  /** claimChallengeBond() */
  claimChallengeBond: '0xd9478509',
};

/** Left-pad a hex value to one 32-byte word. Static types only — see the header. */
function word(value) {
  const hex = (typeof value === 'bigint' ? value.toString(16) : String(value).replace(/^0x/, ''));
  if (hex.length > 64) throw new Error('value does not fit in one word');
  return hex.padStart(64, '0');
}

export function encode(selector, ...args) {
  return selector + args.map(word).join('');
}

export const wallet = {
  available: () => window.ethereum !== undefined && window.ethereum !== null,

  async connect() {
    const accounts = await provider().request({ method: 'eth_requestAccounts' });
    const address = accounts?.[0];
    if (address === undefined) throw new Error('The wallet returned no account.');
    return address.toLowerCase();
  },

  async chainId() {
    const hex = await provider().request({ method: 'eth_chainId' });
    return Number.parseInt(hex, 16);
  },

  /**
   * Sign in.
   *
   * The server renders the message and the wallet signs exactly those bytes
   * (ADR-0014). The page never composes a SIWE message, so there is nothing here
   * a client could vary — which is the whole reason verification can rebuild the
   * message from its own stored fields.
   */
  async signIn() {
    const address = await this.connect();
    const challenge = await api.authNonce(address);
    const signature = await provider().request({
      method: 'personal_sign',
      params: [challenge.message, address],
    });
    const result = await api.authVerify(challenge.nonce, signature);
    setSession(result.token, result.wallet.address);
    return result.wallet;
  },

  async send(to, data) {
    const from = await this.connect();
    return provider().request({
      method: 'eth_sendTransaction',
      params: [{ from, to, data }],
    });
  },

  /** Poll for a receipt. Returns null if it has not been mined within the wait. */
  async waitForReceipt(txHash, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const receipt = await provider().request({
        method: 'eth_getTransactionReceipt',
        params: [txHash],
      });
      if (receipt !== null && receipt !== undefined) return receipt;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  },
};

// --- formatting ------------------------------------------------------------

/** Base units → a decimal string. Integer arithmetic only; never a float. */
export function formatUnits(baseUnits, decimals = 6) {
  const value = BigInt(baseUnits ?? '0');
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals === 0 ? '' : `.${digits.slice(digits.length - decimals)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

export function shortHash(value, lead = 10, tail = 8) {
  if (typeof value !== 'string' || value.length <= lead + tail + 2) return value ?? '—';
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

export function formatInstant(value) {
  if (value === null || value === undefined) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * The block explorer, from the backend's own network record.
 *
 * X Layer testnet has no confirmed explorer API in this deployment
 * (BUILD_STATE, Known issues), so a transaction is shown as its hash with a
 * copy affordance rather than as a link that might 404. When an explorer is
 * confirmed, this is the one place to add it.
 */
export function txDisplay(txHash) {
  return txHash === null || txHash === undefined ? '—' : shortHash(txHash, 12, 10);
}
