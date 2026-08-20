/**
 * Register the testnet specifications through the real API (ADR-0006's join).
 *
 *   node --env-file=../../.env dist/tools/register-markets.js
 *
 * This is the step M4's chain work skipped. `prepare-market` computed the rules
 * hashes and `create-market` committed them on-chain, but nothing ever stored
 * the *rules* those hashes stand for — so the indexer had six markets and no
 * idea what any of them asked.
 *
 * It deliberately goes through HTTP rather than reaching into the repositories:
 * the point is to exercise the path a frontend will use, including SIWE sign-in,
 * the server-side hash recomputation, and the authorization check that a
 * specification may only be registered by the wallet it names as creator.
 *
 * The signing key is read from the environment and used once, in-process, to
 * sign a login message. It is never sent anywhere — the server receives a
 * signature, never a key.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { privateKeyToAccount } from 'viem/accounts';

interface MarketEntry {
  variant: string;
  rulesHash: string;
  specification: Record<string, unknown>;
  onchain?: { marketId: string; address: string };
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is not set.`);
  return value;
}

async function main(): Promise<void> {
  const baseUrl = process.env['API_BASE_URL']?.trim() ?? 'http://127.0.0.1:8080';
  const account = privateKeyToAccount(requireEnv('WALLET_A_PRIVATE_KEY') as `0x${string}`);

  const repoRoot = resolve(process.cwd(), '..', '..');
  const document = JSON.parse(
    readFileSync(
      resolve(repoRoot, 'packages/contracts/deployments/xlayer-testnet-markets.json'),
      'utf8',
    ),
  ) as { chainId: number; markets: MarketEntry[] };

  console.log(`api      ${baseUrl}`);
  console.log(`wallet   ${account.address}`);
  console.log('');

  // --- 1. sign in ----------------------------------------------------------
  const nonceResponse = await fetch(`${baseUrl}/api/auth/nonce`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address: account.address }),
  });
  if (!nonceResponse.ok) {
    throw new Error(`nonce request failed: ${nonceResponse.status} ${await nonceResponse.text()}`);
  }
  const noncePayload = (await nonceResponse.json()) as { data: { message: string; nonce: string } };
  const { message, nonce } = noncePayload.data;

  // Sign exactly what the server rendered. It rebuilds the same string from its
  // own stored fields to verify, so anything else recovers a different address.
  const signature = await account.signMessage({ message });

  const verifyResponse = await fetch(`${baseUrl}/api/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nonce, signature }),
  });
  if (!verifyResponse.ok) {
    throw new Error(`sign-in failed: ${verifyResponse.status} ${await verifyResponse.text()}`);
  }
  const verifyPayload = (await verifyResponse.json()) as {
    data: { token: string; wallet: { address: string } };
  };
  const { token, wallet } = verifyPayload.data;
  console.log(`signed in as ${wallet.address}`);
  console.log('');

  // --- 2. register each specification --------------------------------------
  let registered = 0;
  let failed = 0;

  for (const market of document.markets) {
    process.stdout.write(`${market.variant.padEnd(12)} `);

    const response = await fetch(`${baseUrl}/api/markets`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        specification: market.specification,
        rulesHash: market.rulesHash,
      }),
    });

    const body = await response.text();
    if (response.ok) {
      registered += 1;
      console.log(`registered  ${market.rulesHash}`);
    } else {
      failed += 1;
      // Print the server's own answer. If a past deadline is refused, that is a
      // real product answer and belongs in the output, not smoothed away.
      console.log(`HTTP ${response.status}`);
      console.log(`             ${body.slice(0, 400)}`);
    }
  }

  console.log('');
  console.log(`${registered} registered, ${failed} refused`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
