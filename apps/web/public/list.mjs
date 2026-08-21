/**
 * The market list.
 *
 * Every number shown here comes from the indexer's cache, and the page says so
 * on each row. That is not decoration: the chain is authoritative for money, an
 * indexed total can lag it, and a user about to act should know which they are
 * looking at. The detail page reads the contract directly.
 */

import { api, escapeHtml, formatInstant, formatUnits, shortHash } from './api.mjs';
import { mountShell, notify } from './shell.mjs';

const STATUS_CLASS = {
  SETTLED: 'yes',
  FINALIZED: 'yes',
  CANCELLED: 'invalid',
  CHALLENGED: 'warn',
  RESOLUTION_PROPOSED: 'warn',
};

function card(market) {
  const badge = STATUS_CLASS[market.status] ?? '';
  return `
    <a class="market-card" href="/market.html?id=${encodeURIComponent(market.marketId)}">
      <div class="q">${escapeHtml(market.question)}</div>
      <div class="stack small muted">
        <span class="badge ${badge}">${escapeHtml(market.status)}</span>
        <span>YES ${formatUnits(market.totalYesBaseUnits)}</span>
        <span>NO ${formatUnits(market.totalNoBaseUnits)}</span>
        <span>deadline ${formatInstant(market.deadline)}</span>
        <span class="mono">${shortHash(market.rulesHash)}</span>
        <span class="origin">totals: ${escapeHtml(market.origin)}</span>
      </div>
    </a>`;
}

async function load() {
  const filter = document.getElementById('filter').value;
  const target = document.getElementById('markets');
  target.innerHTML = '<p class="muted small">Loading…</p>';

  try {
    const page = await api.listMarkets(filter === '' ? '' : `?status=${filter}`);
    notify('status', null);
    target.innerHTML =
      page.markets.length === 0
        ? '<div class="panel muted small">No markets yet. <a href="/create.html">Create one</a>.</div>'
        : page.markets.map(card).join('');
  } catch (error) {
    target.innerHTML = '';
    notify('status', `Could not load markets: ${escapeHtml(error.message)}`, 'error');
  }
}

mountShell();
document.getElementById('refresh').addEventListener('click', () => void load());
document.getElementById('filter').addEventListener('change', () => void load());
void load();
