/**
 * The frontend's hard-coded function selectors must match the contracts.
 *
 * `apps/web` has no bundler and therefore no ethers or viem, so the four calls
 * the demo page sends are encoded by hand against selectors written into
 * `public/api.mjs` as constants. A constant is only safe if something recomputes
 * it — a wrong selector produces a transaction the contract silently ignores or
 * reverts on, and nothing about that failure names the cause.
 *
 * So: parse the constants out of the frontend source, recompute each from the
 * *compiled* ABI, and compare. This is the same argument `abi-parity.test.ts`
 * makes for the backend's fragments, applied to the one place a hash could not
 * be derived at run time.
 *
 * Three of these were wrong when first written by hand. That is the whole reason
 * this file exists.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { toFunctionSelector } from 'viem';
import { describe, expect, it } from 'vitest';

const WEB_API = resolve(__dirname, '..', '..', 'web', 'public', 'api.mjs');
const ABI_DIR = resolve(__dirname, '..', '..', '..', 'packages', 'contracts', 'abi');

interface Fragment {
  type: string;
  name?: string;
  inputs?: { type: string }[];
  stateMutability?: string;
}

/** The signature the compiler would produce for a fragment, e.g. `stake(uint8,uint256)`. */
function signatureOf(fragment: Fragment): string {
  return `${fragment.name ?? ''}(${(fragment.inputs ?? []).map((input) => input.type).join(',')})`;
}

/** `SELECTOR = { name: '0x…' }` from the frontend module, as written. */
function readDeclaredSelectors(): Record<string, string> {
  const source = readFileSync(WEB_API, 'utf8');
  const block = /export const SELECTOR = \{([\s\S]*?)\n\};/.exec(source);
  if (block === null) throw new Error(`No SELECTOR block found in ${WEB_API}`);

  const declared: Record<string, string> = {};
  for (const match of block[1]!.matchAll(/(\w+):\s*'(0x[0-9a-f]{8})'/g)) {
    declared[match[1]!] = match[2]!;
  }
  return declared;
}

describe('frontend function selectors', () => {
  const declared = readDeclaredSelectors();

  it('declares the calls the demo page sends, and no more', () => {
    // An extra entry here would be a call the page can encode. Keeping the set
    // exact means adding one is a deliberate edit to this test as well.
    expect(Object.keys(declared).sort()).toEqual(
      ['approve', 'challenge', 'claim', 'claimChallengeBond', 'stake', 'withdrawRefund'].sort(),
    );
  });

  it('matches the compiled ConditionalMarket ABI', () => {
    const path = resolve(ABI_DIR, 'ConditionalMarket.json');
    if (!existsSync(path)) {
      throw new Error(
        `No compiled ABI at ${path}. Run:\n` +
          '  npm run build --workspace @covenant/contracts\n' +
          '  npm run abi:export --workspace @covenant/contracts',
      );
    }

    const abi = JSON.parse(readFileSync(path, 'utf8')) as Fragment[];
    const byName = new Map<string, Fragment>();
    for (const fragment of abi) {
      if (fragment.type === 'function' && fragment.name !== undefined) {
        byName.set(fragment.name, fragment);
      }
    }

    for (const name of ['stake', 'challenge', 'claim', 'withdrawRefund', 'claimChallengeBond']) {
      const fragment = byName.get(name);
      expect(fragment, `${name} is not in the compiled ABI`).toBeDefined();
      expect(declared[name], `selector for ${name}`).toBe(
        toFunctionSelector(signatureOf(fragment as Fragment)),
      );
    }
  });

  it('matches the canonical ERC-20 approve selector', () => {
    // Not from our ABI: `erc20ReadAbi` deliberately declares no `approve`, so the
    // token surface the backend can encode stays read-only. The frontend needs
    // it because the *user's* wallet must approve the market, and the signature
    // is the ERC-20 standard's.
    expect(declared['approve']).toBe(toFunctionSelector('approve(address,uint256)'));
  });

  it('declares no selector for a function that moves someone else\'s funds', () => {
    // Every call the page can encode is one the *signer* is entitled to make for
    // themselves: approving their own token, staking their own money, claiming
    // their own winnings, contesting with their own bond. There is no
    // `transferFrom`, no `proposeResolution` and no factory call.
    const forbidden = ['transferFrom', 'proposeResolution', 'createMarket', 'initialize'];
    for (const name of forbidden) {
      expect(Object.keys(declared)).not.toContain(name);
    }
  });
});
