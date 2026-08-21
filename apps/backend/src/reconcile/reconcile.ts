/**
 * Database ↔ chain reconciliation (§28).
 *
 * Why this exists
 * ---------------
 * The frontend will read market state from this backend, because thirty RPC
 * round trips per page is not a product. That is a reasonable trade only while
 * someone is checking that the cache still matches the chain. This is that
 * check, and it is deliberately a separate, runnable command rather than an
 * assertion buried in the indexer: an indexer cannot audit itself, because the
 * bug being looked for is in the indexer.
 *
 * It reads. It never writes, never repairs, and never deletes. A reconciler that
 * silently "fixes" a discrepancy destroys the evidence of how it happened — and
 * if the cache is wrong the correct response is to look, not to overwrite. The
 * output is a list of findings and an exit code.
 */

import { buildRulesCommitment, verifyEvidenceHash } from '@covenant/shared';

import type { ChainClient } from '../chain/types.js';
import type { Address, Hex } from '../chain/types.js';
import type { Repositories } from '../repositories/types.js';

/** An unset bytes32. The contract's "no proposal yet" for `evidenceHash`. */
const ZERO_HASH = `0x${'0'.repeat(64)}`;

/**
 * How bad a finding is.
 *
 * `mismatch` means the database contradicts the chain — a number a user could
 * be shown that is not true. `missing` means the database is behind or blind.
 * `warning` is something to look at that is not yet wrong.
 */
export type FindingSeverity = 'mismatch' | 'missing' | 'warning';

export interface ReconcileFinding {
  readonly severity: FindingSeverity;
  readonly kind: string;
  readonly subject: string;
  readonly detail: string;
  readonly expected?: string;
  readonly actual?: string;
}

export interface ReconcileReport {
  readonly chainId: number;
  readonly checkedAt: string;
  readonly marketsOnChain: number;
  readonly marketsInDatabase: number;
  readonly eventsInDatabase: number;
  readonly findings: readonly ReconcileFinding[];
  /** True when there is nothing of severity `mismatch` or `missing`. */
  readonly healthy: boolean;
}

export interface ReconcileOptions {
  readonly client: ChainClient;
  readonly repositories: Repositories;
  readonly factoryAddress: Address;
  readonly now?: () => Date;
}

/**
 * Compare the indexed view against the chain.
 *
 * The chain is walked from the factory's own registry rather than from the
 * database, so a market the database has never heard of is *findable* — starting
 * from our own rows could only ever confirm the rows we already have.
 */
export async function reconcile(options: ReconcileOptions): Promise<ReconcileReport> {
  const { client, repositories } = options;
  const now = options.now ?? ((): Date => new Date());
  const chainId = client.chainId;
  const findings: ReconcileFinding[] = [];

  const cachedStates = await repositories.chainState.list(chainId);
  const eventCount = await repositories.events.countByChain(chainId);

  // --- duplicate events -----------------------------------------------------
  // Should be structurally impossible: the primary key is the event identity.
  // Checked anyway, because "impossible" is a claim about a schema that a
  // migration can quietly change.
  const duplicates = await repositories.events.findDuplicateIdentities(chainId);
  for (const identity of duplicates) {
    findings.push({
      severity: 'mismatch',
      kind: 'duplicate-event',
      subject: identity,
      detail:
        'The same (chainId, transactionHash, logIndex) appears more than once. The event ' +
        'identity constraint is not doing its job.',
    });
  }

  // --- walk the chain -------------------------------------------------------
  const onChainAddresses = new Map<string, Address>();
  const dbMarkets = await repositories.markets.list({ chainId, limit: 1_000 });

  for (const market of dbMarkets.markets) {
    const address = await client.findMarketByRulesHash(market.rulesHash as Hex);

    if (address === null) {
      // Not an error by itself: PENDING_ONCHAIN means the creator has not opened
      // the market yet, which is the normal state of an approved specification.
      if (market.status !== 'PENDING_ONCHAIN' && market.status !== 'DRAFT') {
        findings.push({
          severity: 'missing',
          kind: 'market-absent-on-chain',
          subject: market.rulesHash,
          detail:
            `The database has this market in status ${market.status}, but the factory has no ` +
            'market for its rules hash. The row claims an on-chain market that does not exist.',
        });
      }
      continue;
    }

    onChainAddresses.set(address.toLowerCase(), address);

    if (market.contractAddress === null) {
      findings.push({
        severity: 'missing',
        kind: 'market-address-not-indexed',
        subject: market.rulesHash,
        detail:
          'The factory has a market for this rules hash but the database row has no address. ' +
          'The indexer has not seen MarketCreated — it may be behind, or the log may have been ' +
          'missed.',
        expected: address,
        actual: 'null',
      });
    } else if (market.contractAddress.toLowerCase() !== address.toLowerCase()) {
      findings.push({
        severity: 'mismatch',
        kind: 'market-address-mismatch',
        subject: market.rulesHash,
        detail: 'The stored contract address is not the address the factory reports.',
        expected: address,
        actual: market.contractAddress,
      });
      continue;
    }

    // --- the rules hash is the whole point --------------------------------
    // Re-derive it from the stored specification and compare against what the
    // contract holds. If these differ, the rules a user would be shown are not
    // the rules the money is bound by, which is the single worst thing this
    // system could get wrong.
    const onChain = await client.readMarket(address);
    const recomputed = buildRulesCommitment(market.specification);

    if (recomputed.rulesHash !== market.rulesHash) {
      findings.push({
        severity: 'mismatch',
        kind: 'rules-hash-not-reproducible',
        subject: market.rulesHash,
        detail:
          'Re-hashing the stored specification does not reproduce the stored rules hash. The ' +
          'stored specification has been altered.',
        expected: market.rulesHash,
        actual: recomputed.rulesHash,
      });
    }

    if (onChain.rulesHash.toLowerCase() !== market.rulesHash.toLowerCase()) {
      findings.push({
        severity: 'mismatch',
        kind: 'rules-hash-mismatch',
        subject: market.rulesHash,
        detail: 'The rules hash committed on-chain is not the one stored for this market.',
        expected: onChain.rulesHash,
        actual: market.rulesHash,
      });
    }

    // --- the evidence behind the commitment --------------------------------
    //
    // A market that has proposed an outcome carries an `evidenceHash` on-chain.
    // Publishing that digest is only meaningful if the document behind it can
    // be produced *and* re-derives to it — otherwise the commitment is a number
    // nobody can check, which is the failure this product exists to prevent.
    //
    // Three distinct problems, kept distinct because they call for different
    // responses: we do not hold the package at all; we hold one but it hashes to
    // something else; or we hold one that no longer validates.
    if (onChain.evidenceHash !== ZERO_HASH) {
      const stored = await repositories.evidence.findByEvidenceHash(onChain.evidenceHash);

      if (stored === null) {
        findings.push({
          severity: 'missing',
          kind: 'evidence-package-missing',
          subject: address,
          detail:
            'The contract commits to an evidence hash for which this backend holds no package. ' +
            'The outcome is on-chain and unexplainable — nobody can check what it was based on.',
          expected: onChain.evidenceHash,
          actual: 'no stored package',
        });
      } else if (!verifyEvidenceHash(stored.package, onChain.evidenceHash)) {
        // The loudest severity available. The served document is not the one the
        // digest covers, so anything shown from it is a claim about a different
        // agreement.
        findings.push({
          severity: 'mismatch',
          kind: 'evidence-hash-not-reproducible',
          subject: address,
          detail:
            'The stored evidence package does not re-derive to the hash committed on-chain. It ' +
            'has been altered since it was proposed, or it is not the package that was proposed.',
          expected: onChain.evidenceHash,
          actual: stored.evidenceHash,
        });
      } else if (stored.rulesHash.toLowerCase() !== onChain.rulesHash.toLowerCase()) {
        // Reproduces its own digest perfectly and is evidence for another
        // agreement — the distinction `EVIDENCE_RULES_MISMATCH` exists for.
        findings.push({
          severity: 'mismatch',
          kind: 'evidence-bound-to-other-rules',
          subject: address,
          detail:
            'The stored evidence package is bound to a different rules hash than this market ' +
            'committed. The chain cannot detect this; nothing on-chain reads the document.',
          expected: onChain.rulesHash,
          actual: stored.rulesHash,
        });
      }

      // A proposal exists on-chain but the resolver has no record of making
      // one. Either it was made by another operator holding the proposer role,
      // or a submission was lost after the transaction landed.
      const attempt = await repositories.resolutions.findLatestByRulesHash(market.rulesHash);
      if (attempt === null || attempt.evidenceHash === null) {
        findings.push({
          severity: 'warning',
          kind: 'proposal-without-local-record',
          subject: address,
          detail:
            'The contract holds a proposal this backend has no resolution record for. It was ' +
            'proposed by something else, or the record was lost after submission.',
          expected: onChain.evidenceHash,
          actual: attempt?.evidenceHash ?? 'no resolution row',
        });
      }
    }

    // --- cached state ------------------------------------------------------
    const cached = await repositories.chainState.findByAddress(chainId, address);

    if (cached === null) {
      findings.push({
        severity: 'missing',
        kind: 'chain-state-missing',
        subject: address,
        detail: 'No cached chain state for a market that exists on-chain.',
      });
      continue;
    }

    const comparisons: readonly [string, string, string][] = [
      ['state', onChain.state, cached.state],
      ['totalYes', onChain.totalYes.toString(), cached.totalYes],
      ['totalNo', onChain.totalNo.toString(), cached.totalNo],
      ['pool', onChain.pool.toString(), cached.pool],
      ['finalOutcome', onChain.finalOutcome, cached.finalOutcome],
      ['proposedOutcome', onChain.proposedOutcome, cached.proposedOutcome],
      ['proposalRound', String(onChain.proposalRound), String(cached.proposalRound)],
      ['refundMode', String(onChain.refundMode), String(cached.refundMode)],
      ['evidenceHash', onChain.evidenceHash, cached.evidenceHash],
      ['challenger', onChain.challenger, cached.challenger],
      ['marketId', onChain.marketId.toString(), cached.chainMarketId],
    ];

    for (const [field, expected, actual] of comparisons) {
      if (expected !== actual) {
        findings.push({
          severity: 'mismatch',
          kind: 'chain-state-stale',
          subject: `${address}.${field}`,
          detail: `The cached ${field} does not match the contract.`,
          expected,
          actual,
        });
      }
    }

    // The market's own token balance must cover what it still owes. A shortfall
    // is not a caching bug — it would mean funds left the contract.
    //
    // "Still owes" is the important word. `pool()` is the *original*
    // distributable amount and does not shrink as winners claim, so comparing
    // the balance against it flags every correctly-settled market as
    // underfunded — a false positive on the healthiest possible state.
    //
    // What is actually owed, and readable without duplicating the contract's
    // payout arithmetic:
    //   - an outstanding challenge bond, exactly;
    //   - in refund mode, the stake not yet withdrawn, exactly.
    // Outside refund mode the remaining payout is proportional and cannot be
    // derived from a single getter, so the weaker but still meaningful check is
    // that a market with claims outstanding holds *something*.
    const balance = await client.readTokenBalance(onChain.token, address);

    const bondOwed = onChain.bondOutstanding ? onChain.challengeBond : 0n;
    const refundOwed = onChain.refundMode ? onChain.remainingClaimableStake : 0n;
    const owed = bondOwed + refundOwed;

    if (balance < owed) {
      findings.push({
        severity: 'mismatch',
        kind: 'market-underfunded',
        subject: address,
        detail:
          'The market holds fewer tokens than it still owes in refunds and outstanding bonds. ' +
          'This is a chain-level finding, not an indexing one.',
        expected: `>= ${owed.toString()}`,
        actual: balance.toString(),
      });
    } else if (!onChain.refundMode && onChain.remainingClaimableStake > 0n && balance === 0n) {
      findings.push({
        severity: 'mismatch',
        kind: 'market-underfunded',
        subject: address,
        detail:
          'The market still has claimable stake outstanding but holds no tokens at all. Someone ' +
          'entitled to a payout cannot be paid.',
        expected: '> 0',
        actual: '0',
      });
    }
  }

  // --- markets on-chain that the database has no specification for ---------
  for (const cached of cachedStates) {
    const known = await repositories.markets.findByRulesHash(cached.rulesHash);
    if (known === null) {
      findings.push({
        severity: 'warning',
        kind: 'unknown-specification',
        subject: cached.contractAddress,
        detail:
          'A market exists on-chain whose specification this backend has never seen. Anyone may ' +
          'call the factory, so this is expected rather than alarming — but it cannot be ' +
          'displayed as an approved condition.',
      });
    }
  }

  // --- indexer liveness -----------------------------------------------------
  const checkpoint = await repositories.checkpoints.loadOrCreate({
    chainId,
    stream: 'market-factory',
    startBlock: '0',
    at: now(),
  });
  const safeHead = await client.getSafeBlockNumber();
  const lag = safeHead - BigInt(checkpoint.lastProcessedBlock);
  if (lag > 1_000n) {
    findings.push({
      severity: 'warning',
      kind: 'indexer-lagging',
      subject: 'market-factory',
      detail: `The indexer is ${lag.toString()} blocks behind the safe head.`,
      expected: safeHead.toString(),
      actual: checkpoint.lastProcessedBlock,
    });
  }

  return {
    chainId,
    checkedAt: now().toISOString(),
    marketsOnChain: onChainAddresses.size,
    marketsInDatabase: dbMarkets.markets.length,
    eventsInDatabase: eventCount,
    findings,
    healthy: findings.every((finding) => finding.severity === 'warning'),
  };
}

/** Human-readable report, for the CLI. */
export function formatReconcileReport(report: ReconcileReport): string {
  const lines = [
    `reconciliation — chain ${report.chainId} — ${report.checkedAt}`,
    `  markets on-chain     ${report.marketsOnChain}`,
    `  markets in database  ${report.marketsInDatabase}`,
    `  events in database   ${report.eventsInDatabase}`,
    '',
  ];

  if (report.findings.length === 0) {
    lines.push('  no findings — the indexed view matches the chain.');
    return lines.join('\n');
  }

  for (const finding of report.findings) {
    lines.push(`  [${finding.severity}] ${finding.kind} — ${finding.subject}`);
    lines.push(`      ${finding.detail}`);
    if (finding.expected !== undefined) lines.push(`      chain:    ${finding.expected}`);
    if (finding.actual !== undefined) lines.push(`      database: ${finding.actual}`);
  }

  lines.push('');
  lines.push(report.healthy ? '  no mismatches (warnings only).' : '  MISMATCHES PRESENT.');
  return lines.join('\n');
}
