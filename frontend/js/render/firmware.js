/* ============================================================================
   firmware.js — what has been on this board, and what the agent learned.
   ----------------------------------------------------------------------------
   Two lists that belong together.

   The image history is the audit trail: every local build, whether it reached
   the device, and what became of it. A failed build is a normal entry here;
   active means a later hello reported the exact ELF hash.

   Below it, procedural memory: the board-specific limits the agent has
   worked out by running into them. These outlive the work order and narrow
   the search space next time, which is the difference between an agent that
   iterates and one that merely retries.
   ========================================================================== */

import { clock, NIL } from '../format.js';

const OUTCOME = {
  built:       { label: 'BUILT',       tone: 'ok' },
  flashing:    { label: 'FLASHING',    tone: 'warn' },
  active:      { label: 'ACTIVE',      tone: 'active' },
  held:        { label: 'HELD',        tone: 'ok' },
  failed:      { label: 'FAILED',      tone: 'fault' },
  rolled_back: { label: 'ROLLED BACK', tone: 'warn' },
  superseded:  { label: 'SUPERSEDED',  tone: 'muted' },
};

let el = {};

export function mountFirmware(root) {
  el = {
    body:   root.querySelector('[data-fw=body]'),
    empty:  root.querySelector('[data-fw=empty]'),
    memory: root.querySelector('[data-fw=memory]'),
    memEmpty: root.querySelector('[data-fw=mem-empty]'),
  };
}

export function renderFirmware(state) {
  const rows = state.firmware;
  el.empty.hidden = rows.length > 0;

  const html = rows.map(f => {
    const o = OUTCOME[f.outcome] || OUTCOME.superseded;
    return `
      <tr data-outcome="${f.outcome}">
        <td class="fw__ver">${esc(f.version)}</td>
        <td class="fw__sha">${esc((f.sha || '').slice(0, 7) || NIL)}</td>
        <td class="fw__size">${Number.isFinite(f.bytes) ? (f.bytes / 1024).toFixed(0) + ' KB' : NIL}</td>
        <td class="fw__time">${clock(f.builtAt)}</td>
        <td class="fw__outcome"><span class="tag" data-tone="${o.tone}">${o.label}</span></td>
      </tr>
      ${f.note ? `<tr class="fw__noterow"><td colspan="5"><span class="fw__note">${esc(f.note)}</span></td></tr>` : ''}
    `;
  }).join('');

  if (el.body.innerHTML !== html) el.body.innerHTML = html;
}

/**
 * Procedural memory. Derived here from what the attempts actually
 * established, so the list can never claim a limit the log does not support.
 * In the live system this reads devices/{id}/memory/procedural instead.
 */
export function renderMemory(state) {
  const facts = [];

  for (const a of state.attempts) {
    if (a.learned) {
      facts.push({
        ...a.learned,
        src: `attempt ${String(a.n).padStart(2, '0')}${a.by === 'agent' ? ' · by agent' : ''}`,
        committed: !!a.gate && a.gate.state === 'approved',
      });
    }
  }
  /* Recorded directly by an agent through record_limit. Listed with what the
     attempts established rather than apart from it — one memory, whoever
     wrote to it — but labelled, because a limit a person can trace to a
     measurement is worth more than one a model asserted. */
  for (const m of state.memory || []) {
    facts.push({
      key: m.key, value: m.value,
      src: `recorded by ${m.source || 'agent'}${m.note ? ` · ${m.note}` : ''}`,
      committed: !!m.committed,
    });
  }

  el.memEmpty.hidden = facts.length > 0;

  const html = facts.map(f => `
    <li class="limit" data-committed="${f.committed}">
      <span class="limit__key">${esc(f.key)}</span>
      <span class="limit__val">${esc(f.value)}</span>
      <span class="limit__src">${esc(f.src)}${f.committed ? ' · committed' : ' · session only'}</span>
    </li>`).join('');

  if (el.memory.innerHTML !== html) el.memory.innerHTML = html;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
