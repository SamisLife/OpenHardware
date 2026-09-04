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
let handlers = {};
/**
 * The markup as this file last wrote it.
 *
 * Compared against what was WRITTEN, never against `el.body.innerHTML`. The
 * DOM re-serialises what it is given — a bare `disabled` comes back as
 * `disabled=""` — so a read-back comparison never matches and the table is
 * rebuilt on every paint. That is invisible until something inside a row can
 * be scrolled: a rebuilt node starts at the top again, and an open source
 * listing jumps back to line one four times a second, which is what a
 * heartbeat costs.
 */
let lastBody = null;

export function mountFirmware(root, opts = {}) {
  handlers = opts;
  lastBody = null;
  el = {
    body:   root.querySelector('[data-fw=body]'),
    empty:  root.querySelector('[data-fw=empty]'),
    memory: root.querySelector('[data-fw=memory]'),
    memEmpty: root.querySelector('[data-fw=mem-empty]'),
  };
  /* One delegated listener: the rows are rebuilt wholesale on every render, so
     a listener bound to a button would be lost the next time anything moved. */
  el.body?.addEventListener('click', ev => {
    const hit = ev.target.closest?.('[data-fwact]');
    if (!hit || hit.disabled) return;
    const { fwact: act, build } = hit.dataset;
    if (act === 'flash') handlers.onFlash?.(build);
    else if (act === 'menu') handlers.onMenu?.(build);
    else if (act === 'review') handlers.onReview?.(build);
    else if (act === 'delete') handlers.onDelete?.(build);
    else if (act === 'delete-confirm') handlers.onDeleteConfirm?.(build);
    else if (act === 'close-review') handlers.onCloseReview?.();
  });
}

export function renderFirmware(state) {
  const rows = state.firmware;
  el.empty.hidden = rows.length > 0;

  /* A flash needs a linked board, and only one runs at a time. Both buttons
     everywhere reflect that: disabled with no board, disabled while any flash
     is in flight, and the one row being written says so in place of a button. */
  const linked = state.device.link === 'linked';
  const flashing = state.ui.flashing || null;
  const menuFor = state.ui.menuFor || null;
  const confirmDelete = state.ui.confirmDelete || null;
  const review = state.ui.review || null;
  const lastFlash = state.ui.lastFlash || null;

  const html = rows.map(f => {
    const o = OUTCOME[f.outcome] || OUTCOME.superseded;
    /* Flashable when there is an immutable build with an image behind it. A
       failed build has no hash and nothing to write. */
    const canFlash = !!f.buildId && !!f.sha;
    const isThis = flashing && flashing.buildId === f.buildId;
    /* Three things can occupy this cell, and only one at a time: what this
       flash is doing right now, how the last one ended, or the button to
       start another. */
    let action = '';
    if (canFlash && isThis) {
      action = `<span class="fw__prog">${progressLabel(flashing)}</span>`;
    } else if (canFlash) {
      const verdict = lastFlash && lastFlash.buildId === f.buildId
        ? `<span class="fw__verdict" data-ok="${!!lastFlash.ok}"`
          + `${lastFlash.reason ? ` title="${esc(lastFlash.reason)}"` : ''}`
          + `>${lastFlash.ok ? 'SUCCESS' : 'FAIL'}</span>`
        : '';
      action = verdict
        + `<button type="button" class="btn btn--small fw__flash" data-fwact="flash" data-build="${esc(f.buildId)}"`
          + `${linked && !flashing ? '' : ' disabled'}`
          + `${!linked ? ' title="Link a board first"' : flashing ? ' title="A flash is already in progress"' : ''}`
          + `>${verdict && !lastFlash.ok ? 'Retry' : 'Flash'}</button>`;
    }
    /* The menu exists for anything with a build behind it, including a build
       that failed to compile: its source is exactly what somebody wants to
       read after a failure, and deleting it is how the list stays short. */
    const hasBuild = !!f.buildId;
    const menu = hasBuild
      ? `<button type="button" class="fw__more" data-fwact="menu" data-build="${esc(f.buildId)}"`
        /* Bullets rather than middle dots: the same gesture, at a weight that
           survives being small on a dark face. */
        + ` aria-haspopup="true" aria-expanded="${menuFor === f.buildId}"`
        + ` title="More for this build" aria-label="More for build ${esc(f.buildId)}">•••</button>`
        + (menuFor === f.buildId ? rowMenu(f, confirmDelete === f.buildId) : '')
      : '';

    return `
      <tr data-outcome="${f.outcome}"${f.buildId ? ` data-build="${esc(f.buildId)}"` : ''}>
        <td class="fw__ver">${esc(f.version)}</td>
        <td class="fw__sha">${esc((f.sha || '').slice(0, 7) || NIL)}</td>
        <td class="fw__size">${Number.isFinite(f.bytes) ? (f.bytes / 1024).toFixed(0) + ' KB' : NIL}</td>
        <td class="fw__time">${clock(f.builtAt)}</td>
        <td class="fw__outcome"><span class="tag" data-tone="${o.tone}">${o.label}</span></td>
        <td class="fw__do">${action}<span class="fw__menuwrap">${menu}</span></td>
      </tr>
      ${f.note ? `<tr class="fw__noterow"><td colspan="6"><span class="fw__note">${esc(f.note)}</span></td></tr>` : ''}
      ${review && review.buildId === f.buildId && review.from === 'row'
        ? `<tr class="fw__reviewrow"><td colspan="6">${sourceView(review)}</td></tr>` : ''}
    `;
  }).join('');

  if (lastBody !== html) {
    el.body.innerHTML = html;
    lastBody = html;
  }
  placeMenu();
}

/**
 * Put the open menu where its button is, in viewport coordinates.
 *
 * The table scrolls inside the panel, and the panel is one of several, so a
 * menu positioned against its own row is clipped twice over: by the scroll
 * container it hangs out of, and by the next panel along, which paints over
 * anything a sibling stacks. Neither is fixable with z-index alone.
 *
 * So the menu is taken out of the flow entirely — fixed to the viewport,
 * measured from the button each time it is drawn. It flips above the button
 * when there is no room below, and never runs off the left edge. Whoever
 * opens it also closes it on the next scroll, because a fixed menu does not
 * travel with the row it belongs to.
 */
function placeMenu() {
  const menu = el.body?.querySelector?.('[data-fwmenu]');
  if (!menu || !menu.getBoundingClientRect) return;

  const button = menu.previousElementSibling;
  const anchor = button?.getBoundingClientRect?.();
  if (!anchor) return;

  const view = typeof window === 'undefined' ? null : window;
  const height = menu.offsetHeight || 0;
  const width = menu.offsetWidth || 0;
  const room = view ? view.innerHeight - anchor.bottom : Infinity;

  const top = room < height + 8 ? anchor.top - height - 4 : anchor.bottom + 4;
  const left = Math.max(8, anchor.right - width);

  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.left = `${left}px`;
}

/**
 * What a flash in flight is doing, in the width of a table cell.
 *
 * A percentage only while bytes are actually being counted. Before and after
 * the write there is no denominator — fetching an image, waiting for the chip
 * to answer, watching a candidate boot — and a bar that keeps moving through
 * those is a bar that is making it up. Those stages are named instead.
 */
function progressLabel(flashing) {
  const { written, total, stage } = flashing || {};
  if (Number.isFinite(written) && Number.isFinite(total) && total > 0) {
    const pct = Math.max(0, Math.min(100, Math.round((written / total) * 100)));
    return `${pct}%`;
  }
  return esc(stage || 'flashing');
}

/**
 * The overflow menu on one image row.
 *
 * Two entries, because there are exactly two things to do with a build that
 * are not flashing it: read what it is, and get rid of it. Delete asks twice —
 * the artefact is the only copy of that candidate, and the row it sits on is
 * one pixel from the button that writes firmware to a board.
 */
function rowMenu(f, confirming) {
  return `<span class="fwmenu" role="menu" data-fwmenu="${esc(f.buildId)}">
    <button type="button" class="fwmenu__item" role="menuitem" data-fwact="review" data-build="${esc(f.buildId)}">Review source</button>
    ${confirming
      ? `<button type="button" class="fwmenu__item fwmenu__item--danger" role="menuitem" data-fwact="delete-confirm" data-build="${esc(f.buildId)}">Delete for good</button>`
      : `<button type="button" class="fwmenu__item" role="menuitem" data-fwact="delete" data-build="${esc(f.buildId)}">Delete…</button>`}
  </span>`;
}

/**
 * The source a build was compiled from, as stored beside its images.
 *
 * This is the artefact's own copy, not the current draft: the draft moves on,
 * and what matters when deciding whether to write an image is the code that
 * image was made of. The build id and the source hash are shown with it so a
 * listing can be tied back to the manifest it belongs to.
 */
export function sourceView(review) {
  if (!review) return '';
  const head = `<div class="src__head">
      <span class="src__title">Source · build ${esc(review.buildId)}</span>
      ${review.app ? `<span class="src__app">${esc([review.app.name, review.app.version].filter(Boolean).join(' '))}</span>` : ''}
      <button type="button" class="btn btn--small" data-fwact="close-review">Close</button>
    </div>`;

  if (review.loading) return `<div class="src">${head}<p class="src__note">reading the stored source…</p></div>`;
  if (review.error) return `<div class="src">${head}<p class="src__note src__note--bad">${esc(review.error)}</p></div>`;

  const files = review.files || {};
  const names = Object.keys(files).sort();
  if (!names.length) {
    return `<div class="src">${head}<p class="src__note">this build kept no source</p></div>`;
  }
  const body = names.map(name => `
    <div class="src__file">
      <span class="src__name">${esc(name)}</span>
      <pre class="src__code"><code>${esc(files[name])}</code></pre>
    </div>`).join('');
  return `<div class="src">${head}${review.note ? `<p class="src__note">${esc(review.note)}</p>` : ''}${body}</div>`;
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
