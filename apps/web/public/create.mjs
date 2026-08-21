/**
 * Compile → review → criteria → register.
 *
 * Compilation is conversational (ADR-0011): `INCOMPLETE` is the common answer
 * and it carries questions a person can answer, so the page keeps a session id
 * and sends the reply back into the same conversation rather than starting over.
 *
 * The page never computes a hash. `rulesHash` is whatever the server derived
 * from the specification through `@covenant/shared`, and it is displayed for
 * approval — the client-side value in the register request is a checksum the
 * server recomputes and compares, never the value that gets stored.
 */

import { api, escapeHtml, formatInstant } from './api.mjs';
import { mountShell, notify } from './shell.mjs';

let state = {
  sessionId: undefined,
  specification: null,
  rulesHash: null,
  chainId: null,
};

/** A plan skeleton, pre-filled from the compiled sources so it is editable, not invented. */
function planTemplate(specification) {
  const source = specification.approvedSources[0];
  return JSON.stringify(
    {
      checks: [
        {
          checkId: 'primary-criterion',
          kind: 'NUMERIC_COMPARISON',
          // `pointer: null` uses the specification's own approved `dataPath`,
          // which is the preferred form — that locator is inside the hash.
          observation: { sourceId: 'source-0', pointer: source?.dataPath ?? null },
          operator: 'GREATER_THAN',
          threshold: '0',
        },
      ],
      // Which of the two conditions these checks were written against. Getting
      // this backwards would invert a settlement, so it is explicit.
      encodes: 'successCondition',
    },
    null,
    2,
  );
}

function renderSpec(specification) {
  const sources = specification.approvedSources
    .map(
      (source, index) =>
        `<tr><td>${index}${index === 0 ? ' <span class="badge">primary</span>' : ''}</td>
         <td>${escapeHtml(source.name)}</td>
         <td class="mono">${escapeHtml(source.url)}</td>
         <td class="mono">${escapeHtml(source.dataPath ?? '—')}</td></tr>`,
    )
    .join('');

  return `
    <dl class="facts">
      <dt>Question</dt><dd>${escapeHtml(specification.question)}</dd>
      <dt>YES when</dt><dd>${escapeHtml(specification.successCondition)}</dd>
      <dt>NO when</dt><dd>${escapeHtml(specification.failureCondition)}</dd>
      <dt>Deadline</dt><dd>${formatInstant(specification.deadline)} (${escapeHtml(specification.timezone)})</dd>
      <dt>Method</dt><dd>${escapeHtml(specification.resolutionMethod)}</dd>
      <dt>Trading ends</dt><dd>${formatInstant(specification.settlement.tradingEndsAt)}</dd>
      <dt>Challenge window</dt><dd>${specification.settlement.challengeWindowSeconds}s</dd>
      <dt>Challenge bond</dt><dd>${escapeHtml(specification.settlement.challengeBondBaseUnits)} base units</dd>
    </dl>
    <h3 style="margin-top:16px">Approved sources — position is precedence</h3>
    <table><thead><tr><th>#</th><th>Name</th><th>URL</th><th>Data path</th></tr></thead>
    <tbody>${sources}</tbody></table>`;
}

async function compile() {
  const message = document.getElementById('message').value.trim();
  if (message === '') {
    notify('status', 'Describe the condition first.', 'error');
    return;
  }

  const button = document.getElementById('compile');
  button.disabled = true;
  notify('status', 'Compiling…');

  try {
    if (state.chainId === null) {
      const health = await api.health();
      state.chainId = health.chainId;
    }

    const result = await api.compile(message, state.chainId, state.sessionId);
    state.sessionId = result.sessionId;
    document.getElementById('session').textContent = `session ${result.sessionId}`;
    document.getElementById('review-panel').hidden = false;
    document.getElementById('interpretation').textContent = result.interpretation;

    if (result.status === 'INCOMPLETE') {
      // Not an error. The compiler declining to invent a missing deadline is the
      // system working, so the questions are shown and the conversation stays open.
      document.getElementById('questions').innerHTML = `
        <div class="notice">
          <strong>The compiler needs more before this can be enforced.</strong>
          <ul>${result.questions.map((q) => `<li>${escapeHtml(q.question)} <span class="muted small">— ${escapeHtml(q.why)}</span></li>`).join('')}</ul>
          Answer above and compile again.
        </div>`;
      document.getElementById('spec-summary').innerHTML = '';
      document.getElementById('plan-panel').hidden = true;
      document.getElementById('register-panel').hidden = true;
      notify('status', null);
      return;
    }

    state.specification = result.specification;
    state.rulesHash = result.rulesHash;

    document.getElementById('questions').innerHTML = '';
    document.getElementById('spec-summary').innerHTML = renderSpec(result.specification);
    document.getElementById('canonical').textContent = result.canonical;
    document.getElementById('plan').value = planTemplate(result.specification);
    document.getElementById('rules-hash').textContent = result.rulesHash;
    document.getElementById('plan-panel').hidden = false;
    document.getElementById('register-panel').hidden = false;
    notify('status', 'Compiled. Review the specification and the criteria before registering.', 'ok');
  } catch (error) {
    notify('status', `Compile failed: ${escapeHtml(error.message)}`, 'error');
  } finally {
    button.disabled = false;
  }
}

async function register() {
  if (state.specification === null) return;
  const button = document.getElementById('register');
  button.disabled = true;

  try {
    let plan;
    const raw = document.getElementById('plan').value.trim();
    if (raw !== '') {
      try {
        plan = JSON.parse(raw);
      } catch {
        throw new Error('The acceptance criteria are not valid JSON.');
      }
    }

    const result = await api.register(state.specification, state.rulesHash, plan);
    notify(
      'status',
      `Registered <span class="mono">${escapeHtml(result.rulesHash)}</span> as ` +
        `${escapeHtml(result.status)}. Now create the market on-chain from your own wallet with ` +
        'this rules hash — the backend does not do it for you.',
      'ok',
    );
  } catch (error) {
    const issues =
      error.issues?.length > 0
        ? `<ul>${error.issues.map((i) => `<li class="mono">${escapeHtml(i.path)}: ${escapeHtml(i.message)}</li>`).join('')}</ul>`
        : '';
    notify('status', `Registration failed: ${escapeHtml(error.message)}${issues}`, 'error');
  } finally {
    button.disabled = false;
  }
}

mountShell();
document.getElementById('compile').addEventListener('click', () => void compile());
document.getElementById('register').addEventListener('click', () => void register());
