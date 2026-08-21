/**
 * The market detail page, and the resolution panel that is the product.
 *
 * The panel renders one chain in one order:
 *
 *   1 RULES        the hashed agreement and its digest
 *   2 EVIDENCE     which approved sources were read, what came back, its hash
 *   3 CHECKS       what code compared, against what, and what it found
 *   4 REASONING    the model's reading — last, and only ever concurring
 *   5 OUTCOME      the proposal, its confidence, and its evidence hash
 *   6 ON-CHAIN     the transaction, the challenge window, the final outcome
 *
 * The order is the argument. A reader who stops after stage 3 has already seen
 * everything that decided the outcome; stage 4 is the part that can withhold a
 * proposal but never flip one, and the page says so rather than presenting the
 * model as the authority.
 */

import {
  api,
  encode,
  escapeHtml,
  formatInstant,
  formatUnits,
  SELECTOR,
  sessionAddress,
  shortHash,
  txDisplay,
  wallet,
} from './api.mjs';
import { mountShell, notify } from './shell.mjs';

const marketId = new URLSearchParams(window.location.search).get('id') ?? '';
let current = null;

const OUTCOME_CLASS = { YES: 'yes', NO: 'no', INVALID: 'invalid' };
const RESULT_CLASS = { PASS: 'pass', FAIL: 'fail', INDETERMINATE: 'indeterminate' };

const STATUS_NOTE = {
  RESOLVED: 'A proposal was produced.',
  NEEDS_REVIEW: 'The resolver will not guess. A person has something to read.',
  INSUFFICIENT_EVIDENCE:
    'No approved source produced usable content. Absence of evidence is not evidence for either side.',
  INVALID: 'This market could not be resolved at all — see the reason.',
  RESOLUTION_FAILED: 'Nothing was attempted. Retrying is the correct response.',
};

function facts(rows) {
  return `<dl class="facts">${rows
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${value}</dd>`)
    .join('')}</dl>`;
}

// --- the agreement ----------------------------------------------------------

function renderAgreement(market) {
  const spec = market.specification;
  if (spec === null) {
    return '<p class="muted small">This market was created on-chain with a specification this backend has never seen. The chain is authoritative about which markets exist, so it is shown rather than hidden — but its rules cannot be displayed.</p>';
  }

  return facts([
    ['YES when', escapeHtml(spec.successCondition)],
    ['NO when', escapeHtml(spec.failureCondition)],
    ['Deadline', `${formatInstant(spec.deadline)} <span class="muted">(${escapeHtml(spec.timezone)})</span>`],
    ['Method', escapeHtml(spec.resolutionMethod)],
    ['Trading ends', formatInstant(spec.settlement.tradingEndsAt)],
    ['Challenge window', `${spec.settlement.challengeWindowSeconds}s`],
    ['Challenge bond', `${formatUnits(spec.settlement.challengeBondBaseUnits)} ${escapeHtml(spec.settlement.token.symbol)}`],
    ['Creator', `<span class="mono">${escapeHtml(spec.creator)}</span>`],
    [
      'rulesHash',
      `<span class="mono">${escapeHtml(market.rulesHash)}</span><br>` +
        (market.rulesHashVerified
          ? '<span class="badge pass">re-derived from the stored specification</span>'
          : '<span class="badge fail">does NOT match the stored specification</span>'),
    ],
    [
      'Ambiguities',
      spec.ambiguities.length === 0
        ? '<span class="muted">none recorded</span>'
        : `<ul style="margin:0;padding-left:18px">${spec.ambiguities
            .map((a) => `<li>${escapeHtml(a.description)}<br><span class="muted">assumed: ${escapeHtml(a.assumption)}</span></li>`)
            .join('')}</ul>`,
    ],
    [
      'Edge cases',
      spec.edgeCases.length === 0
        ? '<span class="muted">none recorded</span>'
        : `<ul style="margin:0;padding-left:18px">${spec.edgeCases
            .map((e) => `<li>${escapeHtml(e.scenario)} → <span class="badge ${OUTCOME_CLASS[e.outcome] ?? ''}">${escapeHtml(e.outcome)}</span></li>`)
            .join('')}</ul>`,
    ],
  ]);
}

function renderChain(market) {
  const chain = market.chain;
  if (chain === null || chain === undefined) {
    return '<p class="muted small">The indexer has not reached this market yet. Nothing is shown rather than a zero, because a zero would look like a fact.</p>';
  }

  return (
    facts([
      ['State', `<span class="badge">${escapeHtml(chain.state)}</span>`],
      ['Address', `<span class="mono">${escapeHtml(chain.address)}</span>`],
      ['Market id', escapeHtml(chain.marketId)],
      ['Staked YES', `${formatUnits(chain.totalYesBaseUnits)}`],
      ['Staked NO', `${formatUnits(chain.totalNoBaseUnits)}`],
      ['Pool', `${formatUnits(chain.poolBaseUnits)}`],
      ['Proposed outcome', `<span class="badge ${OUTCOME_CLASS[chain.proposedOutcome] ?? ''}">${escapeHtml(chain.proposedOutcome)}</span>`],
      ['Final outcome', `<span class="badge ${OUTCOME_CLASS[chain.finalOutcome] ?? ''}">${escapeHtml(chain.finalOutcome)}</span>`],
      ['Proposal round', `${chain.proposalRound} of 2`],
      ['Refund mode', chain.refundMode ? 'yes — everyone takes their own stake back' : 'no'],
      ['evidenceHash', `<span class="mono">${escapeHtml(chain.evidenceHash)}</span>`],
    ]) + `<div class="origin" style="margin-top:10px">cached by the indexer · observed ${formatInstant(chain.observedAt)}</div>`
  );
}

function renderSources(market) {
  const spec = market.specification;
  if (spec === null) return '<p class="muted small">—</p>';
  return `<table><thead><tr><th>#</th><th>Name</th><th>URL</th><th>Kind</th><th>Data path</th></tr></thead><tbody>
    ${spec.approvedSources
      .map(
        (source, index) => `<tr>
          <td>${index}${index === 0 ? ' <span class="badge">primary</span>' : ''}</td>
          <td>${escapeHtml(source.name)}</td>
          <td class="mono"><a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.url)}</a></td>
          <td class="mono">${escapeHtml(source.retrievalKind)}</td>
          <td class="mono">${escapeHtml(source.dataPath ?? '—')}</td>
        </tr>`,
      )
      .join('')}
  </tbody></table>`;
}

// --- the resolution chain ---------------------------------------------------

function stage(step, title, body, kind = '') {
  return `<div class="stage ${kind}" data-step="${step}">
    <h3>${escapeHtml(title)}</h3>${body}</div>`;
}

function renderEvidenceStage(detail) {
  if (detail.sources.length === 0) {
    return '<p class="muted small">No sources were read. Either nothing was attempted, or the attempt did not get this far.</p>';
  }
  return `<table><thead><tr><th>#</th><th>Source</th><th>Status</th><th>Retrieved</th><th>contentHash</th></tr></thead><tbody>
    ${detail.sources
      .map(
        (source) => `<tr>
          <td>${source.approvedSourceIndex}</td>
          <td>${escapeHtml(source.name)}<br><span class="mono muted">${escapeHtml(source.url)}</span></td>
          <td><span class="badge ${source.status === 'RETRIEVED' ? 'pass' : 'warn'}">${escapeHtml(source.status)}</span></td>
          <td class="small">${formatInstant(source.retrievedAt)}</td>
          <td class="mono">${source.contentHash === null ? '<span class="muted">— nothing was read</span>' : escapeHtml(shortHash(source.contentHash))}</td>
        </tr>`,
      )
      .join('')}
  </tbody></table>`;
}

function renderChecksStage(detail) {
  if (detail.deterministicChecks.length === 0) {
    return '<p class="muted small">No checks ran.</p>';
  }
  return (
    `<table><thead><tr><th>Check</th><th>Expected</th><th>Observed</th><th>Result</th></tr></thead><tbody>
      ${detail.deterministicChecks
        .map(
          (check) => `<tr>
            <td><span class="mono">${escapeHtml(check.checkId)}</span><br><span class="muted small">${escapeHtml(check.checkType)}</span></td>
            <td class="mono">${escapeHtml(check.expected ?? '—')}</td>
            <td class="mono">${escapeHtml(check.observed ?? '—')}</td>
            <td><span class="badge ${RESULT_CLASS[check.result] ?? ''}">${escapeHtml(check.result)}</span><br>
                <span class="muted small">${escapeHtml(check.explanation)}</span></td>
          </tr>`,
        )
        .join('')}
    </tbody></table>` +
    `<p class="muted small" style="margin-top:10px">Deterministic verdict:
      <span class="badge">${escapeHtml(detail.verdict ?? 'not reached')}</span>
      — this, not the model, is what decides the outcome.</p>`
  );
}

function renderReasoningStage(detail) {
  if (detail.reasoning === null) {
    return `<p class="muted small">The model was not consulted, or produced nothing usable.
      ${detail.reason === null ? '' : `Reason: <span class="mono">${escapeHtml(detail.reason)}</span>.`}</p>`;
  }

  const claims =
    detail.claims.length === 0
      ? ''
      : `<h3 style="margin-top:14px">Claims</h3>
         <table><thead><tr><th>Claim</th><th>Value</th><th>Support</th><th>How it was extracted</th></tr></thead><tbody>
         ${detail.claims
           .map(
             (claim) => `<tr>
               <td>${escapeHtml(claim.statement)}</td>
               <td class="mono">${claim.value === null ? '<span class="muted">not found</span>' : escapeHtml(claim.value)}</td>
               <td><span class="badge ${claim.support === 'SUPPORTED' ? 'pass' : claim.support === 'DISPUTED' ? 'warn' : ''}">${escapeHtml(claim.support)}</span></td>
               <td class="small">${escapeHtml(claim.extractionMethod)}
                 ${claim.extractionLocator === null
                   ? '<br><span class="muted">a model\'s reading — not independently reproducible</span>'
                   : `<br><span class="mono">${escapeHtml(claim.extractionLocator)}</span> <span class="muted">— anyone can re-run this</span>`}
               </td>
             </tr>`,
           )
           .join('')}
         </tbody></table>`;

  return (
    `<blockquote class="reasoning">${escapeHtml(detail.reasoning)}</blockquote>` +
    `<p class="muted small" style="margin-top:10px">Model:
      <span class="mono">${escapeHtml(detail.model ?? 'none')}</span> ·
      resolver <span class="mono">${escapeHtml(detail.resolverVersion)}</span>.
      The model concurs in the outcome the checks established; it cannot flip one, only withhold it.</p>` +
    claims
  );
}

function renderOutcomeStage(detail) {
  if (detail.outcome === null) {
    return `<p><span class="badge warn">${escapeHtml(detail.status)}</span>
      <span class="muted small">${escapeHtml(STATUS_NOTE[detail.status] ?? '')}</span></p>
      <p class="small">${escapeHtml(detail.detail)}</p>
      <p class="muted small">No outcome was proposed, so nothing was submitted on-chain.</p>`;
  }

  return (
    `<p><span class="badge ${OUTCOME_CLASS[detail.outcome] ?? ''}" style="font-size:15px">${escapeHtml(detail.outcome)}</span>
       <span class="muted small">at ${detail.confidenceBps} bps confidence</span></p>` +
    `<p class="small">${escapeHtml(detail.rationale ?? detail.detail)}</p>` +
    facts([
      ['evidenceHash', `<span class="mono">${escapeHtml(detail.evidenceHash ?? '—')}</span>`],
      ['Round', String(detail.round)],
      ['Resolved at', formatInstant(detail.resolvedAt)],
    ]) +
    `<p class="muted small" style="margin-top:8px">Confidence is audit metadata. There is no
      confidence parameter in the contract and no path from this number to a payout — it is a floor
      for <em>proposing at all</em>, never a reason to settle.</p>`
  );
}

function renderOnChainStage(detail, onChain) {
  const rows = [
    [
      'Submission',
      `<span class="badge ${detail.submissionState === 'CONFIRMED' ? 'pass' : detail.submissionState === 'FAILED' ? 'fail' : 'warn'}">${escapeHtml(detail.submissionState)}</span>`,
    ],
    ['Proposal tx', `<span class="mono">${escapeHtml(txDisplay(detail.proposalTxHash))}</span>`],
    ['Block', escapeHtml(detail.proposalBlockNumber ?? '—')],
  ];

  if (onChain !== null && onChain !== undefined) {
    rows.push(
      ['Contract state', `<span class="badge">${escapeHtml(onChain.state)}</span>`],
      ['Committed evidenceHash', `<span class="mono">${escapeHtml(onChain.evidenceHash)}</span>`],
      ['Challenge window closes', formatInstant(onChain.challengeEndsAt)],
      [
        'Challengeable now',
        onChain.challengeWindowOpen
          ? '<span class="badge warn">yes — round 1, window open</span>'
          : onChain.proposalsExhausted
            ? '<span class="badge">no — the replacement proposal is final (ADR-0004)</span>'
            : '<span class="badge">no</span>',
      ],
      [
        'Finalizable now',
        onChain.finalizable
          ? '<span class="badge pass">yes — the window has closed</span>'
          : '<span class="badge">no</span>',
      ],
      ['Final outcome', `<span class="badge ${OUTCOME_CLASS[onChain.finalOutcome] ?? ''}">${escapeHtml(onChain.finalOutcome)}</span>`],
    );
  }

  const match =
    detail.evidenceHash !== null && onChain?.evidenceHash !== undefined
      ? detail.evidenceHash.toLowerCase() === onChain.evidenceHash.toLowerCase()
        ? '<p class="small"><span class="badge pass">the stored package hashes to the digest the contract holds</span></p>'
        : '<p class="small"><span class="badge fail">the stored package does NOT match the on-chain digest</span></p>'
      : '';

  return facts(rows) + match;
}

function renderResolution(detail, onChain, history) {
  if (detail === null) {
    return `<p class="muted small">No resolution has been attempted yet. Run one once the condition
      deadline has passed and trading has closed — the contract refuses a proposal before then, and
      so does the resolver.</p>`;
  }

  const earlier =
    history.length <= 1
      ? ''
      : `<details style="margin-top:18px"><summary class="small muted">${history.length - 1} earlier attempt(s)</summary>
         <table><thead><tr><th>When</th><th>Round</th><th>Status</th><th>Outcome</th><th>Why</th></tr></thead><tbody>
         ${history
           .slice(1)
           .map(
             (entry) => `<tr>
               <td class="small">${formatInstant(entry.resolvedAt)}</td>
               <td>${entry.round}</td>
               <td><span class="badge">${escapeHtml(entry.status)}</span></td>
               <td>${entry.outcome === null ? '—' : escapeHtml(entry.outcome)}</td>
               <td class="small">${escapeHtml(entry.detail)}</td>
             </tr>`,
           )
           .join('')}
         </tbody></table></details>`;

  return (
    `<div class="chain">
      ${stage(1, 'Rules — the hashed agreement', `<p class="mono small">${escapeHtml(detail.rulesHash)}</p><p class="muted small">Committed on-chain before any evidence existed. Everything below is measured against this document and nothing else.</p>`, 'done')}
      ${stage(2, 'Evidence — what was read', renderEvidenceStage(detail), detail.sources.length > 0 ? 'done' : 'blocked')}
      ${stage(3, 'Deterministic checks — decided without a model', renderChecksStage(detail), detail.deterministicChecks.length > 0 ? 'done' : 'blocked')}
      ${stage(4, 'AI reasoning — concurrence, not authority', renderReasoningStage(detail), detail.reasoning !== null ? 'done' : 'blocked')}
      ${stage(5, 'Proposed outcome', renderOutcomeStage(detail), detail.outcome !== null ? 'done' : 'blocked')}
      ${stage(6, 'On-chain', renderOnChainStage(detail, onChain), detail.submissionState === 'CONFIRMED' ? 'done' : 'blocked')}
    </div>` + earlier
  );
}

// --- settlement and events --------------------------------------------------

function renderSettlement(market) {
  const chain = market.chain;
  if (chain === null || chain === undefined) return '';
  return facts([
    ['State', `<span class="badge">${escapeHtml(chain.state)}</span>`],
    ['Final outcome', `<span class="badge ${OUTCOME_CLASS[chain.finalOutcome] ?? ''}">${escapeHtml(chain.finalOutcome)}</span>`],
    ['Pool', formatUnits(chain.poolBaseUnits)],
    ['Refund mode', chain.refundMode ? 'yes' : 'no'],
    ['Cancellation reason', escapeHtml(chain.cancellationReason)],
  ]);
}

function renderEvents(market) {
  if (market.events.length === 0) return '<p class="muted small">No events indexed yet.</p>';
  return `<table><thead><tr><th>Block</th><th>Event</th><th>Transaction</th></tr></thead><tbody>
    ${market.events
      .map(
        (event) => `<tr>
          <td class="mono">${escapeHtml(event.blockNumber)}</td>
          <td>${escapeHtml(event.name)}</td>
          <td class="mono">${escapeHtml(txDisplay(event.transactionHash))}</td>
        </tr>`,
      )
      .join('')}
  </tbody></table>`;
}

// --- load -------------------------------------------------------------------

async function load() {
  try {
    const market = await api.getMarket(marketId);
    current = market;

    document.getElementById('question').textContent = market.question;
    document.getElementById('headline').innerHTML = `
      <span class="badge">${escapeHtml(market.status)}</span>
      <span class="muted">market ${escapeHtml(market.marketId)}</span>
      <span class="mono muted">${escapeHtml(market.address)}</span>`;

    document.getElementById('agreement').innerHTML = renderAgreement(market);
    document.getElementById('chain').innerHTML = renderChain(market);
    document.getElementById('sources').innerHTML = renderSources(market);
    document.getElementById('events').innerHTML = renderEvents(market);

    const state = market.chain?.state;
    document.getElementById('stake-panel').hidden = state !== 'OPEN';
    const settling = state === 'FINALIZED' || state === 'SETTLED' || state === 'CANCELLED';
    document.getElementById('settle-panel').hidden = !settling;
    if (settling) document.getElementById('settlement').innerHTML = renderSettlement(market);

    const resolution = await api.getResolution(marketId);
    document.getElementById('resolution').innerHTML = renderResolution(
      resolution.latest,
      resolution.onChain,
      resolution.history,
    );

    renderChallengePanel(market, resolution.onChain);
  } catch (error) {
    notify('status', `Could not load this market: ${escapeHtml(error.message)}`, 'error');
  }
}

function renderChallengePanel(market, onChain) {
  const panel = document.getElementById('challenge-panel');
  const form = document.getElementById('challenge-form');

  if (onChain === null || onChain === undefined) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  const filed = market.challenge;
  document.getElementById('challenge-state').innerHTML = filed
    ? facts([
        ['Challenger', `<span class="mono">${escapeHtml(filed.challenger)}</span>`],
        ['Bond', formatUnits(filed.bondBaseUnits)],
        ['reasonHash', `<span class="mono">${escapeHtml(filed.reasonHash)}</span>`],
        ['Filed at', formatInstant(filed.challengedAt)],
        ['Argument', `<blockquote class="reasoning">${escapeHtml(filed.reason)}</blockquote>`],
        [
          'Second proposal',
          onChain.secondProposalRequired
            ? '<span class="badge warn">required — the resolver must answer</span>'
            : '<span class="badge pass">made; it is final</span>',
        ],
      ])
    : onChain.challengeWindowOpen
      ? '<p class="small">A proposal stands and the window is open. Anyone with a stake in this market may contest it.</p>'
      : `<p class="muted small">Not challengeable: ${
          onChain.proposalsExhausted
            ? 'the replacement proposal is final (ADR-0004 — one round, so the process terminates).'
            : 'the window is closed or there is no standing proposal.'
        }</p>`;

  form.hidden = !(onChain.challengeWindowOpen && filed === null);
  const bond = market.chain?.challengeBondBaseUnits;
  if (bond !== undefined) document.getElementById('bond-amount').textContent = formatUnits(bond);
}

// --- actions ----------------------------------------------------------------

async function runResolution(dryRun) {
  const button = document.getElementById(dryRun ? 'dry-run' : 'resolve');
  button.disabled = true;
  notify('status', dryRun ? 'Running the pipeline without submitting…' : 'Resolving…');

  try {
    const detail = await api.resolve(marketId, dryRun ? { dryRun: true } : {});
    notify(
      'status',
      `<strong>${escapeHtml(detail.status)}</strong> — ${escapeHtml(detail.detail)}`,
      detail.status === 'RESOLVED' ? 'ok' : '',
    );
    await load();
  } catch (error) {
    notify('status', `Resolution failed: ${escapeHtml(error.message)}`, 'error');
  } finally {
    button.disabled = false;
  }
}

async function finalize() {
  const button = document.getElementById('finalize');
  button.disabled = true;
  try {
    const result = await api.finalize(marketId);
    notify('status', escapeHtml(result.detail), result.submitted ? 'ok' : '');
    await load();
  } catch (error) {
    notify('status', `Finalize failed: ${escapeHtml(error.message)}`, 'error');
  } finally {
    button.disabled = false;
  }
}

async function sendStake(approveOnly) {
  if (current === null) return;
  const token = current.specification?.settlement?.token?.address;
  const address = current.chain?.address;
  if (token === undefined || address === undefined) {
    notify('status', 'This market is not on-chain yet.', 'error');
    return;
  }

  const amount = BigInt(document.getElementById('stake-amount').value.trim() || '0');
  const side = Number.parseInt(document.getElementById('stake-side').value, 10);

  try {
    if (approveOnly) {
      const data = encode(SELECTOR.approve, address.replace(/^0x/, ''), amount);
      const tx = await wallet.send(token, data);
      notify('status', `Approval sent: <span class="mono">${escapeHtml(tx)}</span>`, 'ok');
      return;
    }
    const data = encode(SELECTOR.stake, BigInt(side), amount);
    const tx = await wallet.send(address, data);
    notify('status', `Stake sent: <span class="mono">${escapeHtml(tx)}</span>. Waiting…`);
    await wallet.waitForReceipt(tx);
    await load();
  } catch (error) {
    notify('status', `Transaction failed: ${escapeHtml(error.message)}`, 'error');
  }
}

/**
 * File a challenge, then record the argument behind it.
 *
 * The two steps are in this order because the contract is what commits the
 * hash: the wallet sends `challenge(reasonHash)`, and only once that is mined
 * does the backend have something to verify the text against. Recording first
 * would mean storing an argument for a challenge that may never exist.
 *
 * `reasonHash` is computed **by the backend** from the same text, through
 * `@covenant/shared` — the page cannot keccak256 without a library, and adding
 * one so the client could compute a protocol hash is exactly what ADR-0001
 * forbids. So the page asks the server for the hash first, shows it, and sends
 * that value on-chain.
 */
async function fileChallenge() {
  if (current === null) return;
  const address = current.chain?.address;
  const reason = document.getElementById('challenge-reason').value;
  if (reason.trim() === '') {
    notify('status', 'Write the argument first — its hash is what goes on-chain.', 'error');
    return;
  }

  const button = document.getElementById('file-challenge');
  button.disabled = true;

  try {
    // Ask the backend to hash the exact bytes. It refuses to record anything
    // whose hash does not match what the contract stored, so this is the same
    // value on both sides by construction.
    const prepared = await api.challengePrepare(marketId, reason);
    const tx = await wallet.send(address, encode(SELECTOR.challenge, prepared.reasonHash));
    notify('status', `Challenge sent: <span class="mono">${escapeHtml(tx)}</span>. Waiting…`);
    await wallet.waitForReceipt(tx);
    await api.challenge(marketId, reason, tx);
    notify('status', 'Challenge filed and its argument recorded.', 'ok');
    await load();
  } catch (error) {
    notify('status', `Challenge failed: ${escapeHtml(error.message)}`, 'error');
  } finally {
    button.disabled = false;
  }
}

async function marketCall(selector, label) {
  if (current === null) return;
  const address = current.chain?.address;
  if (address === undefined) return;
  try {
    const tx = await wallet.send(address, selector);
    notify('status', `${escapeHtml(label)} sent: <span class="mono">${escapeHtml(tx)}</span>`, 'ok');
    await wallet.waitForReceipt(tx);
    await load();
  } catch (error) {
    notify('status', `${escapeHtml(label)} failed: ${escapeHtml(error.message)}`, 'error');
  }
}

mountShell();
document.getElementById('resolve').addEventListener('click', () => void runResolution(false));
document.getElementById('dry-run').addEventListener('click', () => void runResolution(true));
document.getElementById('finalize').addEventListener('click', () => void finalize());
document.getElementById('refresh').addEventListener('click', () => void load());
document.getElementById('approve').addEventListener('click', () => void sendStake(true));
document.getElementById('stake').addEventListener('click', () => void sendStake(false));
document.getElementById('file-challenge').addEventListener('click', () => void fileChallenge());
document.getElementById('claim').addEventListener('click', () => void marketCall(SELECTOR.claim, 'Claim'));
document.getElementById('refund').addEventListener('click', () => void marketCall(SELECTOR.withdrawRefund, 'Refund'));
document
  .getElementById('claim-bond')
  .addEventListener('click', () => void marketCall(SELECTOR.claimChallengeBond, 'Bond claim'));

if (sessionAddress() === null) {
  notify('status', 'Sign in with your wallet to resolve, stake or challenge.', '');
}
void load();
