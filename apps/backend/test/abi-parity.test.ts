/**
 * The hand-written ABI fragments must match the compiled contracts.
 *
 * `src/chain/abi.ts` declares fragments as `as const` so viem can infer types
 * from them — a JSON import cannot carry literal types. The cost of that choice
 * is the possibility of drift: a fragment here disagreeing with the bytecode
 * actually deployed would decode a log into confident nonsense, and nothing
 * about that failure would look like a failure.
 *
 * This test closes that gap. `packages/contracts/abi/*.json` is written by
 * `npm run abi:export` straight from the compiler's output and committed; every
 * fragment the backend declares is compared against it, field by field. If a
 * signature changes upstream, this fails.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { conditionalMarketAbi, erc20ReadAbi, marketFactoryAbi } from '../src/chain/abi.js';

const ABI_DIR = resolve(__dirname, '..', '..', '..', 'packages', 'contracts', 'abi');

interface Fragment {
  type: string;
  name?: string;
  inputs?: { name: string; type: string; indexed?: boolean }[];
  outputs?: { name: string; type: string }[];
  stateMutability?: string;
  anonymous?: boolean;
}

function loadCompiled(contract: string): Fragment[] {
  const path = resolve(ABI_DIR, `${contract}.json`);
  if (!existsSync(path)) {
    throw new Error(
      `No compiled ABI at ${path}. Run:\n` +
        '  npm run build --workspace @covenant/contracts\n' +
        '  npm run abi:export --workspace @covenant/contracts\n' +
        'The exported ABIs are committed precisely so this check does not need a compiler.',
    );
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Fragment[];
}

/** Compare only what matters for encoding: name, kind, and the type lists. */
function signature(fragment: Fragment): string {
  const inputs = (fragment.inputs ?? [])
    .map((input) => `${input.type}${input.indexed === true ? ' indexed' : ''}`)
    .join(',');
  const outputs = (fragment.outputs ?? []).map((output) => output.type).join(',');
  return `${fragment.type} ${fragment.name ?? ''}(${inputs})->(${outputs})`;
}

function assertSubset(declared: readonly Fragment[], compiled: readonly Fragment[], label: string): void {
  const available = new Map(compiled.map((fragment) => [signature(fragment), fragment]));

  for (const fragment of declared) {
    const key = signature(fragment);
    const match = available.get(key);

    expect(
      match,
      `${label}: the backend declares \`${key}\` but the compiled ABI has no such fragment. ` +
        'Either the contract changed or src/chain/abi.ts is stale.',
    ).toBeDefined();

    if (fragment.type === 'event') {
      // Indexed-ness decides which topic a value lands in. Getting it wrong
      // decodes every field after it into garbage.
      expect(
        (match?.inputs ?? []).map((input) => input.indexed === true),
        `${label}.${fragment.name ?? ''}: indexed flags differ`,
      ).toEqual((fragment.inputs ?? []).map((input) => input.indexed === true));
    }
  }
}

describe('ABI parity with the compiled contracts', () => {
  it('every MarketFactory fragment the backend declares exists in the compiled ABI', () => {
    assertSubset(marketFactoryAbi as unknown as Fragment[], loadCompiled('MarketFactory'), 'MarketFactory');
  });

  it('every ConditionalMarket fragment the backend declares exists in the compiled ABI', () => {
    assertSubset(
      conditionalMarketAbi as unknown as Fragment[],
      loadCompiled('ConditionalMarket'),
      'ConditionalMarket',
    );
  });

  it('every ERC-20 read the backend declares exists on TestUSD', () => {
    assertSubset(erc20ReadAbi as unknown as Fragment[], loadCompiled('TestUSD'), 'TestUSD');
  });

  it('declares every market event the indexer claims to observe (§17)', () => {
    const declared = new Set(
      (conditionalMarketAbi as unknown as Fragment[])
        .filter((fragment) => fragment.type === 'event')
        .map((fragment) => fragment.name),
    );
    const factoryEvents = new Set(
      (marketFactoryAbi as unknown as Fragment[])
        .filter((fragment) => fragment.type === 'event')
        .map((fragment) => fragment.name),
    );

    for (const required of [
      'StakePlaced',
      'MarketClosed',
      'ResolutionProposed',
      'ResolutionChallenged',
      'MarketFinalized',
      'WinningsClaimed',
      'MarketCancelled',
    ]) {
      expect(declared, `missing event ${required}`).toContain(required);
    }
    expect(factoryEvents).toContain('MarketCreated');
  });

  it('declares no function that can move a market\'s funds', () => {
    // The backend reads. It declares exactly two writes, and neither transfers
    // anything or names a recipient:
    //
    //   `proposeResolution` — the resolver key's only authority. Records an
    //     outcome and an evidence commitment.
    //   `finalize`          — permissionless on the contract, takes no
    //     arguments, and refused before the challenge window closes. It makes
    //     the *standing* proposal final; it cannot choose what that says.
    //
    // The assertion is exact rather than a denylist: a future `claim` or
    // `withdrawRefund` appearing here has to be added to this list first, which
    // is a change no one can make by accident.
    const writable = (conditionalMarketAbi as unknown as Fragment[]).filter(
      (fragment) =>
        fragment.type === 'function' &&
        fragment.stateMutability !== 'view' &&
        fragment.stateMutability !== 'pure',
    );

    expect(writable.map((fragment) => fragment.name)).toEqual(['proposeResolution', 'finalize']);
  });

  it('declares no token function that could move value', () => {
    // The ERC-20 surface is read-only. `transfer`, `transferFrom` and `approve`
    // are absent, so no amount of code above this layer can encode one.
    const names = (erc20ReadAbi as unknown as Fragment[]).map((fragment) => fragment.name);
    for (const forbidden of ['transfer', 'transferFrom', 'approve', 'permit']) {
      expect(names, `${forbidden} must not be declared`).not.toContain(forbidden);
    }
  });
});
