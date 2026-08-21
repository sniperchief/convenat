/**
 * The end-to-end demo driver.
 *
 *   npm run build --workspace @covenant/backend
 *   node --env-file=../../.env dist/tools/demo.js <step>
 *
 * Steps, in order:
 *
 *   register   sign in as Wallet A, register the demo specification and its
 *              acceptance criteria through the real API
 *   status     print where the market is, on-chain and off
 *   stake      Wallet A stakes YES, Wallet B stakes NO (approve + stake each)
 *   resolve    trigger the resolution pipeline; the resolver proposes on-chain
 *   challenge  Wallet B contests the standing proposal and records its argument
 *   finalize   close the market once the challenge window has run
 *   claim      the winner withdraws; balances are printed before and after
 *   all        register → status, then tell you what to run next and when
 *
 * ## Why a driver rather than a script that runs start to finish
 *
 * Because M4 already learned this the hard way: the first lifecycle script
 * assumed one uninterrupted process and died after eleven minutes with real
 * money staked in two live markets and no way to resume. Every step here derives
 * what to do from **on-chain state**, so each is independently re-runnable and
 * running one twice is not a second transaction.
 *
 * ## What it does not do
 *
 * It does not propose. `resolve` asks the API to run the pipeline; the resolver
 * key is the server's and this process never holds it. It does not compute a
 * payout — it reads `previewClaim` from the contract. And it does not fabricate
 * a result: every step prints what the chain actually reports.
 */

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { conditionalMarketAbi, erc20ReadAbi } from '../chain/abi.js';

// --- ABI fragments this tool needs and the backend deliberately lacks --------
//
// `stake`, `approve` and `claim` move a *user's* funds, so they are absent from
// `chain/abi.ts` — the backend must not be able to encode one. This is a local
// operator script signing with a wallet's own key, which is a different actor
// with different authority, so the fragments live here and nowhere else.
const participantAbi = [
  {
    type: 'function',
    name: 'stake',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'side', type: 'uint8' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'challenge',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'reasonHash', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'claim',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [{ name: 'payout', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'withdrawRefund',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [{ name: 'amount', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'claimChallengeBond',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [{ name: 'amount', type: 'uint256' }],
  },
] as const;

const erc20WriteAbi = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

/**
 * `createMarket` takes a **struct**, not seven flat arguments.
 *
 * Written flat the first time, which produced the selector for
 * `createMarket(address,bytes32,uint64,uint64,uint32,uint32,uint256)` — a
 * function that does not exist — so every call reverted with no reason string.
 * The real signature is `createMarket((address,bytes32,uint64,uint64,uint32,
 * uint32,uint256))` and it returns two values.
 *
 * Transcribed from `packages/contracts/abi/MarketFactory.json`, which is written
 * straight from the compiler's output. This is the failure mode
 * `abi-parity.test.ts` and `web-selectors.test.ts` exist to prevent; this file
 * is a local operator script outside both, and it paid for that.
 */
const factoryCreateAbi = [
  {
    type: 'function',
    name: 'createMarket',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'token', type: 'address' },
          { name: 'rulesHash', type: 'bytes32' },
          { name: 'tradingEndsAt', type: 'uint64' },
          { name: 'conditionDeadline', type: 'uint64' },
          { name: 'challengeWindow', type: 'uint32' },
          { name: 'resolutionWindow', type: 'uint32' },
          { name: 'challengeBond', type: 'uint256' },
        ],
      },
    ],
    outputs: [
      { name: 'marketId', type: 'uint256' },
      { name: 'market', type: 'address' },
    ],
  },
  {
    type: 'function',
    name: 'marketByRulesHash',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'bytes32' }],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

// ---------------------------------------------------------------------------

const API = process.env['API_BASE_URL']?.trim() ?? 'http://127.0.0.1:8080';
const REPO_ROOT = resolvePath(process.cwd(), '..', '..');
const DEMO_PATH = resolvePath(REPO_ROOT, 'packages/contracts/deployments/xlayer-testnet-demo.json');

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is not set.`);
  return value;
}

interface DemoDocument {
  chainId: number;
  factory: Address;
  creator: string;
  market: {
    rulesHash: Hex;
    specification: Record<string, unknown>;
    validationPlan: Record<string, unknown>;
    createMarketParams: {
      token: Address;
      rulesHash: Hex;
      tradingEndsAt: number;
      conditionDeadline: number;
      challengeWindow: number;
      resolutionWindow: number;
      challengeBond: string;
    };
  };
}

function loadDemo(): DemoDocument {
  return JSON.parse(readFileSync(DEMO_PATH, 'utf8')) as DemoDocument;
}

const rpcUrl = (): string =>
  process.env['XLAYER_RPC_URL']?.trim() ??
  process.env['XLAYER_TESTNET_RPC_URL']?.trim() ??
  'https://testrpc.xlayer.tech/terigon';

const publicClient = () => createPublicClient({ transport: http(rpcUrl(), { timeout: 60_000 }) });

function walletFor(key: string) {
  const account = privateKeyToAccount(requireEnv(key) as Hex);
  return {
    account,
    client: createWalletClient({ account, transport: http(rpcUrl(), { timeout: 60_000 }) }),
  };
}

/** Six-decimal base units → a readable decimal. Integer arithmetic only. */
function tusd(value: bigint): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(7, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -6)}.${digits.slice(-6)}`;
}

async function send(label: string, run: () => Promise<Hex>): Promise<Hex> {
  const hash = await run();
  process.stdout.write(`  ${label.padEnd(28)} ${hash} `);
  const receipt = await publicClient().waitForTransactionReceipt({ hash, timeout: 180_000 });
  // A hash is not a result: a mined revert is a failure and is reported as one.
  console.log(receipt.status === 'success' ? '✓' : '✗ REVERTED');
  if (receipt.status !== 'success') throw new Error(`${label} reverted`);
  return hash;
}

// --- API ---------------------------------------------------------------------

async function apiCall(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token !== undefined) headers['authorization'] = `Bearer ${token}`;

  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    // Spread rather than an explicit `undefined`: `exactOptionalPropertyTypes`
    // distinguishes "absent" from "present and undefined", and `RequestInit`
    // means the first.
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const payload = text === '' ? null : JSON.parse(text);

  if (!response.ok || (payload !== null && 'error' in payload)) {
    throw new Error(
      `${method} ${path} → ${response.status}: ${JSON.stringify(payload?.error ?? payload)}`,
    );
  }
  return payload?.data ?? null;
}

/**
 * Sign in over the real SIWE exchange.
 *
 * The server renders the message; this signs exactly those bytes and sends back
 * a signature. A private key never leaves this process.
 */
async function signIn(keyEnv: string): Promise<{ token: string; address: string }> {
  const account = privateKeyToAccount(requireEnv(keyEnv) as Hex);
  const challenge = (await apiCall('POST', '/api/auth/nonce', { address: account.address })) as {
    message: string;
    nonce: string;
  };
  const signature = await account.signMessage({ message: challenge.message });
  const verified = (await apiCall('POST', '/api/auth/verify', {
    nonce: challenge.nonce,
    signature,
  })) as { token: string; wallet: { address: string } };
  return { token: verified.token, address: verified.wallet.address };
}

// --- steps -------------------------------------------------------------------

async function stepRegister(): Promise<void> {
  const demo = loadDemo();
  const session = await signIn('WALLET_A_PRIVATE_KEY');
  console.log(`signed in as ${session.address}`);

  const result = (await apiCall(
    'POST',
    '/api/markets',
    {
      specification: demo.market.specification,
      rulesHash: demo.market.rulesHash,
      validationPlan: demo.market.validationPlan,
    },
    session.token,
  )) as { rulesHash: string; status: string };

  console.log(`registered   ${result.rulesHash} (${result.status})`);
  console.log('');
  console.log('The backend now holds the rules. It has NOT created the market —');
  console.log('the creator\'s own wallet commits the hash. Run: demo.js create');
}

async function stepCreate(): Promise<void> {
  const demo = loadDemo();
  const params = demo.market.createMarketParams;
  const wallet = walletFor('WALLET_A_PRIVATE_KEY');

  const existing = (await publicClient().readContract({
    address: demo.factory,
    abi: factoryCreateAbi,
    functionName: 'marketByRulesHash',
    args: [params.rulesHash],
  })) as Address;

  if (existing !== '0x0000000000000000000000000000000000000000') {
    console.log(`already created at ${existing}`);
    return;
  }

  await send('createMarket', () =>
    wallet.client.writeContract({
      account: wallet.account,
      chain: null,
      address: demo.factory,
      abi: factoryCreateAbi,
      functionName: 'createMarket',
      args: [
        {
          token: params.token,
          rulesHash: params.rulesHash,
          tradingEndsAt: BigInt(params.tradingEndsAt),
          conditionDeadline: BigInt(params.conditionDeadline),
          challengeWindow: params.challengeWindow,
          resolutionWindow: params.resolutionWindow,
          challengeBond: BigInt(params.challengeBond),
        },
      ],
    }),
  );

  const address = (await publicClient().readContract({
    address: demo.factory,
    abi: factoryCreateAbi,
    functionName: 'marketByRulesHash',
    args: [params.rulesHash],
  })) as Address;

  // The hash is read back off the chain and compared. If they ever differ, the
  // market is not the agreement that was registered, and everything downstream
  // is meaningless.
  const onChainHash = (await publicClient().readContract({
    address,
    abi: conditionalMarketAbi,
    functionName: 'rulesHash',
  })) as Hex;

  console.log(`market       ${address}`);
  console.log(`rulesHash    ${onChainHash}`);
  console.log(
    onChainHash.toLowerCase() === params.rulesHash.toLowerCase()
      ? '             ✓ matches the hash computed by @covenant/shared'
      : '             ✗ MISMATCH — stop here',
  );
}

async function marketAddress(): Promise<Address> {
  const demo = loadDemo();
  const address = (await publicClient().readContract({
    address: demo.factory,
    abi: factoryCreateAbi,
    functionName: 'marketByRulesHash',
    args: [demo.market.rulesHash],
  })) as Address;
  if (address === '0x0000000000000000000000000000000000000000') {
    throw new Error('The demo market has not been created on-chain yet. Run: demo.js create');
  }
  return address;
}

async function stepStake(): Promise<void> {
  const demo = loadDemo();
  const address = await marketAddress();
  const token = demo.market.createMarketParams.token;

  // A stakes YES 100, B stakes NO 300 — the same asymmetry M4 used, so the
  // payout is visibly proportional rather than a simple doubling.
  for (const [keyEnv, side, amount, label] of [
    ['WALLET_A_PRIVATE_KEY', 1, 100_000_000n, 'A → YES 100'],
    ['WALLET_B_PRIVATE_KEY', 2, 300_000_000n, 'B → NO 300'],
  ] as const) {
    const wallet = walletFor(keyEnv);
    console.log(label);
    await send('approve', () =>
      wallet.client.writeContract({
        account: wallet.account,
        chain: null,
        address: token,
        abi: erc20WriteAbi,
        functionName: 'approve',
        args: [address, amount],
      }),
    );
    await send('stake', () =>
      wallet.client.writeContract({
        account: wallet.account,
        chain: null,
        address,
        abi: participantAbi,
        functionName: 'stake',
        args: [side, amount],
      }),
    );
  }

  const held = (await publicClient().readContract({
    address: token,
    abi: erc20ReadAbi,
    functionName: 'balanceOf',
    args: [address],
  })) as bigint;
  console.log('');
  console.log(`custody      ${tusd(held)} TUSD held by the market`);
}

async function stepResolve(dryRun: boolean): Promise<void> {
  const demo = loadDemo();
  const session = await signIn('WALLET_A_PRIVATE_KEY');

  const detail = (await apiCall(
    'POST',
    `/api/markets/${demo.market.rulesHash}/resolve`,
    dryRun ? { dryRun: true } : {},
    session.token,
  )) as Record<string, unknown>;

  console.log(`status       ${String(detail['status'])}`);
  console.log(`detail       ${String(detail['detail'])}`);
  console.log(`outcome      ${String(detail['outcome'] ?? '—')}`);
  console.log(`confidence   ${String(detail['confidenceBps'])} bps`);
  console.log(`verdict      ${String(detail['verdict'] ?? '—')}`);
  console.log(`evidenceHash ${String(detail['evidenceHash'] ?? '—')}`);
  console.log(`submission   ${String(detail['submissionState'])}`);
  console.log(`proposal tx  ${String(detail['proposalTxHash'] ?? '—')}`);

  const checks = detail['deterministicChecks'] as { checkId: string; expected: string; observed: string; result: string }[];
  if (Array.isArray(checks) && checks.length > 0) {
    console.log('');
    console.log('deterministic checks:');
    for (const check of checks) {
      console.log(
        `  ${check.checkId.padEnd(28)} expected ${String(check.expected).padEnd(14)} ` +
          `observed ${String(check.observed).padEnd(14)} ${check.result}`,
      );
    }
  }

  const reasoning = detail['reasoning'];
  if (typeof reasoning === 'string') {
    console.log('');
    console.log('model reasoning:');
    console.log(`  ${reasoning.replace(/\n/g, '\n  ')}`);
  }
}

async function stepChallenge(): Promise<void> {
  const demo = loadDemo();
  const address = await marketAddress();
  const session = await signIn('WALLET_B_PRIVATE_KEY');
  const wallet = walletFor('WALLET_B_PRIVATE_KEY');

  const reason =
    'The proposed outcome is contested: the challenger asserts the approved source was read ' +
    'outside the window the specification permits.';

  // The hash comes from the backend, which computes it through
  // `@covenant/shared` — the only implementation of keccak256 over text in this
  // repository. Computing it a second way here is exactly what ADR-0001 forbids.
  const prepared = (await apiCall(
    'POST',
    `/api/markets/${demo.market.rulesHash}/challenge/prepare`,
    { reason },
    session.token,
  )) as { reasonHash: Hex };

  console.log(`reasonHash   ${prepared.reasonHash}`);

  const bond = BigInt(demo.market.createMarketParams.challengeBond);
  await send('approve (bond)', () =>
    wallet.client.writeContract({
      account: wallet.account,
      chain: null,
      address: demo.market.createMarketParams.token,
      abi: erc20WriteAbi,
      functionName: 'approve',
      args: [address, bond],
    }),
  );
  const txHash = await send('challenge', () =>
    wallet.client.writeContract({
      account: wallet.account,
      chain: null,
      address,
      abi: participantAbi,
      functionName: 'challenge',
      args: [prepared.reasonHash],
    }),
  );

  // Only now is there a committed hash for the backend to verify the text
  // against. Recording first would store an argument for a challenge that might
  // never exist.
  await apiCall(
    'POST',
    `/api/markets/${demo.market.rulesHash}/challenge`,
    { reason, txHash },
    session.token,
  );
  console.log('');
  console.log('challenge filed and its argument recorded.');
  console.log('The resolver must now produce a SECOND proposal: demo.js resolve');
}

async function stepFinalize(): Promise<void> {
  const demo = loadDemo();
  const result = (await apiCall('POST', `/api/markets/${demo.market.rulesHash}/finalize`)) as {
    submitted: boolean;
    txHash: string | null;
    state: string;
    finalOutcome: string;
    refundMode: boolean;
    detail: string;
  };

  console.log(`submitted    ${result.submitted}`);
  console.log(`tx           ${result.txHash ?? '—'}`);
  console.log(`state        ${result.state}`);
  console.log(`outcome      ${result.finalOutcome}`);
  console.log(`refund mode  ${result.refundMode}`);
  console.log(`detail       ${result.detail}`);
}

async function stepClaim(): Promise<void> {
  const demo = loadDemo();
  const address = await marketAddress();
  const token = demo.market.createMarketParams.token;
  const client = publicClient();

  for (const [keyEnv, label] of [
    ['WALLET_A_PRIVATE_KEY', 'A'],
    ['WALLET_B_PRIVATE_KEY', 'B'],
  ] as const) {
    const wallet = walletFor(keyEnv);
    // Read from the contract, never computed here. The contract owns the payout.
    const preview = (await client.readContract({
      address,
      abi: conditionalMarketAbi,
      functionName: 'previewClaim',
      args: [wallet.account.address],
    })) as bigint;

    const before = (await client.readContract({
      address: token,
      abi: erc20ReadAbi,
      functionName: 'balanceOf',
      args: [wallet.account.address],
    })) as bigint;

    console.log(`${label}  balance ${tusd(before)}  claimable ${tusd(preview)}`);
    if (preview === 0n) continue;

    const state = (await client.readContract({
      address,
      abi: conditionalMarketAbi,
      functionName: 'refundMode',
    })) as boolean;

    await send(state ? 'withdrawRefund' : 'claim', () =>
      wallet.client.writeContract({
        account: wallet.account,
        chain: null,
        address,
        abi: participantAbi,
        functionName: state ? 'withdrawRefund' : 'claim',
        args: [],
      }),
    );

    const after = (await client.readContract({
      address: token,
      abi: erc20ReadAbi,
      functionName: 'balanceOf',
      args: [wallet.account.address],
    })) as bigint;
    console.log(`   → ${tusd(before)} → ${tusd(after)}  (+${tusd(after - before)})`);
  }

  const residual = (await client.readContract({
    address: token,
    abi: erc20ReadAbi,
    functionName: 'balanceOf',
    args: [address],
  })) as bigint;
  console.log('');
  console.log(`residual in market: ${tusd(residual)} TUSD`);
}

async function stepStatus(): Promise<void> {
  const demo = loadDemo();
  const client = publicClient();

  console.log(`api          ${API}`);
  console.log(`rulesHash    ${demo.market.rulesHash}`);

  const address = (await client.readContract({
    address: demo.factory,
    abi: factoryCreateAbi,
    functionName: 'marketByRulesHash',
    args: [demo.market.rulesHash],
  })) as Address;

  if (address === '0x0000000000000000000000000000000000000000') {
    console.log('on-chain     not created yet');
  } else {
    const names = [
      'state', 'proposedOutcome', 'finalOutcome', 'proposalRound',
      'totalYes', 'totalNo', 'pool', 'challengeEndsAt', 'conditionDeadline', 'evidenceHash',
    ] as const;
    const values = await Promise.all(
      names.map((functionName) =>
        client.readContract({ address, abi: conditionalMarketAbi, functionName }),
      ),
    );
    console.log(`market       ${address}`);
    names.forEach((name, index) => {
      const value: unknown = values[index];
      const rendered =
        name === 'totalYes' || name === 'totalNo' || name === 'pool'
          ? tusd(BigInt(value as string | bigint))
          : name === 'challengeEndsAt' || name === 'conditionDeadline'
            ? `${String(value)} (${new Date(Number(value) * 1000).toISOString()})`
            : String(value);
      console.log(`  ${name.padEnd(18)} ${rendered}`);
    });
    console.log(`  now                ${Math.floor(Date.now() / 1000)} (${new Date().toISOString()})`);
  }

  try {
    const detail = (await apiCall('GET', `/api/markets/${demo.market.rulesHash}`)) as {
      status: string;
    };
    console.log(`backend      ${detail.status}`);
  } catch (error) {
    console.log(`backend      unreachable or unregistered (${(error as Error).message})`);
  }
}

// ---------------------------------------------------------------------------

const STEPS: Record<string, () => Promise<void>> = {
  register: stepRegister,
  create: stepCreate,
  stake: stepStake,
  resolve: () => stepResolve(false),
  'dry-run': () => stepResolve(true),
  challenge: stepChallenge,
  finalize: stepFinalize,
  claim: stepClaim,
  status: stepStatus,
};

async function main(): Promise<void> {
  const step = process.argv[2];
  if (step === undefined || STEPS[step] === undefined) {
    console.log('usage: node dist/tools/demo.js <step>');
    console.log(`steps: ${Object.keys(STEPS).join(', ')}`);
    process.exitCode = 1;
    return;
  }
  await STEPS[step]!();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
