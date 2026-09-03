/* ============================================================================
   agent.js — the build log.
   ----------------------------------------------------------------------------
   Deliberately not a conversation. There is no message list, no avatars, no
   typing indicator, and nowhere to type. The agent is not talking to you; it
   is working, and this is the record it leaves behind.

   Each attempt is one closed loop: build, ship, observe, conclude. The steps
   are what it did and whether each one held. The reasoning block is the only
   prose on the page, and it is confined to four fixed fields so that two
   attempts can be compared line for line:

     OBSERVED    what came back from the hardware
     HYPOTHESIS  what it believes is wrong
     CHANGE      what it altered, concretely, with values
     RESULT      whether that worked

   Attempts render newest first. The defining moment of this project is
   coming back to the tab after two minutes and finding work already done, so
   the most recent thing must be the thing you see without scrolling.
   ========================================================================== */

import { dur, clock, shortKey, NIL } from '../format.js';

const STATUS_LABEL = {
  running:   'RUNNING',
  passed:    'GOAL MET',
  failed:    'FAILED',
  abandoned: 'ABANDONED',
  awaiting_approval: 'AWAITING APPROVAL',
  idle:      'NO WORK ORDER',
};

const STEP_ORDER = [
  'observe', 'synthesize', 'apply', 'compile', 'flash', 'boot_confirm', 'frame_check', 'measure', 'soak',
];

let el = {};
let handlers = {};
/** n -> { node, sig } so an unchanged attempt is never rebuilt. */
const built = new Map();

export function mountAgent(root, opts = {}) {
  handlers = opts;
  el = {
    status:      root.querySelector('[data-agent=status]'),
    order:       root.querySelector('[data-agent=order]'),
    rehearsal:   root.querySelector('[data-agent=rehearsal]'),
    abandon:     root.querySelector('[data-agent=abandon]'),
    goal:        root.querySelector('[data-agent=goal]'),
    constraints: root.querySelector('[data-agent=constraints]'),
    id:          root.querySelector('[data-agent=id]'),
    opened:      root.querySelector('[data-agent=opened]'),
    count:       root.querySelector('[data-agent=count]'),
    list:        root.querySelector('[data-agent=attempts]'),
    empty:       root.querySelector('[data-agent=empty]'),
    gate:        root.querySelector('[data-agent=gate]'),
  };
  el.abandon?.addEventListener('click', () => handlers.onAbandon?.());
}

/**
 * A gate raised by a tool rather than by an attempt.
 *
 * Drawn above the log with the same block the loop's gate uses, and answered
 * by the same two handlers, so an operator sees one kind of question whoever
 * asked it. The block names who asked: an agent wanting to flash a board is a
 * different sentence from the loop wanting to remember a limit.
 */
export function renderGate(state) {
  if (!el.gate) return;
  const g = state.gate;
  el.gate.hidden = !g;
  if (!g) { el.gate.innerHTML = ''; return; }

  el.gate.innerHTML = gateBlock({ gate: g }, g.requestedBy === 'agent' ? 'an agent asked' : null);
  if (g.state === 'pending') {
    el.gate.querySelector('[data-gate=approve]')?.addEventListener('click', () => handlers.onApprove?.(g));
    el.gate.querySelector('[data-gate=hold]')?.addEventListener('click', () => handlers.onHold?.(g));
  }
}

export function renderWorkOrder(state) {
  const wo = state.workOrder;

  el.status.textContent = STATUS_LABEL[wo?.status || 'idle'] || 'UNKNOWN';
  el.status.dataset.status = wo?.status || 'idle';

  /* The belt occupies this space until there is a work order; see belt.js.
     Two views of one slot rather than a placeholder that has to pretend to
     be both. */
  el.order.hidden = !wo;
  if (!wo) {
    el.constraints.innerHTML = '';
    el.id.textContent = NIL;
    el.opened.textContent = NIL;
    return;
  }

  /* Said once, at the top, for as long as the run is a rehearsal. Leaving it
     to be inferred from the step markers would be leaving it to be missed. */
  el.rehearsal.hidden = !wo.rehearsal;
  if (wo.rehearsal && el.rehearsal.textContent !== wo.rehearsal) {
    el.rehearsal.textContent = wo.rehearsal;
  }
  el.abandon.textContent = wo.status === 'running' ? 'Abandon' : 'Clear';

  if (el.goal.textContent !== wo.goal) el.goal.textContent = wo.goal;
  el.id.textContent = wo.id;
  el.opened.textContent = clock(wo.createdAt);

  const chips = (wo.constraints || []).map(c => `<li class="chip">${esc(c)}</li>`).join('');
  if (el.constraints.innerHTML !== chips) el.constraints.innerHTML = chips;
}

export function renderAttempts(state) {
  const list = el.list;
  const attempts = state.attempts;

  el.count.textContent = attempts.length
    ? `${attempts.length} attempt${attempts.length === 1 ? '' : 's'}`
    : NIL;
  el.empty.hidden = attempts.length > 0;

  /* drop nodes for attempts that no longer exist (scenario restart) */
  for (const [n, rec] of built) {
    if (!attempts.some(a => a.n === n)) { rec.node.remove(); built.delete(n); }
  }

  /* newest first: walk descending and keep the DOM in that order */
  const desc = [...attempts].sort((a, b) => b.n - a.n);
  let anchor = null;

  for (const a of desc) {
    const sig = JSON.stringify(a);
    let rec = built.get(a.n);

    if (!rec) {
      const node = document.createElement('article');
      node.className = 'attempt';
      rec = { node, sig: null };
      built.set(a.n, rec);
    }
    if (rec.sig !== sig) {
      paintAttempt(rec.node, a);
      rec.sig = sig;
    }

    const want = anchor ? anchor.nextElementSibling : list.firstElementChild;
    if (want !== rec.node) list.insertBefore(rec.node, want);
    anchor = rec.node;
  }
}

/* ------------------------------------------------------------------------ */

function paintAttempt(node, a) {
  node.dataset.status = a.status;
  node.classList.toggle('is-live', a.status === 'running' || a.status === 'gated');

  const steps = [...(a.steps || [])].sort(
    (x, y) => STEP_ORDER.indexOf(x.id) - STEP_ORDER.indexOf(y.id));

  node.innerHTML = `
    <header class="attempt__head">
      <span class="attempt__n">ATTEMPT ${String(a.n).padStart(2, '0')}</span>
      <span class="attempt__verdict" data-tone="${tone(a.status)}">${esc(a.verdict || headline(a))}</span>
      <span class="attempt__meta">${esc(metaLine(a))}</span>
    </header>
    <ol class="steps">${steps.map(stepRow).join('')}</ol>
    ${reasonBlock(a.reasoning)}
    ${a.gate ? gateBlock(a) : ''}
  `;

  if (a.gate && a.gate.state === 'pending' && handlers.onApprove) {
    node.querySelector('[data-gate=approve]')
      ?.addEventListener('click', () => handlers.onApprove(a));
    node.querySelector('[data-gate=hold]')
      ?.addEventListener('click', () => handlers.onHold?.(a));
  }
}

function stepRow(s) {
  return `
    <li class="step" data-status="${esc(s.status)}" data-sim="${s.sim ? 'true' : 'false'}">
      <span class="step__glyph" aria-hidden="true"></span>
      <span class="step__label">${esc(s.label)}</span>
      <span class="step__detail">${esc(s.detail || '')}</span>
      ${s.sim ? '<span class="step__sim" title="this step did not really happen — nothing was built or written, or the decision was the local search\'s rather than an agent\'s">SIM</span>' : ''}
      <span class="step__key" title="idempotency key">${esc(shortKey(s.key))}</span>
      <span class="step__dur">${s.status === 'running' ? '···' : (Number.isFinite(s.ms) ? dur(s.ms) : '')}</span>
      <span class="sr-only">${esc(s.status)}</span>
    </li>`;
}

const REASON_FIELDS = [
  ['observed',   'OBSERVED'],
  ['hypothesis', 'HYPOTHESIS'],
  ['change',     'CHANGE'],
  ['result',     'RESULT'],
];

function reasonBlock(r) {
  if (!r) return '';
  const rows = REASON_FIELDS
    .filter(([k]) => r[k])
    .map(([k, label]) => `
      <div class="reason__row" data-field="${k}">
        <dt>${label}</dt>
        <dd>${esc(r[k])}</dd>
      </div>`)
    .join('');
  return rows ? `<dl class="reason">${rows}</dl>` : '';
}

/**
 * The approval gate. Irreversible side effects do not happen because a model
 * decided they should. This one guards a write to procedural memory: a
 * learned board limit that will constrain every future work order on this
 * hardware, which is exactly the kind of thing you want a human to sign.
 */
function gateBlock(a, who = null) {
  const g = a.gate;
  if (g.state === 'approved' || g.state === 'operator') {
    return `<div class="gate" data-state="approved">
      <span class="gate__mark">APPROVED</span>
      <span class="gate__what">${esc(g.action)}</span>
      <span class="gate__by">${esc(g.approvedBy || 'operator')} · ${clock(g.approvedAt || g.answeredAt)}</span>
    </div>`;
  }
  if (g.state === 'held' || g.state === 'cancelled') {
    return `<div class="gate" data-state="held">
      <span class="gate__mark">${g.state === 'held' ? 'HELD' : 'WITHDRAWN'}</span>
      <span class="gate__what">${esc(g.action)}</span>
      <span class="gate__by">nothing was written · ${clock(g.answeredAt)}</span>
    </div>`;
  }
  return `<div class="gate" data-state="pending">
    <div class="gate__head">
      <span class="gate__mark">APPROVAL REQUIRED${who ? ` · ${esc(who)}` : ''}</span>
      <span class="gate__what">${esc(g.action)}</span>
    </div>
    <p class="gate__why">${esc(g.rationale)}</p>
    <div class="gate__actions">
      <button class="btn btn--primary" data-gate="approve">Approve</button>
      <button class="btn" data-gate="hold">Hold</button>
      <span class="gate__policy" data-gate="policy">${esc(g.policy || '')}</span>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------------ */

function headline(a) {
  if (a.status === 'running') return 'IN PROGRESS';
  if (a.status === 'gated')   return 'HELD AT GATE';
  const failed = (a.steps || []).find(s => s.status === 'fail');
  if (failed) return `FAILED AT ${failed.label}`;
  return a.status === 'passed' ? 'ALL CHECKS PASSED' : a.status.toUpperCase();
}

function metaLine(a) {
  const bits = [];
  /* Who drove it, when it was not the loop. One history, two hands. */
  if (a.by === 'agent') bits.push('by agent');
  if (a.firmware) bits.push(a.firmware);
  if (Number.isFinite(a.durationMs)) bits.push(dur(a.durationMs));
  else if (a.startedAt) bits.push(`opened ${clock(a.startedAt)}`);
  return bits.join(' · ');
}

function tone(status) {
  if (status === 'passed') return 'ok';
  if (status === 'failed') return 'fault';
  if (status === 'running' || status === 'gated') return 'active';
  return 'muted';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
